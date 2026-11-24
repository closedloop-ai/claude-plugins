// The launcher's caps on a finished worker turn: a result over its size limits, and a turn stopped by its time cap.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const SUMMARY_LIMIT = 4096;
const RESULT_LIMIT = 16 * 1024;
const TRUNCATED = " [truncated by the launcher]";
const DATA_DROPPED = " [data dropped by the launcher: over 16 KB; see the trace]";

/**
 * The launcher caps a result instead of rejecting it after the turn. A result
 * rejected for length left its request open, and the writer refused the next
 * request until a continuation nobody sent.
 */
export function capWorkerResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...(value as Record<string, unknown>) };
  const clip = (summary: string, suffix: string) => summary.length + suffix.length <= SUMMARY_LIMIT ? `${summary}${suffix}`
    : `${summary.slice(0, SUMMARY_LIMIT - suffix.length)}${suffix}`;
  if (typeof result.summary === "string" && result.summary.length > SUMMARY_LIMIT) result.summary = clip(result.summary, TRUNCATED);
  const originalBytes = JSON.stringify(result).length;
  if (originalBytes > RESULT_LIMIT && "data" in result) {
    result.status = "BLOCKED";
    result.data = { launcher: { code: "WORKER_DATA_TOO_LARGE", originalBytes } };
    if (typeof result.summary === "string") result.summary = clip(result.summary, DATA_DROPPED);
  }
  return result;
}

export type CapCheckpoint = { dirtyFiles: number; midMerge: boolean; patch?: string };

/**
 * A writer turn that hits its time cap leaves its edits uncommitted, twice
 * mid-merge, with no report (vibe-13007, 2026-10-23). Before the turn is
 * released, record what it left and save tracked changes as a patch in the
 * git dir; nothing is committed, reset or discarded.
 */
export function capCheckpoint(root: string, gitDir: string, turnId: string): CapCheckpoint | undefined {
  try {
    const run = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"] });
    const dirtyFiles = run(["status", "--porcelain"]).split("\n").filter(Boolean).length;
    const midMerge = existsSync(join(gitDir, "MERGE_HEAD"));
    const diff = run(["diff", "--binary", "HEAD"]);
    if (!diff) return { dirtyFiles, midMerge };
    const patch = join(gitDir, `vibe-cap-${turnId}.patch`);
    writeFileSync(patch, diff, { mode: 0o600, flag: "wx" });
    return { dirtyFiles, midMerge, patch };
  } catch { return undefined; }
}
