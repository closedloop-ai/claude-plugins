#!/usr/bin/env node
// The pre-merge criteria audit and coverage matrix. A pull request merged with
// eight defects a fresh-context audit found in about twenty minutes: review
// and QA had been scoped by the writer's own plan, nothing compared the
// flag-off path with the base, and the audit against the criteria ran only
// after merge.
//
// Usage: criteria-audit.mjs --worktree <path> --ticket <ticket body .md> --audit <audit .md> --matrix <matrix .json> [--at head]
//          [--member <ISS-124>=<that ticket's body .md> ...] [--prd <slug>=<PRD body .md> ...] [--plan <slug>=<plan body .md> ...] [--review <review.json>] [--slug <ticket slug>]
//
// The criteria are the ticket's `- Acceptance criteria:` checklist, numbered
// AC-1, AC-2, ... in order. A fleet unit's session (ISS-13924) delivers other
// tickets in the same PR; it records them with `vibe-sessions.mjs touch
// --member-ticket`, and each needs `--member <slug>=<body>`, whose criteria are
// <slug>:AC-1, <slug>:AC-2, ... in the audit and the matrix. A recorded member
// with no `--member` body is a problem, so no member's criteria go unaudited.
// The audit is a fresh-context reviewer's table given only those criteria and
// the diff: one `| AC-n | MET|PARTIAL|MISSED | <type> | <ref> |` row per
// criterion, so the verdict, its evidence type and its ref live in one place
// (vibe/references/spec-card.md, "Audit rows"). Every criterion needs a MET row
// whose type is test, script, screenshot, api-read or source-trace and whose ref names the
// evidence; a criterion with no such row blocks "done", and so does any
// PARTIAL or MISSED row. A test ref must name a file that exists: in the worktree
// for a candidate audit (the writer's new tests are not committed yet), at HEAD with `--at head`, which handoff-gate.mjs passes. Later work is classified by qa-impact.mjs, which reruns this
// audit only when its affected scope changed.
// The matrix: {"surfaces": [...], "inputs": [...], "flags": ["on", "off"] or [],
// "rows": [{"criterion", "surface", "input", "flag", "evidence"}]}. Every
// criterion x surface x input x flag cell needs a row with evidence; `"input":
// "*"` covers every input only with evidence starting `not input-driven:`.
// A flag-off cell's evidence starts `no behavior change:` (a story,
// accessibility or snapshot diff against the base) or `ruling:` (the human
// source). A criterion that needs the product running on a surface (it names
// Web, Desktop, the browser or the running app, as in "verified on web and
// Desktop") is never MET by typecheck, unit-test or source evidence alone: it
// needs a MET screenshot row, or a test or script row whose ref is an e2e spec
// or a control run. A PR once claimed such a criterion met by tests and
// typecheck only. A unit (member tickets, or a PRD with `--prd <slug>=<body>`) also
// needs `--review <review.json>`: unit-review.mjs checks that every member and
// PRD criterion passed both a code review and a visual QA capture on each page
// and surface it names, and its GAP lines join the problems.
// Prints {"ok","problems"}; exits 1 on any problem.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readSessionRecord } from "../../vibe/scripts/session-record.mjs";
import { EVIDENCE_TYPES } from "../../vibe/scripts/spec-card.mjs";
import { reviewUnit } from "./unit-review.mjs";

export const EvidenceAt = Object.freeze({ Worktree: "worktree", Head: "head" });

