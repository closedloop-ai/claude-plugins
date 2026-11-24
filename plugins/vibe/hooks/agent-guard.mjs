// PreToolUse guard for Agent: Claude vibe workers and reviewers use the
// capability-binding launcher. Native dispatch skips session and graph tools.

import { deny, eventCwd } from "./hook-dispatch.mjs";
import { vibeSkillOf } from "../shared/plugin-roots.mjs";
import { vibeScriptPath, vibeSkill } from "../shared/vibe-install.mjs";
import { briefProviderProblem } from "../lib/vibe/scripts/provider-brief.mjs";
import { recordedBinding } from "../lib/vibe/scripts/provider.mjs";

// Roles are agent names qualified by either vibe plugin.
const VIBE_WORKER = /^vibe-[a-z0-9-]+-worker$/;
// Seed refresh is a Codex-owned automation; the launcher refuses seed roles by design.
const SEED_REFRESH_WORKER = /^vibe-seed-[a-z]+-worker$/;
const CAPABILITY_BOUND_ADVISORS = new Set([
  "vibe-guardrails-reviewer",
  "vibe-adversarial-reviewer",
  "vibe-storybook-decomposer",
]);
const STARTUP_ROLES = new Set(["vibe-requirements-worker", "vibe-setup-worker"]);
const TAKEOVER_REVIEWERS = new Set(["vibe-adversarial-reviewer", "vibe-guardrails-reviewer"]);
const LAUNCHER = "skills/vibe/scripts/dist/claude-worker.mjs";
const REVIEW_RECEIPTS = "skills/handoff/scripts/review-receipts.mjs";

/** The refusal for a direct internal vibe-worker launch, or null. */
export function agentLaunchProblem(input, cwd = process.cwd()) {
  const subagent = input?.subagent_type;
  const role = vibeSkillOf(subagent);
  if (CAPABILITY_BOUND_ADVISORS.has(role)) {
    const refusal = `do not launch ${subagent} through the native Agent tool: use the vibe capability-binding worker launcher so available graph tools reach the reviewer`;
    return TAKEOVER_REVIEWERS.has(role) ? `${refusal}. ${takeoverRoute(subagent, role, cwd)}` : refusal;
  }
  if (role === null || !VIBE_WORKER.test(role)) return null;
  if (SEED_REFRESH_WORKER.test(role)) {
    return `do not launch ${subagent} in Claude Code: vibe seed refresh runs in Codex (\`$vibe-seed-refresh\`), which dispatches its own seed workers; it has no Claude Code worker path`;
  }
  if (STARTUP_ROLES.has(role)) return startupRoute(subagent, role, cwd);
  return `do not launch ${subagent} through the native Agent tool: invoke \`${vibeSkill("vibe", cwd)}\` and use its capability-binding worker launcher so the writer gets its session record, environment setup, guardrails and adversarial review, PR preflight and SendMessage path`;
}

/** The PreToolUse result for a native vibe agent launch, or null. */
export function agentGuard(event, home) {
  const problem = agentLaunchProblem(event?.tool_input, eventCwd(event))
    ?? writerBindingProblem(event, home);
  return problem ? deny(problem) : null;
}

/**
 * A Claude writer started through the Agent tool (a fleet writer preamble that invokes the vibe skill) works under the
 * binding of the chat that starts it, as a Codex writer does; only a `Provider:` line naming another binding is refused.
 */
export function writerBindingProblem(event, home) {
  const prompt = event?.tool_input?.prompt;
  if (typeof prompt !== "string") return null;
  const binding = recordedBinding({ worktree: eventCwd(event), conversation: event?.session_id ?? null, ...(home ? { home } : {}) });
  const problem = briefProviderProblem(prompt, binding);
  return problem ? `${problem}; name the lead's binding on that line or drop the line` : null;
}

function launcherRequest(role, mode, sessionless, worktree) {
  return `{"worktree": "<${worktree}>", "agentName": "${role}", "mode": "${mode}", "requestId": "<id>", "input": "<brief>", "capabilities": [<every graph and tracker read you can see, as {name, service, operation, access: "read"}>], "sessionless": ${sessionless}}`;
}

function startupRoute(subagent, role, cwd) {
  return `do not launch ${subagent} through the native Agent tool, which gives it no graph or tracker tools. It needs no vibe session: run \`node ${vibeScriptPath(LAUNCHER, cwd)}\` and send this one JSON object on stdin: ${launcherRequest(role, "request", `{"kind": "startup"}`, "checkout root")}`;
}

function takeoverRoute(subagent, role, cwd) {
  return `A pull request takeover needs no vibe session: run \`node ${vibeScriptPath(LAUNCHER, cwd)}\` in the takeover worktree checked out at the PR head and send this one JSON object on stdin: ${launcherRequest(role, "pull-request", `{"kind": "takeover", "evidence": {"prUrl": "<PR URL>", "headSha": "<full head SHA>"}}`, "takeover worktree")}. Save its output and record it with \`node ${vibeScriptPath(REVIEW_RECEIPTS, cwd)} --worktree <takeover worktree> --role ${role} --result <output.json> --out <receipt.json> --pr-url <PR URL> --head <full head SHA>\``;
}
