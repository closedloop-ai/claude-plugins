import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const CLAUDE_FAILURE_EVIDENCE = "VIBE_NIGHTLY_CLAUDE_FAILURE_EVIDENCE ";
const PARTIAL_REASONS = new Set(["auth_failed", "cost_ceiling", "interrupted"]);

/** The two local artifacts retained for one failed native Claude run. */
export interface ClaudeFailureEvidence {
  claudeResultPath: string;
  claudeProcessLogPath: string;
}

/** Return the native failure sentinel using only a numeric schema version or a known partial reason. */
export function claudeNativeFailure(version: unknown, partial: unknown, reason: unknown): string | null {
  if (version !== 1 || (partial !== true && partial !== false)) {
    return "eval-claude-schema:" + (Number.isSafeInteger(version) ? String(version) : "unknown");
  }
  if (partial === false) return null;
  return "eval-claude-partial:" + (typeof reason === "string" && PARTIAL_REASONS.has(reason) ? reason : "unknown");
}

/** Identify the exact native sentinels that may carry evidence and preserve their spelling. */
export function isClaudeNativeFailure(reason: string): boolean {
  const [kind, detail, extra] = reason.split(":");
  if (!detail || extra !== undefined) return false;
  if (kind === "eval-claude-schema") return detail === "unknown" || /^-?\d+$/.test(detail);
  return kind === "eval-claude-partial" && (detail === "unknown" || PARTIAL_REASONS.has(detail));
}

/** Render a paired evidence line only after both fixed output paths have been retained. */
export function retainedClaudeFailureEvidenceLine(runRoot: string): string | null {
  const root = resolve(runRoot);
  const evidence = { claudeResultPath: join(root, "claude", "result.json"),
    claudeProcessLogPath: join(root, "claude-process.log") };
  return Object.values(evidence).every(existsSync) ? CLAUDE_FAILURE_EVIDENCE + JSON.stringify(evidence) : null;
}

/** Accept a machine-log evidence line only when both files name the same absolute run directory. */
export function readClaudeFailureEvidence(line: string): ClaudeFailureEvidence | null {
  if (!line.startsWith(CLAUDE_FAILURE_EVIDENCE)) return null;
  try {
    const row = JSON.parse(line.slice(CLAUDE_FAILURE_EVIDENCE.length)) as Partial<ClaudeFailureEvidence> | null;
    if (!row || typeof row !== "object" || Object.keys(row).length !== 2) return null;
    const { claudeResultPath, claudeProcessLogPath } = row;
    if (typeof claudeResultPath !== "string" || typeof claudeProcessLogPath !== "string" ||
        !isAbsolute(claudeResultPath) || /[\x00-\x1f\x7f]/.test(claudeResultPath + claudeProcessLogPath)) return null;
    const root = dirname(dirname(claudeResultPath));
    if (claudeResultPath !== join(root, "claude", "result.json") ||
        claudeProcessLogPath !== join(root, "claude-process.log")) return null;
    return { claudeResultPath, claudeProcessLogPath };
  } catch {
    return null;
  }
}
