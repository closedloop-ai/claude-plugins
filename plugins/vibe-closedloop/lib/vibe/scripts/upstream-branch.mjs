import { execFileSync } from "node:child_process";

/**
 * The remote branch name `branch` is set to push to on `remote` (`branch.<name>.merge` under
 * `branch.<name>.remote`), or null when it tracks no branch there.
 */
export function upstreamBranchName(worktree, branch, remote = "origin") {
  const config = (key) => execFileSync("git", ["-C", worktree, "config", "--get", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (!branch || config(`branch.${branch}.remote`) !== remote) return null;
    const merge = config(`branch.${branch}.merge`);
    return merge.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : null;
  } catch {
    return null;
  }
}
