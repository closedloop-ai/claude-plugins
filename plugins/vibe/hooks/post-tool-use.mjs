#!/usr/bin/env node
// The vibe plugin's only PostToolUse hook. Each finished tool call is routed by
// tool_name to its guards in this one process (hook-dispatch.mjs). A new
// PostToolUse guard is a module added to a route here, never another hooks.json
// command.
//
// Usage (hook): reads the PostToolUse JSON on stdin; prints nothing.

import { isMain, mergeResults, runGuards, runHookScript } from "./hook-dispatch.mjs";
import { telemetryLaunch } from "./telemetry-launch.mjs";

/** The guards each tool runs, in order; hooks.json's PostToolUse matcher names exactly these tools. */
export const POST_TOOL_USE_ROUTES = Object.freeze({
  Agent: Object.freeze([{ name: "telemetry-launch", run: telemetryLaunch }]),
});

/** The PostToolUse output for `event`, or null; `report(line)` receives each failing guard's error. */
export function postToolUse(event, report) {
  const tool = event?.tool_name;
  const guards = typeof tool === "string" && Object.hasOwn(POST_TOOL_USE_ROUTES, tool) ? POST_TOOL_USE_ROUTES[tool] : [];
  return mergeResults("PostToolUse", runGuards(guards, event, report));
}

if (isMain(import.meta.url)) runHookScript("post-tool-use", postToolUse);