const CRITERIA_START = /^\s*-\s*Acceptance criteria:\s*$/;
const CRITERIA_HEADING = /^(#{1,6})\s+Acceptance criteria\b/i;
const HEADING = /^(#{1,6})\s/;
const CHECKBOX = /^\s+-\s*\[([ xX])\]\s*(\S.*)$/;
const TOP_CHECKBOX = /^\s*[-*]\s*\[([ xX])\]\s*(\S.*)$/;
const AUDIT_ROW = /^\|\s*((?:[A-Z]+-\d+:)?AC-\d+)\s*\|\s*(MET|PARTIAL|MISSED)\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$/gm;
const FLAG_OFF_EVIDENCE = /^(?:no behavior change:|ruling:)\s*\S/;
const ANY_INPUT_EVIDENCE = /^not input-driven:\s*\S/;
const RUNTIME_CRITERION = /\b(?:web|desktop|electron|browser)\b|\brunning (?:app|product)\b/i;
const RUNTIME_REF = /\be2e\b|\.spec\.[cm]?[jt]sx?\b|\bplaywright\b|\bcontrol\b/i;

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

/** Criteria with no valid MET row, rows that are not MET or are unproven, and rows for criteria the ticket does not list. */
export function auditProblems(audit, criteria, worktree = null, at = EvidenceAt.Worktree) {
  const rows = [...audit.matchAll(AUDIT_ROW)].map((match) => ({ criterion: match[1], verdict: match[2], type: match[3], ref: match[4] }));
  const problems = [];
  for (const { id, text } of criteria) {
    const entries = rows.filter((row) => row.criterion === id);
    if (entries.length === 0) {
      problems.push(`${id}: not audited`);
      continue;
    }
    const rowProblems = entries.flatMap((row) => auditRowProblems(id, row, worktree, at));
    problems.push(...rowProblems);
    if (rowProblems.length === 0 && !entries.some((row) => row.verdict === "MET")) problems.push(`${id}: no MET audit row`);
    else if (rowProblems.length === 0 && RUNTIME_CRITERION.test(text ?? "") && !entries.some((row) => row.verdict === "MET" && isRuntimeRow(row))) {
      problems.push(`${id}: it needs the product running on a surface, so typecheck, unit-test or source evidence alone does not meet it; add a screenshot, e2e or control row`);
    }
  }
  const known = new Set(criteria.map(({ id }) => id));
  for (const row of rows) {
    if (!known.has(row.criterion)) problems.push(`${row.criterion}: audit row for a criterion the ticket does not list`);
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

/** A row that saw the product run: a screenshot, or a test or script run through e2e or the repo's control skill. */
function isRuntimeRow(row) {
  return row.type === "screenshot" || ((row.type === "test" || row.type === "script") && RUNTIME_REF.test(row.ref));
}

function auditRowProblems(id, row, worktree, at) {
  if (row.verdict !== "MET") return [`${id}: ${row.verdict}${row.ref ? ` (${row.ref})` : ""}`];
  if (!EVIDENCE_TYPES.includes(row.type)) return [`${id}: evidence type must be one of ${EVIDENCE_TYPES.join(", ")}`];
  if (row.ref.trim() === "") return [`${id}: MET needs a ref naming the ${row.type}`];
  if (row.type === "test" && worktree !== null) {
    const file = row.ref.split(/::|#/)[0].trim();
    if (!testFileExists(worktree, file, at)) return [`${id}: the test ${file} does not exist ${at === EvidenceAt.Head ? "at HEAD" : "in the worktree"}; a planned test is not evidence`];
  }
  return [];
}

function testFileExists(worktree, file, at) {
  return at === EvidenceAt.Head ? existsAtHead(worktree, file) : existsSync(path.join(worktree, file)) || existsInIndex(worktree, file);
}

function existsInIndex(worktree, file) {
  try {
    execFileSync("git", ["-C", worktree, "cat-file", "-e", `:${file}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function existsAtHead(worktree, file) {
  try {
    execFileSync("git", ["-C", worktree, "cat-file", "-e", `HEAD:${file}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Each member ticket's criteria as <slug>:AC-n, and the recorded members that have no body. */
export function memberCriteria(members, recorded = []) {
  const problems = [];
  const criteria = [];
  const given = new Set();
  for (const entry of members) {
    const at = entry.indexOf("=");
    const slug = entry.slice(0, at);
    if (at <= 0 || !/^[A-Z]+-\d+$/.test(slug)) throw new Error(`--member needs <slug>=<ticket body file>, got ${entry}`);
    given.add(slug);
    const own = ticketCriteria(readFileSync(entry.slice(at + 1), "utf8")).map(({ id, text }) => ({ id: `${slug}:${id}`, text }));
    if (own.length === 0) problems.push(`member ${slug} has no acceptance criteria checklist`);
    criteria.push(...own);
  }
  for (const slug of recorded) if (!given.has(slug)) problems.push(`member ${slug} is recorded on the session but has no --member body; its criteria are not audited`);
  return { criteria, problems };
}

/** The member tickets the session recorded; none when the worktree has no session record. */
function recordedMembers(worktree) {
  try { return readSessionRecord(worktree)?.memberTickets ?? []; }
  catch { return []; }
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { worktree: { type: "string" }, ticket: { type: "string" }, audit: { type: "string" }, matrix: { type: "string" }, at: { type: "string" }, member: { type: "string", multiple: true }, prd: { type: "string", multiple: true }, plan: { type: "string", multiple: true }, review: { type: "string" }, slug: { type: "string" } } });
  if (!values.worktree || !values.ticket || !values.audit || !values.matrix) {
    throw new Error("Usage: criteria-audit.mjs --worktree <path> --ticket <ticket body .md> --audit <audit .md> --matrix <matrix .json> [--member <slug>=<body> ...] [--prd <slug>=<body> ...] [--plan <slug>=<body> ...] [--review <review.json>] [--slug <ticket slug>]");
  }
  const own = ticketCriteria(readFileSync(values.ticket, "utf8"));
  const recorded = recordedMembers(values.worktree);
  const members = memberCriteria(values.member ?? [], recorded);
  const criteria = [...own, ...members.criteria];
  const at = values.at === EvidenceAt.Head ? EvidenceAt.Head : EvidenceAt.Worktree;
  const problems = [
    ...(own.length === 0 ? ["the ticket has no acceptance criteria checklist"] : []),
    ...members.problems,
    ...auditProblems(readFileSync(values.audit, "utf8"), criteria, values.worktree, at),
    ...matrixProblems(JSON.parse(readFileSync(values.matrix, "utf8")), criteria),
  ];
  const unit = unitReview(values, recorded, at);
  problems.push(...unit.problems);
  const exemptions = unit.notVisible.length ? { notVisible: unit.notVisible.map((entry) => `NOT-VISIBLE ${entry.ticket} ${entry.criterion}: ${entry.reason}`) } : {};
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, criteria: criteria.map(({ id }) => id), problems, ...exemptions }, null, 2)}\n`);
  return problems.length === 0 ? 0 : 1;
}

/** A unit (member tickets, recorded or given, or a PRD) needs its review of the completed work: code and visual QA per criterion, page and surface. */
function unitReview(values, recorded, at) {
  const isUnit = recorded.length > 0 || (values.member ?? []).length > 0 || (values.prd ?? []).length > 0;
  if (!values.review) {
    return { notVisible: [], problems: isUnit ? ["this session delivers a unit (member tickets or a PRD); pass --review <review.json> and --prd <slug>=<body> for its PRD, so every member and PRD criterion is reviewed in code and in visual QA (unit-review.mjs)"] : [] };
  }
  const result = reviewUnit({ worktree: values.worktree, ticket: values.ticket, review: values.review, slug: values.slug, members: values.member ?? [], prds: values.prd ?? [], plans: values.plan ?? [], at });
  const problems = result.ok ? [] : result.lines.filter((line) => /^(?:GAP|PROBLEM) /.test(line)).map((line) => line.replace(/^PROBLEM /, "unit review: "));
  return { notVisible: result.notVisible, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
