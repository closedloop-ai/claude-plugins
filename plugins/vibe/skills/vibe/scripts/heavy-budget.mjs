#!/usr/bin/env node
// Cross-run worker budget (PRD-823, WS8 load-aware execution, W1, ISS-13584). Every vitest or turbo run sizes
// its workers to the core count without knowing about other runs, so concurrent runs
// multiply each other. Before a heavy command starts, this counts what is already
// running on the machine and leaves the command what is left of
// cores * target utilisation.
//
// Outstanding runs are found two ways, both machine-wide:
//   1. Leases: one JSON file per heavy run that went through this script (pid, start
//      time, workers it was given), in one directory. A lease whose pid is gone is
//      removed and never counted.
//   2. A process scan for vitest, turbo, playwright and jest processes that hold no
//      lease (another tool's or another agent's run), summed by CPU share. Processes
//      that descend from a leased run or from this process are the run's own workers
//      and are not counted twice.
//
// The scanner, clock, core count, process list, pid liveness and file system are all
// injectable, so tests need no real load.
//
// Usage: heavy-budget.mjs status      prints the current budget snapshot as JSON
//
// Every default is in DEFAULTS, one frozen object, and every one is overridable by
// an environment variable named in ENV. The budget is opt-in: VIBE_HEAVY_BUDGET=on enables it, and without that
// the previous behavior holds (no budget, no lease, the command's own concurrency).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Operational parameters nobody has specified yet (flagged for the owner in the pull request).
export const DEFAULTS = Object.freeze({
  targetUtilisation: 0.8,
  minWorkers: 2,
  // The ambient turbo test fan-out of the target repository (scripts/test-affected.sh uses 2); never raised above the caller's own value.
  turboTestConcurrency: 2,
  // W2 (ISS-13585): wait for capacity, then retry a load failure once at half the workers.
  maxWaitSeconds: 600,
  pollSeconds: 5,
  pollBackoffFactor: 1.5,
  maxPollSeconds: 30,
  retries: 1,
  retryWorkerDivisor: 2,
  highLoadPerCore: 1.5,
  // W4 (ISS-13587): independent verify lanes run in a pool this large at most, fewer when the budget has less to spare.
  poolSize: 2,
});

export const ENV = Object.freeze({
  off: "VIBE_HEAVY_BUDGET",
  cores: "VIBE_HEAVY_CORES",
  targetUtilisation: "VIBE_HEAVY_TARGET",
  minWorkers: "VIBE_HEAVY_MIN_WORKERS",
  leaseDir: "VIBE_HEAVY_LEASE_DIR",
  maxWaitSeconds: "VIBE_HEAVY_MAX_WAIT_SECONDS",
  retries: "VIBE_HEAVY_RETRIES",
  highLoadPerCore: "VIBE_HEAVY_HIGH_LOAD_PER_CORE",
  poolSize: "VIBE_VERIFY_POOL_SIZE",
  poolable: "VIBE_VERIFY_POOLABLE",
});

const HEAVY_TOOLS = new Set(["vitest", "jest", "playwright", "turbo", "tsc", "dagger"]);
const PACKAGE_RUNNERS = new Set(["pnpm", "npm", "npx", "yarn"]);
const HEAVY_SCRIPT = /^(?:test|typecheck|lint|build|verify|check)(?::|$)/;
const HEAVY_PROCESS = /(?:^|[\s/])(?:vitest|turbo|playwright|jest)(?:\.[cm]?js)?(?:\s|$)/;
const STRIP_QUOTES = /^['"]+|['"]+$/g;

export function numberSetting(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** The effective settings: DEFAULTS overridden by the environment; a malformed override falls back to the default. */
export function resolveSettings(env = process.env) {
  return Object.freeze({
    ...DEFAULTS,
    targetUtilisation: numberSetting(env, ENV.targetUtilisation, DEFAULTS.targetUtilisation, { min: 0.05, max: 1 }),
    minWorkers: Math.floor(numberSetting(env, ENV.minWorkers, DEFAULTS.minWorkers, { min: 1 })),
    maxWaitSeconds: numberSetting(env, ENV.maxWaitSeconds, DEFAULTS.maxWaitSeconds, { min: 0 }),
    retries: Math.floor(numberSetting(env, ENV.retries, DEFAULTS.retries, { min: 0, max: 3 })),
    highLoadPerCore: numberSetting(env, ENV.highLoadPerCore, DEFAULTS.highLoadPerCore, { min: 0.1 }),
    poolSize: Math.floor(numberSetting(env, ENV.poolSize, DEFAULTS.poolSize, { min: 1, max: 8 })),
  });
}

/** Whether the budget is off: it is opt-in, so anything but `VIBE_HEAVY_BUDGET=on` leaves the previous behavior. */
export function budgetDisabled(env = process.env) {
  return !(env[ENV.off] === "on");
}

/** Whether a command is CPU-heavy: a known heavy tool, or a package runner invoked with a test, typecheck, lint, build, verify or check script. */
export function isHeavyCommand(command, args = []) {
  const tokens = [command, ...args].flatMap((part) => String(part).split(/\s+/)).map((token) => token.replace(STRIP_QUOTES, "")).filter(Boolean);
  const names = tokens.map((token) => path.basename(token));
  if (names.some((name) => HEAVY_TOOLS.has(name))) return true;
  const runner = names.findIndex((name) => PACKAGE_RUNNERS.has(name));
  return runner >= 0 && tokens.slice(runner + 1).some((token) => HEAVY_SCRIPT.test(token));
}

/** Parses `ps -axo pid=,ppid=,pcpu=,command=` output into process records. */
export function parseProcessList(text) {
  return String(text).split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line))
    .filter(Boolean).map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]), command: match[4] }));
}

