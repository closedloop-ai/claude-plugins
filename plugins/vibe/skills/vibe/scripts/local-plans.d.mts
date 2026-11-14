/** The in-worktree local plan folder a binding's provider recipe names, or null when the plans live in the git directory. */
export function localPlanPrefix(binding: unknown): string | null;
/** The session at `worktree`'s in-worktree local plan folder, or null. */
export function sessionLocalPlanPrefix(worktree: string): string | null;
/** Whether `filePath` is in the in-worktree local plan folder `prefix`; never with no such folder. */
export function isLocalPlanPath(filePath: string, prefix: string | null): boolean;
/** Plans already present in HEAD under `prefix`; none without one. */
export function committedLocalPlans(runGit: (args: string[]) => string, prefix: string | null): string[];
/** The session's plan folder, plan file and decision table, as absolute paths. */
export function localPlanPaths(worktree: string, options?: { requestId?: string | null; binding?: unknown }): {
  root: string; plans: string; plan?: string; decisionTable: string; inWorktree: boolean;
};
/** Every in-worktree plan folder of the bound provider or of any provider installed here. */
export function knownLocalPlanPrefixes(binding: unknown): string[];
