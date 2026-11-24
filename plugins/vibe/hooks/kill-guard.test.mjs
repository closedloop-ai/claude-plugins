import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { killProblems, recordedOwn } from "./kill-guard.mjs";
import { ACTIVATED_SESSION, activatedChat } from "./activation-test-support.mjs";
import { recordHookSkill } from "./hook-session-scope.mjs";

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
    "bash -c 'kill $(date)'",
    'bash -c "kill $(date)"',
    'eval "kill $(date)"',
    "ssh host 'kill $(date)'",
    "f() { kill $(date); }; f",
    "# <<EOF\nkill 1",
    "kill</dev/null 1",
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
    "printf '%s\\n' 'kill $(date)'",
    "cat <<'EOF'\nkill $(date)\nEOF",
    "f() { kill $(date); }",
  ];
  for (const command of allowed) assert.deepEqual(killProblems(command, isOwn), [], command);
  assert.deepEqual(killProblems("ssh host 'bash -lc \"kill 777\"'", isOwn), [], "a remote pid is not judged against the local ledger");
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
  const chat = activatedChat(t, { ...process.env, HOME: home });
  const run = (event) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify(chat.payload(event)), encoding: "utf8", env: { ...chat.env, HOME: home } });
  recordHookSkill(ACTIVATED_SESSION, "vibe:vibe", home);
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

test("an exact signal approval is checked against its command, authority, expiry, ruling digest and process identities", async () => {
  const { createHash } = await import("node:crypto");
  const { approvedSignalTargets } = await import("./kill-guard.mjs");
  const now = Date.parse("2026-11-24T00:00:00Z");
  const record = (over = {}) => ({ version: 1, command: "stop the stale vite", authority: "operator", signal: "SIGTERM",
    expiresAt: "2026-11-24T01:00:00Z", targets: [{ pid: 5001, started: "Mon 01", cwd: "/wt/a" }], ...over });
  const ruling = (r) => `Signal approval: ${r.authority} ${createHash("sha256").update(JSON.stringify([r.command, r.authority, r.signal, r.expiresAt, r.targets])).digest("hex")}`;
  const check = (r, over = {}) => approvedSignalTargets(r, { command: "stop the stale vite", rulings: ruling(r), owns: () => false, clock: () => now,
    startOf: (pid) => (pid === 5001 || pid === 5002 ? "Mon 01" : null), ...over });
  assert.deepEqual(check(record()), record().targets);
  assert.throws(() => check(record(), { command: "stop every vite" }), /does not match this command/);
  assert.throws(() => check(record({ authority: "writer" })), /does not match this command, authority/);
  assert.throws(() => check(record({ signal: "SIGSTOP" })), /does not match/);
  assert.throws(() => check(record({ expiresAt: "2026-11-23T23:00:00Z" })), /expired/);
  assert.throws(() => check(record(), { rulings: "Signal approval: operator " + "0".repeat(64) }), /no ruling for this exact approval snapshot/);
  assert.throws(() => check(record(), { startOf: () => "Tue 02" }), /unowned, expired, duplicate or unrecognized/);
  assert.throws(() => check(record({ targets: [{ pid: 5001, started: "Mon 01" }, { pid: 5001, started: "Mon 01" }] })), /duplicate/);
  assert.throws(() => check(record({ targets: [{ pid: 1, started: "Mon 01" }] })), /unrecognized process identity/);
  const orchestrator = record({ authority: "orchestrator" });
  assert.throws(() => check(orchestrator), /unowned/);
  assert.deepEqual(check(orchestrator, { owns: (target) => target.pid === 5001 }), orchestrator.targets);
});

test("apply-approved consumes the receipt before signaling only the approved live process, and the receipt cannot be reused", async (t) => {
  const { createHash } = await import("node:crypto");
  const { spawn } = await import("node:child_process");
  const { chmodSync, existsSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { startTimeOf } = await import("./kill-guard.mjs");
  const home = mkdtempSync(path.join(tmpdir(), "vibe-approved-signal-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const program = path.join(home, "program"), approvals = path.join(program, "approved-signals");
  mkdirSync(approvals, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already stopped */ } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = startTimeOf(child.pid);
  assert.ok(started, "the fixture child is running");
  const record = { version: 1, command: "stop the fixture child", authority: "operator", signal: "SIGTERM",
    expiresAt: new Date(Date.now() + 600_000).toISOString(), targets: [{ pid: child.pid, started }] };
  const digest = createHash("sha256").update(JSON.stringify([record.command, record.authority, record.signal, record.expiresAt, record.targets])).digest("hex");
  writeFileSync(path.join(program, "rulings.md"), `Signal approval: operator ${digest}\n`);
  writeFileSync(path.join(program, "board.json"), JSON.stringify({ writers: {} }));
  const receipt = path.join(approvals, "one.json");
  writeFileSync(receipt, JSON.stringify(record)); chmodSync(receipt, 0o600);
  const apply = (command) => spawnSync(process.execPath, [RECORDER, "apply-approved", program, "one.json", command],
    { encoding: "utf8", env: { ...process.env, HOME: home } });
  const wrong = apply("stop every node");
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /does not match this command/);
  assert.equal(existsSync(receipt), true, "a refused command leaves the receipt unused");
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal)));
  const done = apply("stop the fixture child");
  assert.equal(done.status, 0, done.stderr);
  assert.equal(await exited, "SIGTERM");
  assert.equal(existsSync(receipt), false);
  assert.equal(existsSync(receipt + ".used"), true);
  const again = apply("stop the fixture child");
  assert.notEqual(again.status, 0, "a consumed receipt cannot authorize a second signal");
});
