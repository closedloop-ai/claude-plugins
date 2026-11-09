#!/usr/bin/env node
// The vibe plugin's only PostToolUse hook. Every tool call runs these guards in
// this one process; their output merges as hook-dispatch.mjs describes. A new
// PostToolUse guard is a module added here, never another hooks.json command.
//
// Usage (hook): reads the PostToolUse JSON on stdin; prints a notice or nothing.

import { contextGuard } from "./context-guard.mjs";
import { isMain, mergeResults, runGuards, runHookScript } from "./hook-dispatch.mjs";

/** The guards every tool call runs after it finishes, in order. */
export const POST_TOOL_USE_GUARDS = Object.freeze([{ name: "context-guard", run: contextGuard }]);

/** The PostToolUse output for `event`, or null; `report(line)` receives each failing guard's error. */
function postToolUse(event, report) {
  return mergeResults("PostToolUse", runGuards(POST_TOOL_USE_GUARDS, event, report));
}

if (isMain(import.meta.url)) runHookScript("post-tool-use", postToolUse);
