#!/usr/bin/env node
// Before a pull request opens, every test lane the repository's lane report
// names for the diff has a passing run recorded for that changed-file scope (operator
// ruling, 2026-10-22). The repository's own rule said so and was skipped:
// main broke four times in one day in suites PR CI does not run.
//
// Usage:
//   pre-pr-lanes.mjs run    --worktree <path> --head <sha> --command "<lane command>" (--report <initial lane report> | --impact <qa-impact JSON>) [--main-worktree <checkout of captured main> --main-sha <sha>]
//   pre-pr-lanes.mjs record [--source <external source JSON; required for uncommitted inputs>] --worktree <path> --head <sha the run tested> --command "<lane command>" --result pass|fail (--report <initial lane report> | --impact <qa-impact JSON>) [--targeted-specs '<JSON list>' --graph-query '<exact tool arguments JSON>' --graph-session <native thread> --graph-turn <completed turn>]
//   pre-pr-lanes.mjs record --ran-on <host> --proof-commit <sha the remote run tested> --git-tree <its Git tree> --worktree <path> --head <clean local HEAD> --command "<lane command>" --result pass|fail (--report <initial lane report> | --impact <qa-impact JSON>)
//   pre-pr-lanes.mjs record --cloud-result <cloud-worker validation JSON> --worktree <path> --head <clean local HEAD> --command "<exact lane recipe>" --result pass (--report <workflow lane report> | --impact <qa-impact JSON>)
//   pre-pr-lanes.mjs check  --worktree <path> (--report <initial lane report> | --impact <qa-impact JSON>) [--skip <regex> --skip-ruling "<who, when, where>"]
//
// The report's lane commands are its 4-space-indented lines that start with a
// package runner (pnpm, npm, npx, yarn, node), after any `KEY='value'`
// assignments the lane's CI step binds; a trailing ` (<detail>)` is not part of
// the command. A JSON report with a github-workflow source binds the exact
// job/matrix recipes to the declared workflow at HEAD. These recipes identify
// CI jobs and are recorded after execution by their owning CI/harness.
// A text report that says nothing changed needs no lane. `check`
// prints `MISSING-LANE <command>` for each lane with no passing record for that scope
// and exits 1; a report it cannot read exits 2. After automated QA, `--impact`
// narrows the check to only lanes qa-impact.mjs selected. A None result needs
// no local lane merely because another commit exists. Records live in the session's
// git dir (`vibe-lane-results.json`). Changes nothing else.
//
// `check --reuse-cache [--base <sha>] [--config <text>]...` (off by default)
// also accepts a lane with no passing record for the scope when an
// earlier FRESH pass has the same cache key (lane-cache.mjs: command, tree,
// base, config and changed-file scope). It records the lane `cached` and prints
// `CACHED-LANE <command> (reused from <sha>: not a fresh run)`; a cached record
// is never a `pass`, and without the flag it counts as missing.
//
// `check --reuse-unaffected <qa-impact request JSON>` (off by default) also
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
// neither the environment nor the app's env file) cannot run the local web
// e2e lane: its teardown reaps as those identities and returns 401. There
// `check` does not run or require that lane; it records it `not-run` for the selected scope,
// prints `NOT-RUN-LANE <command> (...)` and relies on the containerized or CI
// run instead of stopping (operator ruling, 2026-10-28).
//
// The Desktop Electron e2e lane runs only under the displayless Linux harness
// (dbus, keyring and Xvfb); vibe never launches Electron natively, and the
// repo's container tier has no display server. On any other machine `check`
// records it `not-run` the same way (`NOT-RUN-LANE`), and the post-merge
// desktop-e2e-validation run, which publishes `desktop-e2e/validated`, covers
// it. A passing run recorded from a remote runner still counts.
//
// A selected lane that fails on the branch source and on captured main is
// not the session's to fix (the handoff's rule for failures already on main).
// `run --main-worktree <checkout of captured main> --main-sha <sha>` reruns a
// failing lane there and records it `main-preexisting` when it fails there
// too; `check` accepts that record, printing `MAIN-PREEXISTING-LANE`, and the
// pull request body lists it under Known main failures.
//
// A diff that changes a Storybook story whose package has no typecheck script
// also selects the story-typecheck.mjs lane: the repository's lane
// report names none, and PR #9732 shipped a type error in such a story.
//
// `run` runs a lane in the worktree and records its result; `record` takes a
// result run elsewhere. Both refuse unless the worktree's HEAD is `--head`
// and record HEAD, diffSha256 and treeSha256 (tested-head.mjs). `run` fails
// if HEAD or uncommitted inputs move. `check` refuses evidence for other content.
// `record --ran-on` takes a lane run on another host against a proof commit
// this clone may never receive: it needs a clean worktree whose
// HEAD's Git tree is `--git-tree`, records this HEAD's source, and adds
// `ranOn: { host, proofCommit, gitTree, command }`; the proof commit is never resolved here.
// `record --cloud-result` instead verifies cloud-worker's host, GitHub repository,
// exact commit and passing recipe against clean HEAD, then records that complete provenance.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { qaImpactRequest } from "../../handoff/scripts/qa-impact.mjs";
import { repositoryLaneReportProblems } from "../../handoff/scripts/ci-job-shape.mjs";
import { containerizedE2eIdentityProblem, RUNNER_HOST } from "../../handoff/scripts/e2e-tier.mjs";
import { targetedTestsRuling } from "../../handoff/scripts/targeted-tests-ruling.mjs";
import { CACHED_RESULT, cachedRecord, findReusable, laneKeyFor, Provenance } from "./lane-cache.mjs";
import { storyTypecheckLane } from "./story-typecheck.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

