// Shared by vibe's per-event hook modules. vibe-core's hooks.json registers one
// command per event; vibe-core's loader hands each event to runtime.mjs here, which
// runs the guards routed to it and returns the one JSON object the event's contract
// reads (code.claude.com/docs/en/hooks). Started directly, an entry module reads stdin
// itself through runHookScript.
//
// A guard returns null, `{ decision, reason }` or `{ context }`, optionally with
// `systemMessage` (a line the harness shows the user). Every guard
// fails open on its own, as each did when it was a separate script: one that
// throws contributes nothing, is reported on stderr under its name, and the
// others still run. A guard that throws because its bound provider is broken is the
// exception: the person sees the reason and fix, and a guard whose `guards(event)`
// names this event refuses it rather than relax to its generic default. The script
// always exits 0.

import { readFileSync } from "node:fs";
import { isProviderBroken } from "../lib/vibe/scripts/provider.mjs";
import { activated } from "./activation.mjs";

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

/**
 * The non-null results of `guards` for `event`; `report(line)` receives each throwing guard's error.
 * A guard with `activated: true` runs only in a chat that activated vibe (activation.mjs); that is
 * decided once, the first time such a guard comes up, by `isActivated(event)`.
 */
export function runGuards(guards, event, report, isActivated = activated) {
  const results = [];
  let active;
  for (const { name, run, activated: gated, guards: guardsEvent } of guards) {
    try {
      if (gated) {
        active ??= isActivated(event) === true;
        if (!active) continue;
      }
      const result = run(event);
      if (result) results.push(result);
    } catch (error) {
      if (isProviderBroken(error)) results.push(providerBrokenResult(name, error, guardsEvent, event));
      else report(`${name}: ${errorText(error)}`);
    }
  }
  return results;
}

/**
 * A guard whose bound provider is broken: one line for the person with the reason and fix, and, when the guard's
 * `guardsEvent(event)` says this event is the action it guards, a deny, since its generic default would relax the
 * bound rule it cannot read. Any other guard falls back to its generic default, which is doing nothing here.
 */
function providerBrokenResult(name, error, guardsEvent, event) {
  const systemMessage = `vibe ${name}: provider-broken: ${error.message}`;
  let refuse = false;
  try { refuse = guardsEvent?.(event) === true; } catch { refuse = true; }
  return refuse ? { decision: "deny", reason: `${name} cannot read its bound provider rule, so it refuses this action: ${error.message}`, systemMessage }
    : { systemMessage };
}

/**
 * One hook output for `eventName` from guard results, or null when none fired. The
 * highest-precedence decision wins and carries every reason given for it, one per
 * line in guard order; every guard's context is kept, separated by a blank line.
 */
export function mergeResults(eventName, results) {
  const decision = DECISION_PRECEDENCE.find((candidate) => results.some((result) => result.decision === candidate));
  const contexts = results.map((result) => result.context).filter((context) => typeof context === "string" && context !== "");
  const messages = results.map((result) => result.systemMessage).filter((message) => typeof message === "string" && message !== "");
  if (decision === undefined && contexts.length === 0 && messages.length === 0) return null;
  const output = { hookEventName: eventName };
  if (decision !== undefined) {
    output.permissionDecision = decision;
    const reasons = results.filter((result) => result.decision === decision && result.reason).map((result) => result.reason);
    if (reasons.length > 0) output.permissionDecisionReason = reasons.join("\n");
  }
  if (contexts.length > 0) output.additionalContext = contexts.join("\n\n");
  return messages.length > 0 ? { systemMessage: messages.join("\n"), hookSpecificOutput: output } : { hookSpecificOutput: output };
}

/**
 * Reads the event on stdin, runs `dispatch(event, report)` and prints its output, a string as plain
 * text (a PreCompact hook's stdout is the compaction instructions) and anything else as JSON; never exits nonzero.
 * Whether the guards run at all (vibe installed, enabled, new enough) is vibe-core's loader's decision.
 */
export function runHookScript(scriptName, dispatch) {
  const report = (line) => process.stderr.write(`${line}\n`);
  let settle;
  try {
    const event = JSON.parse(readFileSync(0, "utf8") || "{}");
    const output = dispatch(event, report, callback => { settle = callback; });
    if (output) {
      const text = typeof output === "string" ? output : JSON.stringify(output);
      process.stdout.write(`${text}\n`, error => settle?.(!error));
    } else settle?.(false);
  } catch (error) {
    settle?.(false);
    report(`${scriptName}: ${errorText(error)}`);
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
