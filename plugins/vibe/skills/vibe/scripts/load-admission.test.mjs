import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBudget, DEFAULTS, ENV, parseProcessList, resolveSettings } from "./heavy-budget.mjs";
import { classifyLoadFailure, runAdmitted, Signature, waitForAdmission } from "./load-admission.mjs";
import { runBoundedDetailed } from "./run-bounded.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const settings = resolveSettings({});

/** A machine under a fake load: `busy(time)` returns the cores some other tool's run uses at that moment. */
function machine({ cores = 10, busy = () => 0, pid = 100 } = {}) {
  const clock = { t: 0 };
  const files = new Map();
  const budget = createBudget({
    env: {}, cores, pid, now: () => clock.t, isAlive: () => true, leaseDir: "/leases",
    processes: () => parseProcessList(`  900     1  ${busy(clock.t) * 100}.0 node vitest.mjs run\n`),
    fs: { mkdir: () => {}, list: () => [...files.keys()].map((file) => path.basename(file)), read: (file) => files.get(file), write: (file, text) => files.set(file, text), remove: (file) => files.delete(file) },
  });
  const sleeps = [];
  return { clock, budget, files, sleeps, sleep: async (ms) => { sleeps.push(ms); clock.t += ms; }, now: () => clock.t };
}

const ok = { code: 0, output: "" };

test("exit 137 and out-of-memory are load failures; a failing assertion never is, even beside a kill", () => {
  assert.deepEqual(classifyLoadFailure({ exitCode: 137, output: "", loadHigh: false }), { retry: true, signature: Signature.Sigkill });
  assert.equal(classifyLoadFailure({ exitCode: 1, output: "FATAL ERROR: JavaScript heap out of memory", loadHigh: false }).signature, Signature.OutOfMemory);
  assert.deepEqual(classifyLoadFailure({ exitCode: 1, output: "AssertionError: expected 1 to be 2", loadHigh: true }), { retry: false, signature: Signature.Assertion });
  assert.deepEqual(classifyLoadFailure({ exitCode: 137, output: "FAIL a.test.ts\nAssertionError: expected 'a' to equal 'b'", loadHigh: true }), { retry: false, signature: Signature.Assertion });
  assert.deepEqual(classifyLoadFailure({ exitCode: 1, output: "TypeError: x is not a function", loadHigh: true }), { retry: false, signature: null });
});

test("timeouts and dropped connections are load failures only while the machine was loaded at the start", () => {
  const timeout = "Error: Test timed out in 5000ms.";
  assert.equal(classifyLoadFailure({ exitCode: 1, output: timeout, loadHigh: true }).signature, Signature.TestTimeout);
  assert.deepEqual(classifyLoadFailure({ exitCode: 1, output: timeout, loadHigh: false }), { retry: false, signature: null });
  assert.equal(classifyLoadFailure({ exitCode: 124, output: "", loadHigh: true }).signature, Signature.RunTimeout);
  assert.equal(classifyLoadFailure({ exitCode: 124, output: "", loadHigh: false }).retry, false);
  assert.equal(classifyLoadFailure({ exitCode: 1, output: "read ECONNRESET", loadHigh: true }).signature, Signature.StarvedServer);
  assert.equal(classifyLoadFailure({ exitCode: 1, output: "write EPIPE", loadHigh: false }).retry, false);
  assert.equal(classifyLoadFailure({ exitCode: 0, output: "", loadHigh: true }).retry, false);
});

test("below the minimum, admission waits with backoff (bounded sleeps, no busy loop), then proceeds when capacity frees", async () => {
  const m = machine({ busy: (t) => (t < 30_000 ? 8 : 0) });
  const admission = await waitForAdmission({ budget: m.budget, settings, sleep: m.sleep, now: m.now });
  assert.equal(admission.timedOut, false);
  assert.equal(admission.snapshot.belowMinimum, false);
  assert.deepEqual(m.sleeps, [5000, 7500, 11_250, 16_875]);
  assert.ok(m.sleeps.every((ms) => ms >= 5000), "every poll sleeps; none spins");
});

