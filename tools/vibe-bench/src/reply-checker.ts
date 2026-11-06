import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { evalArray as array, evalObject as object } from "./eval-collector.ts";
import type { EvalRuntimeRecord, EvalSuiteResult } from "./eval-collector.ts";

interface ReplyCheckerEntry {
  caseId: string;
  graderName: string;
  checker: string;
}

interface ReplyCheckerInstallation {
  entries: ReplyCheckerEntry[];
  version: string;
  sha256: string;
}

const DRIVER_VIBE_DIR = join(import.meta.dirname, "../../../plugins/vibe");

function checkerInstallation(vibeDir: string,
  selectedCases: string[]): ReplyCheckerInstallation {
  if (!selectedCases.includes("pm-prd-children-are-scope")) {
    return { entries: [], version: "", sha256: "" };
  }
  if (lstatSync(vibeDir).isSymbolicLink()) throw new Error("eval-checker-root-invalid");
  const evalsRoot = join(vibeDir, "evals");
  if (lstatSync(evalsRoot).isSymbolicLink()) throw new Error("eval-checker-root-invalid");
  const declaredRoot = join(vibeDir, "evals/checkers");
  if (lstatSync(declaredRoot).isSymbolicLink()) throw new Error("eval-checker-root-invalid");
  const root = realpathSync(declaredRoot);
  if (realpathSync(dirname(root)) !== realpathSync(evalsRoot)) {
    throw new Error("eval-checker-root-invalid");
  }
  const manifestPath = join(root, "manifest.json");
  if (lstatSync(manifestPath).isSymbolicLink() || realpathSync(dirname(manifestPath)) !== root) {
    throw new Error("eval-checker-manifest-invalid");
  }
  const manifestBytes = readFileSync(manifestPath);
  const manifest = object(JSON.parse(manifestBytes.toString("utf8")),
    "eval-checker-manifest-invalid");
  const values = array(manifest.entries, "eval-checker-manifest-invalid");
  if (manifest.schemaVersion !== 1) {
    throw new Error("eval-checker-manifest-invalid");
  }
  const module = join(root, "iss-13760-reply-format.mjs");
  if (lstatSync(module).isSymbolicLink() || realpathSync(dirname(module)) !== root) {
    throw new Error("eval-checker-module-invalid");
  }
  let validated: Record<string, unknown>;
  try { validated = runProtocol(module, { operation: "validate-manifest", manifest }); }
  catch { throw new Error("eval-checker-manifest-invalid"); }
  if (Object.keys(validated).join(",") !== "valid" || validated.valid !== true) {
    throw new Error("eval-checker-manifest-invalid");
  }
  const entries = values.map((value): ReplyCheckerEntry => {
    const item = object(value, "eval-checker-manifest-invalid");
    if (Object.keys(item).sort().join(",") !== "caseId,checker,graderName" ||
        typeof item.caseId !== "string" || typeof item.graderName !== "string" ||
        typeof item.checker !== "string") throw new Error("eval-checker-manifest-invalid");
    const checkerPath = join(root, item.checker);
    if (lstatSync(checkerPath).isSymbolicLink() || realpathSync(dirname(checkerPath)) !== root) {
      throw new Error("eval-checker-module-invalid");
    }
    return { caseId: item.caseId, graderName: item.graderName, checker: checkerPath };
  });
  const keys = entries.map((item) => `${item.caseId}\0${item.graderName}`);
  if (new Set(keys).size !== entries.length) throw new Error("eval-checker-manifest-invalid");
  const pluginPath = join(vibeDir, ".claude-plugin/plugin.json");
  if (lstatSync(pluginPath).isSymbolicLink()) throw new Error("eval-checker-version-invalid");
  const plugin = object(JSON.parse(readFileSync(pluginPath, "utf8")),
    "eval-checker-version-invalid");
  if (typeof plugin.version !== "string" || !/^\d+\.\d+\.\d+$/.test(plugin.version)) {
    throw new Error("eval-checker-version-invalid");
  }
  const sha256 = createHash("sha256").update(manifestBytes).update("\0")
    .update(readFileSync(module)).digest("hex");
  return { entries, version: plugin.version, sha256 };
}

function runProtocol(checker: string, input: Record<string, unknown>): Record<string, unknown> {
  const execution = spawnSync(process.execPath, [checker], {
    input: JSON.stringify(input),
    encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024,
  });
  if (execution.status !== 0 || execution.error || execution.stderr ||
      Buffer.byteLength(execution.stdout) > 16 * 1024) {
    throw new Error("eval-checker-execution-failed");
  }
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(execution.stdout), "eval-checker-output-invalid"); }
  catch { throw new Error("eval-checker-output-invalid"); }
  return value;
}

function runChecker(entry: ReplyCheckerEntry, reply: string): {
  caseId: string; graderName: string; passed: boolean; reason: string;
} {
  const value = runProtocol(entry.checker,
    { caseId: entry.caseId, graderName: entry.graderName, reply });
  if (Object.keys(value).sort().join(",") !== "caseId,graderName,passed,reason" ||
      value.caseId !== entry.caseId || value.graderName !== entry.graderName ||
      typeof value.passed !== "boolean" || typeof value.reason !== "string" || !value.reason) {
    throw new Error("eval-checker-output-invalid");
  }
  return { caseId: value.caseId, graderName: value.graderName,
    passed: value.passed, reason: value.reason };
}

