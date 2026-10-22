#!/usr/bin/env node
// Before a pull request opens, every test lane the repository's lane report
// names for the diff has a passing run recorded at the current head (operator
// ruling, 2026-10-22). The repository's own rule said so and was skipped:
// main broke four times in one day in suites PR CI does not run.
//
// Usage:
//   pre-pr-lanes.mjs record --worktree <path> --command "<the lane's command, as the report prints it>" --result pass|fail
//   pre-pr-lanes.mjs check  --worktree <path> --report <the lane report's output, e.g. `pnpm test:lanes`> [--skip <regex, default e2e>]
//
// The report's lane commands are its 4-space-indented lines that start with a
// package runner (pnpm, npm, npx, yarn, node); a trailing `(<detail>)` is not
// part of the command. A report that says nothing changed needs no lane. `check`
// prints `MISSING-LANE <command>` for each lane with no passing record at HEAD
// and exits 1; a report it cannot read exits 2. Records live in the session's
// git dir (`vibe-lane-results.json`). Changes nothing else.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "./session-record.mjs";

const LANE_LINE = /^ {4}((?:pnpm|npm|npx|yarn|node)\s.*?)(?:\s{2,}\(.*\))?\s*$/;
const NOTHING = /nothing to cover|No paths changed/i;

/** The lane commands a lane report names, or null when it names none and does not say nothing changed. */
export function reportLanes(report, skip = /e2e/i) {
  const all = [...new Set(report.split("\n").map((line) => LANE_LINE.exec(line)?.[1]).filter(Boolean))];
  if (all.length === 0) return NOTHING.test(report) ? [] : null;
  return all.filter((lane) => !skip.test(lane));
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
    worktree: { type: "string" }, command: { type: "string" }, result: { type: "string" }, report: { type: "string" }, skip: { type: "string" },
  } });
  if (!values.worktree) throw new Error("--worktree is required");
  const head = git(values.worktree, ["rev-parse", "HEAD"]);
  if (command === "record") {
    if (!values.command?.trim() || !["pass", "fail"].includes(values.result)) throw new Error("record needs --command and --result pass|fail");
    const records = readRecords(values.worktree).filter((record) => !(record.command === values.command.trim() && record.head === head));
    records.push({ command: values.command.trim(), head, result: values.result, at: new Date().toISOString() });
    writeFileSync(recordsFile(values.worktree), `${JSON.stringify(records, null, 2)}\n`);
    process.stdout.write(`recorded ${values.result} for ${values.command.trim()} at ${head}\n`);
    return 0;
  }
  if (command === "check") {
    if (!values.report) throw new Error("check needs --report <lane report output>");
    const lanes = reportLanes(readFileSync(values.report, "utf8"), new RegExp(values.skip ?? "e2e", "i"));
    if (lanes === null) {
      process.stderr.write("the lane report names no lane and does not say nothing changed; rerun the repository's lane report and save its output\n");
      return 2;
    }
    const missing = missingLanes(lanes, readRecords(values.worktree), head);
    for (const lane of missing) process.stdout.write(`MISSING-LANE ${lane}: run it, then record it with pre-pr-lanes.mjs record --command "${lane}" --result pass\n`);
    process.stdout.write(`pre-pr lanes: ${lanes.length} lanes, ${missing.length} missing at ${head.slice(0, 10)}\n`);
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
