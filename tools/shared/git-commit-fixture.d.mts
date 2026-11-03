export function ensureGitCommit(repo: string, sha: string, remote?: string): string;
export function ensureGitCommits(repo: string, shas: readonly string[], remote?: string): string[];
export function archiveGitFixture(repo: string, sha: string, paths: readonly string[],
  destination: string): void;
