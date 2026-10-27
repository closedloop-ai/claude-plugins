// UserPromptSubmit reminder for an orchestrator: an operator prompt that
// changes the program (no build, design only, a different PRD, start over)
// is recorded before the orchestrator acts on it. fleet-orchestrator already
// said to record every ruling in the resume log; one session took three such
// rulings in four hours and its resume log still read "Pending: operator
// ruling on how to proceed" (2026-10-22).
//
// Fires only in a session that loaded fleet-orchestrator. Runs from
// user-prompt-submit.mjs.

import { loadsSkill, readTranscript } from "./skill-transcript.mjs";

const PROGRAM_CHANGE = [
  /\b(?:don'?t|do not) want to (?:build|look at|work on|do|ship)\b/i,
  /\bstart (?:over|again|from scratch)\b|\bfrom scratch\b/i,
  /\b(?:drop|abandon|forget|park|switch (?:to|from)|go back to|go back and look at|move (?:to|on to)|instead of)\s+(?:the\s+)?(?:PRD|ISS|PLN)-\d+/i,
  /\b(?:stop|no) build(?:ing)?\b|\bdesign only\b|\bdon'?t build\b/i,
];

export const PROGRAM_CHANGE_REMINDER = [
  "This operator message may change the program. If it does, record it before acting on it:",
  "1. Append the operator's words to <orchDir>/rulings.md as `- Ruling YYYY-MM-DD (operator message: <quote>): <decision>`.",
  "2. Add a <orchDir>/resume-log.md entry naming the new program and clearing pending items it settles; for a different program, close this one and `fleet-home.mjs start <slug>`.",
].join("\n");

/** The UserPromptSubmit result for a prompt: the reminder as context when it reads as a program change, or null. */
export function programChange(event) {
  const prompt = String(event?.prompt ?? "");
  if (!PROGRAM_CHANGE.some((pattern) => pattern.test(prompt))) return null;
  return loadsSkill(readTranscript(event?.transcript_path), "fleet-orchestrator") ? { context: PROGRAM_CHANGE_REMINDER } : null;
}
