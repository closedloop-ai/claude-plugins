import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshness } from "./freshness.mjs";

const SCRIPT = fileURLToPath(new URL("./freshness.mjs", import.meta.url));

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "freshness-")));
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=a@b.c", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
  const remote = path.join(root, "remote.git");
  const clone = path.join(root, "clone");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, clone], { stdio: "ignore" });
  git(clone, "checkout", "-q", "-b", "main");
  writeFileSync(path.join(clone, "a.txt"), "1");
  git(clone, "add", ".");
  git(clone, "commit", "-qm", "one");
  git(clone, "push", "-q", "origin", "main");
  return { root, clone, remote, git };
}

test("it records the path, HEAD and the freshly fetched remote SHA, and counts the drift", () => {
  const { root, clone, remote, git } = fixture();
  try {
    const other = path.join(root, "other");
    execFileSync("git", ["clone", "-q", remote, other], { stdio: "ignore" });
    writeFileSync(path.join(other, "b.txt"), "2");
    git(other, "add", ".");
    git(other, "commit", "-qm", "two");
    git(other, "push", "-q", "origin", "main");
    const stale = git(clone, "rev-parse", "origin/main");
    const report = freshness({ worktree: clone });
    assert.equal(report.ok, true, report.problems.join());
    assert.equal(report.path, clone);
    assert.equal(report.head, stale);
    assert.equal(report.originMain, git(other, "rev-parse", "HEAD"));
    assert.notEqual(report.originMain, stale, "the cached origin/main was stale; the fetch moved it");
    assert.equal(report.behindMain, 1);
    assert.equal(report.aheadOfMain, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed fetch leaves originMain null and fails, never falling back to the cached ref", () => {
  const { root, clone, remote } = fixture();
  try {
    rmSync(remote, { recursive: true, force: true });
    const report = freshness({ worktree: clone });
    assert.equal(report.originMain, null);
    assert.equal(report.fetched, false);
    assert.equal(report.ok, false);
    assert.match(report.problems[0], /could not fetch origin main/);
    assert.equal(report.behindMain, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the wrong checkout is a problem, and --no-fetch is reported as not fresh", () => {
  const { root, clone } = fixture();
  try {
    const wrong = freshness({ worktree: clone, expectPath: path.join(root, "elsewhere") });
    assert.ok(wrong.problems.some((problem) => problem.includes("not the expected")));
    const skipped = freshness({ worktree: clone, fetch: false });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.originMain, null);
    const notGit = freshness({ worktree: root });
    assert.equal(notGit.path, null);
    assert.equal(notGit.head, null);
    const cli = spawnSync("node", [SCRIPT, "--worktree", clone], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
