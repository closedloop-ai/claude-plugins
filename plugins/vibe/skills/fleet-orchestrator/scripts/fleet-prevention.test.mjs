import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { approvedSignalTargets, startTimeOf, stopOwnedPid } from "../../../hooks/kill-guard.mjs";
import { makeHome } from "../../vibe/scripts/test-fixtures.mjs";
import { heldPullProblems, unreadyCommits } from "./board.mjs";
import { captureCommand } from "./capture-command.mjs";
import { verifiedPluginRoot } from "./codex-session.mjs";
import { classifyScreen, classifyThread, guiHooks, LaunchState } from "./launch-check.mjs";
import { turnEndProblems } from "./turn-end-check.mjs";

test("prevention skips completed and verified merged rows but observes unresolved open ones", () => {
  const row = { worktree: "/unused/missing-worktree", repo: "example/widgets", pr: 3 };
  const queried = [];
  const findings = unreadyCommits({ writers: {
    done: { ...row, status: "DONE" }, merged: { ...row, pr: 4 }, open: row,
  } }, {}, (candidate) => {
    queried.push(candidate.pr);
    return candidate.pr === 4 ? "MERGED" : null;
  });
  assert.deepEqual(queried, [4, 3]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /PUSH-READY-UNKNOWN open/);
});

test("prevention treats a hold as protected only when the exact pull request is verified draft", () => {
  const writers = { row: { repo: "example/widgets", pr: 9, mergeHold: { reason: "manual layout check pending" } } };
  assert.deepEqual(heldPullProblems(writers, () => ({ state: "OPEN", isDraft: true })), []);
  assert.deepEqual(heldPullProblems(writers, () => ({ state: "MERGED", isDraft: false })), []);
  assert.match(heldPullProblems(writers, () => ({ state: "OPEN", isDraft: false }))[0], /PR-HELD-NOT-DRAFT.*manual layout/);
  assert.match(heldPullProblems(writers, () => { throw new Error("unverified"); })[0], /PR-HOLD-UNKNOWN/);
});

test("prevention records the exact capture supervisor and emits timing after its own command ends", async (t) => {
  const { root, cleanup } = makeHome("vibe-owned-capture-");
  t.after(cleanup);
  const timing = path.join(root, "time");
  const owner = path.join(root, "pid");
  assert.equal(await captureCommand(timing, owner, process.execPath, ["-e", "process.exit(7)"]), 7);
  const [pid, started] = readFileSync(owner, "utf8").trim().split("\n");
  assert.equal(Number(pid), process.pid);
  assert.equal(started, startTimeOf(process.pid));
  assert.match(readFileSync(timing, "utf8"), /^\d+\n$/);
});

test("prevention refuses changed approvals and stale ownership without interpreting the command string", () => {
  const target = { pid: 9_000_000, started: "fixture-time" };
  const now = Date.parse("2026-11-19T10:00:00Z");
  const record = { version: 1, command: "literal approval fixture", authority: "orchestrator", signal: "SIGTERM",
    expiresAt: "2026-11-19T11:00:00Z", targets: [target] };
  const digest = createHash("sha256").update(JSON.stringify([record.command, record.authority, record.signal,
    record.expiresAt, record.targets])).digest("hex");
  const input = { command: record.command, rulings: "Signal approval: orchestrator " + digest,
    owns: () => true, clock: () => now, startOf: () => target.started };

  assert.deepEqual(approvedSignalTargets(record, input), [target]);
  assert.throws(() => approvedSignalTargets(record, { ...input, command: "different" }), /does not match/);
  assert.throws(() => approvedSignalTargets(record, { ...input, owns: () => false }), /unowned/);
  assert.throws(() => approvedSignalTargets(record, { ...input, startOf: () => "reused" }), /identity/);
  assert.throws(() => approvedSignalTargets(record, { ...input, clock: () => now + 3600_001 }), /expired/);
});

test("prevention safely stops the exact child it recorded and refuses a reused identity", async (t) => {
  const { root, cleanup } = makeHome("vibe-pid-stop-");
  t.after(cleanup);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { cwd: root, stdio: "ignore" });
  const exited = once(child, "exit");
  await once(child, "spawn");
  assert(Number.isSafeInteger(child.pid));
  const started = startTimeOf(child.pid);
  assert(started);
  const ledger = { [child.pid]: { cwd: root, started } };
  assert.throws(() => stopOwnedPid(child.pid, { cwd: root, ledger, startOf: () => "reused",
    signal: () => assert.fail("identity mismatch signalled") }), /live PID/);
  stopOwnedPid(child.pid, { cwd: root, ledger });
  const [, signal] = await exited;
  assert.equal(signal, "SIGTERM");
});

