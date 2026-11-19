import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { absoluteGitDir, sessionRecordPath } from "./session-record.mjs";

function countGitDirLookups(t) {
  const original = childProcess.execFileSync;
  const calls = [];
  childProcess.execFileSync = (command, args, options) => {
    if (command === "git" && args.includes("--absolute-git-dir")) calls.push(options?.cwd);
    return original(command, args, options);
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });
  return calls;
}

function checkout(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "session-record-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "main");
  mkdirSync(main);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git(main, "init", "-q", "-b", "main");
  writeFileSync(path.join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "a");
  return { root, main, git };
}

test("ISS-14116: a worktree's git directory is resolved once per process, not once per provider read", (t) => {
  const { root, main, git } = checkout(t);
  const linked = path.join(root, "linked");
  git(main, "worktree", "add", "-q", "-b", "one", linked);
  const calls = countGitDirLookups(t);
  for (let index = 0; index < 50; index += 1) {
    assert.equal(sessionRecordPath(linked), path.join(git(linked, "rev-parse", "--absolute-git-dir"), "vibe-session.json"));
  }
  assert.equal(calls.filter((cwd) => cwd === linked).length, 1, "50 record path reads resolve the git directory once");
});

test("ISS-14116: the reused git directory follows each checkout layout", (t) => {
  const { root, main, git } = checkout(t);
  const linked = path.join(root, "linked");
  git(main, "worktree", "add", "-q", "-b", "one", linked);
  const subdirectory = path.join(main, "sub");
  mkdirSync(subdirectory);
  // Decision table: checkout layout -> the git directory git itself reports, before and after a repeat.
  const rows = [
    ["main checkout", main],
    ["linked worktree", linked],
    ["subdirectory of a checkout", subdirectory],
  ];
  for (const [name, cwd] of rows) {
    const expected = git(cwd, "rev-parse", "--absolute-git-dir");
    assert.equal(absoluteGitDir(cwd), expected, name);
    assert.equal(absoluteGitDir(cwd), expected, `${name}, repeated`);
  }
  // A worktree deleted by hand and added again at the same path from another repository gets that repository's git
  // directory, while the old one is still on disk.
  const before = absoluteGitDir(linked);
  rmSync(linked, { recursive: true, force: true });
  const other = path.join(root, "other");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  git(other, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "b");
  git(other, "worktree", "add", "-q", "-b", "three", linked);
  const after = git(linked, "rev-parse", "--absolute-git-dir");
  assert.notEqual(after, before, "the fixture re-registers the path under a new git directory");
  assert.equal(absoluteGitDir(linked), after);
  // A path that stops being a checkout is never answered from the cache.
  rmSync(path.join(linked, ".git"));
  assert.throws(() => sessionRecordPath(linked));
});
