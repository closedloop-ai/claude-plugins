// The vibe launcher's record of the worker sessions it started. A headless worker runs with the agent
// flag and loads no skill, so without this record vibe-core's activation check (hooks/activation.mjs)
// would treat the worker's chat as one that never activated vibe and its guards would stay silent.
// Kept apart from the hook modules so the launcher bundle needs only node builtins for it.

import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Records that the vibe launcher started worker session `sessionId` in `worktree`; returns the record's path. */
export function recordWorkerScope(sessionId, worktree, home = os.homedir(), now = new Date()) {
  const file = workerScopePath(sessionId, home);
  if (!file) throw new Error(`unusable worker session id ${JSON.stringify(sessionId)}`);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ sessionId, worktree, recordedAt: now.toISOString() })}\n`, { mode: 0o600 });
  renameSync(temp, file);
  sweep(path.dirname(file), now);
  return file;
}

/** Removes records past their 7 days, so one launch per turn does not grow the folder without bound. */
function sweep(dir, now) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now.getTime() - statSync(file).mtimeMs > MAX_AGE_MS) rmSync(file, { force: true });
    } catch {
      // Another launch removed it first.
    }
  }
}

/** Whether the vibe launcher recorded `sessionId` as a worker it started within the last 7 days. */
export function launcherWorker(sessionId, home = os.homedir(), now = new Date()) {
  const file = workerScopePath(sessionId, home);
  if (!file) return false;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false;
    const record = JSON.parse(readFileSync(file, "utf8"));
    const age = now.getTime() - Date.parse(record.recordedAt ?? "");
    return record.sessionId === sessionId && age >= 0 && age <= MAX_AGE_MS;
  } catch {
    return false;
  }
}

function workerScopePath(sessionId, home) {
  if (!SESSION.test(sessionId ?? "")) return null;
  return path.join(home, ".vibe-hook-scope", "workers", `${sessionId}.json`);
}
