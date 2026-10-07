import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Executes bounded git reads and operations for the session's exact worktree. */
export function git(cwd, args) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Resolves the private record shared by vibe and handoff, never tracked files. */
function recordPath(worktree) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "vibe-session.json");
}

/** Reads the persisted record without adding surface-specific defaults. */
export function readSessionRecord(worktree) {
  const file = recordPath(worktree);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** Keeps Desktop bridge URLs and all ownership data readable only by the owner. */
export function writeSessionRecord(worktree, record) {
  const file = recordPath(worktree);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
