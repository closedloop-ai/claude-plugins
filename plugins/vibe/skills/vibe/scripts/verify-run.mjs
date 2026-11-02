#!/usr/bin/env node
// The scriptable part of `vibe-verify-worker` (PRD-823, WS3 D5, ISS-13347):
// run the repository's own required checks at an exact head, bounded, and write
// ONE evidence JSON that keeps every outcome distinct. It runs nothing the
// repository does not already define: Biome through `pnpm exec biome check` on
// the changed files, `pnpm check:source-gates`, `pnpm typecheck:affected`, the
// lanes `pnpm test:lanes` names (through `pre-pr-lanes.mjs`, which owns their
// records, the not-run rules and main-preexisting), and the selected tests the
// verify worker supplies. Every command goes through `run-bounded.mjs`.
//
// Usage: verify-run.mjs --worktree <path> --head <sha> [--base <sha>] [--tests-file <file>]
//                       [--out <file>] [--no-cache] [--no-lanes]
//   --tests-file  [{ "file": "<source path>", "selector": "code_tests_for"|"related",
//                    "tests": ["<test path>"], "command": "<the package command that runs them>" }]
//                 The graph's `code_tests_for` is an MCP tool this script cannot call, so
//                 the worker supplies its result; an entry with no command is `not-run`.
//
// Evidence statuses, never merged: `passed` (ran at this head and exited 0),
// `failed`, `blocked` (could not run, or timed out on this machine),
// `cached` (a pass at this same head and command from an earlier run, never
// reported as `passed`), `main-preexisting` (a lane that also fails on the
// captured main), `no-op` (the check has nothing to check on this diff, with
// the reason), `skipped` and `not-run` (not executed here, with the reason and
// who runs it). A skipped, no-op, cached or not-run entry is never a pass, and
// `ok` is true only when every required check is `passed` or `cached`. The
// evidence lists what is left to the verify worker under `leftToWorker`:
// E2E specs, story plays, touch flows and the control sweep run in a browser.
//
// `coveredByNoLane` lists the paths the lane report says no lane covers (null when the
// report was not read). It is reported only and does not change `ok`.
//
// A typecheck or other turbo run that replayed every task from its cache is
// `cached` with `cachedFrom.kind` `turbo-cache`, never `passed`: the code did not run.
//
// Lanes are scheduled, never skipped (ISS-13587, lane-pool.mjs): pure script-suite lanes run in
// a pool sized from the worker budget (at most 2 by default), every other lane, and any lane the
// pool list does not name, runs serially, and e2e lanes run under e2e-lock.mjs. The records come
// back in lane-report order whatever finished first. `scheduling` in the evidence is additive.
// VIBE_VERIFY_POOL=serial (or VIBE_HEAVY_BUDGET=off) restores the previous strictly serial path.
//
// Background (ISS-13586, verify-background.mjs): `--background` starts the same run detached and prints a
// run id at once; `--status <id>` and `--wait <id>` (both need --worktree) read its record under
// `<gitdir>/vibe-verify-runs/`. A run whose process is gone without a result is `orphaned`, a run
// whose result is for another head than the worktree's (or `--head`) is `head-moved`; only `passed`
// exits 0 (failed 1, unknown 2, orphaned 3, running 4, head-moved 5). Without these flags nothing changes.
//
// Exits 0 only when `ok`. Prints the evidence; with --out writes it too (by
// default `<gitdir>/vibe-verify-evidence.json`).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { RESULT_PREFIX } from "./run-bounded.mjs";
import { reportLanes } from "./pre-pr-lanes.mjs";
import { budgetDisabled, createBudget, resolveSettings } from "./heavy-budget.mjs";
import { classifyLane, LaneKind, poolSizeFor, runScheduled } from "./lane-pool.mjs";
import { readRun, RunExit, startBackground, waitForRun, writeRecord } from "./verify-background.mjs";
import { execCommand, execCommandAsync, parseJson, tailLines, toolDidNotRun } from "./ws3-exec.mjs";

