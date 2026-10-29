import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureSessionProcessIdentities, ownership, processInfo, stopSessionProcesses } from "./session-processes.mjs";
import { git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "vibe-sessions.mjs");

/**
 * A long-running node process whose command line names `marker`, started in `cwd` through a shell that exits at
 * once, so it is not this test's child, as a session's Storybook is not the stop command's.
 */
function longRunning(t, dir, cwd, marker) {
  const file = path.join(dir, `${marker.replace(/\W+/g, "-")}.mjs`);
  writeFileSync(file, "setInterval(() => {}, 1000);\n");
  const started = spawnSync("/bin/sh", ["-c", `nohup "$0" "$1" ${marker} >/dev/null 2>&1 & echo $!`, process.execPath, file], { cwd, encoding: "utf8" });
  const pid = Number(started.stdout.trim());
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });
  return pid;
}

const waitFor = async (check) => {
  for (let i = 0; i < 40 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
};

test("only a live process of the right kind running in the session's worktree is the session's (ISS-13321)", (t) => {
  const { root, cleanup } = makeHome("vibe-session-processes-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  mkdirSync(worktree);
  mkdirSync(path.join(worktree, "apps/storybook"), { recursive: true });
  assert.deepEqual(ownership("storybook", null, worktree), { owned: false, reason: "not running" });
  assert.equal(ownership("storybook", { command: "node storybook dev -p 6100", cwd: worktree }, worktree).owned, true);
  assert.equal(ownership("storybook", { command: "node storybook dev -p 6100", cwd: path.join(worktree, "apps/storybook") }, worktree).owned, true);
  assert.equal(ownership("storybook", { command: "node something-else", cwd: worktree }, worktree).owned, false, "a reused pid running another program");
  assert.equal(ownership("storybook", { command: "node storybook dev", cwd: path.join(root, "other") }, worktree).owned, false, "another session's Storybook");
  assert.equal(ownership("storybook", { command: `node storybook dev --config-dir ${worktree}/.storybook`, cwd: root }, worktree).owned, false,
    "another ticket's Storybook may mention this worktree without running in it");
  assert.equal(ownership("desktop", { command: "pnpm --filter desktop vibe:profile launch --profile p", cwd: worktree }, worktree).owned, true);
});

test("a foreign process merely naming the worktree is never recorded or signalled (ISS-13321)", async (t) => {
  const { root, cleanup } = makeHome("vibe-session-foreign-command-");
  t.after(cleanup);
  const worktree = path.join(root, "ticket-a");
  const elsewhere = path.join(root, "ticket-b");
  mkdirSync(worktree); mkdirSync(elsewhere);
  const foreign = { command: `node storybook dev --config-dir ${worktree}/.storybook`, cwd: elsewhere, started: "Tue Oct 28 12:00:00 2026" };
  const stack = captureSessionProcessIdentities(worktree, { storybookPid: 987654 }, { read: () => foreign });
  assert.equal(stack.storybookIdentity, undefined);
  const signals = [];
  const stopped = await stopSessionProcesses(worktree, stack, { read: () => foreign, signal: (pid) => signals.push(pid), waitMs: 0 });
  assert.deepEqual(stopped.results.map(({ result }) => result), ["left-alone"]);
  assert.deepEqual(signals, []);
});

test("a process that survives SIGTERM prevents discard from treating the stop as complete (ISS-13321)", async (t) => {
  const { root, cleanup } = makeHome("vibe-session-stubborn-process-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  mkdirSync(worktree);
  const running = { command: "node storybook dev", cwd: worktree, started: "Tue Oct 28 12:00:00 2026" };
  const stack = captureSessionProcessIdentities(worktree, { storybookPid: 987655 }, { read: () => running });
  await assert.rejects(stopSessionProcesses(worktree, stack, { read: () => running, signal: () => {}, waitMs: 0 }),
    /recorded process is still running/);
});

test("stop signals the session's own Storybook and leaves a reused or stale pid alone (ISS-13321)", async (t) => {
  const { root, cleanup } = makeHome("vibe-session-stop-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  const elsewhere = path.join(root, "elsewhere");
  mkdirSync(worktree);
  mkdirSync(elsewhere);
  const ours = longRunning(t, root, worktree, "storybook dev");
  const reused = longRunning(t, root, elsewhere, "storybook dev");
  await waitFor(() => processInfo(ours) && processInfo(reused));
  const recorded = captureSessionProcessIdentities(worktree, { storybookPid: ours, storybookUrl: "http://localhost:6100", desktopPid: reused, other: 1 });
  const { results, stack } = await stopSessionProcesses(worktree, recorded, { waitMs: 5000 });
  assert.deepEqual(results.map(({ kind, result }) => [kind, result]), [["storybook", "stopped"], ["desktop", "left-alone"]]);
  assert.equal(processInfo(ours), null);
  assert.notEqual(processInfo(reused), null, "a process the session cannot prove is its own is never signalled");
  assert.deepEqual(stack, { desktopPid: reused, other: 1 });
  const gone = await stopSessionProcesses(worktree, { storybookPid: ours }, { waitMs: 100 });
  assert.deepEqual(gone.results.map(({ result }) => result), ["not-running"]);
  assert.deepEqual(gone.stack, {});
});

test("vibe-sessions stop and a confirmed discard stop the recorded Storybook (ISS-13321)", async (t) => {
  const fixture = makeHome("vibe-session-stop-cli-");
  t.after(fixture.cleanup);
  const { root, home } = fixture;
  const checkout = path.join(home, "Documents", "Closedloop.ai - Active Work", "symphony-alpha");
  makeCheckout({ root, home, checkout, files: { "README.md": "seed\n" } });
  const created = runNode(SCRIPT, ["new", "--repo", checkout, "--slug", "stop-me", "--summary", "stop me", "--mode", "blank",
    "--operator-id", "user-operator", "--operator-email", "operator@example.com"], home);
  assert.equal(created.status, 0, created.stderr);
  const worktree = created.json.session.worktree;
  const first = longRunning(t, root, worktree, "storybook dev");
  const firstDesktop = longRunning(t, root, worktree, "vibe:profile launch");
  await waitFor(() => processInfo(first) && processInfo(firstDesktop));
  runNode(SCRIPT, ["touch", "--worktree", worktree, "--stack", JSON.stringify({ storybookPid: first, storybookUrl: "http://localhost:6101",
    desktopPid: firstDesktop })], home);
  const stopped = runNode(SCRIPT, ["stop", "--worktree", worktree], home);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.deepEqual(stopped.json.processes.map(({ result }) => result), ["stopped", "stopped"]);
  assert.equal(processInfo(first), null);
  assert.equal(processInfo(firstDesktop), null);
  assert.equal(runNode(SCRIPT, ["show", "--worktree", worktree], home).json.session.stack, null);
  const second = longRunning(t, root, worktree, "storybook dev");
  const secondDesktop = longRunning(t, root, worktree, "vibe:profile launch");
  await waitFor(() => processInfo(second) && processInfo(secondDesktop));
  runNode(SCRIPT, ["touch", "--worktree", worktree, "--stack", JSON.stringify({ storybookPid: second, desktopPid: secondDesktop })], home);
  const discarded = runNode(SCRIPT, ["discard", "--worktree", worktree, "--confirm"], home);
  assert.equal(discarded.status, 0, discarded.stdout + discarded.stderr);
  assert.deepEqual(discarded.json.processes.map(({ result }) => result), ["stopped", "stopped"]);
  assert.equal(processInfo(second), null);
  assert.equal(processInfo(secondDesktop), null);
  assert.equal(git(checkout, ["branch", "--list", "vibe/stop-me"], home), "");
});

test("stop refuses a different branch before signalling its recorded process (ISS-13321)", async (t) => {
  const { root, home, cleanup } = makeHome("vibe-session-stop-branch-");
  t.after(cleanup);
  const checkout = path.join(home, "Documents", "Closedloop.ai - Active Work", "symphony-alpha");
  makeCheckout({ root, home, checkout, files: { "README.md": "seed\n" } });
  const created = runNode(SCRIPT, ["new", "--repo", checkout, "--slug", "branch-owner", "--summary", "branch owner", "--mode", "blank",
    "--operator-id", "user-operator", "--operator-email", "operator@example.com"], home);
  assert.equal(created.status, 0, created.stderr);
  const worktree = created.json.session.worktree;
  const pid = longRunning(t, root, worktree, "storybook dev");
  await waitFor(() => processInfo(pid));
  assert.equal(runNode(SCRIPT, ["touch", "--worktree", worktree, "--stack", JSON.stringify({ storybookPid: pid })], home).status, 0);
  git(worktree, ["checkout", "-q", "-b", "vibe/different-owner"], home);
  const stopped = runNode(SCRIPT, ["stop", "--worktree", worktree], home);
  assert.notEqual(stopped.status, 0);
  assert.match(String(stopped.json.error), /exact owned session worktree|matching private branch record/);
  assert.notEqual(processInfo(pid), null);
});

test("stop leaves a reused same-command same-worktree pid alive (ISS-13321)", async (t) => {
  const { root, home, cleanup } = makeHome("vibe-session-stop-reused-");
  t.after(cleanup);
  const checkout = path.join(home, "Documents", "Closedloop.ai - Active Work", "symphony-alpha");
  makeCheckout({ root, home, checkout, files: { "README.md": "seed\n" } });
  const created = runNode(SCRIPT, ["new", "--repo", checkout, "--slug", "reused-pid", "--summary", "reused pid", "--mode", "blank",
    "--operator-id", "user-operator", "--operator-email", "operator@example.com"], home);
  assert.equal(created.status, 0, created.stderr);
  const worktree = created.json.session.worktree;
  const first = longRunning(t, root, worktree, "storybook dev");
  await waitFor(() => processInfo(first));
  assert.equal(runNode(SCRIPT, ["touch", "--worktree", worktree, "--stack", JSON.stringify({ storybookPid: first })], home).status, 0);
  const recordPath = path.join(git(worktree, ["rev-parse", "--absolute-git-dir"], home), "vibe-session.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.match(record.stack.storybookIdentity, /^[0-9a-f]{64}$/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const reused = longRunning(t, root, worktree, "storybook dev");
  await waitFor(() => processInfo(reused));
  record.stack.storybookPid = reused;
  writeFileSync(recordPath, JSON.stringify(record));
  const refreshed = runNode(SCRIPT, ["touch", "--worktree", worktree, "--stack",
    JSON.stringify({ storybookPid: reused, storybookIdentity: "caller-supplied" })], home);
  assert.equal(refreshed.status, 0);
  assert.equal(refreshed.json.session.stack.storybookIdentity, record.stack.storybookIdentity,
    "an unrelated stack update cannot promote a reused pid to a new owned process");
  const stopped = runNode(SCRIPT, ["stop", "--worktree", worktree], home);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual(stopped.json.processes.map(({ result }) => result), ["left-alone"]);
  assert.notEqual(processInfo(reused), null);
});

test("stop can retire a legacy process only when the session kill ledger proves its birth (ISS-13321)", async (t) => {
  const { root, home, cleanup } = makeHome("vibe-session-stop-legacy-");
  t.after(cleanup);
  const checkout = path.join(home, "Documents", "Closedloop.ai - Active Work", "symphony-alpha");
  makeCheckout({ root, home, checkout, files: { "README.md": "seed\n" } });
  const created = runNode(SCRIPT, ["new", "--repo", checkout, "--slug", "legacy-stop", "--summary", "legacy stop", "--mode", "blank",
    "--operator-id", "user-operator", "--operator-email", "operator@example.com"], home);
  assert.equal(created.status, 0, created.stderr);
  const worktree = created.json.session.worktree;
  const launchCwd = path.join(worktree, "apps/storybook");
  mkdirSync(launchCwd, { recursive: true });
  const pid = longRunning(t, root, launchCwd, "storybook dev");
  await waitFor(() => processInfo(pid));
  assert.equal(runNode(SCRIPT, ["touch", "--worktree", worktree, "--stack", JSON.stringify({ storybookPid: pid })], home).status, 0);
  const recordPath = path.join(git(worktree, ["rev-parse", "--absolute-git-dir"], home), "vibe-session.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  delete record.stack.storybookIdentity;
  writeFileSync(recordPath, JSON.stringify(record));
  const unproven = runNode(SCRIPT, ["stop", "--worktree", worktree], home);
  assert.deepEqual(unproven.json.processes.map(({ result }) => result), ["left-alone"]);
  assert.notEqual(processInfo(pid), null);
  const ledger = path.join(home, ".claude", "vibe", "owned-pids.json");
  mkdirSync(path.dirname(ledger), { recursive: true });
  const firstStarted = processInfo(pid).started;
  writeFileSync(ledger, JSON.stringify({ [pid]: { cwd: launchCwd, started: firstStarted } }));
  const stopped = runNode(SCRIPT, ["stop", "--worktree", worktree], home);
  assert.deepEqual(stopped.json.processes.map(({ result }) => result), ["stopped"]);
  assert.equal(processInfo(pid), null);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const reused = longRunning(t, root, launchCwd, "storybook dev");
  await waitFor(() => processInfo(reused));
  record.stack = { storybookPid: reused };
  writeFileSync(recordPath, JSON.stringify(record));
  writeFileSync(ledger, JSON.stringify({ [reused]: { cwd: launchCwd, started: firstStarted } }));
  const stale = runNode(SCRIPT, ["stop", "--worktree", worktree], home);
  assert.deepEqual(stale.json.processes.map(({ result }) => result), ["left-alone"]);
  assert.notEqual(processInfo(reused), null);
});

test("repeating desktop-launched cannot promote a reused PID with an old log (ISS-13321)", async (t) => {
  const { root, home, cleanup } = makeHome("vibe-session-desktop-reused-");
  t.after(cleanup);
  const checkout = path.join(home, "Documents", "Closedloop.ai - Active Work", "symphony-alpha");
  makeCheckout({ root, home, checkout, files: { "README.md": "seed\n" } });
  const created = runNode(SCRIPT, ["new", "--repo", checkout, "--slug", "desktop-reuse", "--summary", "desktop reuse", "--mode", "blank",
    "--operator-id", "user-operator", "--operator-email", "operator@example.com"], home);
  assert.equal(created.status, 0, created.stderr);
  const worktree = created.json.session.worktree;
  const first = longRunning(t, root, worktree, "vibe:profile launch");
  await waitFor(() => processInfo(first));
  const gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"], home);
  const log = path.join(gitDir, "vibe-desktop.log");
  writeFileSync(log, "Desktop window visible\n");
  const launched = runNode(SCRIPT, ["desktop-launched", "--worktree", worktree, "--pid", String(first), "--log", log], home);
  assert.equal(launched.status, 0, launched.stderr);
  const firstIdentity = launched.json.session.stack.desktopIdentity;
  assert.match(firstIdentity, /^[0-9a-f]{64}$/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const reused = longRunning(t, root, worktree, "vibe:profile launch");
  await waitFor(() => processInfo(reused));
  const recordPath = path.join(gitDir, "vibe-session.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.stack.desktopPid = reused;
  writeFileSync(recordPath, JSON.stringify(record));
  const repeated = runNode(SCRIPT, ["desktop-launched", "--worktree", worktree, "--pid", String(reused), "--log", log], home);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.json.session.stack.desktopIdentity, firstIdentity);
  const stopped = runNode(SCRIPT, ["stop", "--worktree", worktree], home);
  assert.deepEqual(stopped.json.processes.map(({ result }) => result), ["left-alone"]);
  assert.notEqual(processInfo(reused), null);
});
