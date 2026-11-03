/** Exact extension-independent private plan namespace shared by all publication owners. */
export function isLocalPlanPath(filePath: string): boolean;
export const LOCAL_PLAN_PREFIX: string;
export function committedLocalPlans(runGit: (args: string[]) => string): string[];