test("past the maximum wait it proceeds at the minimum worker count instead of failing", async () => {
  const m = machine({ busy: () => 9 });
  const result = await runAdmitted("pnpm", ["test"], { seconds: 60, budget: m.budget, settings, sleep: m.sleep, now: m.now, loadAverage: () => 30, run: async (_c, _a, options) => ({ code: Number(options.env.VITEST_MAX_WORKERS) === 2 ? 0 : 1, output: "" }) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.attempts[0].workers, DEFAULTS.minWorkers);
  assert.equal(result.admission, "waited-timed-out");
  assert.ok(result.waitedMs >= settings.maxWaitSeconds * 1000);
  assert.equal(result.loadAtStart.belowMinimum, true);
});

test("three concurrent runs under a fake load wait for each other instead of failing, and each is admitted", async () => {
  // One shared machine: each run holds a lease while it runs (a fake 20 s), so the second and third see no capacity until it ends.
  const m = machine();
  const events = [];
  const run = (name) => runAdmitted("pnpm", ["test"], { seconds: 60, budget: m.budget, settings, sleep: m.sleep, now: m.now, loadAverage: () => 12,
    run: async () => { events.push(`start ${name} at ${m.clock.t}`); await m.sleep(20_000); events.push(`end ${name}`); return ok; } });
  // Serialized by the fake clock: a run only polls after the one ahead released.
  const results = [];
  for (const name of ["a", "b", "c"]) results.push(await run(name));
  assert.deepEqual(results.map((r) => r.exitCode), [0, 0, 0]);
  assert.deepEqual(results.map((r) => r.retried), [false, false, false]);
  assert.equal(m.files.size, 0, "every lease is released");
});

test("a retry fixes a 137: one retry at half the workers after waiting, and the result keeps the first failure's provenance", async () => {
  const m = machine();
  const seen = [];
  const result = await runAdmitted("pnpm", ["test"], { seconds: 60, budget: m.budget, settings, sleep: m.sleep, now: m.now, loadAverage: () => 20,
    run: async (_c, _a, options) => { seen.push(Number(options.env.VITEST_MAX_WORKERS)); return seen.length === 1 ? { code: 137, output: "Killed: 9" } : ok; } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.retried, true);
  assert.equal(result.firstFailureSignature, Signature.Sigkill);
  assert.deepEqual(result.attempts.map((a) => [a.attempt, a.exitCode, a.signature]), [[1, 137, Signature.Sigkill], [2, 0, null]]);
  assert.equal(result.attempts[1].workers, result.attempts[0].workers / 2);
  assert.ok(seen[1] < seen[0] || seen[0] === 1);
  assert.equal(result.loadAtStart.load1, 20);
});

test("a failing assertion is never retried, and neither is a failure with no load signature", async () => {
  for (const output of ["AssertionError: expected 3 to be 4", "TypeError: boom"]) {
    const m = machine();
    let calls = 0;
    const result = await runAdmitted("pnpm", ["test"], { seconds: 60, budget: m.budget, settings, sleep: m.sleep, now: m.now, loadAverage: () => 20, run: async () => { calls += 1; return { code: 1, output }; } });
    assert.equal(calls, 1, output);
    assert.equal(result.exitCode, 1);
    assert.equal(result.retried, false);
  }
});

test("a second failure is final: the exit is the retry's own non-zero code, never a pass", async () => {
  const m = machine();
  let calls = 0;
  const result = await runAdmitted("pnpm", ["test"], { seconds: 60, budget: m.budget, settings, sleep: m.sleep, now: m.now, loadAverage: () => 20, run: async () => { calls += 1; return { code: 137, output: "" }; } });
  assert.equal(calls, 2);
  assert.equal(result.exitCode, 137);
  assert.equal(result.attempts.length, 2);
});

test("the switches restore the old behavior: no retry with VIBE_HEAVY_RETRY=off, no wait with VIBE_HEAVY_WAIT=off", async () => {
  const noRetry = machine();
  let calls = 0;
  const first = await runAdmitted("pnpm", ["test"], { seconds: 60, env: { [ENV.retry]: "off" }, budget: noRetry.budget, settings, sleep: noRetry.sleep, now: noRetry.now, loadAverage: () => 20, run: async () => { calls += 1; return { code: 137, output: "" }; } });
  assert.equal(calls, 1);
  assert.equal(first.exitCode, 137);
  const noWait = machine({ busy: () => 9 });
  const second = await runAdmitted("pnpm", ["test"], { seconds: 60, env: { [ENV.wait]: "off" }, budget: noWait.budget, settings, sleep: noWait.sleep, now: noWait.now, loadAverage: () => 20, run: async () => ok });
  assert.deepEqual(noWait.sleeps, []);
  assert.equal(second.exitCode, 0);
});

test("run-bounded keeps streaming output while capturing its tail, and reports the exit code", async () => {
  const result = await runBoundedDetailed(process.execPath, ["-e", "console.log('hello'); console.error('oops'); process.exit(5)"], { seconds: 20, capture: true });
  assert.equal(result.code, 5);
  assert.match(result.output, /hello/);
  assert.match(result.output, /oops/);
});

test("the CLI prints the attempts line for a heavy command and leaves a non-heavy one alone", () => {
  const script = path.join(HERE, "run-bounded.mjs");
  const env = { ...process.env, [ENV.leaseDir]: path.join(process.env.TMPDIR ?? "/tmp", `vibe-heavy-cli-${process.pid}`) };
  const heavy = spawnSync(process.execPath, [script, "20", process.execPath, "-e", "process.exit(0)", "vitest"], { encoding: "utf8", timeout: 40_000, env });
  assert.equal(heavy.status, 0, heavy.stderr);
  assert.match(heavy.stderr, /run-bounded-result: \{.*"attempts":\[\{"attempt":1/);
  const light = spawnSync(process.execPath, [script, "20", process.execPath, "-e", "process.exit(0)"], { encoding: "utf8", timeout: 40_000, env });
  assert.doesNotMatch(light.stderr, /run-bounded-result/);
});
