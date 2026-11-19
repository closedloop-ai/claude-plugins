// PreToolUse guard for Bash in a vibe session's worktree: no foreground command
// may wait longer than 5 minutes. A Claude pane teammate reads messages only
// between turns, so writers blocked in long foreground runs kept re-asking
// questions already answered, and answers had to be sent three times. A long
// command runs in the background (`run_in_background`) and the turn ends while
// it waits.
//
// Runs from pre-tool-use.mjs.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { deny, eventCwd } from "./hook-dispatch.mjs";

export const MAX_FOREGROUND_MS = 5 * 60 * 1000;

/** Whether `cwd` is inside a vibe session's worktree (its git dir holds the session record). */
export function inVibeSession(cwd) {
  try {
    const gitDir = execFileSync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return existsSync(path.join(gitDir, "vibe-session.json"));
  } catch {
    return false;
  }
}

/** The deny reason for a Bash call that would wait in the foreground longer than allowed, or null. */
export function foregroundProblem(input) {
  if (input?.run_in_background === true) return null;
  const timeout = Number(input?.timeout);
  if (!Number.isFinite(timeout) || timeout <= MAX_FOREGROUND_MS) return null;
  return `a foreground command may wait at most 5 minutes in a vibe session (timeout ${timeout} ms): run it with run_in_background and end the turn while it runs, so messages reach you between turns`;
}

/** The PreToolUse result for a Bash call: a deny for a long foreground wait inside a vibe session, or null. */
export function foregroundGuard(event) {
  const problem = foregroundProblem(event?.tool_input);
  return problem && inVibeSession(eventCwd(event)) ? deny(problem) : null;
}
