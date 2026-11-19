import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { detachWorktree, frozenGate, GateExit } from "./frozen-render-gate.mjs";
import { bindProviderInProcess, git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";

bindProviderInProcess(after);

/** A repository with one commit and a linked worktree holding a large-ish tree, as a bootstrapped base would. */
function repositoryWithWorktree(t) {
  const home = makeHome("vibe-frozen-cleanup-");
  t.after(home.cleanup);
  const repo = path.join(home.root, "repo");
  git(home.root, ["init", "--quiet", "--initial-branch=main", repo], home.home);
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, ["add", "-A"], home.home);
  git(repo, ["commit", "--quiet", "-m", "base"], home.home);
  const out = path.join(home.root, "out");
  mkdirSync(out);
  const worktree = path.join(out, "base-worktree");
  git(repo, ["worktree", "add", "--quiet", "--detach", worktree, "HEAD"], home.home);
  mkdirSync(path.join(worktree, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(worktree, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  const registered = () => git(repo, ["worktree", "list", "--porcelain"], home.home).split("\n")
    .filter((line) => line.startsWith("worktree ")).some((line) => path.basename(line) === "base-worktree");
  return { repo, out, worktree, registered };
}

test("the base worktree leaves git's worktree list at once, even if its background delete never runs (ISS-14395)", (t) => {
  const { repo, out, worktree, registered } = repositoryWithWorktree(t);
  assert.equal(registered(), true);
  const deferred = [];
  detachWorktree(repo, worktree, { deleteLater: (dir) => deferred.push(dir) });
  assert.equal(registered(), false, "no worktree stays registered when the delete crashes or never starts");
  assert.equal(existsSync(worktree), false);
  assert.equal(deferred.length, 1);
  assert.ok(existsSync(deferred[0]), "the files wait, renamed aside, for the background delete");
  assert.match(path.basename(deferred[0]), /^base-worktree\.removing-/);
  assert.deepEqual(readdirSync(out), [path.basename(deferred[0])]);
});

test("the default background delete removes the renamed files after detachWorktree has returned", async (t) => {
  const { repo, out, worktree, registered } = repositoryWithWorktree(t);
  detachWorktree(repo, worktree);
  assert.equal(registered(), false);
  for (let tries = 0; tries < 100 && readdirSync(out).length; tries++) await delay(50);
  assert.deepEqual(readdirSync(out), []);
});

test("the gate reports its verdict before it removes the base worktree it made (ISS-14395)", async () => {
  const events = [];
  const summary = { ok: false, blocking: [{ storyId: "a--story" }], lines: [] };
  const result = await frozenGate({ repo: "/repo", base: "abc", out: "/out", changeLog: "/log", onVerdict: (verdict) => events.push(`verdict ${verdict.exitCode}`) }, {
    record: () => null, select: () => ["a.stories.tsx"], launch: () => "launcher",
    prepare: () => events.push("prepare"), bootstrap: () => ({ status: "OK" }),
    compare: async () => { events.push("compare"); return summary; },
    removeWorktree: () => events.push("remove"),
  });
  assert.equal(result.exitCode, GateExit.Block);
  assert.deepEqual(events, ["prepare", "compare", `verdict ${GateExit.Block}`, "remove"]);
});
