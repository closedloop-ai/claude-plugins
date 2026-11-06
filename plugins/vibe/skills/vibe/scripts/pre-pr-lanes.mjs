#!/usr/bin/env node
// Before a pull request opens, every test lane the repository's lane report
// names for the diff has a passing run recorded for that changed-file scope (operator
// ruling, 2026-10-22). The repository's own rule said so and was skipped:
// main broke four times in one day in suites PR CI does not run.
//
// Usage:
//   pre-pr-lanes.mjs run    --phase first-candidate|followup --worktree <path> --head <sha> --command "<lane command>" (--report <initial lane report> | --impact <qa-impact JSON>) [--main-worktree <checkout of captured main> --main-sha <sha>]
//   pre-pr-lanes.mjs record --phase first-candidate|followup [--source <external source JSON; required for uncommitted inputs>] --worktree <path> --head <sha the run tested> --command "<lane command>" --result pass|fail (--report <initial lane report> | --impact <qa-impact JSON>)
//   pre-pr-lanes.mjs check  --phase first-candidate|followup --worktree <path> (--report <initial lane report> | --impact <qa-impact JSON>) [--skip <regex> --skip-ruling "<who, when, where>"]
//
// The report's lane commands are its 4-space-indented lines that start with a
// package runner (pnpm, npm, npx, yarn, node, uv or Python), after any `KEY='value'`
// assignments the lane's CI step binds; a trailing ` (<detail>)` is not part of
// the command. A report that says nothing changed needs no lane. `check`
// prints `MISSING-LANE <command>` for each lane with no passing record for that scope
// and exits 1; a report it cannot read exits 2. After automated QA, `--impact`
// narrows the check to only lanes qa-impact.mjs selected. A None result needs
// no local lane merely because another commit exists. Records live in the session's
// git dir (`vibe-lane-results.json`); a successful check writes the canonical
// source-bound selection receipt beside it (`vibe-lane-selection.json`).
//
// `check --reuse-cache [--base <sha>] [--config <text>]...` (off by default,
// ISS-13354) also accepts a lane with no passing record for the scope when an
// earlier FRESH pass has the same cache key (lane-cache.mjs: command, tree,
// base, config and changed-file scope). It records the lane `cached` and prints
// `CACHED-LANE <command> (reused from <sha>: not a fresh run)`; a cached record
// is never a `pass`, and without the flag it counts as missing.
//
// `check --reuse-unaffected <qa-impact request JSON>` (off by default, PRD-823 WS7 F2) also
// accepts a lane with no passing record for the scope when an earlier FRESH pass recorded at
// the request's `lastQa.boundary` commit (committed inputs only) is untouched by what changed
// since: qa-impact.mjs is recomputed in this worktree, and a lane counts as untouched when
// the outcome is None, or when every changed file names its lanes in `laneSelections` and
// this lane is not among them. A changed file with no lane entry, or a lane that is not
// named, is never reused. It records the lane `cached` and prints `CACHED-LANE <command>
// (reused from <sha>: ...; not a fresh run)`; a cached record is never a `pass`.
//
// Every lane the report names is required, e2e lanes included: a pull request
// once merged with two Desktop E2E reds because this check skipped e2e lanes
// by default and could not read a lane line that starts with the step's
// variables. `--skip` drops lanes only with a recorded operator ruling
// (deadline mode), printing `SKIPPED-LANE <command> (<ruling>)` for each.
//
// A machine without the staging e2e identities (the e2e sign-in password in
// neither the environment nor apps/app/.env.local) cannot run the local web
// e2e lane: its teardown reaps as those identities and returns 401. There
// `check` does not run or require that lane; it records it `not-run` for the selected scope,
// prints `NOT-RUN-LANE <command> (...)` and relies on the containerized or CI
// run instead of stopping (operator ruling, 2026-10-28, ISS-13291).
//
// The Desktop Electron e2e lane runs only under the displayless Linux harness
// (dbus, keyring and Xvfb); vibe never launches Electron natively, and the
// repo's container tier has no display server. On any other machine `check`
// records it `not-run` the same way (`NOT-RUN-LANE`), and the post-merge
// desktop-e2e-validation run, which publishes `desktop-e2e/validated`, covers
// it (ISS-13321). A passing run recorded from a remote runner still counts.
//
// A selected lane that fails on the branch source and on captured main is
// not the session's to fix (the handoff's rule for failures already on main).
// `run --main-worktree <checkout of captured main> --main-sha <sha>` reruns a
// failing lane there and records it `main-preexisting` when it fails there
// too; `check` accepts that record, printing `MAIN-PREEXISTING-LANE`, and the
// pull request body lists it under Known main failures (ISS-13321).
//
// `run` runs a lane in the worktree and records its result; `record` takes a
// result run elsewhere. Both refuse unless the worktree's HEAD is `--head`
// and record HEAD, diffSha256 and treeSha256 (tested-head.mjs). `run` fails
// if HEAD or uncommitted inputs move. `check` refuses evidence for other content.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { qaImpactRequest } from "../../handoff/scripts/qa-impact.mjs";
import { CACHED_RESULT, cachedRecord, findReusable, laneKeyFor, Provenance } from "./lane-cache.mjs";
import { git } from "./session-record.mjs";
import { testedHead, testedSource, sourceIdentity, sameSource, validSourceIdentity, withStableSource } from "./tested-head.mjs";

