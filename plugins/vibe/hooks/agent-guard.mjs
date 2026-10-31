// PreToolUse guard for Agent: Claude vibe workers and reviewers use the
// capability-binding launcher. Native dispatch skips session and graph tools.

import { deny } from "./hook-dispatch.mjs";

const VIBE_WORKER = /^vibe:vibe-[a-z0-9-]+-worker$/;
const CAPABILITY_BOUND_ADVISORS = new Set([
  "vibe:vibe-guardrails-reviewer",
  "vibe:vibe-adversarial-reviewer",
  "vibe:vibe-storybook-decomposer",
]);

/** The refusal for a direct internal vibe-worker launch, or null. */
export function agentLaunchProblem(input) {
  const subagent = input?.subagent_type;
  if (CAPABILITY_BOUND_ADVISORS.has(subagent)) {
    return `do not launch ${subagent} through the native Agent tool: use the vibe capability-binding worker launcher so available graph tools reach the reviewer`;
  }
  if (typeof subagent !== "string" || !VIBE_WORKER.test(subagent)) return null;
  return `do not launch ${subagent} through the native Agent tool: invoke \`vibe:vibe\` and use its capability-binding worker launcher so the writer gets its session record, environment setup, guardrails and adversarial review, PR preflight and SendMessage path`;
}

/** The PreToolUse result for a native vibe agent launch, or null. */
export function agentGuard(event) {
  const problem = agentLaunchProblem(event?.tool_input);
  return problem ? deny(problem) : null;
}