/** Whether the selected suite requires the case-local deterministic checker. */
export function hasMappedReplyCheckers(selectedCases: string[]): boolean {
  return checkerInstallation(DRIVER_VIBE_DIR, selectedCases).entries.length > 0;
}

/** Validate an explicitly supplied installation for fail-closed boundary tests. */
export function validateReplyCheckerInstallation(vibeDir: string,
  selectedCases: string[]): { version: string; sha256: string } {
  const installation = checkerInstallation(vibeDir, selectedCases);
  return { version: installation.version, sha256: installation.sha256 };
}

/** Apply only the exact manifest-mapped checker verdicts to a cloned Claude aggregate. */
export function applyClaudeReplyCheckers(raw: unknown, expectedCases: string[],
  replies: Map<string, string>, driverVibeDir = DRIVER_VIBE_DIR): {
    raw: unknown; changed: boolean; overrideHash: string; provenance: string[];
    checkerVersion: string; checkerSha256: string;
  } {
  const installation = checkerInstallation(driverVibeDir, expectedCases);
  const entries = installation.entries;
  if (!entries.length) return { raw, changed: false, overrideHash: "", provenance: [],
    checkerVersion: "", checkerSha256: "" };
  const copy = structuredClone(raw);
  const root = object(copy, "eval-claude-json-invalid");
  const cases = array(root.cases, "eval-claude-cases-invalid");
  const applied = [];
  let changed = false;
  for (const entry of entries) {
    const matchingCases = cases.filter((value) =>
      object(value, "eval-claude-case-invalid").name === entry.caseId);
    if (matchingCases.length !== 1) throw new Error("eval-checker-case-mismatch");
    const caseItem = object(matchingCases[0], "eval-claude-case-invalid");
    const runs = array(object(caseItem.arms, "eval-claude-arms-invalid").with,
      "eval-claude-runs-invalid");
    const reply = replies.get(entry.caseId);
    if (!reply) throw new Error("eval-checker-reply-missing");
    for (const runValue of runs) {
      const run = object(runValue, "eval-claude-run-invalid");
      const graders = array(run.graders, "eval-claude-graders-invalid").map((value) =>
        object(value, "eval-claude-grader-invalid"));
      const matches = graders.filter((grader) => grader.name === entry.graderName);
      if (matches.length !== 1 || typeof matches[0].passed !== "boolean") {
        throw new Error("eval-checker-grader-mismatch");
      }
      const checked = runChecker(entry, reply);
      changed ||= matches[0].passed !== checked.passed;
      matches[0].passed = checked.passed;
      matches[0].explanation = `deterministic reply-format override: ${checked.reason}`;
      run.passed = graders.filter((grader) => grader.scored !== false).every((grader) =>
        grader.passed === true);
      applied.push({ caseId: checked.caseId, graderName: checked.graderName,
        passed: checked.passed, reason: checked.reason });
    }
  }
  const aggregate = object(root.aggregates, "eval-claude-aggregate-missing");
  aggregate.casesPassed = cases.filter((value) => {
    const item = object(value, "eval-claude-case-invalid");
    const runs = array(object(item.arms, "eval-claude-arms-invalid").with,
      "eval-claude-runs-invalid");
    return runs.some((run) => object(run, "eval-claude-run-invalid").passed === true);
  }).length;
  const canonical = JSON.stringify(applied);
  const overrideHash = createHash("sha256").update(canonical).digest("hex");
  return { raw: copy, changed, overrideHash,
    provenance: applied.map((item) => `${item.caseId}/${item.graderName}`),
    checkerVersion: installation.version, checkerSha256: installation.sha256 };
}

/** Bind semantic overrides to one already-validated native Claude artifact. */
export function deterministicClaudeRecord(nativeRecord: EvalRuntimeRecord,
  semantic: EvalSuiteResult, override: { overrideHash: string; provenance: string[];
    checkerVersion: string; checkerSha256: string }): EvalRuntimeRecord {
  if (nativeRecord.runtime !== "claude" || nativeRecord.invalidReason || !nativeRecord.result ||
      nativeRecord.exitCode !== (nativeRecord.result.failed === 0 ? 0 : 1) ||
      !override.overrideHash || override.provenance.length === 0 ||
      !/^\d+\.\d+\.\d+$/.test(override.checkerVersion) ||
      !/^[a-f0-9]{64}$/.test(override.checkerSha256) ||
      new Set(override.provenance).size !== override.provenance.length) {
    throw new Error("eval-checker-native-provenance-invalid");
  }
  const result: EvalSuiteResult = { ...semantic, nativeHash: nativeRecord.result.nativeHash,
    deterministicOverride: { sha256: override.overrideHash,
      graders: [...new Set(override.provenance)], checkerVersion: override.checkerVersion,
      checkerSha256: override.checkerSha256 } };
  return { runtime: "claude", exitCode: result.failed === 0 ? 0 : 1,
    result, invalidReason: null };
}
