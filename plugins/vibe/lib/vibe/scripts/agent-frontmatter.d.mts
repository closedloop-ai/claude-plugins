/** Leading YAML metadata and the prompt body of a canonical agent definition. */
export function agentFrontmatter(source: string): { metadata: Record<string, unknown>; prompt: string };

/** Top-level YAML name of a repository agent definition used for role registration. */
export function agentFrontmatterName(source: string): string;
