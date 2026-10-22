#!/usr/bin/env node
// Refuses to mark a PRD or plan EXECUTED until its first section is the
// production visual-QA flag section (operator ruling, 2026-10-21): every
// feature flag its shipped changes rely on, where to see each in production,
// and each flag's current production state, checked after the last merge, so
// someone else can visual-QA the work in production.
// A PRD is also executed only when every child it PRODUCES is DONE or
// CANCELED: a PRD was once marked EXECUTED with four children still open.
// Prints one JSON object; exits 0 when the document may be marked EXECUTED and
// 1 otherwise. Changes nothing.
//
// Usage: executed-check.mjs --kind plan --file <document body .md> --last-merge <iso time of the last merged pull request>
//        executed-check.mjs --kind prd --file <...> --last-merge <...> --children <children.json>
// children.json: the PRODUCES children read just now, `[{"slug", "status"}]`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const SECTION = "Production visual QA";
const HEADING = /^##\s+(.+?)\s*$/;
const CHECKED = /^\s*(?:[-*]\s+)?Checked:\s*(\S+)/m;
const FLAG_ROW = /^\s*(?:[-*]\s+`[^`]+`|\|\s*`[^`]+`\s*\|)/m;
const NO_FLAGS = /^\s*(?:[-*]\s+)?No flags:\s*\S/m;
const KINDS = new Set(["plan", "prd"]);
const FINISHED = new Set(["DONE", "CANCELED"]);

/** Problems with a PRD's children: each one not DONE or CANCELED. */
export function childProblems(children) {
  if (!Array.isArray(children)) {
    return ["--children must be a JSON array of {slug, status}"];
  }
  return children
    .filter((child) => !FINISHED.has(child?.status))
    .map((child) => `child ${child?.slug ?? "?"} is ${child?.status ?? "missing a status"}; a PRD is executed only when every PRODUCES child is DONE or CANCELED`);
}

/** Problems that keep `body` from being marked EXECUTED after a merge at `lastMerge`. */
export function executedProblems(body, lastMerge) {
  const lines = body.split("\n");
  const first = lines.findIndex((line) => HEADING.test(line));
  if (first < 0 || HEADING.exec(lines[first])[1] !== SECTION) {
    return [`the first section is not "## ${SECTION}"; add it at the top: each flag key in backticks, where to see it in production and its current state, or "No flags: <why>", then "Checked: <ISO time>"`];
  }
  const end = lines.findIndex((line, index) => index > first && HEADING.test(line));
  const section = lines.slice(first + 1, end < 0 ? lines.length : end).join("\n");
  const problems = [];
  if (!FLAG_ROW.test(section) && !NO_FLAGS.test(section)) {
    problems.push("the section lists no flag (a `key` row) and no \"No flags: <why>\" line");
  }
  const merged = Date.parse(lastMerge);
  const checked = Date.parse(CHECKED.exec(section)?.[1] ?? "");
  if (!Number.isFinite(checked)) {
    problems.push("the section has no \"Checked: <ISO time>\" line");
  } else if (!Number.isFinite(merged)) {
    problems.push(`--last-merge ${JSON.stringify(lastMerge)} is not a time`);
  } else if (checked < merged) {
    problems.push(`the flag states were checked at ${new Date(checked).toISOString()}, before the last merge at ${new Date(merged).toISOString()}; check them again`);
  }
  return problems;
}

function main() {
  const { values } = parseArgs({ options: { kind: { type: "string" }, file: { type: "string" }, "last-merge": { type: "string" }, children: { type: "string" } } });
  const error = !KINDS.has(values.kind) ? "--kind plan or --kind prd is required."
    : !values.file || !values["last-merge"] ? "--file and --last-merge are required."
    : values.kind === "prd" && !values.children ? "--kind prd needs --children <file> with its PRODUCES children read just now."
    : null;
  if (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
    process.exit(1);
  }
  const problems = [
    ...executedProblems(readFileSync(path.resolve(values.file), "utf8"), values["last-merge"]),
    ...(values.kind === "prd" ? childProblems(JSON.parse(readFileSync(path.resolve(values.children), "utf8"))) : []),
  ];
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
