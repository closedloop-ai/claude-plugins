#!/usr/bin/env node
// The vibe plugin's only UserPromptSubmit hook. Every prompt runs these guards in
// this one process; their context merges as hook-dispatch.mjs describes. A new
// UserPromptSubmit guard is a module added here, never another hooks.json command.
//
// Usage (hook): reads the UserPromptSubmit JSON on stdin; prints additional context or nothing.

import { chatProgramDir, defaultHome } from "../lib/fleet-orchestrator/scripts/fleet-home.mjs";
import { chatBinding, currentProgram, validChat } from "../lib/fleet-orchestrator/scripts/chat-binding.mjs";
import { takeSleepNotices } from "../lib/codex-fleet-monitor/scripts/watch-gap.mjs";
import { conversationSkill } from "./hook-session-scope.mjs";
import { awayProtocol } from "./away-protocol.mjs";
import { mergeResults, runGuards, runHookScript } from "./hook-dispatch.mjs";
import { pluginVersionPromptStart } from "./plugin-version-guard.mjs";
import { programChange } from "./program-change.mjs";
import { isEntryPoint } from "../shared/plugin-roots.mjs";

/** Only the orchestrator for this program can claim its pending sleep notices. */
function watcherSleep(event) {
  const chat = validChat(event?.session_id);
  if (!chat) return null;
  const home = defaultHome(process.env, chat);
  const explicit = process.env.FLEET_HOME || chatBinding(chat);
  let selectedDir = null;
  try {
    const resolved = chatProgramDir(home, chat);
    if (explicit || resolved.program) selectedDir = resolved.dir;
  } catch {
    // A selected program held by another chat cannot fall back to the private queue.
    if (explicit || currentProgram(home)) return null;
  }
  return takeSleepNotices(selectedDir, chat, () => conversationSkill(event) === "fleet-orchestrator", event);
}

/** The guards every prompt runs, in order. */
export const USER_PROMPT_SUBMIT_GUARDS = Object.freeze([
  { name: "away-protocol", run: awayProtocol, activated: true },
  { name: "plugin-version-start", run: pluginVersionPromptStart },
  { name: "program-change", run: programChange },
  { name: "watcher-sleep", run: watcherSleep },
]);

/** The UserPromptSubmit output for `event`, or null; `report(line)` receives each failing guard's error. */
export function userPromptSubmit(event, report, afterOutput) {
  // Older loaders cannot acknowledge a write. Leave their notices queued for a capable prompt.
  const guards = afterOutput ? USER_PROMPT_SUBMIT_GUARDS : USER_PROMPT_SUBMIT_GUARDS.filter(guard => guard.run !== watcherSleep);
  const results = runGuards(guards, event, report);
  const receipt = results.find(result => result.settle);
  if (receipt) afterOutput(receipt.settle);
  return mergeResults("UserPromptSubmit", results);
}

if (isEntryPoint(import.meta.url)) runHookScript("user-prompt-submit", userPromptSubmit);
