#!/usr/bin/env node
// The pre-merge criteria audit and coverage matrix. A pull request merged with
// eight defects a fresh-context audit found in about twenty minutes: review
// and QA had been scoped by the writer's own plan, nothing compared the
// flag-off path with the base, and the audit against the criteria ran only
// after merge.
//
// Usage: criteria-audit.mjs --worktree <path> --ticket <ticket body .md> --audit <audit .md> --matrix <matrix .json>
//
// The criteria are the ticket's `- Acceptance criteria:` checklist, numbered
// AC-1, AC-2, ... in order.
// The audit is a fresh-context reviewer's table given only those criteria and
// the diff, run on the final head after the last main merge: a `Head: <sha>`
// line, then one `| AC-n | MET|PARTIAL|MISSED | <evidence> |` row per
// criterion. Every criterion must be MET, on the worktree's HEAD.
// The matrix: {"surfaces": [...], "inputs": [...], "flags": ["on", "off"] or [],
// "rows": [{"criterion", "surface", "input", "flag", "evidence"}]}. Every
// criterion x surface x input x flag cell needs a row with evidence; `"input":
// "*"` covers every input only with evidence starting `not input-driven:`.
// A flag-off cell's evidence starts `no behavior change:` (a story,
// accessibility or snapshot diff against the base) or `ruling:` (the human
// source). Prints {"ok","problems"}; exits 1 on any problem.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const CRITERIA_START = /^\s*-\s*Acceptance criteria:\s*$/;
const CRITERIA_HEADING = /^(#{1,6})\s+Acceptance criteria\b/i;
const HEADING = /^(#{1,6})\s/;
const CHECKBOX = /^\s+-\s*\[([ xX])\]\s*(\S.*)$/;
const TOP_CHECKBOX = /^\s*[-*]\s*\[([ xX])\]\s*(\S.*)$/;
const AUDIT_ROW = /^\|\s*(AC-\d+)\s*\|\s*(MET|PARTIAL|MISSED)\s*\|\s*(.*?)\s*\|\s*$/gm;
const AUDIT_HEAD = /^Head:\s*([0-9a-f]{7,40})\s*$/m;
const FLAG_OFF_EVIDENCE = /^(?:no behavior change:|ruling:)\s*\S/;
const ANY_INPUT_EVIDENCE = /^not input-driven:\s*\S/;

/** The ticket's acceptance criteria as AC-n ids with their text. */
export function ticketCriteria(ticket) {
  return criteriaStates(ticket).map(({ id, text }) => ({ id, text }));
}

/**
 * The acceptance criteria with whether each box is checked: the template's
 * `- Acceptance criteria:` list, or the checkboxes under an `Acceptance
 * criteria` heading up to the next heading of the same or a higher level.
 */
export function criteriaStates(ticket) {
  const criteria = [];
  const push = (match) => criteria.push({ id: `AC-${criteria.length + 1}`, text: match[2], checked: match[1] !== " " });
  let inList = false;
  let headingLevel = 0;
  for (const line of ticket.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      inList = false;
      headingLevel = CRITERIA_HEADING.test(line) ? heading[1].length : headingLevel && heading[1].length > headingLevel ? headingLevel : 0;
      continue;
    }
    if (CRITERIA_START.test(line)) {
      inList = true;
      continue;
    }
    const item = inList ? CHECKBOX.exec(line) : headingLevel ? TOP_CHECKBOX.exec(line) : null;
    if (item) {
      push(item);
    } else if (inList && line.trim() !== "" && !/^\s{4,}\S/.test(line)) {
      inList = false;
    }
  }
  return criteria;
}

/** Problems with the audit table against the criteria and the head. */
export function auditProblems(audit, criteria, head) {
  const problems = [];
  const auditedHead = AUDIT_HEAD.exec(audit)?.[1];
  if (!auditedHead || !head.startsWith(auditedHead)) {
    problems.push(`the audit ran on ${auditedHead ?? "no recorded head"}, not ${head}; rerun it on the final head after the last main merge`);
  }
  const rows = new Map([...audit.matchAll(AUDIT_ROW)].map((match) => [match[1], { verdict: match[2], evidence: match[3] }]));
  for (const { id } of criteria) {
    const row = rows.get(id);
    if (!row) problems.push(`${id}: not audited`);
    else if (row.verdict !== "MET") problems.push(`${id}: ${row.verdict}${row.evidence ? ` (${row.evidence})` : ""}`);
  }
  return problems;
}

/** Empty or unproven cells of the criteria x surface x input x flag matrix. */
export function matrixProblems(matrix, criteria) {
  const surfaces = Array.isArray(matrix?.surfaces) ? matrix.surfaces : [];
  const inputs = Array.isArray(matrix?.inputs) ? matrix.inputs : [];
  const flags = Array.isArray(matrix?.flags) && matrix.flags.length > 0 ? matrix.flags : [null];
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  if (surfaces.length === 0 || inputs.length === 0) {
    return ["the matrix names no surfaces or no input modes; list every host or adapter and every input mode (pointer, keyboard, touch)"];
  }
  if (flags[0] !== null && !flags.includes("off")) {
    return ['the matrix has flag states but no "off"; the flag-off path needs its own cells'];
  }
  const problems = [];
  for (const { id } of criteria) {
    for (const surface of surfaces) {
      for (const flag of flags) {
        for (const input of inputs) {
          const cell = `${id} x ${surface} x ${input}${flag === null ? "" : ` x flag ${flag}`}`;
          const row = rows.find((entry) => entry?.criterion === id && entry.surface === surface && (flag === null || entry.flag === flag)
            && (entry.input === input || (entry.input === "*" && ANY_INPUT_EVIDENCE.test(String(entry.evidence ?? "")))));
          const evidence = String(row?.evidence ?? "").trim();
          if (!evidence) problems.push(`${cell}: no test or QA evidence`);
          else if (flag === "off" && !FLAG_OFF_EVIDENCE.test(evidence) && !ANY_INPUT_EVIDENCE.test(evidence)) {
            problems.push(`${cell}: flag-off evidence must start "no behavior change:" (a diff against the base) or "ruling:"`);
          }
        }
      }
    }
  }
  return problems;
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { worktree: { type: "string" }, ticket: { type: "string" }, audit: { type: "string" }, matrix: { type: "string" } } });
  if (!values.worktree || !values.ticket || !values.audit || !values.matrix) {
    throw new Error("Usage: criteria-audit.mjs --worktree <path> --ticket <ticket body .md> --audit <audit .md> --matrix <matrix .json>");
  }
  const criteria = ticketCriteria(readFileSync(values.ticket, "utf8"));
  const head = execFileSync("git", ["-C", values.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const problems = [
    ...(criteria.length === 0 ? ["the ticket has no acceptance criteria checklist"] : []),
    ...auditProblems(readFileSync(values.audit, "utf8"), criteria, head),
    ...matrixProblems(JSON.parse(readFileSync(values.matrix, "utf8")), criteria),
  ];
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, criteria: criteria.map(({ id }) => id), problems }, null, 2)}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