test("prevention checks the installed root and observes actual tool and GUI hook states", (t) => {
  const { root, cleanup } = makeHome("vibe-root-check-");
  t.after(cleanup);
  const enabled = path.join(root, "enabled");
  const old = path.join(root, "old");
  mkdirSync(enabled);
  mkdirSync(old);
  const list = () => ({ installed: ["vibe", "vibe-generic"].map((name) =>
    ({ name, enabled: true, installed: true, source: { path: enabled } })) });
  assert.equal(verifiedPluginRoot(enabled, { list }), enabled);
  assert.throws(() => verifiedPluginRoot(old, { list }), /differs from the verified installed root/);
  assert.equal(classifyThread({ turns: [{ items: [] }] }).state, LaunchState.Waiting);
  assert.equal(classifyThread({ turns: [{ items: [{ type: "commandExecution", status: "inProgress" }] }] }).state, LaunchState.ToolRunning);
  assert.equal(classifyThread({ turns: [{ items: [{ type: "mcpToolCall", status: "completed" }] }] }).state, LaunchState.ToolDone);
  assert.equal(classifyScreen("Running PreToolUse hooks (1/2)").state, LaunchState.HookWait);
  const settings = { hooks: { PreToolUse: [{ hooks: [{ command: "/fixture/shell-hook" }] }] } };
  const reasons = guiHooks(settings, { readScript: () => 'test -n "$ITERM_SESSION_ID" && osascript …' });
  assert.equal(reasons[0]?.guarded, true);
});

test("prevention keeps owned slot holders visible until an independently watched handoff", () => {
  const input = {
    writer: "writer", worktree: "/session", holders: [{ pid: 100, lock: "heavy", owner: "writer" }],
    jobs: [{ pid: 99, name: "captured-run", identity: "started" }],
    parentOf: (pid) => pid === 100 ? 99 : 1, startOf: (pid) => pid === 99 ? "started" : null,
  };
  assert.equal(turnEndProblems({ ...input, watcher: { ok: true } }).ok, true);
  assert.match(turnEndProblems({ ...input, watcher: { ok: false, line: "no monitor" } }).lines[0], /no watcher/);
  assert.match(turnEndProblems({ ...input, jobs: [], watcher: { ok: true } }).lines[0], /^RUNNING heavy/);
});

test("a completed writer's open hold still requires verified draft protection",()=>{
  const row={repo:"example/widgets",pr:9,status:"DONE",mergeHold:{reason:"manual check"}};
  assert.match(heldPullProblems({row},()=>({state:"OPEN",isDraft:false}))[0],/PR-HELD-NOT-DRAFT/);
  assert.deepEqual(heldPullProblems({row},()=>({state:"CLOSED",isDraft:false})),[]);
});

test("retirement retains protection of any held PR that remains open",()=>{
  const row={repo:"example/widgets",pr:9,retiredAt:"now",mergeHold:{reason:"manual check"}};
  assert.match(heldPullProblems({row},()=>({state:"OPEN",isDraft:false}))[0],/PR-HELD-NOT-DRAFT/);
  assert.deepEqual(heldPullProblems({row},()=>({state:"MERGED",isDraft:false})),[]);
});

test("fleet stop-owned stops the exact recorded child before any plugin version is resolved", async (t) => {
  const { chmodSync, mkdirSync, mkdtempSync: temp, rmSync: remove, writeFileSync: write } = await import("node:fs");
  const { spawn: start, spawnSync: run } = await import("node:child_process");
  const { once: wait } = await import("node:events");
  const { tmpdir } = await import("node:os");
  const root = temp(path.join(tmpdir(), "vibe-stop-owned-"));
  t.after(() => remove(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), orch = path.join(root, "orch"), bin = path.join(root, "bin");
  for (const dir of [home, orch, bin]) mkdirSync(dir, { recursive: true });
  write(path.join(bin, "jq"), "#!/bin/sh\necho 'version resolution must not run for stop-owned' >&2\nexit 99\n");
  chmodSync(path.join(bin, "jq"), 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const child = start(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { cwd: root, stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* stopped */ } });
  await wait(child, "spawn");
  const guard = new URL("../../../hooks/kill-guard.mjs", import.meta.url).pathname;
  assert.equal(run(process.execPath, [guard, "own", String(child.pid)], { cwd: root, env, encoding: "utf8" }).status, 0);
  const exited = wait(child, "exit");
  const fleet = new URL("./fleet.sh", import.meta.url).pathname;
  const stopped = run("bash", [fleet, orch, "local", "stop-owned", String(child.pid)], { cwd: root, env, encoding: "utf8" });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.doesNotMatch(stopped.stderr, /version resolution/);
  const [, signal] = await exited;
  assert.equal(signal, "SIGTERM");
  const stranger = run("bash", [fleet, orch, "local", "stop-owned", String(process.pid)], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(stranger.status, 0, "an unrecorded pid is refused");
});
