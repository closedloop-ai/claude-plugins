import { isLocalPlanPath, knownLocalPlanPrefixes, sessionLocalPlanPrefix } from "../../../plugins/vibe/skills/vibe/scripts/local-plans.mjs";
import { sessionBinding } from "../../../plugins/vibe-core/lib/vibe/scripts/provider.mjs";

const prefixes = new Map<string, string | null>();
const knownPrefixes = new Map<string, string[]>();

/**
 * The session at `root`'s in-worktree local plan folder (`local-plans.mjs`: the provider's artifact root, or null
 * when the plans live in the git directory), read once per root for the life of the process.
 */
export function planPrefixOf(root: string): string | null {
  if (!prefixes.has(root)) prefixes.set(root, sessionLocalPlanPrefix(root));
  return prefixes.get(root) ?? null;
}

/**
 * Every in-worktree plan folder known in this repository (`knownLocalPlanPrefixes`: the bound provider's and any
 * installed provider's), read once per root, so a plan written while bound stays private when the session is not.
 */
export function planPrefixesOf(root: string): string[] {
  if (!knownPrefixes.has(root)) knownPrefixes.set(root, knownLocalPlanPrefixes(sessionBinding(root)));
  return knownPrefixes.get(root) ?? [];
}

/** Whether `file`, relative to `root`, is in any in-worktree local plan folder known in this repository. */
export function isPlanFile(root: string, file: string): boolean {
  return planPrefixesOf(root).some((prefix) => isLocalPlanPath(file, prefix));
}

/** The in-worktree private artifact root (the plan folder's parent), or null. */
export function artifactRootOf(root: string): string | null {
  const prefix = planPrefixOf(root);
  return prefix ? prefix.slice(0, prefix.slice(0, -1).lastIndexOf("/") + 1) : null;
}
