// vibe-core's hook loader. Each entry module beside this one is the command hooks.json registers for one event;
// it calls runEvent, which finds the vibe the event's session uses (shared/vibe-install.mjs), imports that vibe's
// hooks/runtime.mjs, picks the highest hook contract both sides know, and prints what vibe's runHook returns.
// vibe's guards live in vibe, so a vibe release leaves this bundle, and Codex's approval of its hooks, unchanged;
// that approval covers this loader and not the guard code it loads.
//
// It never refuses anything and always exits 0. With no vibe for the session, a disabled one, or one that still
// registers its own hooks (1.1.70 and older), it prints nothing. When vibe's guards cannot run (a vibe it cannot
// resolve, one with no hooks/runtime.mjs, one that fails to load, serves no shared contract or throws), the action
// proceeds and the degraded notice goes to the agent as additionalContext, in the shape vibe's mergeResults prints,
// on an event in NOTICE_EVENTS; every other event proceeds silently.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ownPluginRoot } from "../shared/plugin-roots.mjs";
import { hookStandDown, VibeProblem, vibeLookup } from "../shared/vibe-install.mjs";

/** The hook contracts this vibe-core can call, oldest first (vibe's hooks/runtime.mjs CONTRACTS). */
export const SHIM_CONTRACTS = Object.freeze([1]);

/** The events whose stdout carries the degraded notice; every other event stays silent. */
export const NOTICE_EVENTS = Object.freeze(["UserPromptSubmit"]);

/** The event whose stdout is plain text (compaction instructions), so it never carries the notice. */
const PLAIN_TEXT_EVENT = "PreCompact";

/** The degraded notice for `reason` (a VibeProblem phrase). */
export function degradedNotice(reason) {
  return `vibe's safety checks couldn't load (${reason}), so they're off for now. Your work continues. To fix: run \`claude plugin update vibe@closedloop-ai\` then start a new Claude Code session, or run \`codex plugin add vibe@closedloop-ai\` then quit and reopen the Codex app.`;
}

/** The highest contract in both `ours` and `theirs`, or null when they share none. */
export function sharedContract(ours, theirs) {
  return [...ours].reverse().find((contract) => theirs.includes(contract)) ?? null;
}

/**
 * Runs hook `event` ("PreToolUse", "PostToolUse", "PreCompact", "UserPromptSubmit", "SessionStart"): reads the
 * event from `read()`, prints through `write(text)` and reports through `report(line)`. `from` locates this
 * vibe-core. Never throws or rejects, and leaves the exit code 0: it sets process.exitCode and installs a
 * process-wide uncaughtException handler, so drive it in its own process, never inside a test runner.
 */
export async function runEvent(event, { read = () => readFileSync(0, "utf8"), write = (text) => process.stdout.write(text),
  report = (line) => process.stderr.write(`${line}\n`), from = import.meta.url } = {}) {
  keepExitZero(event, report);
  // The VibeProblem an unexpected throw from here on means; null before vibe is looked up.
  let stage = null;
  try {
    const input = JSON.parse(read() || "{}");
    const cwd = typeof input?.cwd === "string" ? input.cwd : process.cwd();
    stage = VibeProblem.Unresolved;
    const lookup = vibeLookup(cwd, from);
    if (lookup.absent) return;
    if (lookup.unresolved) throw problem(lookup.unresolved);
    const { install } = lookup;
    if (hookStandDown(install, cwd)) return;
    const runtimeFile = path.join(install.root, "hooks", "runtime.mjs");
    if (!existsSync(runtimeFile)) throw problem(VibeProblem.Older);
    stage = VibeProblem.Incomplete;
    const runtime = await import(pathToFileURL(runtimeFile).href);
    const theirs = runtime.CONTRACTS;
    if (!Array.isArray(theirs) || theirs.length === 0 || !theirs.every(Number.isInteger) || typeof runtime.runHook !== "function") {
      throw problem(VibeProblem.Incomplete);
    }
    const contract = sharedContract(SHIM_CONTRACTS, theirs);
    if (contract === null) throw problem(Math.min(...theirs) > Math.max(...SHIM_CONTRACTS) ? VibeProblem.Newer : VibeProblem.Older);
    stage = VibeProblem.Failed;
    const core = ownPluginRoot(from);
    const output = await runtime.runHook({ event, input, core: { root: core.root, version: core.version, contract }, report });
    if (typeof output === "string") write(`${output}\n`);
    else if (output !== null && typeof output === "object") write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const reason = error?.vibeProblem ?? stage;
    if (reason === null) report(`vibe-core ${event}: ${errorText(error)}`);
    else if (event !== PLAIN_TEXT_EVENT && NOTICE_EVENTS.includes(event)) {
      write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: degradedNotice(reason) } })}\n`);
    }
  }
}

let exitGuarded = false;

/** A throw or rejection vibe's code leaves behind after runHook settles is reported, never turned into exit 1. */
function keepExitZero(event, report) {
  process.exitCode = 0;
  if (exitGuarded) return;
  exitGuarded = true;
  process.on("uncaughtException", (error) => {
    report(`vibe-core ${event}: ${errorText(error)}`);
    process.exitCode = 0;
  });
}

function problem(reason) {
  return Object.assign(new Error(reason), { vibeProblem: reason });
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
