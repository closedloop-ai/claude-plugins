#!/usr/bin/env node
// Before a pull request opens, every test lane the repository's lane report
// names for the diff has a passing run recorded at the current head (operator
// ruling, 2026-10-22). The repository's own rule said so and was skipped:
// main broke four times in one day in suites PR CI does not run.
//
// Usage:
//   pre-pr-lanes.mjs run    --worktree <path> --head <sha> --command "<the lane's command, as the report prints it>"
//   pre-pr-lanes.mjs record --worktree <path> --head <sha the run tested> --command "<lane command>" --result pass|fail
//   pre-pr-lanes.mjs check  --worktree <path> --report <the lane report's output, e.g. `pnpm test:lanes`> [--skip <regex> --skip-ruling "<who, when, where>"]
//
// The report's lane commands are its 4-space-indented lines that start with a
// package runner (pnpm, npm, npx, yarn, node), after any `KEY='value'`
// assignments the lane's CI step binds; a trailing ` (<detail>)` is not part of
// the command. A report that says nothing changed needs no lane. `check`
// prints `MISSING-LANE <command>` for each lane with no passing record at HEAD
// and exits 1; a report it cannot read exits 2. Records live in the session's
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
// `check` does not run or require that lane; it records it `not-run` at HEAD,
// prints `NOT-RUN-LANE <command> (...)` and relies on the containerized or CI
// run instead of stopping (operator ruling, 2026-10-28, ISS-13291). The Desktop
// e2e lane is not a web lane and stays required.
//
// `run` runs a lane in the worktree and records its result; `record` takes a
// result run elsewhere. Both refuse unless the worktree's HEAD is `--head`
// with no modified tracked file (tested-head.mjs), and `run` records a failure
// when HEAD moved while it ran, so every result names the commit it tested.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "./session-record.mjs";
import { testedHead } from "./tested-head.mjs";

const LANE_LINE = /^ {4}((?:[A-Za-z_][A-Za-z0-9_]*=(?:'(?:[^']|'\\'')*'|\S+)\s+)*(?:pnpm|npm|npx|yarn|node)\s.*?)(?:\s+\(.*\))?\s*$/;
const NOTHING = /nothing to cover|No paths changed/i;
// The repo's web Playwright lanes (`pnpm test:e2e`, `pnpm test:web-smoke`); a lane naming desktop is the Electron one.
const WEB_E2E = /\b(?:test:e2e|test:web-smoke)\b/;
const DESKTOP = /\bdesktop\b/i;
// symphony-alpha e2e/helpers/sign-in.ts signs the primary identity in with this password; playwright.config.ts loads apps/app/.env.local.
export const STAGING_IDENTITY_KEY = "DEVOPS_CLOSEDLOOP_APP_PWD";
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
export const NOT_RUN_NO_IDENTITY = "no staging e2e identities on this machine; the containerized or CI run covers it";

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

/** Lanes with no passing record at `head`. */
export function missingLanes(lanes, records, head) {
  return lanes.filter((lane) => !records.some((record) => record.command === lane && record.head === head && record.result === "pass"));
}

function recordsFile(worktree) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "vibe-lane-results.json");
}

function readRecords(worktree) {
  const file = recordsFile(worktree);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: {
    worktree: { type: "string" }, head: { type: "string" }, command: { type: "string" }, result: { type: "string" }, report: { type: "string" }, skip: { type: "string" }, "skip-ruling": { type: "string" },
  } });
  if (!values.worktree) throw new Error("--worktree is required");
  if (command === "run" || command === "record") {
    if (!values.command?.trim() || (command === "record" && !["pass", "fail"].includes(values.result))) throw new Error(`${command} needs --head, --command${command === "record" ? " and --result pass|fail" : ""}`);
    const tested = testedHead(values.worktree, values.head);
    let result = values.result;
    if (command === "run") {
      const run = spawnSync(values.command, { cwd: values.worktree, shell: true, stdio: "inherit" });
      const after = git(values.worktree, ["rev-parse", "HEAD"]);
      result = run.status === 0 && after === tested ? "pass" : "fail";
      if (after !== tested) process.stdout.write(`HEAD-MOVED from ${tested.slice(0, 12)} to ${after.slice(0, 12)} during the run\n`);
    }
    const records = readRecords(values.worktree).filter((record) => !(record.command === values.command.trim() && record.head === tested));
    records.push({ command: values.command.trim(), head: tested, result, at: new Date().toISOString() });
    writeFileSync(recordsFile(values.worktree), `${JSON.stringify(records, null, 2)}\n`);
    process.stdout.write(`recorded ${result} for ${values.command.trim()} at ${tested}\n`);
    return result === "pass" ? 0 : 1;
  }
  const head = git(values.worktree, ["rev-parse", "HEAD"]);
  if (command === "check") {
    if (!values.report) throw new Error("check needs --report <lane report output>");
    if (values.skip && !values["skip-ruling"]?.trim()) throw new Error("--skip needs --skip-ruling naming the operator ruling that waives those lanes");
    const named = reportLanes(readFileSync(values.report, "utf8"));
    if (named === null) {
      process.stderr.write("the lane report names no lane and does not say nothing changed; rerun the repository's lane report and save its output\n");
      return 2;
    }
    const skip = values.skip ? new RegExp(values.skip, "i") : null;
    const records = readRecords(values.worktree);
    const notRun = hasStagingE2eIdentity(values.worktree) ? []
      : named.filter((lane) => !skip?.test(lane) && isWebE2eLane(lane) && missingLanes([lane], records, head).length);
    const lanes = named.filter((lane) => !skip?.test(lane) && !notRun.includes(lane));
    for (const lane of named.filter((lane) => skip?.test(lane))) process.stdout.write(`SKIPPED-LANE ${lane} (${values["skip-ruling"].trim()})\n`);
    if (notRun.length) {
      const kept = records.filter((record) => !(notRun.includes(record.command) && record.head === head));
      const at = new Date().toISOString();
      writeFileSync(recordsFile(values.worktree), `${JSON.stringify([...kept, ...notRun.map((lane) => ({ command: lane, head, result: "not-run", reason: NOT_RUN_NO_IDENTITY, at }))], null, 2)}\n`);
      for (const lane of notRun) process.stdout.write(`NOT-RUN-LANE ${lane} (${NOT_RUN_NO_IDENTITY})\n`);
    }
    const missing = missingLanes(lanes, records, head);
    for (const lane of missing) process.stdout.write(`MISSING-LANE ${lane}: run it, with pre-pr-lanes.mjs run --head <HEAD> --command "${lane}"\n`);
    process.stdout.write(`pre-pr lanes: ${lanes.length} lanes, ${missing.length} missing${notRun.length ? `, ${notRun.length} not run locally` : ""} at ${head.slice(0, 10)}\n`);
    return missing.length === 0 ? 0 : 1;
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
