import { isLocalPlanPath, sessionLocalPlanPrefix } from "../../../plugins/vibe/skills/vibe/scripts/local-plans.mjs";

const prefixes = new Map<string, string | null>();

/**
 * The session at `root`'s in-worktree local plan folder (`local-plans.mjs`: the provider's artifact root, or null
 * when the plans live in the git directory), read once per root for the life of the process.
 */
export function planPrefixOf(root: string): string | null {
  if (!prefixes.has(root)) prefixes.set(root, sessionLocalPlanPrefix(root));
  return prefixes.get(root) ?? null;
}

/** Whether `file`, relative to `root`, is in that session's in-worktree local plan folder. */
export function isPlanFile(root: string, file: string): boolean {
  return isLocalPlanPath(file, planPrefixOf(root));
}

/** The in-worktree private artifact root (the plan folder's parent), or null. */
export function artifactRootOf(root: string): string | null {
  const prefix = planPrefixOf(root);
  return prefix ? prefix.slice(0, prefix.slice(0, -1).lastIndexOf("/") + 1) : null;
}
