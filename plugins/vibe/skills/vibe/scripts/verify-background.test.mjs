import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isRunId, newRunId, readRun, recordFile, RunExit, RunState, startBackground, waitForRun, writeRecord } from "./verify-background.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "verify-run.mjs");
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

function memory() {
  const files = new Map();
  return { files, fs: { read: (file) => files.get(file), exists: (file) => files.has(file), write: (file, text) => files.set(file, text) } };
}

const finish = (memoryFs, id, patch) => writeRecord("/gd", id, { state: "finished", ok: true, evidenceHead: HEAD, summary: { passed: 3 }, ...patch }, memoryFs.fs);

test("run ids are well formed and only well formed ids are read", () => {
  assert.ok(isRunId(newRunId(1_700_000_000_000, () => "0123abcd")));
  assert.equal(isRunId("../../etc/passwd"), false);
  assert.equal(readRun({ gitDir: "/gd", id: "../x", fs: memory().fs }).state, RunState.Unknown);
});

test("starting in the background returns a run id at once and writes a running record; nothing waits for the run", () => {
  const m = memory();
  let spawned = null;
  const started = startBackground({ gitDir: "/gd", worktree: "/wt", head: HEAD, scriptPath: "/s/verify-run.mjs", passArgs: ["--no-cache"], fs: m.fs, now: () => 1000, newId: () => "vr-x1-0123abcd",
    spawnDetached: (command, args) => { spawned = { command, args }; return 4242; } });
  assert.equal(started.id, "vr-x1-0123abcd");
  assert.equal(started.state, RunState.Running);
  assert.deepEqual(spawned.args.slice(0, 5), ["/s/verify-run.mjs", "--worktree", "/wt", "--head", HEAD]);
  assert.ok(spawned.args.includes("--run-id") && spawned.args.includes("--no-cache"));
  assert.equal(JSON.parse(m.files.get(recordFile("/gd", started.id))).pid, 4242);
});

test("a running record with a live process is running; with a dead process it is orphaned, never passed", () => {
  const m = memory();
  writeRecord("/gd", "vr-x1-0123abcd", { head: HEAD, state: "running", pid: 77 }, m.fs);
  assert.equal(readRun({ gitDir: "/gd", id: "vr-x1-0123abcd", fs: m.fs, alive: () => true }).state, RunState.Running);
  const orphan = readRun({ gitDir: "/gd", id: "vr-x1-0123abcd", fs: m.fs, alive: () => false });
  assert.equal(orphan.state, RunState.Orphaned);
  assert.notEqual(RunExit[orphan.state], 0);
});

test("only a finished, ok run at the head under review is passed; failed, pending and moved heads are not", () => {
  const m = memory();
  const id = "vr-x1-0123abcd";
  const read = (extra = {}) => readRun({ gitDir: "/gd", id, fs: m.fs, alive: () => true, currentHead: HEAD, expectedHead: HEAD, ...extra });
  writeRecord("/gd", id, { head: HEAD, state: "running", pid: 1 }, m.fs);
  assert.equal(read().state, RunState.Running);
  finish(m, id, {});
  assert.equal(read().state, RunState.Passed);
  assert.equal(RunExit[read().state], 0);
  assert.equal(read({ currentHead: OTHER }).state, RunState.HeadMoved, "the worktree moved on after the run");
  assert.equal(read({ expectedHead: OTHER }).state, RunState.HeadMoved, "the head under review is not the head that was verified");
  finish(m, id, { evidenceHead: OTHER });
  assert.equal(read().state, RunState.HeadMoved, "the result is for another head");
  finish(m, id, { ok: false, evidenceHead: HEAD });
  assert.equal(read().state, RunState.Failed);
  writeRecord("/gd", id, { state: "error", error: "boom" }, m.fs);
  assert.equal(read().state, RunState.Failed);
});

test("a short head matches the full head it abbreviates, in either direction", () => {
  const m = memory();
  finish(m, "vr-x1-0123abcd", { head: HEAD.slice(0, 12) });
  assert.equal(readRun({ gitDir: "/gd", id: "vr-x1-0123abcd", fs: m.fs, currentHead: HEAD, expectedHead: HEAD.slice(0, 12) }).state, RunState.Passed);
});

test("waiting polls until the run is no longer running and returns a pending run as running when the wait ends", async () => {
  let reads = 0;
  let clock = 0;
  const sleeps = [];
  const done = await waitForRun({ read: () => ({ state: ++reads < 4 ? RunState.Running : RunState.Passed }), sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock, waitSeconds: 600, pollSeconds: 10 });
  assert.equal(done.state, RunState.Passed);
  assert.deepEqual(sleeps, [10_000, 10_000, 10_000]);
  clock = 0;
  const pending = await waitForRun({ read: () => ({ state: RunState.Running }), sleep: async (ms) => { clock += ms; }, now: () => clock, waitSeconds: 30, pollSeconds: 10 });
  assert.equal(pending.state, RunState.Running);
  assert.notEqual(RunExit[pending.state], 0);
});

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-bg-"));
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "package.json"), "{}\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { dir, head: git("rev-parse", "HEAD").stdout.trim(), git };
}

test("a real background run returns before it finishes, can be joined with --wait, and a run that checks nothing is failed, not passed", () => {
  const { dir, head } = repo();
  try {
    const started = spawnSync(process.execPath, [SCRIPT, "--background", "--worktree", dir, "--head", head, "--no-lanes", "--no-cache"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(started.status, 0, started.stderr);
    const { id } = JSON.parse(started.stdout);
    const joined = spawnSync(process.execPath, [SCRIPT, "--wait", id, "--worktree", dir, "--head", head, "--wait-seconds", "60"], { encoding: "utf8", timeout: 90_000 });
    const run = JSON.parse(joined.stdout);
    assert.equal(run.state, RunState.Failed, joined.stdout);
    assert.equal(joined.status, RunExit[RunState.Failed]);
    assert.ok(run.progress.length >= 1, "progress was written as it ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a killed background run is orphaned through the CLI and exits non-zero", () => {
  const { dir, head } = repo();
  try {
    const gitDir = spawnSync("git", ["-C", dir, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim();
    const id = "vr-orphan-0123abcd";
    mkdirSync(path.join(gitDir, "vibe-verify-runs"), { recursive: true });
    writeFileSync(recordFile(gitDir, id), JSON.stringify({ id, head, state: "running", pid: 2_000_000_000 }));
    const result = spawnSync(process.execPath, [SCRIPT, "--status", id, "--worktree", dir], { encoding: "utf8", timeout: 30_000 });
    assert.equal(JSON.parse(result.stdout).state, RunState.Orphaned);
    assert.equal(result.status, RunExit[RunState.Orphaned]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
