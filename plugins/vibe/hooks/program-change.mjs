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
import { readHookSkill } from "./hook-session-scope.mjs";
import { eventCwd } from "./hook-dispatch.mjs";
import { isProviderBroken, recordedBinding, ticketReference } from "../lib/vibe/scripts/provider.mjs";
import os from "node:os";

const PROGRAM_CHANGE = [
  /\b(?:don'?t|do not) want to (?:build|look at|work on|do|ship)\b/i,
  /\bstart (?:over|again|from scratch)\b|\bfrom scratch\b/i,
  /\b(?:stop|no) build(?:ing)?\b|\bdesign only\b|\bdon'?t build\b/i,
];

const WORK_ITEM_MOVE = String.raw`\b(?:drop|abandon|forget|park|switch (?:to|from)|go back to|go back and look at|move (?:to|on to)|instead of)`;

export const PROGRAM_CHANGE_REMINDER = [
  "This operator message may change the program. If it does, record it before acting on it:",
  "1. Append the operator's words to <orchDir>/rulings.md as `- Ruling YYYY-MM-DD (operator message: <quote>): <decision>`.",
  "2. Add a <orchDir>/resume-log.md entry naming the new program and clearing pending items it settles; for a different program, close this one and `fleet-home.mjs start <slug>`.",
].join("\n");

/** The UserPromptSubmit result for a prompt: the reminder as context when it reads as a program change, or null. */
export function programChange(event, home = os.homedir()) {
  const prompt = String(event?.prompt ?? "");
  let warning = null;
  let binding = null;
  try {
    binding = recordedBinding({ worktree: eventCwd(event), conversation: event?.session_id ?? null, home });
    ticketReference(binding);
  } catch (error) {
    // A broken bound provider cannot name its tracker's references: say so, and match the generic ones.
    if (!isProviderBroken(error)) throw error;
    warning = `vibe program-change: provider-broken: ${error.message}`;
    binding = null;
  }
  const fires = PROGRAM_CHANGE.some((pattern) => pattern.test(prompt)) || leavesWorkItem(prompt, binding);
  const result = fires && (loadsSkill(readTranscript(event?.transcript_path), "fleet-orchestrator")
    || readHookSkill(event?.session_id, home) === "fleet-orchestrator") ? { context: PROGRAM_CHANGE_REMINDER } : null;
  return warning ? { ...result, systemMessage: warning } : result;
}

/** Whether the prompt moves away from or to a work item, named the way the session's tracker (`binding`) references one. */
function leavesWorkItem(prompt, binding) {
  const reference = ticketReference(binding).source;
  return new RegExp(`${WORK_ITEM_MOVE}\\s+(?:the\\s+)?(?:${reference})`, "i").test(prompt);
}