/** The machine's processes; an unreadable list is empty, so the scan never blocks a run. */
export function scanProcesses() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pcpu=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? parseProcessList(result.stdout) : [];
}

function descendantsOf(roots, processes) {
  const owned = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const proc of processes) {
      if (!owned.has(proc.pid) && owned.has(proc.ppid)) {
        owned.add(proc.pid);
        grew = true;
      }
    }
  }
  return owned;
}

/** Cores worth of CPU used by heavy processes that hold no lease and are not this process or its descendants, and the pids counted. */
export function unleasedHeavyLoad(processes, leases, selfPid) {
  const owned = descendantsOf([selfPid, ...leases.map((lease) => lease.pid)], processes);
  const counted = processes.filter((proc) => !owned.has(proc.pid) && HEAVY_PROCESS.test(proc.command));
  return { cores: counted.reduce((sum, proc) => sum + proc.cpu / 100, 0), pids: counted.map((proc) => proc.pid) };
}

/** What is left for a new run. `belowMinimum` says the machine has fewer than `minWorkers` cores to spare; the grant is then `minWorkers`. */
export function computeBudget({ cores, targetUtilisation, minWorkers, leases, unleasedCores }) {
  const capacity = cores * targetUtilisation;
  const leased = leases.reduce((sum, lease) => sum + lease.workers, 0);
  const available = Math.max(0, Math.floor(capacity - leased - unleasedCores));
  const belowMinimum = available < minWorkers;
  return { cores, capacity, leasedWorkers: leased, unleasedCores, available, belowMinimum, workers: belowMinimum ? minWorkers : Math.min(available, cores) };
}

/** The concurrency environment for `workers`, never above what the caller already set. */
export function concurrencyEnv(workers, env = process.env, settings = DEFAULTS) {
  const ambientTurbo = numberSetting(env, "TURBO_TEST_CONCURRENCY", settings.turboTestConcurrency, { min: 1 });
  const tasks = Math.max(1, Math.min(Math.floor(ambientTurbo), Math.floor(workers / settings.minWorkers)));
  const perTask = Math.max(1, Math.floor(workers / tasks));
  const cap = (name, wanted) => String(Math.min(wanted, numberSetting(env, name, wanted, { min: 1 })));
  return {
    TURBO_TEST_CONCURRENCY: cap("TURBO_TEST_CONCURRENCY", tasks),
    VITEST_MAX_WORKERS: cap("VITEST_MAX_WORKERS", perTask),
  };
}

export function createBudget({
  env = process.env,
  cores = numberSetting(env, ENV.cores, os.availableParallelism?.() ?? os.cpus().length, { min: 1 }),
  now = () => Date.now(),
  pid = process.pid,
  processes = scanProcesses,
  isAlive = (candidate) => { try { process.kill(candidate, 0); return true; } catch (error) { return error?.code === "EPERM"; } },
  leaseDir = env[ENV.leaseDir] || path.join(os.homedir(), ".codex", "vibe", "locks", "heavy-budget"),
  fs = { mkdir: (dir) => mkdirSync(dir, { recursive: true }), list: (dir) => (existsSync(dir) ? readdirSync(dir) : []), read: (file) => readFileSync(file, "utf8"), write: (file, text) => writeFileSync(file, text), remove: (file) => { try { unlinkSync(file); } catch { /* already gone */ } } },
} = {}) {
  const settings = resolveSettings(env);
  let counter = 0;

  /** Live leases; a lease whose pid is gone, or whose file is unreadable, is removed. */
  function liveLeases() {
    const live = [];
    for (const name of fs.list(leaseDir).filter((file) => file.endsWith(".json"))) {
      const file = path.join(leaseDir, name);
      let lease = null;
      try { lease = JSON.parse(fs.read(file)); } catch { /* unreadable */ }
      if (lease && Number.isInteger(lease.pid) && Number.isFinite(lease.workers) && isAlive(lease.pid)) live.push(lease);
      else fs.remove(file);
    }
    return live;
  }

  /** The budget a run starting now would get. */
  function snapshot() {
    const leases = liveLeases();
    const unleased = unleasedHeavyLoad(processes(), leases, pid);
    return { ...computeBudget({ cores, targetUtilisation: settings.targetUtilisation, minWorkers: settings.minWorkers, leases, unleasedCores: unleased.cores }), leases: leases.length, unleasedPids: unleased.pids, takenAt: new Date(now()).toISOString() };
  }

  /** Takes the budget and records a lease for the child's lifetime; `release` removes it. */
  function acquire({ command, args = [], budget = snapshot() }) {
    fs.mkdir(leaseDir);
    counter += 1;
    const id = `${pid}-${now()}-${counter}`;
    const file = path.join(leaseDir, `${id}.json`);
    fs.write(file, `${JSON.stringify({ id, pid, startedAt: new Date(now()).toISOString(), workers: budget.workers, command: [command, ...args].join(" ").slice(0, 300) })}\n`);
    return { id, workers: budget.workers, budget, env: concurrencyEnv(budget.workers, env, settings), release: () => fs.remove(file) };
  }

  return { settings, snapshot, acquire, liveLeases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] !== "status") {
    process.stderr.write("Usage: heavy-budget.mjs status\n");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(createBudget().snapshot(), null, 2)}\n`);
}
