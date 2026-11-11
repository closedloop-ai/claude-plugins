// PreToolUse guard for Agent: Claude vibe workers and reviewers use the
// capability-binding launcher. Native dispatch skips session and graph tools.

import { deny, eventCwd } from "./hook-dispatch.mjs";
import { vibeScriptPath } from "../shared/vibe-install.mjs";
import { briefProviderProblem } from "../lib/vibe/scripts/provider-brief.mjs";
import { recordedBinding } from "../lib/vibe/scripts/provider.mjs";

const VIBE_WORKER = /^vibe:vibe-[a-z0-9-]+-worker$/;
// Seed refresh is a Codex-owned automation; the launcher refuses seed roles by design.
const SEED_REFRESH_WORKER = /^vibe:vibe-seed-[a-z]+-worker$/;
const CAPABILITY_BOUND_ADVISORS = new Set([
  "vibe:vibe-guardrails-reviewer",
  "vibe:vibe-adversarial-reviewer",
  "vibe:vibe-storybook-decomposer",
]);
const STARTUP_ROLES = new Set(["vibe:vibe-requirements-worker", "vibe:vibe-setup-worker"]);
const TAKEOVER_REVIEWERS = new Set(["vibe:vibe-adversarial-reviewer", "vibe:vibe-guardrails-reviewer"]);
const LAUNCHER = "skills/vibe/scripts/dist/claude-worker.mjs";
const REVIEW_RECEIPTS = "skills/handoff/scripts/review-receipts.mjs";

/** The refusal for a direct internal vibe-worker launch, or null. */
export function agentLaunchProblem(input, cwd = process.cwd()) {
  const subagent = input?.subagent_type;
  if (CAPABILITY_BOUND_ADVISORS.has(subagent)) {
    const refusal = `do not launch ${subagent} through the native Agent tool: use the vibe capability-binding worker launcher so available graph tools reach the reviewer`;
    return TAKEOVER_REVIEWERS.has(subagent) ? `${refusal}. ${takeoverRoute(subagent, cwd)}` : refusal;
  }
  if (typeof subagent !== "string" || !VIBE_WORKER.test(subagent)) return null;
  if (SEED_REFRESH_WORKER.test(subagent)) {
    return `do not launch ${subagent} in Claude Code: vibe seed refresh runs in Codex (\`$vibe-seed-refresh\`), which dispatches its own seed workers; it has no Claude Code worker path`;
  }
  if (STARTUP_ROLES.has(subagent)) return startupRoute(subagent, cwd);
  return `do not launch ${subagent} through the native Agent tool: invoke \`vibe:vibe\` and use its capability-binding worker launcher so the writer gets its session record, environment setup, guardrails and adversarial review, PR preflight and SendMessage path`;
}

/** The PreToolUse result for a native vibe agent launch, or null. */
export function agentGuard(event, home) {
  const problem = agentLaunchProblem(event?.tool_input, eventCwd(event))
    ?? writerBindingProblem(event, home);
  return problem ? deny(problem) : null;
}

/**
 * A Claude writer started through the Agent tool (a fleet writer preamble that invokes vibe:vibe) carries the
 * binding of the chat that starts it, so it works under the lead's provider, as a Codex writer does.
 */
export function writerBindingProblem(event, home) {
  const prompt = event?.tool_input?.prompt;
  if (typeof prompt !== "string") return null;
  const binding = recordedBinding({ worktree: eventCwd(event), conversation: event?.session_id ?? null, ...(home ? { home } : {}) });
  const problem = briefProviderProblem(prompt, binding);
  return problem ? `${problem}; add that line to the writer's brief` : null;
}

function launcherRequest(subagent, mode, sessionless, worktree) {
  return `{"worktree": "<${worktree}>", "agentName": "${subagent.slice("vibe:".length)}", "mode": "${mode}", "requestId": "<id>", "input": "<brief>", "capabilities": [<every graph and tracker read you can see, as {name, service, operation, access: "read"}>], "sessionless": ${sessionless}}`;
}

function startupRoute(subagent, cwd) {
  return `do not launch ${subagent} through the native Agent tool, which gives it no graph or tracker tools. It needs no vibe session: run \`node ${vibeScriptPath(LAUNCHER, cwd)}\` and send this one JSON object on stdin: ${launcherRequest(subagent, "request", `{"kind": "startup"}`, "checkout root")}`;
}

function takeoverRoute(subagent, cwd) {
  return `A pull request takeover needs no vibe session: run \`node ${vibeScriptPath(LAUNCHER, cwd)}\` in the takeover worktree checked out at the PR head and send this one JSON object on stdin: ${launcherRequest(subagent, "pull-request", `{"kind": "takeover", "evidence": {"prUrl": "<PR URL>", "headSha": "<full head SHA>"}}`, "takeover worktree")}. Save its output and record it with \`node ${vibeScriptPath(REVIEW_RECEIPTS, cwd)} --worktree <takeover worktree> --role ${subagent.slice("vibe:".length)} --result <output.json> --out <receipt.json> --pr-url <PR URL> --head <full head SHA>\``;
}
