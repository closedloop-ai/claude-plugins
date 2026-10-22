import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUSY_EXIT, DUPLICATE_EXIT, composeProjectFor, defaultLockDir, readHolder, release, runningForeignCompose, sameWorktreeEntry, tryAcquire } from "./e2e-lock.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "e2e-lock.mjs");
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vibe-e2e-lock-")));
after(() => rmSync(root, { recursive: true, force: true }));
// `run` tests a named commit of a clean worktree, so every run happens in a repository at a known HEAD.
const commitAt = (dir) => {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_AUTHOR_DATE: "2026-10-22T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-22T00:00:00Z" };
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).stdout.trim();
  git("init", "--quiet", "--initial-branch=main");
  git("commit", "--quiet", "--allow-empty", "-m", "base");
  return git("rev-parse", "HEAD");
};
const SHA = commitAt(root);
process.chdir(root);

const owner = (pid, token) => ({ pid, token, cwd: root, command: "e2e", startedAt: "2026-10-19T00:00:00.000Z" });
// A pid that cannot exist: above the macOS and Linux pid ceilings.
const DEAD_PID = 99_999_999;

test("the lock is one folder per machine, under the vibe home", () => {
  assert.equal(defaultLockDir("/home/someone"), path.join("/home/someone", ".codex", "vibe", "locks", "e2e-stack"));
});

test("a second session cannot take the stack while the first holder is alive", () => {
  const lockDir = path.join(root, "held");
  assert.equal(tryAcquire(lockDir, owner(process.pid, "first")).acquired, true);
  const second = tryAcquire(lockDir, owner(process.pid, "second"));
  assert.equal(second.acquired, false);
  assert.equal(second.holder.token, "first");
  release(lockDir, owner(process.pid, "second"));
  assert.equal(readHolder(lockDir).token, "first", "a non-holder cannot release");
  release(lockDir, owner(process.pid, "first"));
  assert.equal(existsSync(lockDir), false);
});

test("a lock left by a process that no longer exists is taken over", () => {
  const lockDir = path.join(root, "stale");
  assert.equal(tryAcquire(lockDir, owner(DEAD_PID, "crashed")).acquired, true);
  const next = tryAcquire(lockDir, owner(process.pid, "next"));
  assert.equal(next.acquired, true);
  assert.equal(readHolder(lockDir).token, "next");
});

test("a lock folder whose owner is still writing its record is not taken; an old ownerless one is", () => {
  const lockDir = path.join(root, "ownerless");
  mkdirSync(lockDir, { recursive: true });
  assert.equal(tryAcquire(lockDir, owner(process.pid, "eager")).acquired, false);
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(lockDir, old, old);
  assert.equal(tryAcquire(lockDir, owner(process.pid, "eager")).acquired, true);
});

test("run serializes two commands on one stack and releases the lock after each", async () => {
  const lockDir = path.join(root, "serial");
  const marks = path.join(root, "marks.log");
  const step = (name) => [SCRIPT, "run", "--head", SHA, "--lock-dir", lockDir, process.execPath, "-e",
    `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(marks)},"${name}-start\\n");` +
    `setTimeout(()=>{fs.appendFileSync(${JSON.stringify(marks)},"${name}-end\\n")},1500)`];
  const first = spawn(process.execPath, step("a"), { stdio: "ignore" });
  const firstStarted = await waitFor(() => existsSync(marks));
  assert.ok(firstStarted);
  const otherWorktree = path.join(root, "wt-serial");
  mkdirSync(otherWorktree);
  assert.equal(commitAt(otherWorktree), SHA);
  const second = spawnSync(process.execPath, step("b"), { encoding: "utf8", timeout: 60_000, cwd: otherWorktree });
  assert.equal(second.status, 0, second.stderr);
  await new Promise((resolve) => first.once("close", resolve));
  assert.deepEqual(readFileSync(marks, "utf8").trim().split("\n"), ["a-start", "a-end", "b-start", "b-end"]);
  assert.equal(existsSync(lockDir), false);
});

