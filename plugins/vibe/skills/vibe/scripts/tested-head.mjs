// Every test result names the commit it actually ran. A worker's container
// runs once tested an old commit for about an hour: a leftover modified file
// made each checkout in that worktree fail, the runs went on at the old head,
// and "23/23 passed" was reported for a pull request that was never tested.
// So a run starts only when the worktree's HEAD is the commit it means to
// test and no tracked file is modified, and its result carries that HEAD.

import { git } from "./session-record.mjs";

/** The full HEAD of `worktree` when it is `intended` (a full or abbreviated SHA) with no modified tracked file; throws otherwise. */
export function testedHead(worktree, intended) {
  if (!/^[0-9a-f]{7,40}$/i.test(intended ?? "")) throw new Error("name the commit to test as a SHA (--head <sha>)");
  const head = git(worktree, ["rev-parse", "HEAD"]);
  if (!head.startsWith(intended.toLowerCase())) {
    throw new Error(`HEAD-MISMATCH the worktree is at ${head.slice(0, 12)}, not ${intended}: check out the commit to test (a failed checkout leaves the old one)`);
  }
  const dirty = git(worktree, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    throw new Error(`DIRTY-WORKTREE modified tracked files would make the run test something other than ${head.slice(0, 12)}: ${dirty.split("\n").map((line) => line.replace(/^\s*\S+\s+/, "")).join(", ")}`);
  }
  return head;
}
