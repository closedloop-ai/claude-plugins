// Fills in what the corpus selector needs about a merged change from a local
// clone: the merge-base parent, the changed files with line counts, and which
// of them are tests. Squash-merged pull requests are one commit, so the first
// parent of the merge commit is the tree the human started from.

import { execFileSync } from "node:child_process";

export const TEST_FILE = /\.test\.|\.spec\.|\/__tests__\/|\/test\/|\.harness\./;
const MAX_BUFFER = 64 * 1024 * 1024;

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** `{mergeBaseSha, files: [{path, additions, deletions}], testFiles}` for `mergeSha`; throws when the commit is not in `repo`. */
export function enrichFromGit({ repo, mergeSha }) {
  const mergeBaseSha = git(repo, ["rev-parse", `${mergeSha}^`]);
  const files = git(repo, ["diff", "--numstat", "--no-renames", mergeBaseSha, mergeSha])
    .split("\n").filter(Boolean).map((line) => {
      const [added, deleted, ...rest] = line.split("\t");
      return { path: rest.join("\t"), additions: Number(added) || 0, deletions: Number(deleted) || 0 };
    });
  const deleted = new Set(git(repo, ["diff", "--name-only", "--diff-filter=D", "--no-renames", mergeBaseSha, mergeSha]).split("\n").filter(Boolean));
  return { mergeBaseSha, files, testFiles: files.map((file) => file.path).filter((file) => TEST_FILE.test(file) && !deleted.has(file)) };
}