const { git } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { testedHead, testedSource, sourceIdentity, sameSource, withStableSource } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const { providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { failScript } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { readCodexTurnItems } = await vibeCore("lib/handoff/scripts/codex-review-runtime.mjs");
const { evidenceFingerprint } = await vibeCore("lib/handoff/scripts/handoff-evidence.mjs");
const { githubRepository } = await vibeCore("lib/vibe/scripts/github-remote.mjs");
const FLEET_SCRIPT = fileURLToPath(new URL("../../fleet-orchestrator/scripts/fleet.sh", import.meta.url));

const LANE_LINE = /^ {4}((?:[A-Za-z_][A-Za-z0-9_]*=(?:'(?:[^']|'\\'')*'|\S+)\s+)*(?:pnpm|npm|npx|yarn|node)\s.*?)(?:\s+\(.*\))?\s*$/;
const NOTHING = /nothing to cover|No paths changed/i;
// The repo's web Playwright lanes (`pnpm test:e2e`, `pnpm test:web-smoke`); a lane naming desktop is the Electron one.
const WEB_E2E = /\b(?:test:e2e|test:web-smoke)\b/;
const DESKTOP = /\bdesktop\b/i;
const E2E_SPEC = /(?:^|\/)e2e(?:\/|.*\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/i;
const TARGETED_POLICY = [
  /An e2e lane \(`e2e`, `desktop-e2e`\) is the exception/i,
  /test[^\n]*changes/i,
  /plus every spec the PR adds or edits/i,
  /full lane runs after merge/i,
];
// The staging e2e identity the web e2e lane signs in with: an env key, set in the environment or the app's env file
// (the provider's `recipes.e2e`); a repository with no such recipe needs none.
export const stagingIdentity = (binding = sessionBinding()) => {
  const e2e = providerDataOr(binding, "recipes", "e2e", null);
  return e2e?.identityKey ? { key: e2e.identityKey, envFile: e2e.identityEnvFile ?? null } : null;
};
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
export const NOT_RUN_NO_IDENTITY = "no staging e2e identities on this machine; the containerized or CI run covers it";
export const NOT_RUN_NO_DESKTOP_HARNESS = "no displayless Linux Electron harness on this machine and vibe never launches Electron natively; the post-merge desktop-e2e-validation run (desktop-e2e/validated) covers it";
const HARNESS_TOOLS = ["dbus-run-session", "xvfb-run", "gnome-keyring-daemon"];

/** The lane commands a lane report names, or null when it names none and does not say nothing changed. */
export function reportLanes(report) {
  const all = [...new Set(report.split("\n").map((line) => LANE_LINE.exec(line)?.[1]).filter(Boolean))];
  if (all.length === 0) return NOTHING.test(report) ? [] : null;
  return all;
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
export function hasStagingE2eIdentity(worktree, env = process.env, identity = stagingIdentity()) {
  if (!identity) {
    return true;
  }
  if (env[identity.key]?.trim()) {
    return true;
  }
  const file = identity.envFile ? path.join(worktree, identity.envFile) : null;
  if (!file || !existsSync(file)) {
    return false;
  }
  return readFileSync(file, "utf8").split("\n").some((line) => {
    const match = ENV_LINE.exec(line);
    return match?.[1] === identity.key && match[2].replace(/^(['"])(.*)\1$/, "$2").trim() !== "";
  });
}

/** Refuse the containerized lane before it starts when its login-shell identity is absent. */
export function lanePreflightProblem(command, env = process.env, recipe) {
  return /(?:^|\s)e2e\/run-containerized\.sh(?:\s|$)/.test(command)
    ? containerizedE2eIdentityProblem(env, recipe) : null;
}

/** The fleet heavy-slot process for a lane run, or null for the direct local path. */
export function fleetLaneInvocation(values, source, tree = values.worktree) {
  const any = ["fleet-where", "fleet-orch", "fleet-owner"].some((key) => values[key] !== undefined);
  if (!any) return null;
  if (!["local", "remote"].includes(values["fleet-where"]) || !path.isAbsolute(values["fleet-orch"] ?? "")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(values["fleet-owner"] ?? "")) {
    throw new Error("fleet lane run needs --fleet-where local|remote, absolute --fleet-orch and --fleet-owner");
  }
  if (values["fleet-where"] === "remote" && source.diffSha256 !== NO_DIFF) {
    throw new Error("remote fleet lane needs a clean worktree so the target can prove the same HEAD");
  }
  const command = values["fleet-where"] === "remote"
    ? `test "$(git rev-parse HEAD)" = ${source.head} || { echo "fleet lane HEAD does not match ${source.head}" >&2; exit 78; }; ${values.command}`
    : values.command;
  return { bin: "bash", args: [FLEET_SCRIPT, values["fleet-orch"], values["fleet-where"], "slot", "heavy",
    values["fleet-owner"], tree, "sh", "-lc", command], receipt: { where: values["fleet-where"], owner: values["fleet-owner"], head: source.head } };
}

function sameSelection(record, selection) {
  return record.laneKey === selection.laneKey && (!selection.source || record.source?.treeSha256 === selection.source.treeSha256);
}

/** Lanes with no passing record for the selected changed-file scope; head is provenance only. */
export function missingLanes(lanes, records, selection) {
  return lanes.filter((lane) => !records.some((record) => record.command === lane && sameSelection(record, selection)
    && ((record.result === "pass" && record.targeted === undefined)
      || (record.result === "main-preexisting" && /^[a-f0-9]{40}$/.test(record.mainSha ?? "")))));
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

/** The session's recorded lane results (`vibe-lane-results.json` in the worktree's git dir), or [] when none exist. */
export function readRecords(worktree) {
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
    if (existing && key && existing.cacheKey === key) {
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
    writeFileSync(recordsFile(values.worktree), `${JSON.stringify([...kept, ...written], null, 2)}\n`);
  }
  return covered;
}

const NO_DIFF = createHash("sha256").digest("hex");
const COMMIT = /^[a-f0-9]{40}$/;

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
    writeFileSync(recordsFile(values.worktree), `${JSON.stringify([...records.filter((record) => !stale(record)), ...written], null, 2)}\n`);
  }
  return covered;
}

function selectedScope(values, command) {
  if (Boolean(values.report) === Boolean(values.impact)) throw new Error("exactly one of --report or --impact is required");
  if (values.impact) {
    const impact = qaImpactRequest(values.worktree, JSON.parse(readFileSync(values.impact, "utf8")));
    const lanes = Array.isArray(impact.lanes) ? withStoryTypecheck(values, impact.lanes) : null;
    if (!lanes || (command && !lanes.includes(command)) || (impact.lanes.length && !/^[a-f0-9]{16}$/.test(impact.laneKey ?? ""))) {
      throw new Error("--impact must select this lane and carry qa-impact.mjs laneKey");
    }
    return { lanes, laneKey: impact.laneKey ?? null, impact };
  }
  const report = readFileSync(values.report, "utf8");
  let workflowCommands = [];
  if (report.trimStart().startsWith("{")) {
    const parsed = JSON.parse(report);
    if (parsed.source?.kind !== "github-workflow") throw new Error("a JSON --report needs a github-workflow source");
    const head = git(values.worktree, ["rev-parse", "HEAD"]);
    const problems = repositoryLaneReportProblems(parsed, values.worktree, head);
    if (problems.length) throw new Error(problems.join("; "));
    workflowCommands = parsed.matches.map(({ command: recipe }) => recipe);
    if (new Set(workflowCommands).size !== workflowCommands.length) throw new Error("workflow recipes must identify each lane unambiguously");
  }
  const named = workflowCommands.length ? workflowCommands : reportLanes(report);
  const lanes = named === null ? null : withStoryTypecheck(values, named);
  if (lanes === null || (command && !lanes.includes(command))) throw new Error("--report must name this lane or explicitly say nothing changed");
  const laneKey = createHash("sha256").update(JSON.stringify(named)).update("\n").update(report).digest("hex").slice(0, 16);
  return { lanes, laneKey, impact: null, workflowCommands };
}

function targetBase(values) {
  if (values.base) return git(values.worktree, ["rev-parse", "--verify", `${values.base}^{commit}`]);
  return git(values.worktree, ["merge-base", "HEAD", "refs/remotes/origin/main"]);
}

/** Bind graph proof to the whole diff, including deletions and untracked additions. */
function targetedScope(values) {
  const base = targetBase(values);
  const diff = (...options) => git(values.worktree, ["diff", "--name-only", "--no-renames", "-z", ...options, base, "--"])
    .split("\0").filter(Boolean);
  const untracked = git(values.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  return {
    base,
    changedFiles: [...new Set([...diff(), ...untracked])].sort(),
    changedSpecs: [...new Set([...diff("--diff-filter=ACMRT"), ...untracked])].filter((file) => E2E_SPEC.test(file)),
  };
}

/** Whether the target repository explicitly permits graph-selected local E2E instead of the full lane. */
export function allowsTargetedE2e(worktree) {
  const file = path.join(worktree, "AGENTS.md");
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  return TARGETED_POLICY.every((pattern) => pattern.test(text));
}

function parseTargetedSpecs(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { value = raw.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean); }
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("--targeted-specs must be a non-empty JSON list or comma-separated list of repository-relative spec paths");
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function parsedToolResult(item) {
  if (item?.result?.structuredContent && typeof item.result.structuredContent === "object") return item.result.structuredContent;
  for (const block of item?.result?.content ?? []) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try { return JSON.parse(block.text); } catch { /* continue */ }
  }
  throw new Error("the graph tool call has no structured result");
}

function relativePath(file) {
  return typeof file === "string" && !file.includes("\\") && !file.startsWith("...")
    && file.split("/").every((part) => part && part !== "." && part !== "..");
}

/** Reject capped results and read only the graph's spec records, never incidental paths in its prose. */
function graphSpecs(entries, total = entries?.length) {
  if (!Array.isArray(entries) || entries.length !== total) throw new Error("the graph E2E spec result is incomplete");
  const paths = entries.map((entry) => typeof entry === "string" ? entry : entry?.spec ?? entry?.path ?? entry?.test ?? entry?.file);
  if (paths.some((file) => !relativePath(file) || !E2E_SPEC.test(file))) throw new Error("the graph E2E spec result is incomplete or contains an invalid path");
  return paths;
}

function graphResult(result) {
  const desktop = result?.desktop_e2e;
  const tier = result?.tier2;
  const mode = desktop?.verdict ?? result?.mode ?? (tier ? "SELECTED" : null);
  if (mode !== "RUN_ALL" && mode !== "SELECTED") throw new Error("the graph tool has no usable E2E verdict");
  const direct = tier ? graphSpecs(tier.rows ?? [], tier.candidates_total) : graphSpecs(result.direct_evidence ?? []);
  const start = desktop?.start_here;
  const ruled = mode === "RUN_ALL"
    ? (desktop ? graphSpecs(start?.specs, start?.specs_total) : graphSpecs(result.start_here))
    : (desktop?.verdict === "SELECTED" ? graphSpecs(desktop.specs, desktop.specs_total) : graphSpecs(result.selected ?? []));
  const selected = [...new Set([...ruled, ...direct])].sort();
  if (mode === "RUN_ALL" && selected.length === 0) throw new Error("RUN_ALL has no start-here or direct-evidence specs for targeted validation");
  return { mode, selected };
}

function assertGraphScope(values, graph, scope) {
  const args = JSON.parse(graph.query);
  const origin = githubRepository(git(values.worktree, ["config", "--get", "remote.origin.url"]));
  const repositories = origin ? [origin.toLowerCase(), origin.split("/").at(-1).toLowerCase()] : [];
  if (typeof args.repo !== "string" || !repositories.includes(args.repo.toLowerCase())
    || (graph.repository && !repositories.includes(graph.repository.toLowerCase()))) {
    throw new Error("the graph query repository differs from this worktree's GitHub origin");
  }
  if (args.e2e === false) throw new Error("the graph query excluded E2E selection");
  // Matching paths do not authenticate the patch text or its completeness. The change query lets the graph derive hunks from verified commits.
  if (args.hunks != null) throw new Error("the graph query used caller-supplied hunks; select whole files or use the exact committed base and head");

  if (Array.isArray(args.files) && !args.change) {
    const paths = args.files.flatMap((entry) => typeof entry === "string" ? [entry]
      : [entry?.path, ...(entry?.previous_path && entry.status === "renamed" ? [entry.previous_path] : [])]);
    if (paths.every(relativePath) && sameStringList([...new Set(paths)].sort(), scope.changedFiles)) return;
  } else if (args.change && args.files == null) {
    const source = sourceIdentity(values.worktree);
    if (source.diffSha256 === NO_DIFF && args.change.base === scope.base && args.change.head === source.head) return;
  }
  throw new Error("the observed graph query must cover the exact changed-file scope of this worktree");
}

function requiredTargetedSpecs(graph, scope) {
  return [...new Set([...graph.result.selected, ...scope.changedSpecs])].sort();
}

/** A successful native graph tool item normalized into the exact spec selection it returned. */
export function graphSelectionFromItem(item, selector) {
  if (item?.type !== "mcpToolCall" || item.status !== "completed" || item.tool !== selector || typeof item.id !== "string") return null;
  const result = parsedToolResult(item);
  return { toolCallId: item.id, query: JSON.stringify(item.arguments ?? {}),
    repository: typeof result?.repo === "string" ? result.repo : null, result: graphResult(result) };
}

async function nativeGraphSelection(values, readTurn = readCodexTurnItems) {
  const selector = values.graphSelector ?? providerDataOr(sessionBinding(values.worktree), "recipes", "prEvidence", "graphSelector", null);
  if (typeof selector !== "string" || !selector) throw new Error("the bound provider does not name a graph selector for targeted E2E");
  const native = await readTurn(values["graph-session"], values["graph-turn"]);
  const calls = native.items.map((item) => graphSelectionFromItem(item, selector)).filter(Boolean);
  if (calls.length !== 1) throw new Error(`the completed native turn needs exactly one successful ${selector} graph call`);
  return { ...calls[0], runtime: "codex", sessionId: values["graph-session"], turnId: values["graph-turn"] };
}

function claudeToolResult(block) {
  const text = typeof block?.content === "string" ? block.content
    : (block?.content ?? []).filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
  try { return JSON.parse(text); } catch { throw new Error("the Claude graph tool result is not JSON"); }
}

function claudeGraphSelection(values, selector) {
  const resultEvidence = evidenceFingerprint(values["graph-launcher-result"]);
  const launcher = JSON.parse(readFileSync(resultEvidence.path, "utf8"));
  const currentSource = sourceIdentity(values.worktree);
  if (launcher.runtime !== "claude" || launcher.status !== "DONE" || !launcher.sessionId || !launcher.tracePath
    || !sameSource(launcher.source, currentSource)) throw new Error("the Claude graph launcher result is not DONE on the current source");
  const traceEvidence = evidenceFingerprint(launcher.tracePath);
  const events = readFileSync(traceEvidence.path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const blocks = events.flatMap((event) => event?.message?.content ?? []);
  const tools = blocks.filter((block) => block?.type === "tool_use" && typeof block.name === "string"
    && block.name.slice(block.name.lastIndexOf("__") + 2).replaceAll("-", "_") === selector);
  if (tools.length !== 1 || typeof tools[0].id !== "string") throw new Error(`the Claude trace needs exactly one ${selector} graph call`);
  const result = blocks.find((block) => block?.type === "tool_result" && block.tool_use_id === tools[0].id && !block.is_error);
  if (!result) throw new Error("the Claude graph call has no successful tool result");
  const selected = graphSelectionFromItem({ type: "mcpToolCall", id: tools[0].id, tool: selector, status: "completed",
    arguments: tools[0].input ?? {}, result: { structuredContent: claudeToolResult(result) } }, selector);
  return { ...selected, runtime: "claude", sessionId: launcher.sessionId, evidence: { result: resultEvidence, trace: traceEvidence } };
}

async function observedGraphSelection(values, readTurn = readCodexTurnItems) {
  const selector = values.graphSelector ?? providerDataOr(sessionBinding(values.worktree), "recipes", "prEvidence", "graphSelector", null);
  if (typeof selector !== "string" || !selector) throw new Error("the bound provider does not name a graph selector for targeted E2E");
  if (values["graph-launcher-result"]) return claudeGraphSelection(values, selector);
  return nativeGraphSelection({ ...values, graphSelector: selector }, readTurn);
}

export async function targetedRecord(values, lane, readTurn = readCodexTurnItems) {
  const baseSupplied = [values["targeted-specs"], values["graph-query"]];
  const nativeSupplied = [values["graph-session"], values["graph-turn"]];
  const launcherSupplied = values["graph-launcher-result"] !== undefined;
  const nativeAny = nativeSupplied.some((item) => item !== undefined);
  const nativeAll = nativeSupplied.every((item) => item !== undefined);
  if (baseSupplied.every((item) => item === undefined) && nativeSupplied.every((item) => item === undefined) && !launcherSupplied) return null;
  if (baseSupplied.some((item) => item === undefined) || (nativeAny && !nativeAll) || (nativeAll === launcherSupplied)) {
    throw new Error("--targeted-specs and --graph-query need exactly one graph proof: --graph-session with --graph-turn, or --graph-launcher-result");
  }
  if (!isWebE2eLane(lane) && !isDesktopE2eLane(lane)) throw new Error("targeted specs are accepted only for an E2E lane");
  if (!allowsTargetedE2e(values.worktree)) throw new Error("the target repository's AGENTS.md does not allow targeted E2E lanes");
  const specs = parseTargetedSpecs(values["targeted-specs"]);
  const graphQuery = values["graph-query"].trim();
  if (!graphQuery) throw new Error("--graph-query must record the non-empty graph query that selected the targeted specs");
  const graph = await observedGraphSelection(values, readTurn);
  if (graph.query !== graphQuery) throw new Error("--graph-query must exactly match the observed graph tool arguments JSON");
  const scope = targetedScope(values);
  assertGraphScope(values, graph, scope);
  const required = requiredTargetedSpecs(graph, scope);
  if (!sameStringList(specs, required)) throw new Error(`--targeted-specs must exactly match graph-selected plus added or edited E2E specs: ${required.join(", ")}`);
  return { specs, graphQuery, graph, changedFiles: scope.changedFiles };
}

function sameStringList(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Valid targeted E2E receipts for the current source and changed-file scope. */
export async function targetedE2eCoverage(values, lanes, records, selected, readTurn = readCodexTurnItems) {
  if (!allowsTargetedE2e(values.worktree)) return [];
  const scope = targetedScope(values);
  const covered = [];
  for (const lane of lanes) {
    if (!isWebE2eLane(lane) && !isDesktopE2eLane(lane)) continue;
    const record = records.find((item) => item.command === lane && item.result === "pass" && item.targeted
      && typeof item.targeted.graphQuery === "string" && item.targeted.graphQuery.trim()
      && sameSelection(item, selected) && sameStringList(item.targeted.changedFiles, scope.changedFiles));
    if (!record) continue;
    let current;
    try {
      current = await observedGraphSelection({ ...values, "graph-session": record.targeted.graph?.runtime === "codex" ? record.targeted.graph.sessionId : undefined,
        "graph-turn": record.targeted.graph?.runtime === "codex" ? record.targeted.graph.turnId : undefined,
        "graph-launcher-result": record.targeted.graph?.runtime === "claude" ? record.targeted.graph.evidence?.result?.path : undefined }, readTurn);
      assertGraphScope(values, current, scope);
    }
    catch { continue; }
    if (current.toolCallId !== record.targeted.graph?.toolCallId || current.query !== record.targeted.graphQuery
      || current.runtime !== record.targeted.graph?.runtime || JSON.stringify(current.result) !== JSON.stringify(record.targeted.graph?.result)
      || (current.runtime === "claude" && JSON.stringify(current.evidence) !== JSON.stringify(record.targeted.graph?.evidence))) continue;
    const required = requiredTargetedSpecs(current, scope);
    if (sameStringList(record.targeted.specs, required)) covered.push({ lane, specs: record.targeted.specs });
  }
  return covered;
}

/**
 * The selected lanes plus story-typecheck.mjs when the diff changes a story whose package has
 * no typecheck script: the repository's lane report names no such lane, and PR #9732 shipped a
 * type error in a story that nothing typechecked. The diff is measured from --base,
 * else from HEAD's merge base with origin/main; with neither, no story lane can be derived.
 */
function withStoryTypecheck(values, lanes) {
  let base = values.base;
  if (!base) {
    try { base = git(values.worktree, ["merge-base", "HEAD", "refs/remotes/origin/main"]); } catch { base = null; }
  }
  const lane = base ? storyTypecheckLane(values.worktree, base) : null;
  return lane && !lanes.includes(lane) ? [...lanes, lane] : lanes;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: {
    worktree: { type: "string" }, head: { type: "string" }, source: { type: "string" }, command: { type: "string" }, result: { type: "string" }, report: { type: "string" }, impact: { type: "string" }, skip: { type: "string" }, "skip-ruling": { type: "string" },
    "main-worktree": { type: "string" }, "main-sha": { type: "string" },
    "reuse-cache": { type: "boolean" }, "reuse-unaffected": { type: "string" }, base: { type: "string" }, config: { type: "string", multiple: true },
    "ran-on": { type: "string" }, "proof-commit": { type: "string" }, "git-tree": { type: "string" },
    "cloud-result": { type: "string" },
    "fleet-where": { type: "string" }, "fleet-orch": { type: "string" }, "fleet-owner": { type: "string" },
    targeted: { type: "string" }, "targeted-ruling-id": { type: "string" }, "targeted-ruling-source": { type: "string" },
    "targeted-specs": { type: "string" }, "graph-query": { type: "string" }, "graph-session": { type: "string" }, "graph-turn": { type: "string" }, "graph-launcher-result": { type: "string" },
    ticket: { type: "string" }, rulings: { type: "string" },
  } });
  if (!values.worktree) throw new Error("--worktree is required");
  if (command === "run" || command === "record") {
    if (!values.command?.trim() || (command === "record" && !["pass", "fail"].includes(values.result))) throw new Error(`${command} needs --head, --command${command === "record" ? " and --result pass|fail" : ""}`);
    const source = testedSource(values.worktree, values.head);
    const tested = source.head;
    const ranOn = command === "record" ? remoteRun(values, source) : null;
    if (command === "record") {
      if (!ranOn && !values.source && source.diffSha256 !== createHash('sha256').digest('hex')) {
        throw new Error('record of uncommitted inputs needs --source <JSON identity captured by the external runner>');
      }
      if (values.source && !sameSource(JSON.parse(values.source), source)) throw new Error('record --source does not match the current inputs');
    }
    const selected = { ...selectedScope(values, values.command.trim()), source };
    if (command === "run" && selected.workflowCommands?.includes(values.command.trim())) {
      throw new Error("a workflow recipe is a CI lane identity. Run its job or matrix entry in the owning harness, then use record with its exact recipe and source evidence");
    }
    const targetedReceipt = command === "record" ? await targetedRecord(values, values.command.trim()) : null;
    if (command === "run" && ["targeted-specs", "graph-query", "graph-session", "graph-turn", "graph-launcher-result"].some((key) => values[key] !== undefined)) {
      throw new Error("targeted E2E evidence is recorded after the selected specs run, with record --targeted-specs --graph-query and a native or Claude graph proof");
    }
    if (Boolean(values["main-worktree"]) !== Boolean(values["main-sha"]) || (values["main-worktree"] && command !== "run")) {
      throw new Error("--main-worktree and --main-sha go together, on run only");
    }
    if (values["main-worktree"] && values["fleet-where"]) throw new Error("a fleet lane run cannot also rerun captured main");
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
        const preflight = lanePreflightProblem(values.command);
        if (preflight) throw new Error(preflight);
        const fleet = fleetLaneInvocation(values, expected, tree);
        return fleet
          ? { status: spawnSync(fleet.bin, fleet.args, { cwd: tree, stdio: 'inherit' }).status, fleet: fleet.receipt }
          : { status: spawnSync(values.command, { cwd: tree, shell: true, stdio: 'inherit' }).status };
      }, { head: expected.head });
      let unchanged = true;
      let fleetReceipt;
      try { const execution = execute(values.worktree, source); result = execution.status === 0 ? 'pass' : 'fail'; fleetReceipt = execution.fleet; }
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
      values.fleetReceipt = fleetReceipt;
    }
    const cacheKey = source.diffSha256 === createHash("sha256").digest("hex") ? laneKeyFor(values.worktree, { command: values.command, base: values.base, config: values.config }) : null;
    // Two lanes of one pool finish close together: the read, the change and the write happen under one lock so neither record is lost.
    withRecordsLock(values.worktree, () => {
      const records = readRecords(values.worktree).filter((record) => !(record.command === values.command.trim() && sameSelection(record, selected)));
      records.push({ command: values.command.trim(), head: tested, source, laneKey: selected.laneKey, result, provenance: Provenance.Fresh, ...(cacheKey ? { cacheKey } : {}), ...(mainSha ? { mainSha, mainSource } : {}), ...(ranOn ? { ranOn } : {}), ...(values.fleetReceipt ? { fleet: values.fleetReceipt } : {}), ...(targetedReceipt ? { targeted: targetedReceipt } : {}), at: new Date().toISOString() });
      writeRecords(values.worktree, records);
    });
    process.stdout.write(`recorded ${result} for ${values.command.trim()} at ${JSON.stringify(source)}${mainSha ? ` (fails on captured main ${mainSha} too)` : ""}${ranOn ? ` (ran on ${ranOn.host} at ${ranOn.proofCommit})` : ""}\n`);
    return result === "pass" || result === "main-preexisting" ? 0 : 1;
  }
  if (command === "check") {
    const source = sourceIdentity(values.worktree);
    const checked = await (async () => {
      const head = source.head;
      if (values.skip && !values["skip-ruling"]?.trim()) throw new Error("--skip needs --skip-ruling naming the operator ruling that waives those lanes");
      const selected = { ...selectedScope(values), source };
      const named = selected.lanes;
      const impact = selected.impact;
      if (impact && !["None", "Lanes only", "Visual QA"].includes(impact.outcome)) throw new Error("the impact file has no valid qa-impact outcome");
      const skip = values.skip ? new RegExp(values.skip, "i") : null;
      const records = readRecords(values.worktree);
      const targeted = targetedLaneDecision(values, named);
      const targetedRuns = await targetedE2eCoverage(values, named, records, selected);
      const targetedRunLanes = targetedRuns.map((item) => item.lane);
      const left = notRunLanes(named.filter((lane) => !skip?.test(lane) && !targeted.left.includes(lane) && !targetedRunLanes.includes(lane)), records, selected,
        { identity: hasStagingE2eIdentity(values.worktree), harness: hasDisplaylessElectronHarness() });
      const notRun = left.map((item) => item.lane);
      const lanes = named.filter((lane) => !skip?.test(lane) && !targeted.left.includes(lane) && !targetedRunLanes.includes(lane) && !notRun.includes(lane));
      for (const lane of named.filter((lane) => skip?.test(lane))) process.stdout.write(`SKIPPED-LANE ${lane} (${values["skip-ruling"].trim()})\n`);
      for (const lane of targeted.left) process.stdout.write(`RULED-LANE ${lane} (${targeted.id}, ${targeted.source}: outside the diff-targeted lane set)\n`);
      for (const { lane, specs } of targetedRuns) process.stdout.write(`TARGETED-LANE ${lane} (${specs.length} specs)\n`);
      if (notRun.length || targeted.left.length) {
        const replaced = [...notRun, ...targeted.left];
        const kept = records.filter((record) => !(replaced.includes(record.command) && sameSelection(record, selected)));
        const at = new Date().toISOString();
        const ruled = targeted.left.map((lane) => ({ command: lane, head, source: selected.source, laneKey: selected.laneKey,
          result: "not-run", ruling: targeted.id, rulingSource: targeted.source, reason: "outside the diff-targeted lane set", at }));
        writeFileSync(recordsFile(values.worktree), `${JSON.stringify([...kept, ...left.map(({ lane, reason }) => ({ command: lane, head, source: selected.source, laneKey: selected.laneKey, result: "not-run", reason, at })), ...ruled], null, 2)}\n`);
        for (const { lane, reason } of left) process.stdout.write(`NOT-RUN-LANE ${lane} (${reason})\n`);
      }
      for (const record of records.filter((item) => lanes.includes(item.command) && sameSelection(item, selected) && item.result === "main-preexisting")) {
        process.stdout.write(`MAIN-PREEXISTING-LANE ${record.command} (fails on captured main ${record.mainSha} too; list it under Known main failures)\n`);
      }
      const covered = values["reuse-cache"] ? reuseCachedLanes(values, lanes, records, selected) : [];
      for (const { lane, from } of covered) process.stdout.write(`CACHED-LANE ${lane} (reused from ${from.slice(0, 12)}: same tree, base, config and scope; not a fresh run)\n`);
      const unaffected = values["reuse-unaffected"] ? reuseUnaffectedLanes(values, lanes, records, selected, covered) : [];
      for (const { lane, from } of unaffected) process.stdout.write(`CACHED-LANE ${lane} (reused from ${from.slice(0, 12)}: nothing changed since touches this lane; not a fresh run)\n`);
      const missing = missingLanes(lanes, records, selected).filter((lane) => ![...covered, ...unaffected].some((item) => item.lane === lane));
      for (const lane of missing) {
        if (selected.workflowCommands?.includes(lane)) {
          process.stdout.write(`MISSING-LANE ${lane}: run the owning workflow job and record its exact recipe with pre-pr-lanes.mjs record --report <lane report>\n`);
        } else {
          process.stdout.write(`MISSING-LANE ${lane}: run it with pre-pr-lanes.mjs run --head <HEAD> --command "${lane}" ${impact ? "--impact <qa-impact JSON>" : "--report <lane report>"}\n`);
        }
      }
      process.stdout.write(`pre-pr lanes: ${lanes.length} lanes, ${missing.length} missing${notRun.length ? `, ${notRun.length} not run locally` : ""}${values["reuse-cache"] || values["reuse-unaffected"] ? `, ${covered.length + unaffected.length} cached` : ""} for changed-file scope ${selected.laneKey ?? "none"}\n`);
      return { exitCode: missing.length === 0 ? 0 : 1 };
    })();
    if (!sameSource(source, sourceIdentity(values.worktree))) throw new Error("worktree source changed while targeted graph evidence was checked");
    return checked.exitCode;
  }
  throw new Error("Usage: pre-pr-lanes.mjs record|check ...");
}

function targetedLaneDecision(values, lanes) {
  const keys = ["targeted", "targeted-ruling-id", "targeted-ruling-source"];
  if (keys.every((key) => values[key] === undefined)) return { left: [], id: null, source: null };
  if (keys.some((key) => values[key] === undefined)) throw new Error("--targeted needs --targeted-ruling-id and --targeted-ruling-source");
  const source = values["targeted-ruling-source"];
  const evidence = { targetedTestsRuling: { id: values["targeted-ruling-id"], source } };
  const verified = targetedTestsRuling(evidence, {
    ticketText: values.ticket ? readFileSync(values.ticket, "utf8") : undefined,
    rulingsText: values.rulings ? readFileSync(values.rulings, "utf8") : undefined,
  });
  if (verified.problems.length) throw new Error(verified.problems.join("; "));
  const pattern = new RegExp(values.targeted, "i");
  const kept = lanes.filter((lane) => pattern.test(lane));
  if (kept.length === 0) throw new Error("--targeted must retain at least one lane named by the diff");
  return { left: lanes.filter((lane) => !kept.includes(lane)), id: verified.id, source };
}

/**
 * The remote run a `record --ran-on` names, or null without it. Its proof commit is provenance only: the
 * binding is the clean local HEAD's Git tree, so the row's source identity is this content's.
 */
function remoteRun(values, source) {
  if (values["cloud-result"] !== undefined) {
    if (["ran-on", "proof-commit", "git-tree"].some((key) => values[key] !== undefined) || values.source) {
      throw new Error("--cloud-result is the complete remote identity and cannot be combined with --ran-on or --source");
    }
    if (source.diffSha256 !== NO_DIFF) throw new Error("a cloud lane result needs a clean worktree so the validated commit is the recorded source");
    let result;
    try { result = JSON.parse(readFileSync(values["cloud-result"], "utf8")); }
    catch (error) { throw new Error(`cloud lane result is not readable JSON: ${error.message}`); }
    let report;
    try { report = JSON.parse(readFileSync(values.report, "utf8")); }
    catch { throw new Error("a cloud lane result needs the verified JSON workflow --report"); }
    const expected = report?.matches?.filter((item) => item?.command === values.command.trim()) ?? [];
    const repository = githubRepository(git(values.worktree, ["config", "--get", "remote.origin.url"]));
    const lane = Array.isArray(result?.lanes) ? result.lanes.find((item) => item?.command === values.command.trim()) : null;
    if (!repository || result?.repository !== repository || githubRepository(result?.provenance?.origin ?? "") !== repository) {
      throw new Error("cloud lane result repository differs from this worktree's GitHub origin");
    }
    if (result?.commit !== source.head || result?.provenance?.commit !== source.head || result?.provenance?.remote !== "true") {
      throw new Error("cloud lane result commit/provenance differs from the clean recorded source");
    }
    if (expected.length !== 1 || lane?.name !== expected[0].name || !isDeepStrictEqual(result?.laneSource, report.source)) {
      throw new Error("cloud lane result differs from the verified workflow lane name/source");
    }
    if (!RUNNER_HOST.test(result?.provenance?.host ?? "") || lane?.passed !== true || lane?.exitCode !== 0 || values.result !== "pass") {
      throw new Error("cloud lane result needs a named passing lane and a valid remote host");
    }
    const tree = git(values.worktree, ["rev-parse", "--verify", `${source.head}^{tree}`]);
    return { host: result.provenance.host, repository, proofCommit: source.head, gitTree: tree,
      command: values.command.trim(), lane: lane.name, source: "cloud-worker" };
  }
  if (["ran-on", "proof-commit", "git-tree"].every((key) => values[key] === undefined)) return null;
  if (values.source) throw new Error("record --ran-on binds by Git tree; it never takes --source");
  if (!RUNNER_HOST.test(values["ran-on"] ?? "") || !COMMIT.test(values["proof-commit"] ?? "") || !COMMIT.test(values["git-tree"] ?? "")) {
    throw new Error("record of a remote run needs --ran-on <host name>, --proof-commit <full sha> and --git-tree <full Git tree hash>");
  }
  if (source.diffSha256 !== NO_DIFF) throw new Error("record --ran-on needs a clean worktree: uncommitted inputs are not the proof's Git tree");
  const tree = git(values.worktree, ["rev-parse", "--verify", `${source.head}^{tree}`]);
  if (tree !== values["git-tree"]) throw new Error(`record --git-tree ${values["git-tree"]} is not HEAD's Git tree ${tree}`);
  return { host: values["ran-on"], proofCommit: values["proof-commit"], gitTree: tree, command: values.command.trim() };
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    process.exit(failScript(error, 2));
  }
}