export const SCHEMA = "vibe.verify-evidence/1";
export const Status = Object.freeze({
  Passed: "passed", Failed: "failed", Blocked: "blocked", Cached: "cached", MainPreexisting: "main-preexisting",
  NoOp: "no-op", Skipped: "skipped", NotRun: "not-run",
});
// Fixed per-check limits: a check that outruns its limit is `blocked` on this machine, not failed and not passed.
export const TIME_LIMITS = Object.freeze({ biome: 300, sourceGates: 600, typecheck: 900, lane: 1800, tests: 900, report: 300 });
const TIMED_OUT = 124;
const BIOME_FILE = /\.(?:tsx?|jsx?|mjs|cjs|json|jsonc|css)$/;
const BIOME_CHUNK = 200;
export const LEFT_TO_WORKER = Object.freeze([
  { name: "e2e-specs", reason: "E2E specs run through the tier the capability probe selects, under the repository's lock" },
  { name: "story-plays", reason: "story plays run in a real browser and are judged by story-play-verdict.mjs" },
  { name: "touch-flows", reason: "touch flows run through Playwright device descriptors" },
  { name: "control-sweep", reason: "the control sweep drives the running web app and Desktop" },
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const BOUNDED = path.join(here, "run-bounded.mjs");
const PRE_PR_LANES = path.join(here, "pre-pr-lanes.mjs");
const E2E_LOCK = path.join(here, "e2e-lock.mjs");

const required = (name, command, status, extra = {}) => ({ name, command, status, required: true, ...extra });

/** The load provenance run-bounded.mjs printed for a heavy run (attempts, first-failure signature, load at start), or null when it ran once with no wait. */
export function loadProvenance(stderr) {
  const line = String(stderr).split("\n").reverse().find((text) => text.startsWith(RESULT_PREFIX));
  const parsed = line ? parseJson(line.slice(RESULT_PREFIX.length), null) : null;
  if (!parsed || (!parsed.retried && parsed.admission === "immediate")) return null;
  return { attempts: parsed.attempts, retried: parsed.retried, firstFailureSignature: parsed.firstFailureSignature, loadAtStart: parsed.loadAtStart, waitedMs: parsed.waitedMs, admission: parsed.admission };
}

/** The lane report's lines this script acts on, from `pre-pr-lanes.mjs check`'s output. */
export function parseLaneCheck(output) {
  const grab = (prefix, pattern) => output.split("\n").filter((line) => line.startsWith(prefix)).map((line) => pattern.exec(line)).filter(Boolean);
  return {
    missing: grab("MISSING-LANE ", /^MISSING-LANE (.*?): run it,? with/).map((match) => match[1]),
    notRun: grab("NOT-RUN-LANE ", /^NOT-RUN-LANE (.*) \((.*)\)$/).map((match) => ({ lane: match[1], reason: match[2] })),
    mainPreexisting: grab("MAIN-PREEXISTING-LANE ", /^MAIN-PREEXISTING-LANE (.*?) \(/).map((match) => match[1]),
    skipped: grab("SKIPPED-LANE ", /^SKIPPED-LANE (.*) \((.*)\)$/).map((match) => ({ lane: match[1], reason: match[2] })),
  };
}

/** The paths the lane report says no lane covers (its `COVERED BY NO LANE` block), or [] when it names none. */
export function uncoveredPaths(report) {
  const lines = report.split("\n");
  const at = lines.findIndex((line) => /^COVERED BY NO LANE\b/.test(line));
  if (at < 0) return [];
  const paths = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^ {4}\S/.test(line)) break;
    paths.push(line.trim());
  }
  return paths;
}

/** A turbo run that replayed every task from its cache (`N cached, N total` or FULL TURBO): the code did not run. */
export function turboReplay(output) {
  const match = /(\d+) cached, (\d+) total/.exec(output);
  if (match && Number(match[1]) === Number(match[2]) && Number(match[2]) > 0) return `${match[1]} cached, ${match[2]} total`;
  return /FULL TURBO/.test(output) ? "FULL TURBO" : null;
}

/** Whether every required check is satisfied: a pass at this head or a cached pass. Nothing skipped, no-op, not run or failed counts. */
export function evidenceOk(checks) {
  const requiredChecks = checks.filter((check) => check.required);
  return requiredChecks.length > 0 && requiredChecks.every((check) => check.status === Status.Passed || check.status === Status.Cached);
}

/** The counts per status, so a reader sees skipped and cached next to passed. */
export function summarize(checks) {
  const counts = Object.fromEntries(Object.values(Status).map((status) => [status, 0]));
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

export function createVerifyRun({
  run = execCommand,
  read = (file) => readFileSync(file, "utf8"),
  write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); },
  exists = existsSync,
  now = () => Date.now(),
  runAsync = execCommandAsync,
  budget = null,
  env = process.env,
  onProgress = () => {},
} = {}) {
  /** One bounded command through run-bounded.mjs: its exit code, a time out as 124, and the output tail on failure. */
  function bounded(seconds, command, args, cwd) {
    const started = now();
    const result = run(process.execPath, [BOUNDED, String(seconds), command, ...args], { cwd, timeoutMs: (seconds + 30) * 1000 });
    const load = loadProvenance(result.stderr);
    return { ...result, durationMs: now() - started, ...(load ? { load } : {}) };
  }

  async function boundedAsync(seconds, command, args, cwd) {
    const started = now();
    const result = await runAsync(process.execPath, [BOUNDED, String(seconds), command, ...args], { cwd, timeoutMs: (seconds + 30) * 1000 });
    const load = loadProvenance(result.stderr);
    return { ...result, durationMs: now() - started, ...(load ? { load } : {}) };
  }

  function outcome(result, seconds) {
    if (result.status === 0) return { status: Status.Passed };
    if (result.status === TIMED_OUT) return { status: Status.Blocked, reason: `stopped after ${seconds}s on this machine; not a pass and not a failure of the session` };
    const missing = toolDidNotRun(result);
    if (missing) return { status: Status.Blocked, reason: `${missing}; the check did not run, so it is neither a pass nor a failure of the session` };
    return { status: Status.Failed, evidenceTail: tailLines(`${result.stdout}\n${result.stderr}`) };
  }

  function loadCache(file) {
    return exists(file) ? parseJson(read(file), {}) : {};
  }

  function scripts(worktree) {
    return parseJson(read(path.join(worktree, "package.json")), {})?.scripts ?? {};
  }

  /** One repository command as a required check: cached at the same head, skipped if the script is missing. */
  function repoCheck({ name, scriptName, command, args, seconds, worktree, head, cache, useCache }) {
    const full = `${command} ${args.join(" ")}`;
    if (scriptName && !(scriptName in scripts(worktree))) {
      return required(name, full, Status.Skipped, { reason: `the repository defines no "${scriptName}" script` });
    }
    if (!exists(path.join(worktree, "node_modules"))) {
      return required(name, full, Status.Blocked, { reason: "dependencies are not installed in the worktree (no node_modules), so the check did not run" });
    }
    const hit = useCache ? cache[`${head}\u0000${full}`] : null;
    if (hit) return required(name, full, Status.Cached, { cachedFrom: { head: hit.head, ranAt: hit.at } });
    const result = bounded(seconds, command, args, worktree);
    const done = outcome(result, seconds);
    const replay = done.status === Status.Passed ? turboReplay(`${result.stdout}\n${result.stderr}`) : null;
    if (replay) {
      return required(name, full, Status.Cached, { exitCode: result.status, durationMs: result.durationMs, cachedFrom: { kind: "turbo-cache", detail: replay, head }, reason: "turbo replayed every task from its cache, so the code did not run in this invocation" });
    }
    if (done.status === Status.Passed) cache[`${head}\u0000${full}`] = { head, at: new Date(now()).toISOString() };
    return required(name, full, done.status, { exitCode: result.status, durationMs: result.durationMs, ...(done.reason ? { reason: done.reason } : {}), ...(done.evidenceTail ? { evidenceTail: done.evidenceTail } : {}), ...(result.load ? { load: result.load } : {}) });
  }

  function biomeCheck({ files, worktree, head, cache, useCache }) {
    const targets = files.filter((file) => BIOME_FILE.test(file) && exists(path.join(worktree, file)));
    if (targets.length === 0) return required("biome", "pnpm exec biome check", Status.NoOp, { reason: "no changed file is one Biome checks" });
    let last = null;
    for (let at = 0; at < targets.length; at += BIOME_CHUNK) {
      const chunk = targets.slice(at, at + BIOME_CHUNK);
      last = repoCheck({ name: "biome", command: "pnpm", args: ["exec", "biome", "check", ...chunk], seconds: TIME_LIMITS.biome, worktree, head, cache, useCache });
      if (last.status !== Status.Passed && last.status !== Status.Cached) break;
    }
    return { ...last, command: `pnpm exec biome check <${targets.length} changed files>`, files: targets.length };
  }

  /** The lane report, the lane check and the records that need no run; each lane still to run carries its key and its scheduling class. */
  function planLanes({ worktree, head, cache, useCache, state }) {
    const gitDir = run("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"]).stdout.trim();
    const reportRun = bounded(TIME_LIMITS.report, "pnpm", ["test:lanes"], worktree);
    if (reportRun.status !== 0) {
      return { done: [required("lanes", "pnpm test:lanes", Status.Blocked, { reason: "the repository's lane report did not run", exitCode: reportRun.status, evidenceTail: tailLines(`${reportRun.stdout}\n${reportRun.stderr}`) })] };
    }
    state.coveredByNoLane = uncoveredPaths(reportRun.stdout);
    const lanes = reportLanes(reportRun.stdout);
    if (lanes === null) return { done: [required("lanes", "pnpm test:lanes", Status.Blocked, { reason: "the lane report names no lane and does not say nothing changed" })] };
    if (lanes.length === 0) return { done: [required("lanes", "pnpm test:lanes", Status.NoOp, { reason: "the lane report says there is nothing to cover on this diff" })] };
    const reportFile = path.join(gitDir, "vibe-verify-lane-report.txt");
    write(reportFile, reportRun.stdout);
    const checked = parseLaneCheck(run(process.execPath, [PRE_PR_LANES, "check", "--worktree", worktree, "--report", reportFile]).stdout);
    const entries = lanes.map((lane) => {
      const name = `lane: ${lane}`;
      const notRun = checked.notRun.find((item) => item.lane === lane);
      if (notRun) return { record: required(name, lane, Status.NotRun, { reason: notRun.reason, owner: "ci" }) };
      if (checked.mainPreexisting.includes(lane)) return { record: required(name, lane, Status.MainPreexisting, { reason: "also fails on the captured main", owner: "known main failures" }) };
      if (!checked.missing.includes(lane)) return { record: required(name, lane, Status.Cached, { reason: "a passing record at this head exists from an earlier run" }) };
      const key = `${head}\u0000${lane}`;
      if (useCache && cache[key]) return { record: required(name, lane, Status.Cached, { cachedFrom: { head: cache[key].head, ranAt: cache[key].at } }) };
      const schedule = classifyLane(lane, env);
      return { name, lane, key, worktree, head, reportFile, schedule };
    });
    return { entries };
  }

  function laneCommand(entry, { locked }) {
    const inner = [process.execPath, PRE_PR_LANES, "run", "--worktree", entry.worktree, "--head", entry.head, "--command", entry.lane, "--report", entry.reportFile];
    return locked && entry.schedule.e2e ? [process.execPath, [E2E_LOCK, "run", "--head", entry.head, ...inner]] : [inner[0], inner.slice(1)];
  }

  /** The record for a lane that ran, and the cache entry for a pass. */
  function laneRecord(entry, result, cache) {
    const done = outcome(result, TIME_LIMITS.lane);
    if (done.status === Status.Passed) cache[entry.key] = { head: entry.head, at: new Date(now()).toISOString() };
    return required(entry.name, entry.lane, done.status, { exitCode: result.status, durationMs: result.durationMs, ...(done.reason ? { reason: done.reason } : {}), ...(done.evidenceTail ? { evidenceTail: done.evidenceTail } : {}), ...(result.load ? { load: result.load } : {}) });
  }

  function laneChecks(context) {
    const plan = planLanes(context);
    if (plan.done) return plan.done;
    return plan.entries.map((entry) => {
      if (entry.record) return entry.record;
      const [command, args] = laneCommand(entry, { locked: false });
      const record = laneRecord(entry, bounded(TIME_LIMITS.lane, command, args, entry.worktree), context.cache);
      onProgress({ stage: "lane", name: entry.name, status: record.status });
      return record;
    });
  }

  /** The same records as `laneChecks`, with independent lanes running at once (lane-pool.mjs); the records come back in lane-report order whatever finished first. */
  async function laneChecksPooled(context) {
    const plan = planLanes(context);
    if (plan.done) return { checks: plan.done, scheduling: null };
    const settings = resolveSettings(env);
    const snapshot = budgetDisabled(env) ? null : (budget ?? createBudget({ env })).snapshot();
    const size = poolSizeFor({ env, settings, snapshot });
    const toRun = plan.entries.filter((entry) => !entry.record);
    const started = now();
    const results = await runScheduled(toRun.map((entry) => ({ entry, serial: entry.schedule.kind === LaneKind.Serial })), {
      size,
      run: ({ entry }) => {
        const [command, args] = laneCommand(entry, { locked: true });
        return boundedAsync(TIME_LIMITS.lane, command, args, entry.worktree).then((result) => {
          onProgress({ stage: "lane", name: entry.name, exitCode: result.status });
          return result;
        });
      },
    });
    const byEntry = new Map(toRun.map((entry, index) => [entry, results[index]]));
    const checks = plan.entries.map((entry) => {
      if (entry.record) return entry.record;
      const result = byEntry.get(entry);
      if (result?.error) return required(entry.name, entry.lane, Status.Blocked, { reason: `the lane could not be started: ${result.error instanceof Error ? result.error.message : String(result.error)}` });
      return { ...laneRecord(entry, result, context.cache), scheduled: entry.schedule.kind };
    });
    return { checks, scheduling: { mode: "pooled", poolSize: size, pooled: toRun.filter((entry) => entry.schedule.kind === LaneKind.Pool).length, serial: toRun.filter((entry) => entry.schedule.kind === LaneKind.Serial).length, wallMs: now() - started } };
  }

  function selectedTests({ entries, worktree }) {
    if (!Array.isArray(entries)) {
      return [{ name: "selected-tests", command: null, status: Status.NotRun, required: false, owner: "verify-worker", reason: "no --tests-file: the graph's code_tests_for is an MCP tool this script cannot call" }];
    }
    const byCommand = new Map();
    for (const entry of entries) {
      const command = typeof entry?.command === "string" ? entry.command.trim() : "";
      const key = command || `no-command:${entry?.file}`;
      const group = byCommand.get(key) ?? { command, files: [], tests: new Set(), selectors: new Set() };
      group.files.push(entry?.file);
      for (const test of entry?.tests ?? []) group.tests.add(test);
      if (entry?.selector) group.selectors.add(entry.selector);
      byCommand.set(key, group);
    }
    return [...byCommand.values()].map((group) => {
      const base = { name: `tests: ${group.command || group.files.join(", ")}`, required: false, files: group.files, tests: [...group.tests], selectors: [...group.selectors] };
      if (!group.command) return { ...base, command: null, status: Status.NotRun, owner: "verify-worker", reason: "the selection named no command to run its tests" };
      const [command, ...args] = group.command.split(/\s+/);
      const result = bounded(TIME_LIMITS.tests, command, args, worktree);
      const done = outcome(result, TIME_LIMITS.tests);
      return { ...base, command: group.command, status: done.status, exitCode: result.status, durationMs: result.durationMs, ...(done.reason ? { reason: done.reason } : {}), ...(done.evidenceTail ? { evidenceTail: done.evidenceTail } : {}), ...(result.load ? { load: result.load } : {}) };
    });
  }

  /** Everything before the lanes. `done` is the finished evidence when the worktree is not at the intended head or is dirty. */
  function begin({ worktree, head, base, useCache = true }) {
    const gitDir = run("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"]).stdout.trim();
    const actual = run("git", ["-C", worktree, "rev-parse", "HEAD"]).stdout.trim();
    const dirty = run("git", ["-C", worktree, "status", "--porcelain", "--untracked-files=no"]).stdout.trim();
    const evidence = { schema: SCHEMA, head: actual, base: base ?? null, ranAt: new Date(now()).toISOString(), checks: [], coveredByNoLane: null, leftToWorker: LEFT_TO_WORKER };
    const intended = (head ?? "").toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(intended) || !actual.startsWith(intended) || dirty) {
      const reason = !actual.startsWith(intended) ? `HEAD-MISMATCH the worktree is at ${actual.slice(0, 12)}, not ${head}` : `DIRTY-WORKTREE modified tracked files: ${dirty.split("\n").map((line) => line.replace(/^\s*\S+\s+/, "")).join(", ")}`;
      evidence.checks = ["biome", "source-gates", "typecheck", "lanes"].map((name) => required(name, null, Status.Blocked, { reason }));
      return { done: finish(evidence) };
    }
    const cacheFile = path.join(gitDir, "vibe-verify-cache.json");
    const cache = useCache ? loadCache(cacheFile) : {};
    const baseRef = base ?? run("git", ["-C", worktree, "merge-base", "HEAD", "origin/main"]).stdout.trim();
    evidence.base = baseRef || null;
    const changed = run("git", ["-C", worktree, "diff", "--name-only", "--diff-filter=AMR", `${baseRef}...HEAD`]).stdout.split("\n").filter(Boolean);
    const state = { coveredByNoLane: null };
    const common = { worktree, head: actual, cache, useCache };
    evidence.checks.push(
      biomeCheck({ files: changed, ...common }),
      repoCheck({ name: "source-gates", scriptName: "check:source-gates", command: "pnpm", args: ["check:source-gates"], seconds: TIME_LIMITS.sourceGates, ...common }),
      repoCheck({ name: "typecheck", scriptName: "typecheck:affected", command: "pnpm", args: ["typecheck:affected"], seconds: TIME_LIMITS.typecheck, ...common }),
    );
    onProgress({ stage: "checks", names: evidence.checks.map((check) => `${check.name}: ${check.status}`) });
    return { evidence, common, state, cache, cacheFile, useCache };
  }

  function conclude({ evidence, state, cache, cacheFile, useCache }, { worktree, testsFile }) {
    evidence.checks.push(...selectedTests({ entries: testsFile ? parseJson(read(testsFile), null) : null, worktree }));
    evidence.coveredByNoLane = state.coveredByNoLane;
    if (useCache) write(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
    return finish(evidence);
  }

  const notRunLanes = () => [required("lanes", "pnpm test:lanes", Status.NotRun, { reason: "--no-lanes was given", owner: "verify-worker" })];

  /** Runs every scriptable check at `head` and returns the evidence; lanes run one after another. */
  function verify(options) {
    const begun = begin(options);
    if (begun.done) return begun.done;
    begun.evidence.checks.push(...(options.runLanes ?? true ? laneChecks({ ...begun.common, state: begun.state }) : notRunLanes()));
    return conclude(begun, options);
  }

  /** `verify` with independent lanes running at once. VIBE_VERIFY_POOL=serial gives exactly `verify`. */
  async function verifyPooled(options) {
    const begun = begin(options);
    if (begun.done) return begun.done;
    if (options.runLanes ?? true) {
      const { checks, scheduling } = await laneChecksPooled({ ...begun.common, state: begun.state });
      begun.evidence.checks.push(...checks);
      if (scheduling) begun.evidence.scheduling = scheduling;
    } else {
      begun.evidence.checks.push(...notRunLanes());
    }
    return conclude(begun, options);
  }

  function finish(evidence) {
    return { ...evidence, ok: evidenceOk(evidence.checks), summary: summarize(evidence.checks) };
  }

  return { verify, verifyPooled };
}

