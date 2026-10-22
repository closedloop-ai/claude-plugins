#!/usr/bin/env node
// PreToolUse guard for Bash in a vibe session's worktree: no foreground command
// may wait longer than 5 minutes. A Claude pane teammate reads messages only
// between turns, so writers blocked in long foreground runs kept re-asking
// questions already answered, and answers had to be sent three times. A long
// command runs in the background (`run_in_background`) and the turn ends while
// it waits.
//
// Usage (hook): reads the PreToolUse JSON on stdin; prints a deny decision or nothing.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(0, "utf8") || "{}");
    const problem = event?.tool_name === "Bash" ? foregroundProblem(event.tool_input) : null;
    if (problem && inVibeSession(typeof event.cwd === "string" ? event.cwd : process.cwd())) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: problem } })}\n`);
    }
  } catch (error) {
    process.stderr.write(`foreground-guard: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
