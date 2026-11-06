import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateTextProblem } from "./private-artifact.ts";

const PRIVATE_REPLY_REDACTION = "[private reply redacted]";
const PRIVATE_TEXT_REDACTION = "[private text redacted]";
const FIXED_DIAGNOSTIC = /^Bash denied: Write unavailable$/i;
const STRUCTURED_DIAGNOSTIC = /^(?:credentials?(?:\s+(?:are|is))?\s+unavailable(?:[.;]\s*sign[- ]in\s+(?:is\s+)?required|\s+for\s+this\s+worker)?|permission denied(?:\s+(?:for|while invoking)\s+(?:Bash|Write)|\s+cleaning\s+owned\s+record)?)[.!]?$/i;
const METADATA_VALUES: Record<string, ReadonlySet<string>> = {
  type: new Set(["system", "assistant", "result"]),
  subtype: new Set(["init", "success", "error", "failure", "failed"]),
  status: new Set(["success", "error", "failed", "completed"]),
};

function retainedResult(value: string, structuredError: boolean,
  classifyFailure: (value: unknown) => string): string {
  if (privateTextProblem(value)) return PRIVATE_TEXT_REDACTION;
  if (FIXED_DIAGNOSTIC.test(value.trim()) ||
      structuredError && STRUCTURED_DIAGNOSTIC.test(value.trim())) return value;
  const failure = classifyFailure(value);
  if (failure !== "ORACLE_MISMATCH") return failure;
  return structuredError ? "ORACLE_MISMATCH" : PRIVATE_REPLY_REDACTION;
}

function redactValue(value: unknown, key: string, structuredError: boolean,
  topLevel: boolean, classifyFailure: (value: unknown) => string): unknown {
  if (typeof value === "string") {
    if (topLevel && key === "result") return retainedResult(value, structuredError, classifyFailure);
    if (topLevel && structuredError && ["error", "message", "reason"].includes(key)) {
      return retainedResult(value, true, classifyFailure);
    }
    if (topLevel && METADATA_VALUES[key]?.has(value) && !privateTextProblem(value)) return value;
    return PRIVATE_TEXT_REDACTION;
  }
  if (Array.isArray(value)) return value.map((item) => typeof item === "string"
    ? PRIVATE_TEXT_REDACTION : redactValue(item, "", structuredError, false, classifyFailure));
  if (value && typeof value === "object") {
    const childrenAreTopLevel = topLevel && key === "";
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) =>
      [childKey, redactValue(child, childKey, structuredError,
        childrenAreTopLevel, classifyFailure)]));
  }
  return value;
}

/** Keep only exact event metadata and typed/fixed diagnostics from Claude JSONL. */
export function terminalEvidence(stdout: string, exitCode: number | null,
  classifyFailure: (value: unknown) => string): string {
  return stdout.split("\n").map((line) => {
    if (!line) return line;
    try {
      const event: unknown = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) return PRIVATE_TEXT_REDACTION;
      const entries = Object.fromEntries(Object.entries(event));
      const structuredError = exitCode !== 0 || entries.is_error === true ||
        (typeof entries.subtype === "string" && /^(?:error|failure|failed)$/.test(entries.subtype));
      return JSON.stringify(redactValue(entries, "", structuredError, true, classifyFailure));
    } catch { return PRIVATE_TEXT_REDACTION; }
  }).join("\n");
}

/** Normalize a catch/stderr value without retaining arbitrary text. */
export function failureDiagnostic(value: unknown,
  classifyFailure: (value: unknown) => string): string {
  const text = value instanceof Error ? value.message : String(value);
  return retainedResult(text, true, classifyFailure);
}

/** Preserve only redacted Claude process evidence before bounded display traces. */
export function evidenceTrace(lines: string[], privateReply = ""): string[] {
  return lines.slice(-200).map((line) => {
    const withoutReply = privateReply ? line.replaceAll(privateReply,
      PRIVATE_REPLY_REDACTION) : line;
    const bounded = Buffer.byteLength(withoutReply) <= 4_000 ? withoutReply :
      `${Buffer.from(withoutReply).subarray(0, 4_000).toString("utf8")}…`;
    return privateTextProblem(bounded) ? PRIVATE_TEXT_REDACTION : bounded;
  });
}

/** Write one private terminal artifact with normalized stderr and JSONL. */
export function recordTurnOutput(root: string, label: string,
  result: { exitCode: number | null; stdout: string; stderr: string },
  classifyFailure: (value: unknown) => string): string {
  if (!/^(turn-one|turn-two|stale-recovery)$/.test(label)) {
    throw new Error("eval-stateful-claude-turn-label-invalid");
  }
  const path = join(root, `${label}.terminal.json`);
  const retained = { exitCode: result.exitCode,
    stdout: terminalEvidence(result.stdout, result.exitCode, classifyFailure),
    stderr: result.stderr ? failureDiagnostic(result.stderr, classifyFailure) : "" };
  writeFileSync(path, `${JSON.stringify(retained)}\n`, { flag: "wx", mode: 0o600 });
  return path;
}
