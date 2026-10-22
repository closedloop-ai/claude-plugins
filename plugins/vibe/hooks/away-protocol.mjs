#!/usr/bin/env node
// UserPromptSubmit hook: when the operator says they are stepping away or are
// back, put the fleet-orchestrator away or return checklist into context. An
// orchestrator once answered "stepping away. brb." with a friendly summary
// and ran none of the away protocol, though its skill required it.
//
// Usage (hook): reads the UserPromptSubmit JSON on stdin; prints the checklist as
// additional context, or nothing.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const AWAY = /\b(?:brb|be right back|afk|stepping away|step(?:ping)? out|going to bed|off to bed|heading (?:out|off|to bed|home)|signing off|back in (?:\d+|a (?:few|bit|while)|an hour|a minute|ten|twenty|thirty)\b)/i;
const BACK = /(?:^|[.!?]\s*)(?:i'?m back|i am back|back now|back again|ok(?:ay)?,? back)\b|^\s*back[.!]*\s*$/i;

export const AWAY_CHECKLIST = [
  "The operator is stepping away. If you orchestrate a fleet (fleet-orchestrator), run the away protocol now, before anything else:",
  "1. Write <orchDir>/attention.md: each decision needed with your recommendation, and what is blocked.",
  "2. Keep the watcher armed (watcher.mjs prints `watcher ok`) and start a recurring schedule every 20 to 30 minutes (loop or cron) that reads every teammate message, answers or applies defaults, and runs `board.mjs <orchDir> status`.",
  "3. Keep reading idle writers' last messages and keep attention.md current until they return.",
].join("\n");

export const BACK_CHECKLIST = [
  "The operator is back. If you orchestrate a fleet (fleet-orchestrator):",
  "1. Lead your reply with <orchDir>/attention.md: decisions needed, recommendations, what is blocked.",
  "2. Delete the away schedule you started (loop or cron), keeping the watcher armed.",
].join("\n");

/** The checklist an operator prompt calls for, or null. */
export function checklistFor(prompt) {
  const text = String(prompt ?? "");
  if (BACK.test(text)) return BACK_CHECKLIST;
  if (AWAY.test(text)) return AWAY_CHECKLIST;
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(0, "utf8") || "{}");
    const checklist = checklistFor(event?.prompt);
    if (checklist) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: checklist } })}\n`);
    }
  } catch (error) {
    process.stderr.write(`away-protocol: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
