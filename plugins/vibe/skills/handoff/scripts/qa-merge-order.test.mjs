import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { changedSpecRunProblems, qaMergeOrderProblems } from "./qa-merge-order.mjs";
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

test("a changed e2e spec needs a passing run at the head in its lane before enqueue", (t) => {
  const r = repo(t);
  mkdirSync(path.join(r.wt, "e2e"), { recursive: true });
  const head = r.commit("e2e/board.spec.ts", "test('x', () => {});\n", "spec");
  const spec = "e2e/board.spec.ts";
  assert.match(changedSpecRunProblems(r.wt, undefined, "main")[0], /no testRuns evidence/);
  assert.deepEqual(changedSpecRunProblems(r.wt, { testRuns: [{ path: spec, status: "passed", commit: head }] }, "main"),
    [`${spec}: no passing run at ${head} in the lane that runs it (a testRuns entry with its lane)`], "a run with no lane does not count");
  assert.equal(changedSpecRunProblems(r.wt, { testRuns: [{ path: spec, status: "passed", commit: r.qaHead, lane: "desktop" }] }, "main").length, 1, "a run on an older head does not count");
  assert.equal(changedSpecRunProblems(r.wt, { testRuns: [{ path: spec, status: "failed", commit: head, lane: "desktop" }] }, "main").length, 1);
  assert.deepEqual(changedSpecRunProblems(r.wt, { testRuns: [{ path: spec, status: "passed", commit: head, lane: "desktop-displayless" }] }, "main"), []);
});

test("a branch that changes no e2e spec needs no spec runs", (t) => {
  const r = repo(t);
  assert.deepEqual(changedSpecRunProblems(r.wt, undefined, "main"), []);
});
