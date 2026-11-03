// The one Codex model and reasoning-effort policy for every worker the vibe
// plugin starts on Codex: cl-sweep ticket owners, cl-execute and cl-sweep
// support lanes, and the vibe skill's own native workers
// (`../../vibe/scripts/worker-model.mjs`). Claude Code workers take their
// model from each agent file's `model:` frontmatter instead.

export const TICKET_OWNER_MODEL = 'gpt-6-sol';
export const LEGACY_UNVERSIONED_MODEL = 'gpt-5.5';
export const EXPLORER_MODEL = 'gpt-5.6-terra';
export const MECHANICAL_SUPPORT_MODEL = 'gpt-6-luna';

// New Codex workers start at high. xhigh stays available, but only when a
// caller raises it explicitly (for example `--reasoning-effort xhigh`).
export const DEFAULT_REASONING_EFFORT = 'high';
export const MECHANICAL_SUPPORT_REASONING_EFFORT = 'low';

export const CodexWorkerRole = Object.freeze({
  Writer: 'writer',
  Reviewer: 'reviewer',
  Verifier: 'verifier',
  Explorer: 'explorer',
  Mechanical: 'mechanical',
});

/** Role to Codex binding. Explorer covers codebase exploration, graph lookups, requirements or precedent research and read-only search. */
export const CODEX_ROLE_BINDINGS = Object.freeze({
  [CodexWorkerRole.Writer]: Object.freeze({ model: TICKET_OWNER_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT }),
  [CodexWorkerRole.Reviewer]: Object.freeze({ model: TICKET_OWNER_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT }),
  [CodexWorkerRole.Verifier]: Object.freeze({ model: TICKET_OWNER_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT }),
  [CodexWorkerRole.Explorer]: Object.freeze({ model: EXPLORER_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT }),
  [CodexWorkerRole.Mechanical]: Object.freeze({
    model: MECHANICAL_SUPPORT_MODEL,
    reasoningEffort: MECHANICAL_SUPPORT_REASONING_EFFORT,
  }),
});

export function isLegacyTicketOwnerModel(model) {
  return model === LEGACY_UNVERSIONED_MODEL
    || (typeof model === 'string' && /^gpt-5\.6-[a-z][a-z0-9-]*$/.test(model));
}

/** The Codex model and reasoning effort for a role; an unknown role is refused, never defaulted. */
export function codexBindingForRole(role) {
  const binding = Object.hasOwn(CODEX_ROLE_BINDINGS, role) ? CODEX_ROLE_BINDINGS[role] : undefined;
  if (!binding) throw new Error(`Unknown Codex worker role: ${role}`);
  return binding;
}
