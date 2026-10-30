#!/usr/bin/env node
// Before a pull request opens, every test lane the repository's lane report
// names for the diff has a passing run recorded for that changed-file scope (operator
// ruling, 2026-10-22). The repository's own rule said so and was skipped:
// main broke four times in one day in suites PR CI does not run.
//
// Usage:
//   pre-pr-lanes.mjs run    --worktree <path> --head <sha> --command "<lane command>" (--report <initial lane report> | --impact <qa-impact JSON>) [--main-worktree <checkout of captured main> --main-sha <sha>]
//   pre-pr-lanes.mjs record [--source <external source JSON; required for uncommitted inputs>] --worktree <path> --head <sha the run tested> --command "<lane command>" --result pass|fail (--report <initial lane report> | --impact <qa-impact JSON>)
//   pre-pr-lanes.mjs check  --worktree <path> (--report <initial lane report> | --impact <qa-impact JSON>) [--skip <regex> --skip-ruling "<who, when, where>"]
//
// The report's lane commands are its 4-space-indented lines that start with a
// package runner (pnpm, npm, npx, yarn, node), after any `KEY='value'`
// assignments the lane's CI step binds; a trailing ` (<detail>)` is not part of
// the command. A report that says nothing changed needs no lane. `check`
// prints `MISSING-LANE <command>` for each lane with no passing record for that scope
// and exits 1; a report it cannot read exits 2. After automated QA, `--impact`
// narrows the check to only lanes qa-impact.mjs selected. A None result needs
// no local lane merely because another commit exists. Records live in the session's
// git dir (`vibe-lane-results.json`). Changes nothing else.
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { qaImpactRequest } from "../../handoff/scripts/qa-impact.mjs";
import { git } from "./session-record.mjs";
import { testedHead, sourceIdentity, sameSource, withStableSource } from "./tested-head.mjs";

const LANE_LINE = /^ {4}((?:[A-Za-z_][A-Za-z0-9_]*=(?:'(?:[^']|'\\'')*'|\S+)\s+)*(?:pnpm|npm|npx|yarn|node)\s.*?)(?:\s+\(.*\))?\s*$/;
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

