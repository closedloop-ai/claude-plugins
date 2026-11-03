#!/usr/bin/env node
// The Codex model and reasoning effort for each vibe worker. Codex spawns this
// plugin's agents as native subagents, so it has no frontmatter to read a
// model from; the vibe and handoff skills take every spawn's `model` and
// `reasoning_effort` from here. The bindings themselves live in
// `../../cl-sweep/scripts/model-policy.mjs`, the plugin's one Codex model
// policy. Claude Code workers keep the `model:` frontmatter of their agent
// file, which `scripts/dist/claude-worker.mjs` passes to `claude --model`.
//
// Usage: worker-model.mjs codex <agent-name>
//
// Prints one JSON object:
//   {"agent":"vibe-requirements-worker","role":"explorer","model":"gpt-5.6-terra","reasoning_effort":"high"}

import path from "node:path";
import { pathToFileURL } from "node:url";
import { CodexWorkerRole, codexBindingForRole } from "../../cl-sweep/scripts/model-policy.mjs";

/** Each vibe agent's role. Explorers only read and search; everything that writes, reviews or verifies keeps the writer model. */
export const VIBE_AGENT_ROLES = Object.freeze({
  "vibe-adversarial-reviewer": CodexWorkerRole.Reviewer,
  "vibe-backend-worker": CodexWorkerRole.Explorer,
  "vibe-change-worker": CodexWorkerRole.Writer,
  "vibe-environment-worker": CodexWorkerRole.Writer,
  "vibe-guardrails-reviewer": CodexWorkerRole.Reviewer,
  "vibe-handoff-summarizer": CodexWorkerRole.Explorer,
  "vibe-primitive-worker": CodexWorkerRole.Explorer,
  "vibe-prototype-worker": CodexWorkerRole.Writer,
  "vibe-requirements-worker": CodexWorkerRole.Explorer,
  "vibe-seed-check-worker": CodexWorkerRole.Verifier,
  "vibe-seed-fix-worker": CodexWorkerRole.Writer,
  "vibe-seed-pr-worker": CodexWorkerRole.Writer,
  "vibe-setup-worker": CodexWorkerRole.Writer,
  "vibe-storybook-decomposer": CodexWorkerRole.Explorer,
  "vibe-ticket-worker": CodexWorkerRole.Writer,
  "vibe-verify-worker": CodexWorkerRole.Verifier,
});

/** The native Codex spawn binding for one vibe agent; an unknown agent is refused rather than given a default. */
export function codexWorkerBinding(agentName) {
  const name = agentName?.replace(/^vibe:/, "");
  const role = Object.hasOwn(VIBE_AGENT_ROLES, name) ? VIBE_AGENT_ROLES[name] : undefined;
  if (!role) {
    throw new Error(`Unknown vibe agent: ${agentName}`);
  }
  const { model, reasoningEffort } = codexBindingForRole(role);
  return { agent: name, role, model, reasoning_effort: reasoningEffort };
}

function main(argv) {
  const [runtime, agentName] = argv;
  if (runtime !== "codex" || !agentName) {
    throw new Error("Usage: worker-model.mjs codex <agent-name>");
  }
  process.stdout.write(`${JSON.stringify(codexWorkerBinding(agentName))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
