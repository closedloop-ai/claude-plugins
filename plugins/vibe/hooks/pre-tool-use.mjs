#!/usr/bin/env node
// The vibe plugin's only PreToolUse hook. Each tool call is routed by tool_name
// to its guards, which run in this one process; their results merge as
// hook-dispatch.mjs describes. A new PreToolUse guard is a module added to a
// route here, never another hooks.json command.
//
// Usage (hook): reads the PreToolUse JSON on stdin; prints one decision or context object, or nothing.

import { agentGuard } from "./agent-guard.mjs";
import { foregroundGuard } from "./foreground-guard.mjs";
import { isMain, mergeResults, runGuards, runHookScript } from "./hook-dispatch.mjs";
import { killGuard } from "./kill-guard.mjs";
import { mergeGuard } from "./merge-guard.mjs";
import { pauseGuard } from "./pause-guard.mjs";
import { pluginVersionGuard, pluginVersionSkillStart } from "./plugin-version-guard.mjs";
import { QUESTION_TOOLS, questionGuard } from "./question-guard.mjs";
import { shellSafetyGuard } from "./shell-safety-guard.mjs";

/** The guards each tool runs, in order; hooks.json's PreToolUse matcher names exactly these tools. */
export const PRE_TOOL_USE_ROUTES = Object.freeze({
  Bash: Object.freeze([
    { name: "kill-guard", run: killGuard },
    { name: "foreground-guard", run: foregroundGuard },
    { name: "merge-guard", run: mergeGuard },
    { name: "shell-safety-guard", run: shellSafetyGuard },
    { name: "plugin-version-guard", run: pluginVersionGuard },
  ]),
  Agent: Object.freeze([
    { name: "agent-guard", run: agentGuard },
    { name: "plugin-version-guard", run: pluginVersionGuard },
  ]),
  SendMessage: Object.freeze([{ name: "pause-guard", run: pauseGuard }]),
  Skill: Object.freeze([{ name: "plugin-version-start", run: pluginVersionSkillStart }]),
  ...Object.fromEntries(QUESTION_TOOLS.map((tool) => [tool, Object.freeze([{ name: "question-guard", run: questionGuard }])])),
});

/** The PreToolUse output for `event`, or null; `report(line)` receives each failing guard's error. */
export function preToolUse(event, report) {
  const tool = event?.tool_name;
  const guards = typeof tool === "string" && Object.hasOwn(PRE_TOOL_USE_ROUTES, tool) ? PRE_TOOL_USE_ROUTES[tool] : [];
  return mergeResults("PreToolUse", runGuards(guards, event, report));
}

if (isMain(import.meta.url)) runHookScript("pre-tool-use", preToolUse);
