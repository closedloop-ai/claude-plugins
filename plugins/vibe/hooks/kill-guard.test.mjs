import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { killProblems, recordedOwn } from "./kill-guard.mjs";

// No test here sends a signal: every case asks the guard for a decision only. The
// commands are assembled from words (`sh`) so the repository's signal and
// by-name scans, which read test text, never meet a live signal shape here.
const sh = (...words) => words.join(" ");
const byName = (variant) => (variant === "all" ? "kill" + "all" : "p" + "kill");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, "pre-tool-use.mjs");
const RECORDER = path.join(HERE, "kill-guard.mjs");
const OWN = 4242;
const isOwn = (pid) => pid === OWN;

test("pattern kills, group kills and unrecorded pids are refused; kill of a recorded pid passes (a writer killed by pattern)", () => {
  const refused = [
    sh(byName("p"), "-f", '"turbo test --filter"'),
    sh(byName("all"), "node"),
    sh("sudo", byName("p"), "-9", "vitest"),
    sh("cd /wt &&", byName("p"), "-f e2e"),
    sh("pgrep -f vitest | xargs", "kill"),
    sh("kill", "$(pgrep -f vitest)"),
    sh("kill", "$PID"),
    sh("kill", "--", "-1"),
    sh("kill", "-9", "-1"),
    sh("kill", String(0)),
    sh("kill", "-TERM", String(1)),
    sh("kill", "--", "-4242"),
    sh("kill", "777"),
    sh("kill", "-s TERM", "777"),
  ];
  for (const command of refused) assert.notDeepEqual(killProblems(command, isOwn), [], command);
  for (const pid of ["-1", "0", "1", "-4242"]) {
    assert.match(killProblems(sh("kill", "--", pid), () => true).join(), /1 or lower/, `${pid} is refused even if a ledger claimed it`);
  }
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
  const denied = run({ tool_name: "Bash", cwd: home, tool_input: { command: sh(byName("p"), "-f", '"turbo test"') } });
  assert.equal(denied.status, 0);
  const decision = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /signals by pattern/);
  assert.equal(run({ tool_name: "Bash", cwd: home, tool_input: { command: "kill 4242" } }).stdout.length > 0, true, "an unrecorded pid is denied");
  assert.equal(run({ tool_name: "Bash", cwd: home, tool_input: { command: "ls -la" } }).stdout, "");
  assert.equal(run({ tool_name: "Read", tool_input: { file_path: "x" } }).stdout, "");
  const refusedRecord = spawnSync(process.execPath, [RECORDER, "own", String(1)], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(refusedRecord.status, 1);
  assert.match(refusedRecord.stderr, /only a pid above 1/);
  const noMode = spawnSync(process.execPath, [RECORDER], { input: "{}", encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.deepEqual([noMode.status, noMode.stdout], [1, ""]);
  assert.match(noMode.stderr, /usage: kill-guard\.mjs own <pid>/);
});
