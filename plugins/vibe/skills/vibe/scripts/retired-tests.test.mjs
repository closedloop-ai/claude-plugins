import assert from "node:assert/strict";
import { statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "retired-tests.mjs");

function checkout(t) {
  const fixture = makeHome("retired-tests-");
  t.after(fixture.cleanup);
  const repo = path.join(fixture.root, "symphony-alpha");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout: repo });
  return { ...fixture, repo };
}

test("records retired-only deletions privately and replaces an entry for the same file and case", (t) => {
  const { home, repo } = checkout(t);
  const record = (extra) => runNode(SCRIPT, ["record", "--worktree", repo, ...extra], home);
  const file = ["--path", "packages/app/sessions/grouped-list.test.tsx", "--retired-by", "PRD-720",
    "--covers", "GroupedListRenderer"];
  assert.equal(record(file).status, 0);
  assert.equal(record([...file.slice(0, 4), "--covers", "GroupedListRenderer and its row helper"]).status, 0);
  const caseEntry = record(["--path", "packages/app/sessions/list.test.tsx", "--case", "renders grouped rows",
    "--retired-by", "ISS-12451", "--covers", "the grouped mode"]);
  assert.equal(caseEntry.status, 0, JSON.stringify(caseEntry.json));
  const listed = runNode(SCRIPT, ["list", "--worktree", repo], home);
  assert.deepEqual(listed.json.retiredTests, [
    { path: "packages/app/sessions/grouped-list.test.tsx", retiredBy: "PRD-720", covers: "GroupedListRenderer and its row helper" },
    { path: "packages/app/sessions/list.test.tsx", case: "renders grouped rows", retiredBy: "ISS-12451", covers: "the grouped mode" },
  ]);
  const recordFile = path.join(git(repo, ["rev-parse", "--absolute-git-dir"], home), "vibe-retired-tests.json");
  assert.equal(statSync(recordFile).mode & 0o777, 0o600);
  assert.equal(git(repo, ["status", "--porcelain"], home), "");
});

test("refuses a deletion without a retiring ticket or PRD, a non-test file or an unnamed covered code", (t) => {
  const { home, repo } = checkout(t);
  for (const args of [
    ["--path", "packages/app/sessions/list.test.tsx", "--covers", "GroupedListRenderer"],
    ["--path", "packages/app/sessions/list.test.tsx", "--retired-by", "the ticket", "--covers", "GroupedListRenderer"],
    ["--path", "packages/app/sessions/list.tsx", "--retired-by", "PRD-720", "--covers", "GroupedListRenderer"],
    ["--path", "../outside/list.test.tsx", "--retired-by", "PRD-720", "--covers", "GroupedListRenderer"],
    ["--path", "packages/app/sessions/list.test.tsx", "--retired-by", "PRD-720"],
  ]) {
    const result = runNode(SCRIPT, ["record", "--worktree", repo, ...args], home);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.json.ok, false);
  }
  assert.deepEqual(runNode(SCRIPT, ["list", "--worktree", repo], home).json.retiredTests, []);
});