/** Whether lanes run strictly one after another: VIBE_VERIFY_POOL=serial, or the whole budget switched off. */
export function strictlySerial(env = process.env) {
  return String(env.VIBE_VERIFY_POOL ?? "").trim().toLowerCase() === "serial" || budgetDisabled(env);
}

const OPTIONS = {
  worktree: { type: "string" }, head: { type: "string" }, base: { type: "string" }, "tests-file": { type: "string" },
  out: { type: "string" }, "no-cache": { type: "boolean", default: false }, "no-lanes": { type: "boolean", default: false },
  background: { type: "boolean", default: false }, status: { type: "string" }, wait: { type: "string" }, "wait-seconds": { type: "string" }, "run-id": { type: "string" },
};

function gitDirOf(worktree) {
  return execCommand("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"]).stdout.trim();
}

/** `--status <id>` and `--wait <id>`: print the run's state and exit 0 only for a pass. */
async function joinRun(values) {
  const gitDir = gitDirOf(values.worktree);
  const id = values.status ?? values.wait;
  const read = () => readRun({ gitDir, id, currentHead: execCommand("git", ["-C", values.worktree, "rev-parse", "HEAD"]).stdout.trim(), expectedHead: values.head });
  const run = values.wait ? await waitForRun({ read, waitSeconds: Number(values["wait-seconds"] ?? 7200) }) : read();
  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  return RunExit[run.state] ?? 1;
}

