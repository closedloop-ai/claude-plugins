// PreToolUse guard for Agent: an orchestrator starts a Claude vibe writer by
// invoking the vibe:vibe skill, never by dispatching one of its internal
// workers. Direct dispatch skips the session record, environment setup,
// guardrails and adversarial review, PR preflight and SendMessage.

import { inVibeSession } from "./foreground-guard.mjs";
import { deny, eventCwd } from "./hook-dispatch.mjs";

const VIBE_WORKER = /^vibe:vibe-[a-z0-9-]+-worker$/;

/** The refusal for a direct internal vibe-worker launch, or null. */
export function agentLaunchProblem(input) {
  const subagent = input?.subagent_type;
  if (typeof subagent !== "string" || !VIBE_WORKER.test(subagent)) return null;
  return `do not launch ${subagent} directly: invoke \`vibe:vibe\` in a Claude agent so the writer gets its session record, environment setup, guardrails and adversarial review, PR preflight and SendMessage path`;
}

/** The PreToolUse result for an Agent call: a deny for a direct vibe-worker launch outside a vibe session, or null. */
export function agentGuard(event) {
  const problem = agentLaunchProblem(event?.tool_input);
  return problem && !inVibeSession(eventCwd(event)) ? deny(problem) : null;
}
