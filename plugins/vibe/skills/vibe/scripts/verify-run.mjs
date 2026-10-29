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
// Exits 0 only when `ok`. Prints the evidence; with --out writes it too (by
// default `<gitdir>/vibe-verify-evidence.json`).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { reportLanes } from "./pre-pr-lanes.mjs";
import { execCommand, parseJson, tailLines } from "./ws3-exec.mjs";

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

const required = (name, command, status, extra = {}) => ({ name, command, status, required: true, ...extra });

/** The lane report's lines this script acts on, from `pre-pr-lanes.mjs check`'s output. */
export function parseLaneCheck(output) {
  const grab = (prefix, pattern) => output.split("\n").filter((line) => line.startsWith(prefix)).map((line) => pattern.exec(line)).filter(Boolean);
  return {
    missing: grab("MISSING-LANE ", /^MISSING-LANE (.*?): run it, with/).map((match) => match[1]),
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
} = {}) {
  /** One bounded command through run-bounded.mjs: its exit code, a time out as 124, and the output tail on failure. */
  function bounded(seconds, command, args, cwd) {
    const started = now();
    const result = run(process.execPath, [BOUNDED, String(seconds), command, ...args], { cwd, timeoutMs: (seconds + 30) * 1000 });
    return { ...result, durationMs: now() - started };
  }

  function outcome(result, seconds) {
    if (result.status === 0) return { status: Status.Passed };
    if (result.status === TIMED_OUT) return { status: Status.Blocked, reason: `stopped after ${seconds}s on this machine; not a pass and not a failure of the session` };
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
    const hit = useCache ? cache[`${head}\u0000${full}`] : null;
    if (hit) return required(name, full, Status.Cached, { cachedFrom: { head: hit.head, ranAt: hit.at } });
    const result = bounded(seconds, command, args, worktree);
    const done = outcome(result, seconds);
    const replay = done.status === Status.Passed ? turboReplay(`${result.stdout}\n${result.stderr}`) : null;
    if (replay) {
      return required(name, full, Status.Cached, { exitCode: result.status, durationMs: result.durationMs, cachedFrom: { kind: "turbo-cache", detail: replay, head }, reason: "turbo replayed every task from its cache, so the code did not run in this invocation" });
    }
    if (done.status === Status.Passed) cache[`${head}\u0000${full}`] = { head, at: new Date(now()).toISOString() };
    return required(name, full, done.status, { exitCode: result.status, durationMs: result.durationMs, ...(done.reason ? { reason: done.reason } : {}), ...(done.evidenceTail ? { evidenceTail: done.evidenceTail } : {}) });
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

  function laneChecks({ worktree, head, cache, useCache, state }) {
    const gitDir = run("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"]).stdout.trim();
    const reportRun = bounded(TIME_LIMITS.report, "pnpm", ["test:lanes"], worktree);
    if (reportRun.status !== 0) {
      return [required("lanes", "pnpm test:lanes", Status.Blocked, { reason: "the repository's lane report did not run", exitCode: reportRun.status, evidenceTail: tailLines(`${reportRun.stdout}\n${reportRun.stderr}`) })];
    }
    state.coveredByNoLane = uncoveredPaths(reportRun.stdout);
    const lanes = reportLanes(reportRun.stdout);
    if (lanes === null) return [required("lanes", "pnpm test:lanes", Status.Blocked, { reason: "the lane report names no lane and does not say nothing changed" })];
    if (lanes.length === 0) return [required("lanes", "pnpm test:lanes", Status.NoOp, { reason: "the lane report says there is nothing to cover on this diff" })];
    const reportFile = path.join(gitDir, "vibe-verify-lane-report.txt");
    write(reportFile, reportRun.stdout);
    const checked = parseLaneCheck(run(process.execPath, [PRE_PR_LANES, "check", "--worktree", worktree, "--report", reportFile]).stdout);
    return lanes.map((lane) => {
      const name = `lane: ${lane}`;
      const notRun = checked.notRun.find((item) => item.lane === lane);
      if (notRun) return required(name, lane, Status.NotRun, { reason: notRun.reason, owner: "ci" });
      if (checked.mainPreexisting.includes(lane)) return required(name, lane, Status.MainPreexisting, { reason: "also fails on the captured main", owner: "known main failures" });
      if (!checked.missing.includes(lane)) return required(name, lane, Status.Cached, { reason: "a passing record at this head exists from an earlier run" });
      const key = `${head}\u0000${lane}`;
      if (useCache && cache[key]) return required(name, lane, Status.Cached, { cachedFrom: { head: cache[key].head, ranAt: cache[key].at } });
      const result = bounded(TIME_LIMITS.lane, process.execPath, [PRE_PR_LANES, "run", "--worktree", worktree, "--head", head, "--command", lane], worktree);
      const done = outcome(result, TIME_LIMITS.lane);
      if (done.status === Status.Passed) cache[key] = { head, at: new Date(now()).toISOString() };
      return required(name, lane, done.status, { exitCode: result.status, durationMs: result.durationMs, ...(done.reason ? { reason: done.reason } : {}), ...(done.evidenceTail ? { evidenceTail: done.evidenceTail } : {}) });
    });
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
      return { ...base, command: group.command, status: done.status, exitCode: result.status, durationMs: result.durationMs, ...(done.reason ? { reason: done.reason } : {}), ...(done.evidenceTail ? { evidenceTail: done.evidenceTail } : {}) };
    });
  }

  /** Runs every scriptable check at `head` and returns the evidence. */
  function verify({ worktree, head, base, testsFile, useCache = true, runLanes = true }) {
    const gitDir = run("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"]).stdout.trim();
    const actual = run("git", ["-C", worktree, "rev-parse", "HEAD"]).stdout.trim();
    const dirty = run("git", ["-C", worktree, "status", "--porcelain", "--untracked-files=no"]).stdout.trim();
    const evidence = { schema: SCHEMA, head: actual, base: base ?? null, ranAt: new Date(now()).toISOString(), checks: [], coveredByNoLane: null, leftToWorker: LEFT_TO_WORKER };
    const intended = (head ?? "").toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(intended) || !actual.startsWith(intended) || dirty) {
      const reason = !actual.startsWith(intended) ? `HEAD-MISMATCH the worktree is at ${actual.slice(0, 12)}, not ${head}` : `DIRTY-WORKTREE modified tracked files: ${dirty.split("\n").map((line) => line.replace(/^\s*\S+\s+/, "")).join(", ")}`;
      evidence.checks = ["biome", "source-gates", "typecheck", "lanes"].map((name) => required(name, null, Status.Blocked, { reason }));
      return finish(evidence, gitDir);
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
    evidence.checks.push(...(runLanes ? laneChecks({ ...common, state }) : [required("lanes", "pnpm test:lanes", Status.NotRun, { reason: "--no-lanes was given", owner: "verify-worker" })]));
    evidence.checks.push(...selectedTests({ entries: testsFile ? parseJson(read(testsFile), null) : null, worktree }));
    evidence.coveredByNoLane = state.coveredByNoLane;
    if (useCache) write(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
    return finish(evidence, gitDir);
  }

  function finish(evidence) {
    return { ...evidence, ok: evidenceOk(evidence.checks), summary: summarize(evidence.checks) };
  }

  return { verify };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    worktree: { type: "string" }, head: { type: "string" }, base: { type: "string" }, "tests-file": { type: "string" },
    out: { type: "string" }, "no-cache": { type: "boolean", default: false }, "no-lanes": { type: "boolean", default: false },
  } });
  if (!values.worktree || !values.head) throw new Error("--worktree and --head are required.");
  const controller = createVerifyRun();
  const evidence = controller.verify({
    worktree: values.worktree, head: values.head, base: values.base, testsFile: values["tests-file"],
    useCache: !values["no-cache"], runLanes: !values["no-lanes"],
  });
  const gitDir = execCommand("git", ["-C", values.worktree, "rev-parse", "--absolute-git-dir"]).stdout.trim();
  const out = values.out ?? path.join(gitDir, "vibe-verify-evidence.json");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...evidence, evidenceFile: out }, null, 2)}\n`);
  return evidence.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
