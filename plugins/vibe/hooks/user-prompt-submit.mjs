#!/usr/bin/env node
// The vibe plugin's only UserPromptSubmit hook. Every prompt runs these guards in
// this one process; their context merges as hook-dispatch.mjs describes. A new
// UserPromptSubmit guard is a module added here, never another hooks.json command.
//
// Usage (hook): reads the UserPromptSubmit JSON on stdin; prints additional context or nothing.

import { awayProtocol } from "./away-protocol.mjs";
import { isMain, mergeResults, runGuards, runHookScript } from "./hook-dispatch.mjs";

/** The guards every prompt runs, in order. */
export const USER_PROMPT_SUBMIT_GUARDS = Object.freeze([{ name: "away-protocol", run: awayProtocol }]);

/** The UserPromptSubmit output for `event`, or null; `report(line)` receives each failing guard's error. */
export function userPromptSubmit(event, report) {
  return mergeResults("UserPromptSubmit", runGuards(USER_PROMPT_SUBMIT_GUARDS, event, report));
}

if (isMain(import.meta.url)) runHookScript("user-prompt-submit", userPromptSubmit);
