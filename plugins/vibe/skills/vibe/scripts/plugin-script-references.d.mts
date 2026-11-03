export function installedPluginVersion(pluginRoot: string): string | null;
export function isVibePluginRoot(dir: string): boolean;
export function pluginScriptReferences(text: string, pluginRoot: string, worktree?: string | null): string[];
export function pluginScriptProblems(text: string, pluginRoot: string, worktree?: string | null): string[];