function readRecords(worktree) {
  const file = recordsFile(worktree);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

function selectedScope(values, command) {
  if (Boolean(values.report) === Boolean(values.impact)) throw new Error("exactly one of --report or --impact is required");
  if (values.impact) {
    const impact = qaImpactRequest(values.worktree, JSON.parse(readFileSync(values.impact, "utf8")));
    if (!Array.isArray(impact.lanes) || (command && !impact.lanes.includes(command)) || (impact.lanes.length && !/^[a-f0-9]{16}$/.test(impact.laneKey ?? ""))) {
      throw new Error("--impact must select this lane and carry qa-impact.mjs laneKey");
    }
    return { lanes: impact.lanes, laneKey: impact.laneKey ?? null, impact };
  }
  const report = readFileSync(values.report, "utf8");
  const lanes = reportLanes(report);
  if (lanes === null || (command && !lanes.includes(command))) throw new Error("--report must name this lane or explicitly say nothing changed");
  const laneKey = createHash("sha256").update(JSON.stringify(lanes)).update("\n").update(report).digest("hex").slice(0, 16);
  return { lanes, laneKey, impact: null };
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: {
    worktree: { type: "string" }, head: { type: "string" }, source: { type: "string" }, command: { type: "string" }, result: { type: "string" }, report: { type: "string" }, impact: { type: "string" }, skip: { type: "string" }, "skip-ruling": { type: "string" },
    "main-worktree": { type: "string" }, "main-sha": { type: "string" },
  } });
  if (!values.worktree) throw new Error("--worktree is required");
  if (command === "run" || command === "record") {
    if (!values.command?.trim() || (command === "record" && !["pass", "fail"].includes(values.result))) throw new Error(`${command} needs --head, --command${command === "record" ? " and --result pass|fail" : ""}`);
    const tested = testedHead(values.worktree, values.head);
    const source = sourceIdentity(values.worktree, tested);
    if (command === "record") {
      if (!values.source && source.diffSha256 !== createHash('sha256').digest('hex')) {
        throw new Error('record of uncommitted inputs needs --source <JSON identity captured by the external runner>');
      }
      if (values.source && !sameSource(JSON.parse(values.source), source)) throw new Error('record --source does not match the current inputs');
    }
    const selected = { ...selectedScope(values, values.command.trim()), source };
    if (Boolean(values["main-worktree"]) !== Boolean(values["main-sha"]) || (values["main-worktree"] && command !== "run")) {
      throw new Error("--main-worktree and --main-sha go together, on run only");
    }
    const mainTested = values["main-worktree"] ? testedHead(values["main-worktree"], values["main-sha"]) : null;
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
    const records = readRecords(values.worktree).filter((record) => !(record.command === values.command.trim() && sameSelection(record, selected)));
    records.push({ command: values.command.trim(), head: tested, source, laneKey: selected.laneKey, result, ...(mainSha ? { mainSha, mainSource } : {}), at: new Date().toISOString() });
    writeFileSync(recordsFile(values.worktree), `${JSON.stringify(records, null, 2)}\n`);
    process.stdout.write(`recorded ${result} for ${values.command.trim()} at ${JSON.stringify(source)}${mainSha ? ` (fails on captured main ${mainSha} too)` : ""}\n`);
    return result === "pass" || result === "main-preexisting" ? 0 : 1;
  }
  if (command === "check") {
    return withStableSource(values.worktree, source => {
      const head = source.head;
      if (values.skip && !values["skip-ruling"]?.trim()) throw new Error("--skip needs --skip-ruling naming the operator ruling that waives those lanes");
      const selected = { ...selectedScope(values), source };
      const named = selected.lanes;
      const impact = selected.impact;
      if (impact && !["None", "Lanes only", "Visual QA"].includes(impact.outcome)) throw new Error("the impact file has no valid qa-impact outcome");
      const skip = values.skip ? new RegExp(values.skip, "i") : null;
      const records = readRecords(values.worktree);
      const left = notRunLanes(named.filter((lane) => !skip?.test(lane)), records, selected,
        { identity: hasStagingE2eIdentity(values.worktree), harness: hasDisplaylessElectronHarness() });
      const notRun = left.map((item) => item.lane);
      const lanes = named.filter((lane) => !skip?.test(lane) && !notRun.includes(lane));
      for (const lane of named.filter((lane) => skip?.test(lane))) process.stdout.write(`SKIPPED-LANE ${lane} (${values["skip-ruling"].trim()})\n`);
      if (notRun.length) {
        const kept = records.filter((record) => !(notRun.includes(record.command) && sameSelection(record, selected)));
        const at = new Date().toISOString();
        writeFileSync(recordsFile(values.worktree), `${JSON.stringify([...kept, ...left.map(({ lane, reason }) => ({ command: lane, head, source: selected.source, laneKey: selected.laneKey, result: "not-run", reason, at }))], null, 2)}\n`);
        for (const { lane, reason } of left) process.stdout.write(`NOT-RUN-LANE ${lane} (${reason})\n`);
      }
      for (const record of records.filter((item) => lanes.includes(item.command) && sameSelection(item, selected) && item.result === "main-preexisting")) {
        process.stdout.write(`MAIN-PREEXISTING-LANE ${record.command} (fails on captured main ${record.mainSha} too; list it under Known main failures)\n`);
      }
      const missing = missingLanes(lanes, records, selected);
      for (const lane of missing) process.stdout.write(`MISSING-LANE ${lane}: run it with pre-pr-lanes.mjs run --head <HEAD> --command "${lane}" ${impact ? "--impact <qa-impact JSON>" : "--report <lane report>"}\n`);
      process.stdout.write(`pre-pr lanes: ${lanes.length} lanes, ${missing.length} missing${notRun.length ? `, ${notRun.length} not run locally` : ""} for changed-file scope ${selected.laneKey ?? "none"}\n`);
      return { exitCode: missing.length === 0 ? 0 : 1 };
    }).exitCode;
  }
  throw new Error("Usage: pre-pr-lanes.mjs record|check ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
