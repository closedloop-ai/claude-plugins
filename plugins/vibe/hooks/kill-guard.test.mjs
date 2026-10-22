import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { killProblems, recordedOwn } from "./kill-guard.mjs";

// No test here sends a signal: every case asks the guard for a decision only.
const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "kill-guard.mjs");
const OWN = 4242;
const isOwn = (pid) => pid === OWN;

test("pattern kills, group kills and unrecorded pids are refused; kill of a recorded pid passes (writer-727 pkill)", () => {
  const refused = [
    'pkill -f "turbo test --filter"',
    "killall node",
    "sudo pkill -9 vitest",
    "cd /wt && pkill -f e2e",
    "pgrep -f vitest | xargs kill",
    "kill $(pgrep -f vitest)",
    "kill $PID",
    "kill -- -1",
    "kill -9 -1",
    "kill 0",
    "kill -TERM 1",
    "kill -- -4242",
    "kill 777",
    "kill -s TERM 777",
  ];
  for (const command of refused) assert.notDeepEqual(killProblems(command, isOwn), [], command);
  const allowed = [
    `kill ${OWN}`,
    `kill -9 ${OWN}`,
    `kill -s TERM ${OWN} 2>/dev/null`,
    `kill -- ${OWN} && echo done`,
    "kill -l",
    "kill %1",
    'git commit -m "stop the watcher"',
    "ps aux | grep kill",
    "echo kill",
  ];
  for (const command of allowed) assert.deepEqual(killProblems(command, isOwn), [], command);
});

test("a recorded pid is own only from its directory and while the same process runs", () => {
  const ledger = { 4242: { cwd: "/src/wt", started: "Thu Oct 22 09:00:00 2026" } };
  const same = () => "Thu Oct 22 09:00:00 2026";
  assert.equal(recordedOwn(ledger, 4242, "/src/wt", same), true);
  assert.equal(recordedOwn(ledger, 4242, "/src/wt/apps/api", same), true);
  assert.equal(recordedOwn(ledger, 4242, "/src/other", same), false, "another session's directory");
  assert.equal(recordedOwn(ledger, 4242, "/src/wt", () => "Thu Oct 22 11:00:00 2026"), false, "the pid was reused");
  assert.equal(recordedOwn(ledger, 4242, "/src/wt", () => null), false, "no longer running");
  assert.equal(recordedOwn(ledger, 5000, "/src/wt", same), false);
});

test("the hook denies a refused Bash command and stays silent otherwise", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "kill-guard-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = (event) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify(event), encoding: "utf8", env: { ...process.env, HOME: home } });
  const denied = run({ tool_name: "Bash", cwd: home, tool_input: { command: 'pkill -f "turbo test"' } });
  assert.equal(denied.status, 0);
  const decision = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /pkill signals by pattern/);
  assert.equal(run({ tool_name: "Bash", cwd: home, tool_input: { command: "kill 4242" } }).stdout.length > 0, true, "an unrecorded pid is denied");
  assert.equal(run({ tool_name: "Bash", cwd: home, tool_input: { command: "ls -la" } }).stdout, "");
  assert.equal(run({ tool_name: "Read", tool_input: { file_path: "x" } }).stdout, "");
  const refusedRecord = spawnSync(process.execPath, [GUARD, "own", "1"], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(refusedRecord.status, 1);
  assert.match(refusedRecord.stderr, /only a pid above 1/);
});
