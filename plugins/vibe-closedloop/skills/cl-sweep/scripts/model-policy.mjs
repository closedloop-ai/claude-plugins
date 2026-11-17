// The one Codex model and reasoning-effort policy for every worker the vibe
// plugin starts on Codex: cl-sweep ticket owners, cl-execute and cl-sweep
// support lanes, and the vibe skill's own native workers
// (`../../vibe/scripts/worker-model.mjs`). Claude Code workers take their
// default model from each agent file's `model:` frontmatter instead. These
// are defaults a person can override (`../../vibe/scripts/agent-models.mjs`).
//
// The default for ticket owners and for writer, operational, reviewer and
// verifier workers is not written here: it is `codexModel` in
// `../../../evals/codex/model-policy.json`, the file the evals also read, so
// the evals, the vibe workers and cl-sweep cannot name different models.

import { readFileSync } from 'node:fs';
import { CodexWorkerRole, ModelRuntime, resolveRoleModel } from '../../vibe/scripts/agent-models.mjs';

const POLICY_FILE = new URL('../../../evals/codex/model-policy.json', import.meta.url);

/** The default named by the policy file. A file that is missing, unreadable or names no model is refused; no model is built in. */
function policyModel() {
  let codexModel;
  try {
    ({ codexModel } = JSON.parse(readFileSync(POLICY_FILE, 'utf8')));
  } catch (error) {
    throw new Error(`eval-codex-model-policy-invalid: ${error.message}`);
  }
  if (typeof codexModel !== 'string' || !/^gpt-[a-z0-9.-]+$/.test(codexModel)) {
    throw new Error('eval-codex-model-policy-invalid: codexModel is missing or is not a model name');
  }
  return codexModel;
}

export const TICKET_OWNER_MODEL = policyModel();
export const EXPLORER_MODEL = 'gpt-5.6-terra';
export const MECHANICAL_SUPPORT_MODEL = 'gpt-6-luna';

// New Codex workers start at high. xhigh stays available, but only when a
// caller raises it explicitly (for example `--reasoning-effort xhigh`).
export const DEFAULT_REASONING_EFFORT = 'high';
export const MECHANICAL_SUPPORT_REASONING_EFFORT = 'low';

/** Role to Codex binding. Operational covers setup, record, environment and publication workers that write no product code. Explorer covers codebase exploration, graph lookups, requirements or precedent research and read-only search. */
export const CODEX_ROLE_BINDINGS = Object.freeze({
  [CodexWorkerRole.Writer]: Object.freeze({ model: TICKET_OWNER_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT }),
  [CodexWorkerRole.Operational]: Object.freeze({ model: TICKET_OWNER_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT }),
  [CodexWorkerRole.Reviewer]: Object.freeze({ model: TICKET_OWNER_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT }),
  [CodexWorkerRole.Verifier]: Object.freeze({ model: TICKET_OWNER_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT }),
  [CodexWorkerRole.Explorer]: Object.freeze({ model: EXPLORER_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT }),
  [CodexWorkerRole.Mechanical]: Object.freeze({
    model: MECHANICAL_SUPPORT_MODEL,
    reasoningEffort: MECHANICAL_SUPPORT_REASONING_EFFORT,
  }),
});

/** A model name every cl-sweep transport can pass on a command line and store; anything else is refused. */
export function validateModelName(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    throw new Error(`${label} must be a compact model identifier`);
  }
  return value;
}

/**
 * The model a new ticket-owner session starts on: this launch's own model, the Codex writer model this machine's
 * person chose, else the default.
 */
export function ticketOwnerModel(options) {
  return resolveRoleModel(ModelRuntime.Codex, CodexWorkerRole.Writer, TICKET_OWNER_MODEL, options).model;
}

/**
 * Whether a saved ticket-owner session must be replaced at its next idle boundary before another turn: its saved model
 * is not the model that resolves for it. A model explicitly requested when the session was started
 * (`requestedModelExplicit: true`, written only then) resolves to itself; any other session, including every session
 * saved before that marker existed, resolves to this machine's Codex writer model, else the default. A saved session
 * is never refused for its model; it finishes its active turn on it. Both ticket-owner session scripts ask this one
 * function; the generic orchestrator has no replacement rule.
 */
export function ticketOwnerNeedsReplacement(session) {
  if (session.requestedModelExplicit === true) return false;
  return session.requestedModel !== ticketOwnerModel();
}

/** Refuses a new turn on a saved session that must first be replaced at its idle boundary. */
export function assertNoReplacementNeeded(session) {
  if (ticketOwnerNeedsReplacement(session)) {
    throw new Error(`Persisted ${session.requestedModel} worker requires idle-boundary replacement with a new ${ticketOwnerModel()} session before another turn`);
  }
}

/**
 * The `status` fields for a saved session's model: `modelReplacement` when it must be replaced at idle, and
 * `modelReplacementError` when this machine's model could not be resolved (status still answers).
 */
export function ticketOwnerReplacementStatus(session, idleCandidate) {
  try {
    return {
      modelReplacement: ticketOwnerNeedsReplacement(session)
        ? { targetModel: ticketOwnerModel(), requiredBeforeNextTurn: true, idleCandidate }
        : null,
      modelReplacementError: null,
    };
  } catch (error) {
    return { modelReplacement: null, modelReplacementError: error.message };
  }
}

/** The Codex model and reasoning effort for a role; an unknown role is refused, never defaulted. */
export function codexBindingForRole(role) {
  const binding = Object.hasOwn(CODEX_ROLE_BINDINGS, role) ? CODEX_ROLE_BINDINGS[role] : undefined;
  if (!binding) throw new Error(`Unknown Codex worker role: ${role}`);
  return binding;
}
