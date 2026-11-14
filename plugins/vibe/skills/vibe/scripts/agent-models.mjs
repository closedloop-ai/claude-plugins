// Each vibe agent's role, and the models a person chose in place of the
// defaults. Every vibe agent's model is a default (ISS-14109; operator
// rulings of 2026-11-12, "opus should be the default for code writing, sonnet for
// exploration", "the user can override the model to whatever they want" and
// "the models should be defaults, not mandatory"). Claude Code takes the
// default from the agent file's `model:` frontmatter, Codex from the role
// binding in `../../cl-sweep/scripts/model-policy.mjs`. That policy reads its
// role names and this machine's choices from here, so this module imports
// nothing from it and the Claude launcher bundle carries no Codex default.
//
// A person's overrides live in one file per machine, ~/.codex/vibe/models.json
// (VIBE_MODELS_FILE names another file), by role or by agent, per harness:
//   {"claude": {"roles": {"writer": "<model>"}, "agents": {"vibe-verify-worker": "<model>"}},
//    "codex": {"roles": {"explorer": "<model>"}}}
// One launch's own model wins over the file, an agent entry over a role entry,
// and with none the default applies. Any model name is accepted.
//
// `worker-model.mjs` is the command; this module has no entry point of its own
// because the Claude launcher bundles it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The roles a Codex worker can have; `../../cl-sweep/scripts/model-policy.mjs` binds each to a model and effort. */
export const CodexWorkerRole = Object.freeze({
  Writer: "writer",
  Operational: "operational",
  Reviewer: "reviewer",
  Verifier: "verifier",
  Explorer: "explorer",
  Mechanical: "mechanical",
});

/**
 * Each vibe agent's role. A writer edits product code; an operational worker runs setup, records, environments and
 * publication and never writes implementation code; explorers only read and search.
 */
export const VIBE_AGENT_ROLES = Object.freeze({
  "vibe-adversarial-reviewer": CodexWorkerRole.Reviewer,
  "vibe-backend-worker": CodexWorkerRole.Explorer,
  "vibe-change-worker": CodexWorkerRole.Writer,
  "vibe-consolidated-reviewer": CodexWorkerRole.Reviewer,
  "vibe-environment-worker": CodexWorkerRole.Operational,
  "vibe-guardrails-reviewer": CodexWorkerRole.Reviewer,
  "vibe-handoff-summarizer": CodexWorkerRole.Explorer,
  "vibe-primitive-worker": CodexWorkerRole.Explorer,
  "vibe-prototype-worker": CodexWorkerRole.Operational,
  "vibe-requirements-worker": CodexWorkerRole.Explorer,
  "vibe-seed-check-worker": CodexWorkerRole.Verifier,
  "vibe-seed-fix-worker": CodexWorkerRole.Writer,
  "vibe-seed-pr-worker": CodexWorkerRole.Operational,
  "vibe-setup-worker": CodexWorkerRole.Operational,
  "vibe-storybook-decomposer": CodexWorkerRole.Explorer,
  "vibe-ticket-worker": CodexWorkerRole.Operational,
  "vibe-verify-worker": CodexWorkerRole.Verifier,
});

export const ModelRuntime = Object.freeze({ Claude: "claude", Codex: "codex" });
export const ModelSource = Object.freeze({ Launch: "launch", Agent: "agent", Role: "role", Default: "default" });
export const MODELS_FILE_ENV = "VIBE_MODELS_FILE";
export const MODEL_OVERRIDES_INVALID = "MODEL_OVERRIDES_INVALID";

const RUNTIMES = Object.values(ModelRuntime);
const GROUPS = Object.freeze(["roles", "agents"]);
const ROLES = new Set(Object.values(VIBE_AGENT_ROLES));
// A model name is one argument of the harness command line, so it has no spaces and cannot read as an option.
const MODEL_NAME = /^[^\s-]\S*$/;

/** Whether `value` can be passed to a harness as a model name; no list of models is kept. */
export function isModelName(value) {
  return typeof value === "string" && MODEL_NAME.test(value);
}

