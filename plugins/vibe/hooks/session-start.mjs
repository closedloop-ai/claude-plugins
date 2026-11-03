#!/usr/bin/env node
// The vibe plugin's only SessionStart hook. Every session start runs these
// guards in this one process; their context merges as hook-dispatch.mjs
// describes. A new SessionStart guard is a module added here, never another
// hooks.json command.
//
// Usage (hook): reads the SessionStart JSON on stdin; prints additional context or nothing.

import { fleetResume } from "./fleet-resume.mjs";
import { isMain, mergeResults, runGuards, runHookScript } from "./hook-dispatch.mjs";

/** The guards every session start runs, in order. */
export const SESSION_START_GUARDS = Object.freeze([{ name: "fleet-resume", run: fleetResume }]);

/** The SessionStart output for `event`, or null; `report(line)` receives each failing guard's error. */
export function sessionStart(event, report) {
  return mergeResults("SessionStart", runGuards(SESSION_START_GUARDS, event, report));
}

if (isMain(import.meta.url)) runHookScript("session-start", sessionStart);
