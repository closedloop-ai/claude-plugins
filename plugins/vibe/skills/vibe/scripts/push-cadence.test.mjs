import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unpushedAge } from "./push-cadence.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "push-cadence.mjs");
const T0 = Date.parse("2026-10-21T10:00:00Z");

function repos(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "push-cadence-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const git = (cwd, args, when = T0) => {
    const date = new Date(when).toISOString();
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    }).trim();
  };
  git(root, ["init", "--quiet", "--bare", origin]);
  git(root, ["init", "--quiet", "-b", "feature", work]);
  writeFileSync(path.join(work, "a.txt"), "1\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "base"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "--quiet", "-u", "origin", "feature"]);
  const commit = (file, when) => {
    writeFileSync(path.join(work, file), `${when}\n`);
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "-m", file], when);
  };
  return { work, git, commit };
}

const minutes = (n) => T0 + n * 60_000;

test("nothing unpushed is never due", (t) => {
  const { work } = repos(t);
  assert.deepEqual(unpushedAge(work, { now: minutes(500) }), { minutes: 0, due: false, since: null, reason: "nothing unpushed" });
});

test("the oldest unpushed commit sets the age, and 90 minutes makes the push due", (t) => {
  const { work, commit } = repos(t);
  commit("b.txt", minutes(10));
  commit("c.txt", minutes(60));
  const early = unpushedAge(work, { now: minutes(80) });
  assert.equal(early.minutes, 70);
  assert.equal(early.due, false);
  assert.match(early.reason, /2 unpushed commit/);
  const late = unpushedAge(work, { now: minutes(100) });
  assert.equal(late.minutes, 90);
  assert.equal(late.due, true);
  assert.equal(late.since, new Date(minutes(10)).toISOString());
  assert.equal(unpushedAge(work, { now: minutes(100), limitMinutes: 120 }).due, false);
});

test("an uncommitted file counts by its modification time, and ignored paths do not", (t) => {
  const { work } = repos(t);
  writeFileSync(path.join(work, "draft.txt"), "x\n");
  utimesSync(path.join(work, "draft.txt"), new Date(minutes(5)), new Date(minutes(5)));
  const result = unpushedAge(work, { now: minutes(100) });
  assert.equal(result.minutes, 95);
  assert.equal(result.due, true);
  assert.match(result.reason, /1 uncommitted file/);
  assert.equal(unpushedAge(work, { now: minutes(100), ignore: ["draft.txt"] }).due, false);
});

test("with no upstream, commits missing from origin/<branch> or every remote ref count", (t) => {
  const { work, git, commit } = repos(t);
  git(work, ["branch", "--quiet", "--unset-upstream"]);
  commit("b.txt", minutes(20));
  assert.equal(unpushedAge(work, { now: minutes(30) }).minutes, 10);
  git(work, ["checkout", "--quiet", "-b", "never-pushed"]);
  commit("c.txt", minutes(25));
  assert.equal(unpushedAge(work, { now: minutes(30) }).minutes, 10, "b.txt is on no remote ref either");
});

test("the command prints the age and exits 1 when the push is due", (t) => {
  const { work, commit } = repos(t);
  commit("b.txt", minutes(0));
  const run = (now) => spawnSync(process.execPath, [SCRIPT, "--worktree", work, "--now", new Date(now).toISOString()], { encoding: "utf8" });
  const due = run(minutes(91));
  assert.equal(due.status, 1);
  assert.equal(JSON.parse(due.stdout).due, true);
  assert.equal(run(minutes(30)).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status, 2);
});