/** The agent's bare name and role; an unknown agent is refused rather than given a default. */
export function agentRole(agentName) {
  const agent = typeof agentName === "string" ? agentName.replace(/^vibe:/, "") : agentName;
  const role = Object.hasOwn(VIBE_AGENT_ROLES, agent) ? VIBE_AGENT_ROLES[agent] : undefined;
  if (!role) {
    throw new Error(`Unknown vibe agent: ${agentName}`);
  }
  return { agent, role };
}

/** The file holding this machine's model overrides. */
export function modelsFile({ env = process.env, home = os.homedir() } = {}) {
  return env[MODELS_FILE_ENV] || path.join(home, ".codex", "vibe", "models.json");
}

/**
 * This machine's model overrides, `{}` when the file is absent. A file that is not JSON, or whose `roles` or `agents`
 * name something that is not a vibe role or agent or give something that is not a model name, is refused, so a
 * mistyped choice is never dropped quietly. Other keys are left alone for later releases.
 */
export function readModelOverrides(options) {
  const file = modelsFile(options);
  if (!existsSync(file)) {
    return {};
  }
  const refuse = (reason) => {
    throw Object.assign(new Error(`Model overrides in ${file} could not be read: ${reason}`), { code: MODEL_OVERRIDES_INVALID });
  };
  let overrides;
  try {
    overrides = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(overrides)) {
    refuse("it is not a JSON object");
  }
  for (const runtime of RUNTIMES.filter((name) => overrides[name] !== undefined)) {
    if (!isRecord(overrides[runtime])) {
      refuse(`${runtime} is not an object`);
    }
    for (const group of GROUPS.filter((name) => overrides[runtime][name] !== undefined)) {
      if (!isRecord(overrides[runtime][group])) {
        refuse(`${runtime}.${group} is not an object`);
      }
      for (const [key, model] of Object.entries(overrides[runtime][group])) {
        if (!(group === "roles" ? ROLES.has(key) : Object.hasOwn(VIBE_AGENT_ROLES, key))) {
          refuse(`${runtime}.${group}.${key} is not a vibe ${group === "roles" ? "role" : "agent"}`);
        }
        if (!isModelName(model)) {
          refuse(`${runtime}.${group}.${key} is not a model name`);
        }
      }
    }
  }
  return overrides;
}

/**
 * The model one agent runs on and where it came from: this launch's own model, the person's override for the agent,
 * their override for its role, else `defaultModel`.
 */
export function resolveWorkerModel(runtime, agentName, defaultModel, { launchModel, ...options } = {}) {
  const { agent, role } = agentRole(agentName);
  if (launchModel) {
    return { model: launchModel, source: ModelSource.Launch };
  }
  const chosen = readModelOverrides(options)[runtime] ?? {};
  if (Object.hasOwn(chosen.agents ?? {}, agent)) {
    return { model: chosen.agents[agent], source: ModelSource.Agent };
  }
  return resolveRoleModel(runtime, role, defaultModel, options);
}

/**
 * The model a worker of `role` runs on when no agent names it (a cl-sweep ticket owner is a Codex writer): this
 * launch's own model, the person's override for the role, else `defaultModel`.
 */
export function resolveRoleModel(runtime, role, defaultModel, { launchModel, ...options } = {}) {
  if (launchModel) {
    return { model: launchModel, source: ModelSource.Launch };
  }
  const roles = readModelOverrides(options)[runtime]?.roles ?? {};
  return Object.hasOwn(roles, role) ? { model: roles[role], source: ModelSource.Role } : { model: defaultModel, source: ModelSource.Default };
}

/** Saves (or, with no `model`, removes) the override for a role or an agent on one harness; returns the saved overrides. */
export function setModelOverride(runtime, key, model, options) {
  if (!RUNTIMES.includes(runtime)) {
    throw new Error(`Unknown harness: ${runtime}`);
  }
  const group = ROLES.has(key) ? "roles" : "agents";
  const name = group === "roles" ? key : agentRole(key).agent;
  if (model !== undefined && !isModelName(model)) {
    throw new Error("A model override must be a model name with no spaces");
  }
  const overrides = readModelOverrides(options);
  const models = { ...overrides[runtime]?.[group] };
  if (model === undefined) {
    delete models[name];
  } else {
    models[name] = model;
  }
  const saved = { ...overrides, [runtime]: { ...overrides[runtime], [group]: models } };
  const file = modelsFile(options);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(saved, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return saved;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
