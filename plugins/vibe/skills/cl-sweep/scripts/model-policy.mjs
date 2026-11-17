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
// the evals, the vibe workers and cl-sweep cannot name different models. The
// same file names the model a planning or review lane takes when cl-analyze
// graded the ticket's complexity HIGH (`codexHighComplexityReviewModel`), and
// the model each of those two falls back to when the running Codex does not
// list it (`codexFallbackModels`; the list is read by `model-catalog.mjs`).
//
// Usage: model-policy.mjs lane <role> [--complexity <LOW|MEDIUM|HIGH>] [--codex <CLI>]
// prints the binding for a cl-execute or cl-sweep support lane, after checking
// that the running Codex lists the model: {"role","model","reasoning_effort"}
// and, when it fell back, "fallback_from" and "note".

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isEntryPoint } from '../../../shared/plugin-roots.mjs';
import { CodexWorkerRole, ModelRuntime, resolveRoleModel } from '../../vibe/scripts/agent-models.mjs';

const POLICY_FILE = new URL('../../../evals/codex/model-policy.json', import.meta.url);

const POLICY_MODEL_NAME = /^gpt-[a-z0-9.-]+$/;

/**
 * The models named by the policy file. A file that is missing, unreadable, names no default or high-complexity model,
 * or names a fallback that is not another model is refused; no model is built in. A model with no fallback is never
 * checked against the running Codex's list.
 */
function readPolicy() {
  let policy;
  try {
    policy = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`eval-codex-model-policy-invalid: ${error.message}`);
  }
  const { codexModel, codexHighComplexityReviewModel, codexFallbackModels = {} } = policy ?? {};
  for (const [key, value] of [['codexModel', codexModel], ['codexHighComplexityReviewModel', codexHighComplexityReviewModel]]) {
    if (typeof value !== 'string' || !POLICY_MODEL_NAME.test(value)) {
      throw new Error(`eval-codex-model-policy-invalid: ${key} is missing or is not a model name`);
    }
  }
  if (!codexFallbackModels || typeof codexFallbackModels !== 'object' || Array.isArray(codexFallbackModels)) {
    throw new Error('eval-codex-model-policy-invalid: codexFallbackModels is not a map of model names');
  }
  for (const [model, fallback] of Object.entries(codexFallbackModels)) {
    if (!POLICY_MODEL_NAME.test(model) || typeof fallback !== 'string' || !POLICY_MODEL_NAME.test(fallback) || fallback === model) {
      throw new Error(`eval-codex-model-policy-invalid: codexFallbackModels gives ${model} no other model`);
    }
  }
  return { codexModel, codexHighComplexityReviewModel, fallbacks: Object.freeze({ ...codexFallbackModels }) };
}

const POLICY = readPolicy();

export const TICKET_OWNER_MODEL = POLICY.codexModel;
/** The planning and review lane model when cl-analyze graded the ticket's complexity HIGH. */
export const HIGH_COMPLEXITY_REVIEW_MODEL = POLICY.codexHighComplexityReviewModel;
/** Each model that needs a Codex new enough to list it, and the model used when the running Codex does not. */
export const CODEX_FALLBACK_MODELS = POLICY.fallbacks;
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
  // A session that fell back keeps the model it was chosen for, so it is not replaced at every idle boundary.
  return (session.requestedModelFallbackFrom ?? session.requestedModel) !== ticketOwnerModel();
}

/** A saved session's fallback record: absent, or the chosen model whose fallback is the saved model. */
export function validateModelFallback(session) {
  if (session.requestedModelFallbackFrom === undefined) return;
  const from = session.requestedModelFallbackFrom;
  if (!Object.hasOwn(CODEX_FALLBACK_MODELS, from) || CODEX_FALLBACK_MODELS[from] !== session.requestedModel) {
    throw new Error('requestedModelFallbackFrom must name the model whose fallback is requestedModel');
  }
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

/** cl-analyze's complexity grades, as its result's `Complexity:` line writes them. */
export const Complexity = Object.freeze({ Low: 'LOW', Medium: 'MEDIUM', High: 'HIGH' });

/**
 * The model a Codex worker starts on, given the model chosen for it and the running Codex's model list
 * (`model-catalog.mjs`: `{ models }`, or `{ error }` when it could not be read). A chosen model that has a fallback
 * runs only when the list names it; when the list lacks it or could not be read, the worker runs on the fallback and
 * `note` says so once for the launch output. A model with no fallback is never checked.
 */
export function availableCodexModel(model, catalog) {
  const fallback = Object.hasOwn(CODEX_FALLBACK_MODELS, model) ? CODEX_FALLBACK_MODELS[model] : undefined;
  const listed = Array.isArray(catalog?.models);
  if (!fallback || (listed && catalog.models.includes(model))) return { model, fallbackFrom: null, note: null };
  const note = listed
    ? `${model} is not in this Codex's model list, so this worker runs on ${fallback}.`
    : `This Codex's model list could not be read (${catalog?.error ?? 'no list'}), so this worker runs on ${fallback} instead of ${model}.`;
  return { model: fallback, fallbackFrom: model, note };
}

/**
 * The model a cl-execute or cl-sweep planning or review lane starts on before the list is checked: the
 * high-complexity model for a reviewer lane when cl-analyze graded the ticket HIGH, else the role's default; a
 * Codex model this machine's person chose for the role wins over either. No grade (a vibe session's workers) is
 * the role's default. A grade other than LOW, MEDIUM or HIGH is refused.
 */
export function laneModel(role, { complexity, ...options } = {}) {
  if (complexity !== undefined && !Object.values(Complexity).includes(complexity)) {
    throw new Error(`--complexity must be one of ${Object.values(Complexity).join(', ')}`);
  }
  const { model, reasoningEffort } = codexBindingForRole(role);
  const chosen = role === CodexWorkerRole.Reviewer && complexity === Complexity.High ? HIGH_COMPLEXITY_REVIEW_MODEL : model;
  return { model: resolveRoleModel(ModelRuntime.Codex, role, chosen, options).model, reasoningEffort };
}

/** The Codex model and reasoning effort for a role; an unknown role is refused, never defaulted. */
export function codexBindingForRole(role) {
  const binding = Object.hasOwn(CODEX_ROLE_BINDINGS, role) ? CODEX_ROLE_BINDINGS[role] : undefined;
  if (!binding) throw new Error(`Unknown Codex worker role: ${role}`);
  return binding;
}

async function main(argv) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    complexity: { type: 'string' }, codex: { type: 'string' },
  } });
  const [command, role, ...rest] = positionals;
  if (command !== 'lane' || !role || rest.length) {
    throw new Error('Usage: model-policy.mjs lane <role> [--complexity <LOW|MEDIUM|HIGH>] [--codex <CLI>]');
  }
  const { model, reasoningEffort } = laneModel(role, { complexity: values.complexity });
  const { readModelCatalog } = await import('./model-catalog.mjs');
  const available = availableCodexModel(model, await readModelCatalog({ codex: values.codex }));
  return {
    role, model: available.model, reasoning_effort: reasoningEffort,
    ...(available.fallbackFrom ? { fallback_from: available.fallbackFrom, note: available.note } : {}),
  };
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`), (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
