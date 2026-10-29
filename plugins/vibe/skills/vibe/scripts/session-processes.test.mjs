import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ownership, processInfo, stopSessionProcesses } from "./session-processes.mjs";
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
  assert.deepEqual(ownership("storybook", null, worktree), { owned: false, reason: "not running" });
  assert.equal(ownership("storybook", { command: "node storybook dev -p 6100", cwd: worktree }, worktree).owned, true);
  assert.equal(ownership("storybook", { command: "node storybook dev -p 6100", cwd: path.join(worktree, "apps/storybook") }, worktree).owned, true);
  assert.equal(ownership("storybook", { command: "node something-else", cwd: worktree }, worktree).owned, false, "a reused pid running another program");
  assert.equal(ownership("storybook", { command: "node storybook dev", cwd: path.join(root, "other") }, worktree).owned, false, "another session's Storybook");
  assert.equal(ownership("desktop", { command: "pnpm --filter desktop vibe:profile launch --profile p", cwd: worktree }, worktree).owned, true);
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
  const { results, stack } = await stopSessionProcesses(worktree, { storybookPid: ours, storybookUrl: "http://localhost:6100", desktopPid: reused, other: 1 }, { waitMs: 5000 });
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
  await waitFor(() => processInfo(first));
  runNode(SCRIPT, ["touch", "--worktree", worktree, "--stack", JSON.stringify({ storybookPid: first, storybookUrl: "http://localhost:6101" })], home);
  const stopped = runNode(SCRIPT, ["stop", "--worktree", worktree], home);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.deepEqual(stopped.json.processes.map(({ result }) => result), ["stopped"]);
  assert.equal(processInfo(first), null);
  assert.equal(runNode(SCRIPT, ["show", "--worktree", worktree], home).json.session.stack, null);
  const second = longRunning(t, root, worktree, "storybook dev");
  await waitFor(() => processInfo(second));
  runNode(SCRIPT, ["touch", "--worktree", worktree, "--stack", JSON.stringify({ storybookPid: second })], home);
  const discarded = runNode(SCRIPT, ["discard", "--worktree", worktree, "--confirm"], home);
  assert.equal(discarded.status, 0, discarded.stdout + discarded.stderr);
  assert.deepEqual(discarded.json.processes.map(({ result }) => result), ["stopped"]);
  assert.equal(processInfo(second), null);
  assert.equal(git(checkout, ["branch", "--list", "vibe/stop-me"], home), "");
});
