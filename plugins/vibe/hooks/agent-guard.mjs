#!/usr/bin/env node
// PreToolUse guard for Agent: an orchestrator starts a Claude vibe writer by
// invoking the vibe:vibe skill, never by dispatching one of its internal
// workers. Direct dispatch skips the session record, environment setup,
// guardrails and adversarial review, PR preflight and SendMessage.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inVibeSession } from "./foreground-guard.mjs";

const VIBE_WORKER = /^vibe:vibe-[a-z0-9-]+-worker$/;

/** The refusal for a direct internal vibe-worker launch, or null. */
export function agentLaunchProblem(input) {
  const subagent = input?.subagent_type;
  if (typeof subagent !== "string" || !VIBE_WORKER.test(subagent)) return null;
  return `do not launch ${subagent} directly: invoke \`vibe:vibe\` in a Claude agent so the writer gets its session record, environment setup, guardrails and adversarial review, PR preflight and SendMessage path`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(0, "utf8") || "{}");
    const problem = event?.tool_name === "Agent" ? agentLaunchProblem(event.tool_input) : null;
    const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
    if (problem && !inVibeSession(cwd)) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: problem } })}\n`);
    }
  } catch (error) {
    process.stderr.write(`agent-guard: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