test("run keeps the command's exit code and runs nothing when the stack stays busy", () => {
  const lockDir = path.join(root, "busy");
  const code = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--lock-dir", lockDir, process.execPath, "-e", "process.exit(4)"]);
  assert.equal(code.status, 4);
  assert.equal(tryAcquire(lockDir, { ...owner(process.pid, "holder"), worktree: path.join(root, "another-worktree") }).acquired, true);
  const marker = path.join(root, "should-not-exist");
  const busy = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--wait-seconds", "0", "--lock-dir", lockDir,
    process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], { encoding: "utf8" });
  assert.equal(busy.status, BUSY_EXIT);
  assert.equal(JSON.parse(busy.stdout).holder.token, "holder");
  assert.equal(existsSync(marker), false);
  const status = spawnSync(process.execPath, [SCRIPT, "status", "--lock-dir", lockDir], { encoding: "utf8" });
  assert.equal(JSON.parse(status.stdout).status, "held");
});

test("one session takes one entry: a second run from the same worktree is refused while the first holds or waits", () => {
  const lockDir = path.join(root, "per-head");
  mkdirSync(path.join(root, "wt-a"), { recursive: true });
  const worktree = realpathSync(path.join(root, "wt-a"));
  assert.equal(commitAt(worktree), SHA);
  assert.equal(tryAcquire(lockDir, { ...owner(process.pid, "first"), worktree }).acquired, true);
  assert.equal(sameWorktreeEntry(lockDir, worktree).token, "first");
  assert.equal(sameWorktreeEntry(lockDir, path.join(root, "wt-b")), null);
  const marker = path.join(root, "per-spec-ran");
  const second = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--wait-seconds", "0", "--lock-dir", lockDir,
    process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], { encoding: "utf8", cwd: worktree });
  assert.equal(second.status, DUPLICATE_EXIT);
  assert.match(JSON.parse(second.stdout).reason, /one run per head/);
  assert.equal(existsSync(marker), false);
  release(lockDir, { ...owner(process.pid, "first"), worktree });
  mkdirSync(`${lockDir}.waiters`, { recursive: true });
  writeFileSync(path.join(`${lockDir}.waiters`, "w.json"), JSON.stringify({ ...owner(process.pid, "waiting"), worktree }));
  assert.equal(sameWorktreeEntry(lockDir, worktree).token, "waiting");
  writeFileSync(path.join(`${lockDir}.waiters`, "w.json"), JSON.stringify({ ...owner(DEAD_PID, "waiting"), worktree }));
  assert.equal(sameWorktreeEntry(lockDir, worktree), null);
});

test("options after the command belong to the command, not the lock", () => {
  const lockDir = path.join(root, "passthrough");
  const echo = path.join(root, "echo-args.cjs");
  writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const result = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--lock-dir", lockDir, process.execPath, echo,
    "--lock-dir", "theirs", "--wait-seconds", "9"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["--lock-dir", "theirs", "--wait-seconds", "9"]);
  assert.equal(existsSync(lockDir), false);
});

test("a missing command is refused with usage", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "run"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage/);
});

test("each run gets its own compose project unless the caller set one", () => {
  const lockDir = path.join(root, "compose-own");
  const print = [process.execPath, "-e", "process.stdout.write(process.env.COMPOSE_PROJECT_NAME)"];
  const env = { ...process.env };
  Reflect.deleteProperty(env, "COMPOSE_PROJECT_NAME");
  Reflect.deleteProperty(env, "VIBE_E2E_FOREIGN_COMPOSE");
  const first = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--lock-dir", lockDir, ...print], { encoding: "utf8", env });
  const second = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--lock-dir", lockDir, ...print], { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^vibe-e2e-[0-9a-f]{8}$/);
  assert.notEqual(first.stdout, second.stdout, "two runs never share a project, so one teardown cannot remove the other's stack");
  assert.match(first.stderr, new RegExp(`compose project ${first.stdout}`));
  const kept = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--lock-dir", lockDir, ...print], { encoding: "utf8", env: { ...env, COMPOSE_PROJECT_NAME: "callers-own" } });
  assert.equal(kept.stdout, "callers-own");
  assert.equal(composeProjectFor({}, "0123abcd-ef45-6789"), "vibe-e2e-0123abcd");
});

