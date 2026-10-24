#!/usr/bin/env node
// PreToolUse guard for SendMessage: a hold is TaskStop, not a message. A vibe
// session was told HOLD twice (2026-10-23) and kept its writer running: a
// message reaches a busy agent only at its next tool round, and never reaches
// the subagents it started. Repo memory already said so; the orchestrator
// skipped it. A message that opens with hold, pause or stop is refused unless
// it says the agent was already stopped with TaskStop.
//
// Usage (hook): reads the PreToolUse JSON on stdin; prints a deny decision or nothing.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HOLD = /^\s*(?:hold|pause|stop)\b/i;

/** The refusal for a hold sent as a message, or null. */
export function holdMessageProblem(input) {
  const message = input?.message;
  if (typeof message !== "string" || !HOLD.test(message) || message.includes("TaskStop")) return null;
  return "a hold is not a message: a busy agent reads it only at its next tool round and its subagents never see it. Stop it with TaskStop, check no process it started is left under its worktree, then message it (say it was stopped with TaskStop)";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(0, "utf8") || "{}");
    const problem = event?.tool_name === "SendMessage" ? holdMessageProblem(event.tool_input) : null;
    if (problem) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: problem } })}\n`);
    }
  } catch (error) {
    process.stderr.write(`pause-guard: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
