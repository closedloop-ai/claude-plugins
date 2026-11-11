/** The GitHub repository a git remote URL names, shared by the cloud worker, the PR-create guard and vibe's PR facts. */
const GITHUB_URL = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** `owner/repo` from an HTTPS or SSH github.com remote URL, or null. */
export function githubRepository(url) {
  return GITHUB_URL.exec(String(url ?? "").trim())?.[1] ?? null;
}
