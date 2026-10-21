import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { qaMergeOrderProblems } from "./qa-merge-order.mjs";
import { git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";

function repo(t) {
  const { root, home, cleanup } = makeHome("vibe-qa-merge-order-");
  t.after(cleanup);
  const wt = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", wt], home);
  const commit = (file, text, message) => {
    writeFileSync(path.join(wt, file), text);
    git(wt, ["add", "-A"], home);
    git(wt, ["commit", "--quiet", "-m", message], home);
    return git(wt, ["rev-parse", "HEAD"], home);
  };
  commit("a.txt", "base\n", "base");
  git(wt, ["checkout", "--quiet", "-b", "feature"], home);
  const qaHead = commit("f.txt", "feature\n", "feature");
  const advanceMain = (n) => {
    git(wt, ["checkout", "--quiet", "main"], home);
    commit(`m${n}.txt`, `${n}\n`, `main ${n}`);
    git(wt, ["checkout", "--quiet", "feature"], home);
  };
  const mergeMain = () => git(wt, ["merge", "--quiet", "--no-edit", "main"], home);
  return { wt, qaHead, commit, advanceMain, mergeMain, check: (head = qaHead) => qaMergeOrderProblems(wt, head, "main") };
}

test("QA'd head, then one main merge, may be enqueued", (t) => {
  const r = repo(t);
  assert.deepEqual(r.check(), []);
  r.advanceMain(1);
  r.mergeMain();
  assert.deepEqual(r.check(), []);
});

test("a second main merge or a new commit after QA is refused", (t) => {
  const r = repo(t);
  r.advanceMain(1);
  r.mergeMain();
  r.advanceMain(2);
  r.mergeMain();
  assert.match(r.check().join(), /merged 2 times after QA/);
  r.commit("g.txt", "fix\n", "fix after QA");
  assert.match(r.check().join(), /1 commit\(s\) after the QA'd head are not a merge of main/);
  assert.match(r.check("0".repeat(40)).join(), /not in this branch/);
});
