import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUSY_EXIT, DUPLICATE_EXIT, defaultLockDir, readHolder, release, sameWorktreeEntry, tryAcquire } from "./e2e-lock.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "e2e-lock.mjs");
const root = mkdtempSync(path.join(os.tmpdir(), "vibe-e2e-lock-"));
after(() => rmSync(root, { recursive: true, force: true }));

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
  const step = (name) => [SCRIPT, "run", "--lock-dir", lockDir, process.execPath, "-e",
    `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(marks)},"${name}-start\\n");` +
    `setTimeout(()=>{fs.appendFileSync(${JSON.stringify(marks)},"${name}-end\\n")},1500)`];
  const first = spawn(process.execPath, step("a"), { stdio: "ignore" });
  const firstStarted = await waitFor(() => existsSync(marks));
  assert.ok(firstStarted);
  const second = spawnSync(process.execPath, step("b"), { encoding: "utf8", timeout: 60_000, cwd: root });
  assert.equal(second.status, 0, second.stderr);
  await new Promise((resolve) => first.once("close", resolve));
  assert.deepEqual(readFileSync(marks, "utf8").trim().split("\n"), ["a-start", "a-end", "b-start", "b-end"]);
  assert.equal(existsSync(lockDir), false);
});

test("run keeps the command's exit code and runs nothing when the stack stays busy", () => {
  const lockDir = path.join(root, "busy");
  const code = spawnSync(process.execPath, [SCRIPT, "run", "--lock-dir", lockDir, process.execPath, "-e", "process.exit(4)"]);
  assert.equal(code.status, 4);
  assert.equal(tryAcquire(lockDir, owner(process.pid, "holder")).acquired, true);
  const marker = path.join(root, "should-not-exist");
  const busy = spawnSync(process.execPath, [SCRIPT, "run", "--wait-seconds", "0", "--lock-dir", lockDir,
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
  assert.equal(tryAcquire(lockDir, { ...owner(process.pid, "first"), worktree }).acquired, true);
  assert.equal(sameWorktreeEntry(lockDir, worktree).token, "first");
  assert.equal(sameWorktreeEntry(lockDir, path.join(root, "wt-b")), null);
  const marker = path.join(root, "per-spec-ran");
  const second = spawnSync(process.execPath, [SCRIPT, "run", "--wait-seconds", "0", "--lock-dir", lockDir,
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
  const result = spawnSync(process.execPath, [SCRIPT, "run", "--lock-dir", lockDir, process.execPath, echo,
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

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