function startRun(values) {
  const passArgs = [];
  for (const name of ["base", "tests-file"]) if (values[name]) passArgs.push(`--${name}`, values[name]);
  for (const name of ["no-cache", "no-lanes"]) if (values[name]) passArgs.push(`--${name}`);
  const started = startBackground({ gitDir: gitDirOf(values.worktree), worktree: values.worktree, head: values.head, scriptPath: fileURLToPath(import.meta.url), passArgs });
  process.stdout.write(`${JSON.stringify(started, null, 2)}\n`);
  return 0;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS });
  if (values.status || values.wait) {
    if (!values.worktree) throw new Error("--worktree is required with --status and --wait.");
    return joinRun(values);
  }
  if (!values.worktree || !values.head) throw new Error("--worktree and --head are required.");
  if (values.background) return startRun(values);
  const gitDir = gitDirOf(values.worktree);
  const runId = values["run-id"];
  const progress = [];
  const record = (patch) => { if (runId) writeRecord(gitDir, runId, patch); };
  const controller = createVerifyRun({
    onProgress: (event) => {
      progress.push({ ...event, at: new Date().toISOString() });
      record({ progress, heartbeatAt: new Date().toISOString() });
    },
  });
  const options = {
    worktree: values.worktree, head: values.head, base: values.base, testsFile: values["tests-file"],
    useCache: !values["no-cache"], runLanes: !values["no-lanes"],
  };
  record({ state: "running", pid: process.pid });
  let evidence;
  try {
    evidence = strictlySerial() ? controller.verify(options) : await controller.verifyPooled(options);
  } catch (error) {
    record({ state: "error", error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
    throw error;
  }
  const out = values.out ?? path.join(gitDir, "vibe-verify-evidence.json");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  record({ state: "finished", ok: evidence.ok, summary: evidence.summary, evidenceHead: evidence.head, evidenceFile: out, finishedAt: new Date().toISOString() });
  process.stdout.write(`${JSON.stringify({ ...evidence, evidenceFile: out }, null, 2)}\n`);
  return evidence.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
