import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBounded, TIMED_OUT_EXIT } from "./run-bounded.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-bounded.mjs");

test("a command that finishes in time keeps its own output and exit code", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "20", process.execPath, "-e",
    "process.stdout.write('done'); process.exit(3)"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.stdout, "done");
  assert.equal(result.status, 3);
});

test("a command past its limit is stopped with everything it started, exiting 124", async () => {
  // The child starts a grandchild that would outlive a plain kill of the child.
  const code = await runBounded(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stdout.write(String(grandchild.pid));
    setInterval(() => {}, 1000);
  `], { seconds: 1, stdio: ["ignore", "pipe", "ignore"] });
  assert.equal(code, TIMED_OUT_EXIT);
});

test("the stopped command's whole process group is gone after a time out", async () => {
  const result = spawnSync(process.execPath, [SCRIPT, "1", process.execPath, "-e", `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    console.log(grandchild.pid);
    setInterval(() => {}, 1000);
  `], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, TIMED_OUT_EXIT, result.stderr);
  assert.match(result.stderr, /stopped after 1s/);
  const grandchild = Number(result.stdout.trim());
  assert.ok(grandchild > 1);
  // A killed grandchild whose parent already exited still answers a liveness probe until it is reaped, so wait, bounded, for it to go.
  const gone = () => {
    try {
      process.kill(grandchild, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  };
  for (let waited = 0; waited < 5000 && !gone(); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(grandchild, 0), { code: "ESRCH" });
});

test("a missing limit or command is refused instead of running unbounded", () => {
  const noLimit = spawnSync(process.execPath, [SCRIPT, "soon", "true"], { encoding: "utf8" });
  assert.equal(noLimit.status, 2);
  assert.match(noLimit.stderr, /positive number of seconds/);
  const noCommand = spawnSync(process.execPath, [SCRIPT, "5"], { encoding: "utf8" });
  assert.equal(noCommand.status, 2);
  assert.match(noCommand.stderr, /Usage/);
});

test("a heavy command takes a worker budget and a lease and its environment is capped; a non-heavy command is untouched (ISS-13584)", async () => {
  const { runBudgeted } = await import("./run-bounded.mjs");
  const taken = [];
  const snapshot = { cores: 8, capacity: 8, available: 4, belowMinimum: false, workers: 4, leases: 0, unleasedCores: 0 };
  const fakeBudget = { snapshot: () => snapshot, acquire: (request) => { taken.push(request); return { workers: 4, env: { TURBO_TEST_CONCURRENCY: "2", VITEST_MAX_WORKERS: "2" }, budget: { available: 4, capacity: 8, leases: 0, unleasedCores: 0 }, release: () => taken.push("released") }; } };
  const printEnv = ["-e", "process.exit(process.env.VITEST_MAX_WORKERS === '2' ? 0 : 9)"];
  // Not heavy: no lease, and the child does not see the cap.
  const on = { VIBE_HEAVY_BUDGET: "on" };
  assert.equal((await runBudgeted(process.execPath, printEnv, { seconds: 20, budget: fakeBudget, env: on })).exitCode, 9);
  assert.deepEqual(taken, []);
  // Heavy (names vitest): leased, capped, released after the child ends.
  assert.equal((await runBudgeted(process.execPath, [...printEnv, "vitest"], { seconds: 20, budget: fakeBudget, env: on, loadAverage: () => 0 })).exitCode, 0);
  assert.equal(taken.length, 2);
  assert.equal(taken[1], "released");
  // Unset (the default) or off: previous behavior, no lease.
  taken.length = 0;
  for (const env of [{}, { VIBE_HEAVY_BUDGET: "off" }]) {
    assert.equal((await runBudgeted(process.execPath, [...printEnv, "vitest"], { seconds: 20, budget: fakeBudget, env })).exitCode, 9);
    assert.deepEqual(taken, []);
  }
});

test("a SIGTERM to run-bounded reaches the child's process group instead of orphaning it", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const wrapper = spawn(process.execPath, [SCRIPT, "60", process.execPath, "-e", "console.log(process.pid);setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "inherit"] });
  const childPid = Number(await new Promise((resolve) => wrapper.stdout.once("data", (chunk) => resolve(String(chunk).trim()))));
  wrapper.kill("SIGTERM");
  await once(wrapper, "close");
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" }, "the child is gone once its wrapper was terminated");
});
