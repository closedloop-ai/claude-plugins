#!/usr/bin/env node
// The model each vibe worker runs on, and the command that changes it. Codex
// spawns this plugin's agents as native subagents, so it has no frontmatter to
// read a model from; the vibe and handoff skills take every spawn's `model`
// and `reasoning_effort` from here. The Codex defaults live in
// `../../cl-sweep/scripts/model-policy.mjs`, the plugin's one Codex model
// policy, which takes the writer, operational, reviewer and verifier model
// from `../../../evals/codex/model-policy.json`. A Claude Code worker's default is the `model:` frontmatter of its
// agent file, which `scripts/dist/claude-worker.mjs` passes to
// `claude --model`. Both are defaults: `agent-models.mjs` applies the models
// this machine's person chose, by role or by agent.
//
// Usage: worker-model.mjs <claude|codex> <agent-name> [--codex <CLI>]
//        worker-model.mjs set <claude|codex> <role-or-agent> <model>
//        worker-model.mjs unset <claude|codex> <role-or-agent>
//
// The first form prints one JSON object:
//   {"agent":"vibe-requirements-worker","role":"explorer","model":"gpt-5.6-terra","reasoning_effort":"high"}
// (`reasoning_effort` on Codex only). On Codex a model that needs a newer Codex is checked against the running
// Codex's model list first (`--codex` names its CLI); when the list lacks it or cannot be read, the binding names
// the fallback model and adds `fallback_from` and a one-line `note` for the launch output. `set` and `unset`
// print the saved overrides.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { availableCodexModel, CODEX_FALLBACK_MODELS, codexBindingForRole } from "../../cl-sweep/scripts/model-policy.mjs";
import { agentRole, ModelRuntime, resolveWorkerModel, setModelOverride } from "./agent-models.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

const AGENTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../agents");
const FRONTMATTER_MODEL = /^---\n[\s\S]*?^model:[ \t]*(\S+)[ \t]*$[\s\S]*?^---/m;
const USAGE = "Usage: worker-model.mjs <claude|codex> <agent-name> [--codex <CLI>] | set <claude|codex> <role-or-agent> <model> | unset <claude|codex> <role-or-agent>";

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

/** The Codex binding after the running Codex's model list is checked; the list is read only for a model with a fallback. */
export async function availableCodexWorkerBinding(agentName, { codex, readCatalog } = {}) {
  const binding = codexWorkerBinding(agentName);
  if (!Object.hasOwn(CODEX_FALLBACK_MODELS, binding.model)) return binding;
  const read = readCatalog ?? (await import("../../cl-sweep/scripts/model-catalog.mjs")).readModelCatalog;
  const available = availableCodexModel(binding.model, await read({ codex }));
  return available.fallbackFrom ? { ...binding, model: available.model, fallback_from: available.fallbackFrom, note: available.note } : binding;
}

async function main(argv) {
  const codexFlag = argv.indexOf("--codex");
  const codex = codexFlag >= 0 ? argv[codexFlag + 1] : undefined;
  if (codexFlag >= 0 && !codex) throw new Error(USAGE);
  const [command, ...rest] = codexFlag >= 0 ? argv.filter((_, index) => index !== codexFlag && index !== codexFlag + 1) : argv;
  if ((command === "set" && rest.length === 3) || (command === "unset" && rest.length === 2)) {
    return setModelOverride(...rest);
  }
  if (command === ModelRuntime.Codex && rest.length === 1) {
    return availableCodexWorkerBinding(rest[0], { codex });
  }
  if (command === ModelRuntime.Claude && rest.length === 1) {
    return claudeWorkerBinding(rest[0]);
  }
  throw new Error(USAGE);
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`), (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
