// Replay workspaces (M2). `prepareClone` builds the checkout every run of one
// ticket copies: a clone at the human change's merge-base parent in which the
// merge commit, the pull request's branch and every other ref are unreachable,
// so an arm cannot read the answer from git. The human change's test files are
// saved apart as the scoring oracle. `copyForRun` gives one run its own copy.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_BUFFER = 64 * 1024 * 1024;

function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], ...options });
}

/**
 * `ticket.pr` needs `mergeSha`, `mergeBaseSha` and `testFiles`. Writes the oracle
 * to `<oracleDir>/files/<path>` (the human version of each test file) and returns
 * `{workspace, oracleDir, testFiles}`. Refuses when the merge commit is still reachable.
 */
export function prepareClone({ sourceRepo, ticket, workspace, oracleDir }) {
  const { mergeSha, mergeBaseSha, testFiles = [] } = ticket.pr;
  if (!mergeSha || !mergeBaseSha) throw new Error(`${ticket.slug}: pr.mergeSha and pr.mergeBaseSha are required.`);
  for (const dir of [workspace, oracleDir]) {
    if (existsSync(dir)) throw new Error(`${dir} already exists.`);
  }
  for (const file of testFiles) {
    const target = path.join(oracleDir, "files", file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, git(sourceRepo, ["show", `${mergeSha}:${file}`]));
  }
  writeFileSync(path.join(oracleDir, "test-files.json"), `${JSON.stringify(testFiles, null, 2)}\n`);
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", sourceRepo, workspace], { stdio: "ignore" });
  git(workspace, ["checkout", "--quiet", "-B", "replay", mergeBaseSha]);
  git(workspace, ["remote", "remove", "origin"]);
  const refs = git(workspace, ["for-each-ref", "--format=%(refname)"]).split("\n").filter((ref) => ref && ref !== "refs/heads/replay");
  if (refs.length > 0) git(workspace, ["update-ref", "--stdin"], { input: refs.map((ref) => `delete ${ref}\n`).join("") });
  git(workspace, ["reflog", "expire", "--expire=now", "--all"]);
  git(workspace, ["gc", "--quiet", "--prune=now"]);
  if (reachable(workspace, mergeSha)) throw new Error(`${ticket.slug}: the merge commit is still reachable in ${workspace}; the replay would leak the answer.`);
  return { workspace, oracleDir, testFiles };
}

/** Copies the prepared clone for one run; the fixed setup cost stays in the clone, not in any arm. */
export function copyForRun({ prepared, dest }) {
  if (existsSync(dest)) throw new Error(`${dest} already exists.`);
  cpSync(prepared, dest, { recursive: true, verbatimSymlinks: true });
  return dest;
}

function reachable(repo, sha) {
  try {
    git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
