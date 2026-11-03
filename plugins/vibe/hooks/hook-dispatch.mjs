// Shared by the vibe plugin's per-event hook scripts. hooks.json registers one
// command per event (pre-tool-use.mjs, user-prompt-submit.mjs); each reads stdin
// once, runs the guards routed to it, and prints the one JSON object the event's
// contract reads (code.claude.com/docs/en/hooks).
//
// A guard returns null, `{ decision, reason }` or `{ context }`. Every guard
// fails open on its own, as each did when it was a separate script: one that
// throws contributes nothing, is reported on stderr under its name, and the
// others still run. The script always exits 0.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** PreToolUse precedence when several decisions disagree: "deny > defer > ask > allow" (hooks docs, PreToolUse decision control). */
export const DECISION_PRECEDENCE = Object.freeze(["deny", "defer", "ask", "allow"]);

/** A deny result carrying `reason`. */
export function deny(reason) {
  return { decision: "deny", reason };
}

/** The working directory a hook event names, or this process's. */
export function eventCwd(event) {
  return typeof event?.cwd === "string" ? event.cwd : process.cwd();
}

/** Whether the module at `metaUrl` is the script node was started with. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(process.argv[1]).href;
}

/** The non-null results of `guards` for `event`; `report(line)` receives each throwing guard's error. */
export function runGuards(guards, event, report) {
  const results = [];
  for (const { name, run } of guards) {
    try {
      const result = run(event);
      if (result) results.push(result);
    } catch (error) {
      report(`${name}: ${errorText(error)}`);
    }
  }
  return results;
}

/**
 * One hook output for `eventName` from guard results, or null when none fired. The
 * highest-precedence decision wins and carries every reason given for it, one per
 * line in guard order; every guard's context is kept, separated by a blank line.
 */
export function mergeResults(eventName, results) {
  const decision = DECISION_PRECEDENCE.find((candidate) => results.some((result) => result.decision === candidate));
  const contexts = results.map((result) => result.context).filter((context) => typeof context === "string" && context !== "");
  if (decision === undefined && contexts.length === 0) return null;
  const output = { hookEventName: eventName };
  if (decision !== undefined) {
    output.permissionDecision = decision;
    const reasons = results.filter((result) => result.decision === decision && result.reason).map((result) => result.reason);
    if (reasons.length > 0) output.permissionDecisionReason = reasons.join("\n");
  }
  if (contexts.length > 0) output.additionalContext = contexts.join("\n\n");
  return { hookSpecificOutput: output };
}

/** Reads the event on stdin, runs `dispatch(event, report)` and prints its output; never exits nonzero. */
export function runHookScript(scriptName, dispatch) {
  const report = (line) => process.stderr.write(`${line}\n`);
  try {
    const output = dispatch(JSON.parse(readFileSync(0, "utf8") || "{}"), report);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    report(`${scriptName}: ${errorText(error)}`);
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