const LANE_LINE = /^ {4}((?:[A-Za-z_][A-Za-z0-9_]*=(?:'(?:[^']|'\\'')*'|\S+)\s+)*(?:pnpm|npm|npx|yarn|node|uv|python3|python)\s.*?)(?:\s+\(.*\))?\s*$/;
const NOTHING = /nothing to cover|No paths changed/i;
// The repo's web Playwright lanes (`pnpm test:e2e`, `pnpm test:web-smoke`); a lane naming desktop is the Electron one.
const WEB_E2E = /\b(?:test:e2e|test:web-smoke)\b/;
const DESKTOP = /\bdesktop\b/i;
// symphony-alpha e2e/helpers/sign-in.ts signs the primary identity in with this password; playwright.config.ts loads apps/app/.env.local.
export const STAGING_IDENTITY_KEY = "DEVOPS_CLOSEDLOOP_APP_PWD";
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
export const NOT_RUN_NO_IDENTITY = "no staging e2e identities on this machine; the containerized or CI run covers it";
export const NOT_RUN_NO_DESKTOP_HARNESS = "no displayless Linux Electron harness on this machine and vibe never launches Electron natively; the post-merge desktop-e2e-validation run (desktop-e2e/validated) covers it";
const HARNESS_TOOLS = ["dbus-run-session", "xvfb-run", "gnome-keyring-daemon"];
const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_FILE = "vibe-lane-selection.json";
const PHASES = new Set(["first-candidate", "followup"]);

/** The lane commands a lane report names, or null when it names none and does not say nothing changed. */
export function reportLanes(report) {
  const sections = [];
  let current = null;
  for (const line of report.split("\n")) {
    const heading = line.startsWith("OUTSIDE THE TURBO GRAPH, BY REFERENCE")
      ? /^OUTSIDE THE TURBO GRAPH, BY REFERENCE\s*[—:]\s*(\d+)\s+lane\(s\)/.exec(line)
      : line.startsWith("OUTSIDE THE TURBO GRAPH")
        ? /^OUTSIDE THE TURBO GRAPH\s*[—:]\s*(?:(\d+)\s+lane\(s\)|none affected\.)/.exec(line)
        : line.startsWith("IN THE TURBO GRAPH")
          ? /^IN THE TURBO GRAPH\s*[—:]\s*(?:(\d+)\s+packages?\b|none\.)/.exec(line)
          : undefined;
    if (heading !== undefined) {
      if (!heading) return null;
      current = { declared: Number(heading[1] ?? 0), commands: [] };
      sections.push(current);
      continue;
    }
    if (/^(?:COVERED BY NO LANE|THIS ANSWERS COVERAGE|Test lanes covering)/.test(line)) current = null;
    const lane = LANE_LINE.exec(line)?.[1];
    if (lane) {
      if (!current) return null;
      current.commands.push(lane);
    }
  }
  if (NOTHING.test(report)) return sections.length === 0 ? [] : null;
  if (sections.length === 0 || sections.some((section) => section.declared !== section.commands.length)) return null;
  return [...new Set(sections.flatMap((section) => section.commands))];
}

