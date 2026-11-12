#!/usr/bin/env node
// The model each vibe worker runs on, and the command that changes it. Codex
// spawns this plugin's agents as native subagents, so it has no frontmatter to
// read a model from; the vibe and handoff skills take every spawn's `model`
// and `reasoning_effort` from here. The Codex defaults live in
// `../../cl-sweep/scripts/model-policy.mjs`, the plugin's one Codex model
// policy. A Claude Code worker's default is the `model:` frontmatter of its
// agent file, which `scripts/dist/claude-worker.mjs` passes to
// `claude --model`. Both are defaults: `agent-models.mjs` applies the models
// this machine's person chose, by role or by agent.
//
// Usage: worker-model.mjs <claude|codex> <agent-name>
//        worker-model.mjs set <claude|codex> <role-or-agent> <model>
//        worker-model.mjs unset <claude|codex> <role-or-agent>
//
// The first form prints one JSON object:
//   {"agent":"vibe-requirements-worker","role":"explorer","model":"gpt-5.6-terra","reasoning_effort":"high"}
// (`reasoning_effort` on Codex only). `set` and `unset` print the saved overrides.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codexBindingForRole } from "../../cl-sweep/scripts/model-policy.mjs";
import { agentRole, ModelRuntime, resolveWorkerModel, setModelOverride } from "./agent-models.mjs";

const AGENTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../agents");
const FRONTMATTER_MODEL = /^---\n[\s\S]*?^model:[ \t]*(\S+)[ \t]*$[\s\S]*?^---/m;
const USAGE = "Usage: worker-model.mjs <claude|codex> <agent-name> | set <claude|codex> <role-or-agent> <model> | unset <claude|codex> <role-or-agent>";

/** The native Codex spawn binding for one vibe agent; an unknown agent is refused rather than given a default. */
export function codexWorkerBinding(agentName, options) {
  const { agent, role } = agentRole(agentName);
  const { model, reasoningEffort } = codexBindingForRole(role);
  return { agent, role, model: resolveWorkerModel(ModelRuntime.Codex, agent, model, options).model, reasoning_effort: reasoningEffort };
}

/** The model the Claude launcher starts one vibe agent on: the person's override, else the agent file's `model:`. */
export function claudeWorkerBinding(agentName, options) {
  const { agent, role } = agentRole(agentName);
  const model = FRONTMATTER_MODEL.exec(readFileSync(path.join(AGENTS, `${agent}.md`), "utf8"))?.[1];
  if (!model) {
    throw new Error(`${agent} declares no model`);
  }
  return { agent, role, model: resolveWorkerModel(ModelRuntime.Claude, agent, model, options).model };
}

function main(argv) {
  const [command, ...rest] = argv;
  if ((command === "set" && rest.length === 3) || (command === "unset" && rest.length === 2)) {
    return setModelOverride(...rest);
  }
  if (command === ModelRuntime.Codex && rest.length === 1) {
    return codexWorkerBinding(rest[0]);
  }
  if (command === ModelRuntime.Claude && rest.length === 1) {
    return claudeWorkerBinding(rest[0]);
  }
  throw new Error(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
