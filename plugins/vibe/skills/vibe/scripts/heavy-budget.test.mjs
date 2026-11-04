import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { budgetDisabled, computeBudget, concurrencyEnv, createBudget, DEFAULTS, ENV, isHeavyCommand, parseProcessList, resolveSettings, unleasedHeavyLoad } from "./heavy-budget.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function memoryFs() {
  const files = new Map();
  return {
    files,
    fs: {
      mkdir: () => {},
      list: () => [...files.keys()].map((file) => path.basename(file)),
      read: (file) => files.get(file),
      write: (file, text) => files.set(file, text),
      remove: (file) => files.delete(file),
    },
  };
}

function harness({ cores = 10, ps = [], alive = () => true, env = {}, pid = 100 } = {}) {
  const memory = memoryFs();
  const budget = createBudget({ env, cores, pid, now: () => 1_000, processes: () => ps, isAlive: alive, leaseDir: "/leases", fs: memory.fs });
  return { budget, ...memory };
}

test("the defaults are one frozen object and every one is overridable by the environment", () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  const settings = resolveSettings({ [ENV.targetUtilisation]: "0.5", [ENV.minWorkers]: "3" });
  assert.equal(settings.targetUtilisation, 0.5);
  assert.equal(settings.minWorkers, 3);
  assert.equal(resolveSettings({ [ENV.targetUtilisation]: "banana", [ENV.minWorkers]: "0" }).targetUtilisation, DEFAULTS.targetUtilisation);
  assert.equal(resolveSettings({ [ENV.minWorkers]: "0" }).minWorkers, DEFAULTS.minWorkers);
  assert.equal(budgetDisabled({}), true, "opt-in: unset leaves the previous behavior");
  assert.equal(budgetDisabled({ [ENV.off]: "off" }), true);
  assert.equal(budgetDisabled({ [ENV.off]: "on" }), false);
});

test("only CPU-heavy commands are heavy: test, typecheck, lint and build runs and the heavy tools; git, node scripts and echo are not", () => {
  for (const [command, args] of [["pnpm", ["test:affected"]], ["pnpm", ["--filter", "app", "test"]], ["pnpm", ["typecheck:affected"]], ["npx", ["vitest", "run"]], ["/usr/bin/env", ["turbo", "test"]],
    [process.execPath, ["pre-pr-lanes.mjs", "run", "--command", "AFFECTED='a b' pnpm test:lint"]], ["pnpm", ["check:source-gates"]], ["pnpm", ["exec", "playwright", "test"]]]) {
    assert.equal(isHeavyCommand(command, args), true, `${command} ${args.join(" ")}`);
  }
  for (const [command, args] of [["git", ["status"]], ["echo", ["hello"]], [process.execPath, ["pre-pr-lanes.mjs", "check", "--report", "r.txt"]], ["pnpm", ["install"]], ["gh", ["pr", "view"]]]) {
    assert.equal(isHeavyCommand(command, args), false, `${command} ${args.join(" ")}`);
  }
});

test("budget is what is left of cores times target utilisation after leased workers and unleased heavy CPU", () => {
  const budget = computeBudget({ cores: 10, targetUtilisation: 0.8, minWorkers: 2, leases: [{ workers: 3 }], unleasedCores: 1.5 });
  assert.equal(budget.capacity, 8);
  assert.equal(budget.available, 3);
  assert.equal(budget.workers, 3);
  assert.equal(budget.belowMinimum, false);
  const none = computeBudget({ cores: 10, targetUtilisation: 0.8, minWorkers: 2, leases: [{ workers: 8 }], unleasedCores: 4 });
  assert.equal(none.available, 0);
  assert.equal(none.belowMinimum, true);
  assert.equal(none.workers, 2);
});

test("a lease whose pid is dead is removed and never counted; a live one is counted", () => {
  const { budget, files } = harness({ alive: (pid) => pid === 200 });
  files.set("/leases/a.json", JSON.stringify({ id: "a", pid: 200, workers: 4 }));
  files.set("/leases/b.json", JSON.stringify({ id: "b", pid: 201, workers: 4 }));
  files.set("/leases/c.json", "not json");
  const snapshot = budget.snapshot();
  assert.equal(snapshot.leases, 1);
  assert.equal(snapshot.leasedWorkers, 4);
  assert.deepEqual([...files.keys()], ["/leases/a.json"]);
});

test("heavy processes with no lease are summed by CPU share; a leased run's own workers and this process's tree are not counted twice", () => {
  const ps = parseProcessList([
    "  300     1  250.0 node /x/node_modules/vitest/vitest.mjs run",
    "  301   300  400.0 node /x/node_modules/vitest/workers/forks.js",
    "  400     1  120.0 node /y/turbo run test",
    "  500   200  300.0 node /z/vitest.mjs run",
    "  501   100  200.0 node /w/playwright test",
    "  600     1   99.0 /usr/bin/python3 server.py",
  ].join("\n"));
  const unleased = unleasedHeavyLoad(ps, [{ pid: 200 }], 100);
  assert.deepEqual(unleased.pids.sort(), [300, 400]);
  assert.ok(Math.abs(unleased.cores - 3.7) < 1e-9, String(unleased.cores));
});

test("a run starting beside an unleased vitest run gets only what is left, with no real load involved", () => {
  const { budget } = harness({ ps: parseProcessList("  300     1  500.0 node vitest.mjs run\n") });
  const snapshot = budget.snapshot();
  assert.equal(snapshot.cores, 10);
  assert.equal(snapshot.available, 3);
  assert.equal(snapshot.workers, 3);
});

test("acquire records a lease for the child's lifetime and release removes it; the next run sees it in between", () => {
  const { budget, files } = harness();
  const taken = budget.acquire({ command: "pnpm", args: ["test:affected"] });
  assert.equal(taken.workers, 8);
  assert.equal(files.size, 1);
  assert.equal(budget.snapshot().leasedWorkers, 8);
  assert.equal(budget.snapshot().belowMinimum, true);
  taken.release();
  assert.equal(files.size, 0);
  assert.equal(budget.snapshot().available, 8);
});

test("the child's concurrency never goes above what the caller already set, and fits the workers it was given", () => {
  assert.deepEqual(concurrencyEnv(8, {}), { TURBO_TEST_CONCURRENCY: "2", VITEST_MAX_WORKERS: "4" });
  assert.deepEqual(concurrencyEnv(2, {}), { TURBO_TEST_CONCURRENCY: "1", VITEST_MAX_WORKERS: "2" });
  assert.deepEqual(concurrencyEnv(8, { TURBO_TEST_CONCURRENCY: "1", VITEST_MAX_WORKERS: "1" }), { TURBO_TEST_CONCURRENCY: "1", VITEST_MAX_WORKERS: "1" });
});

test("the status command prints a snapshot from a real process scan without error", () => {
  const result = spawnSync(process.execPath, [path.join(HERE, "heavy-budget.mjs"), "status"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, [ENV.leaseDir]: path.join(process.env.TMPDIR ?? "/tmp", `vibe-heavy-test-${process.pid}`) } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).cores >= 1);
});