test("a stack started outside the lock on a named compose project keeps the stack busy; no Docker checks nothing", () => {
  const lockDir = path.join(root, "compose-foreign");
  const listing = path.join(root, "compose-ls.json");
  const docker = path.join(root, "fake-docker");
  writeFileSync(docker, `#!/bin/sh\n[ "$1 $2 $3 $4" = "compose ls --format json" ] || exit 9\ncat "${listing}"\n`);
  chmodSync(docker, 0o755);
  writeFileSync(listing, JSON.stringify([{ Name: "fixed-e2e", Status: "running(5)" }, { Name: "other", Status: "exited(1)" }]));
  assert.equal(runningForeignCompose(["other", "fixed-e2e"], docker), "fixed-e2e");
  assert.equal(runningForeignCompose(["other"], docker), null, "an exited project is not a running stack");
  assert.equal(runningForeignCompose(["fixed-e2e"], path.join(root, "no-docker")), null);
  const marker = path.join(root, "foreign-ran");
  const env = { ...process.env, VIBE_E2E_DOCKER: docker };
  Reflect.deleteProperty(env, "VIBE_E2E_FOREIGN_COMPOSE");
  const command = [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`];
  const busy = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--wait-seconds", "0", "--lock-dir", lockDir, "--foreign-compose", "fixed-e2e", ...command], { encoding: "utf8", env });
  assert.equal(busy.status, BUSY_EXIT, busy.stderr);
  assert.deepEqual(JSON.parse(busy.stdout).holder, { composeProject: "fixed-e2e" });
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(lockDir), false, "the lock is released while the foreign stack runs");
  const fromEnv = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--wait-seconds", "0", "--lock-dir", lockDir, ...command], { encoding: "utf8", env: { ...env, VIBE_E2E_FOREIGN_COMPOSE: "x, fixed-e2e" } });
  assert.equal(fromEnv.status, BUSY_EXIT);
  writeFileSync(listing, "[]");
  const free = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--wait-seconds", "0", "--lock-dir", lockDir, "--foreign-compose", "fixed-e2e", ...command], { encoding: "utf8", env });
  assert.equal(free.status, 0, free.stderr);
  assert.equal(existsSync(marker), true);
  rmSync(marker);
  const noDocker = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--wait-seconds", "0", "--lock-dir", lockDir, "--foreign-compose", "fixed-e2e", ...command],
    { encoding: "utf8", env: { ...env, VIBE_E2E_DOCKER: path.join(root, "no-docker") } });
  assert.equal(noDocker.status, 0, noDocker.stderr);
  assert.equal(existsSync(marker), true);
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("run tests only the named commit of a clean worktree and names it (23/23 reported for an untested PR)", () => {
  const lockDir = path.join(root, "tested-head");
  const wt = path.join(root, "wt-head");
  mkdirSync(wt);
  commitAt(wt);
  writeFileSync(path.join(wt, "tracked.txt"), "one\n");
  spawnSync("git", ["-C", wt, "add", "tracked.txt"]);
  spawnSync("git", ["-C", wt, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "pr head"]);
  const head = spawnSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const run = (sha, ...command) => spawnSync(process.execPath, [SCRIPT, "run", "--head", sha, "--lock-dir", lockDir, ...command], { encoding: "utf8", cwd: wt });
  const ok = [process.execPath, "-e", "0"];
  const stale = run(SHA, ...ok);
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /^HEAD-MISMATCH /);
  writeFileSync(path.join(wt, "tracked.txt"), "leftover\n");
  const dirty = run(head, ...ok);
  assert.equal(dirty.status, 2);
  assert.match(dirty.stderr, /^DIRTY-WORKTREE .*tracked\.txt/);
  spawnSync("git", ["-C", wt, "checkout", "--quiet", "--", "tracked.txt"]);
  const clean = run(head.slice(0, 8), ...ok);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stderr, new RegExp(`^e2e-lock: testing ${head}$`, "m"));
  const moved = run(head, "git", "checkout", "--quiet", SHA);
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /^HEAD-MOVED /m);
});
