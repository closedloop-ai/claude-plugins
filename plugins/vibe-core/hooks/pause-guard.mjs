// PreToolUse reminder for SendMessage: a hold is TaskStop, not a message. A vibe
// session was told HOLD twice (2026-10-23) and kept its writer running: a
// message reaches a busy agent only at its next tool round, and never reaches
// the subagents it started. Repo memory already said so; the orchestrator
// skipped it. A message that asks the recipient to pause or hold itself gets a
// TaskStop reminder in context; the message still goes. Ordinary freeze
// instructions ("push nothing more", "stop the investigation and report") are
// not pauses and get nothing.
//
// Runs from pre-tool-use.mjs.

/** Each pattern is a request that the recipient pause or hold itself. */
export const HOLD_PATTERNS = Object.freeze([
  /^\s*(?:HOLD|PAUSE)\b/,
  /\b(?:pause|hold|freeze)\s+(?:all\s+)?(?:of\s+)?(?:your\s+)?(?:work|writers?|sessions?|everything|agents?|subagents?|turns?)\b/i,
  /\bstop\s+(?:all\s+)?(?:of\s+)?(?:your\s+)?(?:writers?|sessions?|everything|agents?|subagents?|all\s+work)\b/i,
  /\bstand\s+down\b/i,
]);

export const TASKSTOP_REMINDER = "This message asks an agent to pause or hold. A busy agent reads it only at its next tool round, and its subagents never see it: stop it with TaskStop, then check that nothing it started still runs under its worktree.";

/** The TaskStop reminder for a message asking its recipient to pause or hold itself, or null. */
export function holdReminder(input) {
  const message = input?.message;
  if (typeof message !== "string" || message.includes("TaskStop")) return null;
  return HOLD_PATTERNS.some((pattern) => pattern.test(message)) ? TASKSTOP_REMINDER : null;
}

/** The PreToolUse result for a SendMessage call: the TaskStop reminder as context, or null. It never refuses. */
export function pauseGuard(event) {
  const reminder = holdReminder(event?.tool_input);
  return reminder ? { context: reminder } : null;
}