/** Recompute the repository-owned CI lane selection before accepting a first-candidate receipt. */
function repositoryCiLanes(worktree) {
  const run = spawnSync("pnpm", ["test:lanes"], { cwd: worktree, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  if (run.status !== 0) throw new Error(`pnpm test:lanes could not verify the first-candidate report: ${run.error?.message ?? run.stderr?.trim() ?? "failed"}`);
  const lanes = reportLanes(run.stdout);
  if (lanes === null) throw new Error("pnpm test:lanes returned an unreadable CI-equivalent report");
  return lanes;
}

/** Whether a lane is the repo's local web e2e lane. */
export function isWebE2eLane(lane) {
  return WEB_E2E.test(lane) && !DESKTOP.test(lane);
}

/** Whether a lane is the repo's Desktop Electron e2e lane. */
export function isDesktopE2eLane(lane) {
  return WEB_E2E.test(lane) && DESKTOP.test(lane);
}

/** Whether this machine can run the Desktop lane displayless: Linux with dbus, Xvfb and the keyring daemon. */
export function hasDisplaylessElectronHarness(platform = process.platform, onPath = commandOnPath) {
  return platform === "linux" && HARNESS_TOOLS.every((tool) => onPath(tool));
}

function commandOnPath(tool) {
  return spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;
}

/** Whether this machine has the staging e2e identities the web e2e lane signs in and tears down as. */
export function hasStagingE2eIdentity(worktree, env = process.env) {
  if (env[STAGING_IDENTITY_KEY]?.trim()) {
    return true;
  }
  const file = path.join(worktree, "apps", "app", ".env.local");
  if (!existsSync(file)) {
    return false;
  }
  return readFileSync(file, "utf8").split("\n").some((line) => {
    const match = ENV_LINE.exec(line);
    return match?.[1] === STAGING_IDENTITY_KEY && match[2].replace(/^(['"])(.*)\1$/, "$2").trim() !== "";
  });
}

function sameSelection(record, selection) {
  return record.laneKey === selection.laneKey && (!selection.source || record.source?.treeSha256 === selection.source.treeSha256);
}

/** Lanes with no passing record for the selected changed-file scope; head is provenance only. */
export function missingLanes(lanes, records, selection) {
  return lanes.filter((lane) => !records.some((record) => record.command === lane && sameSelection(record, selection)
    && (record.result === "pass" || (record.result === "main-preexisting" && /^[a-f0-9]{40}$/.test(record.mainSha ?? "")))));
}

/** The lanes left for CI on this machine: web e2e without the staging identities, Desktop e2e without the harness. */
export function notRunLanes(lanes, records, selection, { identity, harness }) {
  return lanes.flatMap((lane) => {
    if (!missingLanes([lane], records, selection).length) return [];
    if (!identity && isWebE2eLane(lane)) return [{ lane, reason: NOT_RUN_NO_IDENTITY }];
    if (!harness && isDesktopE2eLane(lane)) return [{ lane, reason: NOT_RUN_NO_DESKTOP_HARNESS }];
    return [];
  });
}

function recordsFile(worktree) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "vibe-lane-results.json");
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 60_000;

/** Writes the records through a temp file and a rename, so a reader never sees half a file. */
function writeRecords(worktree, records) {
  const file = recordsFile(worktree);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(records, null, 2)}\n`);
  renameSync(temp, file);
}

/** Runs `change` holding the records lock (an atomic mkdir beside the file); a lock older than LOCK_STALE_MS is a dead holder's and is taken over. */
function withRecordsLock(worktree, change) {
  const lock = `${recordsFile(worktree)}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // The holder released it between the two calls.
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`the lane records lock ${lock} stayed held for ${LOCK_WAIT_MS / 1000}s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return change();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function readRecords(worktree) {
  const file = recordsFile(worktree);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

/** The lanes a cached result covers for the selection, with the head each was reused from; a new match is recorded and a cached record whose key no longer matches is replaced or dropped. */
function reuseCachedLanes(values, lanes, records, selected) {
  const covered = [];
  const written = [];
  const head = selected.source.head;
  for (const lane of missingLanes(lanes, records, selected)) {
    const key = laneKeyFor(values.worktree, { command: lane, base: values.base, config: values.config });
    const existing = records.find((record) => record.command === lane && sameSelection(record, selected) && record.result === CACHED_RESULT);
    const earlier = findReusable(records, key);
    if (existing && earlier && key && existing.cacheKey === key && existing.reusedFrom?.head === earlier.head) {
      covered.push({ lane, from: existing.reusedFrom.head });
    } else if (earlier) {
      written.push({ ...cachedRecord({ command: lane, head, key, source: earlier }), source: selected.source, laneKey: selected.laneKey });
      covered.push({ lane, from: earlier.head });
    }
  }
  const isCached = (record) => record.result === CACHED_RESULT && !record.unaffectedSince && lanes.includes(record.command) && sameSelection(record, selected);
  const stale = (record) => isCached(record) && !covered.some((item) => item.lane === record.command && item.from === record.reusedFrom?.head);
  if (written.length || records.some(stale)) {
    const kept = records.filter((record) => !stale(record));
    writeRecords(values.worktree, [...kept, ...written]);
  }
  return covered;
}

const NO_DIFF = createHash("sha256").digest("hex");

/** The lanes the changes since `request.lastQa.boundary` can touch, or null when that cannot be proven. */
export function lanesTouchedSince(request, impact) {
  if (impact.outcome === "None") return new Set();
  const map = request.laneSelections?.files ?? request.laneSelections;
  const touched = new Set();
  for (const file of impact.changedFiles ?? []) {
    const lanes = map?.[file];
    if (!Array.isArray(lanes) || lanes.length === 0) return null;
    for (const lane of lanes) touched.add(lane);
  }
  return touched;
}

/** The lanes an earlier fresh pass covers because nothing since touched them; new matches are recorded and cached records that no longer hold are dropped. */
function reuseUnaffectedLanes(values, lanes, records, selected, already) {
  const request = JSON.parse(readFileSync(values["reuse-unaffected"], "utf8"));
  const impact = qaImpactRequest(values.worktree, request);
  const touched = lanesTouchedSince(request, impact);
  const boundary = git(values.worktree, ["rev-parse", "--verify", `${request.lastQa.boundary}^{commit}`]);
  const covered = [];
  const written = [];
  for (const lane of missingLanes(lanes, records, selected).filter((name) => !already.some((item) => item.lane === name))) {
    const earlier = touched && !touched.has(lane)
      ? records.find((record) => record.command === lane && record.result === "pass" && record.provenance !== Provenance.Cached && record.head === boundary && record.source?.diffSha256 === NO_DIFF)
      : undefined;
    if (!earlier) continue;
    const key = createHash("sha256").update(JSON.stringify({ unaffectedSince: boundary, impact: impact.laneKey ?? null, command: lane })).digest("hex");
    const existing = records.find((record) => record.command === lane && sameSelection(record, selected) && record.cacheKey === key);
    if (!existing) written.push({ ...cachedRecord({ command: lane, head: selected.source.head, key, source: earlier }), unaffectedSince: boundary, source: selected.source, laneKey: selected.laneKey });
    covered.push({ lane, from: earlier.head });
  }
  const holds = (record) => covered.some((item) => item.lane === record.command && item.from === record.reusedFrom?.head);
  const stale = (record) => record.unaffectedSince && record.result === CACHED_RESULT && lanes.includes(record.command) && sameSelection(record, selected) && !holds(record);
  if (written.length || records.some(stale)) {
    writeRecords(values.worktree, [...records.filter((record) => !stale(record)), ...written]);
  }
  return covered;
}

/** Absolute canonical source-bound lane-selection receipt path for a worktree. */
function laneSelectionReceiptFile(worktree) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), RECEIPT_FILE);
}

/** Read the canonical lane-selection receipt, or null before a successful check. */
export function readLaneSelectionReceipt(worktree) {
  const file = laneSelectionReceiptFile(worktree);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** Shape and exact-source problems; lane-selection semantics remain owned by this script. */
export function laneSelectionReceiptProblems(receipt, source) {
  const problems = [];
  if (receipt?.schemaVersion !== RECEIPT_SCHEMA_VERSION) problems.push("lane receipt schemaVersion must be 1");
  if (!validSourceIdentity(receipt?.source)) problems.push("lane receipt source identity is invalid");
  else if (!sameSource(receipt.source, source)) problems.push("lane receipt source identity is stale");
  if (!PHASES.has(receipt?.phase)) problems.push("lane receipt phase is invalid");
  if (!validSourceIdentity(receipt?.firstCandidateSource)) {
    problems.push("lane receipt needs a valid first-candidate source identity");
  } else if (receipt?.phase === "first-candidate" && !sameSource(receipt.firstCandidateSource, source)) {
    problems.push("first-candidate receipt history does not match its source");
  }
  const expectedKind = receipt?.phase === "first-candidate" ? "ci-report" : "qa-impact";
  if (receipt?.selection?.kind !== expectedKind) {
    problems.push("lane receipt selection kind does not match its phase");
  }
  if (!/^[a-f0-9]{16,64}$/.test(receipt?.selection?.key ?? "")) problems.push("lane receipt selection key is invalid");
  if (!Array.isArray(receipt?.lanes)) problems.push("lane receipt lanes must be an array");
  else {
    const commands = new Set();
    for (const lane of receipt.lanes) {
      if (typeof lane?.command !== "string" || !lane.command.trim()) problems.push("each lane receipt row needs a command");
      if (typeof lane?.reason !== "string" || !lane.reason.trim()) problems.push("each lane receipt row needs a selection reason");
      if (commands.has(lane.command)) problems.push(`duplicate lane receipt command ${lane.command}`);
      commands.add(lane.command);
    }
  }
  return problems;
}

function writeLaneSelectionReceipt(worktree, source, phase, selected) {
  const prior = readLaneSelectionReceipt(worktree);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    source,
    phase,
    selection: selected.selection,
    lanes: selected.lanes.map((command) => ({ command, reason: selected.reasons[command] })),
    ...(phase === "first-candidate" ? { firstCandidateSource: source }
      : prior?.firstCandidateSource ? { firstCandidateSource: prior.firstCandidateSource } : {}),
  };
  const problems = laneSelectionReceiptProblems(receipt, source);
  if (problems.length) throw new Error(problems.join("; "));
  const file = laneSelectionReceiptFile(worktree);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temp, file);
  return receipt;
}

function selectedScope(values, command, source) {
  if (!PHASES.has(values.phase)) throw new Error("--phase first-candidate|followup is required");
  if (values["code-tests"]) throw new Error("--code-tests has no verifiable producer; use source-bound --impact");
  const inputs = [values.report, values.impact].filter(Boolean);
  if (inputs.length !== 1) throw new Error("exactly one of --report or --impact is required");
  if (values.phase === "first-candidate" && !values.report) {
    throw new Error("first-candidate requires the repository CI-equivalent --report and cannot use targeted selection");
  }
  if (values.phase === "followup" && values.report) {
    throw new Error("followup requires --impact selection provenance; an unreasoned full report is refused");
  }
  const priorReceipt = readLaneSelectionReceipt(values.worktree);
  if (values.phase === "first-candidate" && priorReceipt?.firstCandidateSource) {
    throw new Error("the successful first-candidate receipt already exists; later source uses --phase followup");
  }
  if (values.phase === "followup" && !validSourceIdentity(priorReceipt?.firstCandidateSource)) {
    throw new Error("followup selection requires a successful first-candidate receipt");
  }
  if (values.impact) {
    const impact = qaImpactRequest(values.worktree, JSON.parse(readFileSync(values.impact, "utf8")));
    if (!Array.isArray(impact.lanes) || (command && !impact.lanes.includes(command)) || (impact.lanes.length && !/^[a-f0-9]{16}$/.test(impact.laneKey ?? ""))) {
      throw new Error("--impact must select this lane and carry qa-impact.mjs laneKey");
    }
    if (impact.source && !sameSource(impact.source, source)) throw new Error("qa-impact selection is stale for the current source");
    const key = impact.laneKey ?? createHash("sha256").update(JSON.stringify({ source, outcome: impact.outcome, reason: impact.reason })).digest("hex").slice(0, 16);
    const reason = `qa-impact ${impact.outcome}: ${impact.reason}`;
    return { lanes: impact.lanes, laneKey: key, impact, selection: { kind: "qa-impact", key },
      reasons: Object.fromEntries(impact.lanes.map((lane) => [lane, reason])) };
  }
  const report = readFileSync(values.report, "utf8");
  const lanes = reportLanes(report);
  if (lanes === null || (command && !lanes.includes(command))) throw new Error("--report must name this lane or explicitly say nothing changed");
  const laneKey = createHash("sha256").update(JSON.stringify(lanes)).update("\n").update(report).digest("hex").slice(0, 16);
  return { lanes, laneKey, impact: null, selection: { kind: "ci-report", key: laneKey },
    reasons: Object.fromEntries(lanes.map((lane) => [lane, "repository CI-equivalent report selected this lane"])) };
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: {
    worktree: { type: "string" }, head: { type: "string" }, source: { type: "string" }, command: { type: "string" }, result: { type: "string" }, phase: { type: "string" }, report: { type: "string" }, impact: { type: "string" }, "code-tests": { type: "string" }, skip: { type: "string" }, "skip-ruling": { type: "string" },
    "main-worktree": { type: "string" }, "main-sha": { type: "string" },
    "reuse-cache": { type: "boolean" }, "reuse-unaffected": { type: "string" }, base: { type: "string" }, config: { type: "string", multiple: true },
  } });
  if (!values.worktree) throw new Error("--worktree is required");
  if (command === "run" || command === "record") {
    if (!values.command?.trim() || (command === "record" && !["pass", "fail"].includes(values.result))) throw new Error(`${command} needs --head, --command${command === "record" ? " and --result pass|fail" : ""}`);
    const source = testedSource(values.worktree, values.head);
    const tested = source.head;
    if (command === "record") {
      if (!values.source && source.diffSha256 !== createHash('sha256').digest('hex')) {
        throw new Error('record of uncommitted inputs needs --source <JSON identity captured by the external runner>');
      }
      if (values.source && !sameSource(JSON.parse(values.source), source)) throw new Error('record --source does not match the current inputs');
    }
    const selected = { ...selectedScope(values, values.command.trim(), source), source };
    if (Boolean(values["main-worktree"]) !== Boolean(values["main-sha"]) || (values["main-worktree"] && command !== "run")) {
      throw new Error("--main-worktree and --main-sha go together, on run only");
    }
    let mainTested = null;
    try { mainTested = values["main-worktree"] ? testedHead(values["main-worktree"], values["main-sha"]) : null; }
    catch (error) {
      if (!error.message.startsWith('DIRTY-WORKTREE')) throw error;
      throw new Error('captured main must be clean to establish a main-preexisting failure');
    }
    let result = values.result;
    let mainSha;
    const mainSource = mainTested ? sourceIdentity(values["main-worktree"], mainTested) : undefined;
    if (mainSource && mainSource.diffSha256 !== createHash('sha256').digest('hex')) throw new Error('captured main must be clean to establish a main-preexisting failure');
    if (command === "run") {
      const execute = (tree, expected) => withStableSource(tree, current => {
        if (!sameSource(expected, current)) throw new Error('SOURCE-MOVED before lane startup');
        return { status: spawnSync(values.command, { cwd: tree, shell: true, stdio: 'inherit' }).status };
      }, { head: expected.head });
      let unchanged = true;
      try { result = execute(values.worktree, source).status === 0 ? 'pass' : 'fail'; }
      catch (error) {
        if (!error.message.startsWith('SOURCE-MOVED')) throw error;
        unchanged = false;
        result = 'fail';
        process.stdout.write(`${error.message} during the run\n`);
        const after = git(values.worktree, ['rev-parse', 'HEAD']);
        if (after !== tested) process.stdout.write(`HEAD-MOVED from ${tested.slice(0, 12)} to ${after.slice(0, 12)} during the run\n`);
      }
      if (result === 'fail' && unchanged && mainTested && execute(values['main-worktree'], mainSource).status !== 0) {
        result = 'main-preexisting';
        mainSha = mainTested;
      }
    }
    const cacheKey = source.diffSha256 === createHash("sha256").digest("hex")
      ? laneKeyFor(values.worktree, { command: values.command, base: values.base, config: values.config }) : null;
    // A lane result retains both the exact selection and main's fresh/cache provenance.
    withRecordsLock(values.worktree, () => {
      const records = readRecords(values.worktree).filter((record) => !(record.command === values.command.trim() && sameSelection(record, selected)));
      records.push({ command: values.command.trim(), head: tested, source, laneKey: selected.laneKey,
        selection: { ...selected.selection, reason: selected.reasons[values.command.trim()] },
        result, provenance: Provenance.Fresh, ...(cacheKey ? { cacheKey } : {}),
        ...(mainSha ? { mainSha, mainSource } : {}), at: new Date().toISOString() });
      writeRecords(values.worktree, records);
    });
    process.stdout.write(`recorded ${result} for ${values.command.trim()} at ${JSON.stringify(source)}${mainSha ? ` (fails on captured main ${mainSha} too)` : ""}\n`);
    return result === "pass" || result === "main-preexisting" ? 0 : 1;
  }
  if (command === "check") {
    return withStableSource(values.worktree, source => {
      const head = source.head;
      if (values.skip && !values["skip-ruling"]?.trim()) throw new Error("--skip needs --skip-ruling naming the operator ruling that waives those lanes");
      const selected = { ...selectedScope(values, undefined, source), source };
      if (values.phase === "first-candidate") {
        const canonical = repositoryCiLanes(values.worktree);
        if (canonical.length !== selected.lanes.length || canonical.some((lane) => !selected.lanes.includes(lane))) {
          throw new Error("first-candidate --report does not match current pnpm test:lanes selection");
        }
      }
      return withRecordsLock(values.worktree, () => {
      const named = selected.lanes;
      const impact = selected.impact;
      if (impact && !["None", "Lanes only", "Visual QA"].includes(impact.outcome)) throw new Error("the impact file has no valid qa-impact outcome");
      const skip = values.skip ? new RegExp(values.skip, "i") : null;
      let records = readRecords(values.worktree);
      const left = notRunLanes(named.filter((lane) => !skip?.test(lane)), records, selected,
        { identity: hasStagingE2eIdentity(values.worktree), harness: hasDisplaylessElectronHarness() });
      const notRun = left.map((item) => item.lane);
      const lanes = named.filter((lane) => !skip?.test(lane) && !notRun.includes(lane));
      for (const lane of named.filter((lane) => skip?.test(lane))) process.stdout.write(`SKIPPED-LANE ${lane} (${values["skip-ruling"].trim()})\n`);
      if (notRun.length) {
        const kept = records.filter((record) => !(notRun.includes(record.command) && sameSelection(record, selected)));
        const at = new Date().toISOString();
        writeRecords(values.worktree, [...kept, ...left.map(({ lane, reason }) => ({ command: lane, head, source: selected.source, laneKey: selected.laneKey,
          selection: { ...selected.selection, reason: selected.reasons[lane] }, result: "not-run", reason, at }))]);
        records = readRecords(values.worktree);
        for (const { lane, reason } of left) process.stdout.write(`NOT-RUN-LANE ${lane} (${reason})\n`);
      }
      for (const record of records.filter((item) => lanes.includes(item.command) && sameSelection(item, selected) && item.result === "main-preexisting")) {
        process.stdout.write(`MAIN-PREEXISTING-LANE ${record.command} (fails on captured main ${record.mainSha} too; list it under Known main failures)\n`);
      }
      const covered = values["reuse-cache"] ? reuseCachedLanes(values, lanes, records, selected) : [];
      for (const { lane, from } of covered) process.stdout.write(`CACHED-LANE ${lane} (reused from ${from.slice(0, 12)}: same tree, base, config and scope; not a fresh run)\n`);
      records = readRecords(values.worktree);
      const unaffected = values["reuse-unaffected"] ? reuseUnaffectedLanes(values, lanes, records, selected, covered) : [];
      for (const { lane, from } of unaffected) process.stdout.write(`CACHED-LANE ${lane} (reused from ${from.slice(0, 12)}: nothing changed since touches this lane; not a fresh run)\n`);
      records = readRecords(values.worktree);
      const missing = missingLanes(lanes, records, selected).filter((lane) => ![...covered, ...unaffected].some((item) => item.lane === lane));
      const selector = selected.selection.kind === "qa-impact" ? "--impact <qa-impact JSON>" : "--report <lane report>";
      for (const lane of missing) process.stdout.write(`MISSING-LANE ${lane}: run it with pre-pr-lanes.mjs run --phase ${values.phase} --head <HEAD> --command "${lane}" ${selector}\n`);
      process.stdout.write(`pre-pr lanes: ${lanes.length} lanes, ${missing.length} missing${notRun.length ? `, ${notRun.length} not run locally` : ""}${values["reuse-cache"] || values["reuse-unaffected"] ? `, ${covered.length + unaffected.length} cached` : ""} for changed-file scope ${selected.laneKey ?? "none"}\n`);
      if (missing.length === 0) writeLaneSelectionReceipt(values.worktree, source, values.phase, selected);
      return { exitCode: missing.length === 0 ? 0 : 1 };
      });
    }).exitCode;
  }
  throw new Error("Usage: pre-pr-lanes.mjs run|record|check --phase first-candidate|followup ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
