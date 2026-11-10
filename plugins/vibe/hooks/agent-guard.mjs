// PreToolUse guard for Agent: Claude vibe workers and reviewers use the
// capability-binding launcher. Native dispatch skips session and graph tools.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { deny } from "./hook-dispatch.mjs";

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
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(PLUGIN_ROOT, "skills", "vibe", "scripts", "dist", "claude-worker.mjs");
const REVIEW_RECEIPTS = path.join(PLUGIN_ROOT, "skills", "handoff", "scripts", "review-receipts.mjs");

/** The refusal for a direct internal vibe-worker launch, or null. */
export function agentLaunchProblem(input) {
  const subagent = input?.subagent_type;
  if (CAPABILITY_BOUND_ADVISORS.has(subagent)) {
    const refusal = `do not launch ${subagent} through the native Agent tool: use the vibe capability-binding worker launcher so available graph tools reach the reviewer`;
    return TAKEOVER_REVIEWERS.has(subagent) ? `${refusal}. ${takeoverRoute(subagent)}` : refusal;
  }
  if (typeof subagent !== "string" || !VIBE_WORKER.test(subagent)) return null;
  if (SEED_REFRESH_WORKER.test(subagent)) {
    return `do not launch ${subagent} in Claude Code: vibe seed refresh runs in Codex (\`$vibe-seed-refresh\`), which dispatches its own seed workers; it has no Claude Code worker path`;
  }
  if (STARTUP_ROLES.has(subagent)) return startupRoute(subagent);
  return `do not launch ${subagent} through the native Agent tool: invoke \`vibe:vibe\` and use its capability-binding worker launcher so the writer gets its session record, environment setup, guardrails and adversarial review, PR preflight and SendMessage path`;
}

/** The PreToolUse result for a native vibe agent launch, or null. */
export function agentGuard(event) {
  const problem = agentLaunchProblem(event?.tool_input);
  return problem ? deny(problem) : null;
}

function launcherRequest(subagent, mode, sessionless, worktree) {
  return `{"worktree": "<${worktree}>", "agentName": "${subagent.slice("vibe:".length)}", "mode": "${mode}", "requestId": "<id>", "input": "<brief>", "capabilities": [<every closedloop-graph and ClosedLoop read you can see, as {name, service, operation, access: "read"}>], "sessionless": ${sessionless}}`;
}

function startupRoute(subagent) {
  return `do not launch ${subagent} through the native Agent tool, which gives it no graph or ClosedLoop tools. It needs no vibe session: run \`node ${LAUNCHER}\` and send this one JSON object on stdin: ${launcherRequest(subagent, "request", `{"kind": "startup"}`, "checkout root")}`;
}

function takeoverRoute(subagent) {
  return `A pull request takeover needs no vibe session: run \`node ${LAUNCHER}\` in the takeover worktree checked out at the PR head and send this one JSON object on stdin: ${launcherRequest(subagent, "pull-request", `{"kind": "takeover", "evidence": {"prUrl": "<PR URL>", "headSha": "<full head SHA>"}}`, "takeover worktree")}. Save its output and record it with \`node ${REVIEW_RECEIPTS} --worktree <takeover worktree> --role ${subagent.slice("vibe:".length)} --result <output.json> --out <receipt.json> --pr-url <PR URL> --head <full head SHA>\``;
}
