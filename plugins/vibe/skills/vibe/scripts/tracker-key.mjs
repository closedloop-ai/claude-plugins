// The bound tracker's ticket key, for the scripts that read or check a live tracker ticket. They run only in a
// session a tracker provider is bound to; without one a key matches nothing, so no text reads as a ticket.

import { vibeCore } from "../../../shared/vibe-core.mjs";

const { providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");

const NO_KEY = "(?!)";

/** The unanchored ticket key source (`data.tickets.keyPattern`) of the session at `worktree`, or this conversation's. */
export function trackerKey(worktree = null) {
  return providerDataOr(sessionBinding(worktree), "tickets", "keyPattern", NO_KEY);
}

/** The bound tracker's issue key (`data.tickets.issueKey`, unanchored; issues only, not plans or requirements). */
export function issueKey(worktree = null) {
  return providerDataOr(sessionBinding(worktree), "tickets", "issueKey", NO_KEY);
}

/** The bound tracker's requirements document key (`data.tickets.requirementsKey`, unanchored). */
export function requirementsKey(worktree = null) {
  return providerDataOr(sessionBinding(worktree), "tickets", "requirementsKey", NO_KEY);
}

/** Whether a tracker is bound to the session at `worktree` (or this conversation). */
export function trackerBound(worktree = null) {
  return providerDataOr(sessionBinding(worktree), "tickets", "keyPattern", null) !== null;
}

/**
 * A work item reference, anchored: the bound tracker's ticket key, or with no tracker a GitHub issue or pull
 * request number (`#123`).
 */
export function workItem(worktree = null) {
  const key = providerDataOr(sessionBinding(worktree), "tickets", "keyPattern", null);
  return new RegExp(`^(?:${key ?? "#\\d+"})$`);
}
