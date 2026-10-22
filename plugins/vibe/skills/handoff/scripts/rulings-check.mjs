#!/usr/bin/env node
// Every ruling made during the work reaches the ticket, with the acceptance
// criteria it amends. Rulings once lived only in chat, QA records and review
// threads, so a later audit against the written criteria reported deliberate
// changes as misses.
//
// Usage: rulings-check.mjs --ticket <ticket body .md> --record <QA record or resume log> [--record <file>]...
//        rulings-check.mjs --program <rulings.md> --record <orchestrator transcript or QA record> [--record <file>]...
//        rulings-check.mjs --plan <get-document JSON of a PLN> [--plan-body <its latest version text>] [--plan ...]
//
// A ruling in a record is a line `Ruling <anything>: <decision>` (the resume
// log's `- Ruling (operator): ...`, or the same line in a QA record). The
// ticket's Scope and acceptance criteria section carries each one as
// `- Ruling <date> (<who>): "<decision>"; amends: <criteria, or none>`. Prints
// {"ok","problems"} and exits 1 when a record's ruling is missing from the
// ticket or a ticket ruling names no amended criteria.
//
// A plan with no human approver (`approverId` null; vibe sets a PLN's status
// but never its approver) is not a ruling, so each exclusion in it must cite
// a human source: a ticket AC (`<slug> AC-<n>`), a PRD, an operator ruling, or
// a plan approved by a named human. An exclusion is an item on an
// Out-of-scope, Non-goals, Excluded, Deferred, Descoped, Obsolete or Not covered line, a
// GAP line, a bullet under such a heading, or a clause saying out of scope,
// outside this scope, not covered, deferred, descoped or obsolete. An APPROVED
// or EXECUTED plan with no approver must also carry the self-approved marker
// session-plan.mjs renders. A writer once skipped
// two tickets on an uncited Out-of-scope line of a plan vibe itself had set to
// APPROVED, against a direct instruction to build them.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const RECORD_RULING = /^\s*[-*]?\s*Ruling\b[^:\n]*:\s*(.+?)\s*$/gm;
const TICKET_RULING = /^\s*[-*]\s*Ruling\b[^:\n]*:\s*(.+?)\s*$/gm;
const AMENDS = /;\s*amends:\s*(\S.*)$/;
const PROGRAM_RULING = /^\s*[-*]\s*Ruling\s+(\d{4}-\d{2}-\d{2})\s+\((operator message|AskUserQuestion|ticket):\s*(\S.*?)\):\s*(\S.*)$/gm;

const EXCLUSION_LABEL = /^\s*(?:[-*]\s+)?(?:\[[ xX]\]\s*)?\**\s*(out[- ]of[- ]scope|non-?goals?|excluded|exclusions?|deferred|descoped|obsolete|not covered|GAP(?:-\d+)?)\s*\**\s*:\s*\**\s*(.*)$/i;
const EXCLUSION_HEADING = /^#{2,6}\s+(?:out[- ]of[- ]scope|non-?goals?|excluded|exclusions|deferred|descoped|obsolete|not covered|gaps?)\b/i;
const EXCLUSION_PHRASE = /\b(?:out[- ]of[- ]scope|outside (?:of )?(?:this|the) (?:\w+ )?scope|not covered|deferred|descoped|obsolete)\b/i;
const HUMAN_SOURCE = /\bPRD-\d+\b|\b[A-Z]{2,}-\d+\s+AC-?\d+\b|\bacceptance criteri(?:on|a)\b|\boperator\b|\brulings?\b|\bruled\b|\bapproved by\b/i;
const SELF_APPROVED = /^>\s*Self-approved:/m;
const NOTHING = /^(?:none|nothing|n\/a|-)\.?$/i;

/** The exclusions in a plan body that cite no human source. */
export function uncitedExclusions(body) {
  const uncited = [];
  let underHeading = false;
  for (const line of body.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      underHeading = EXCLUSION_HEADING.test(line);
      continue;
    }
    const label = EXCLUSION_LABEL.exec(line);
    let items = [];
    if (label) {
      items = /^GAP/i.test(label[1]) ? [label[2]] : splitItems(label[2]);
    } else if (underHeading && /^\s*[-*]\s+/.test(line)) {
      items = splitItems(line.replace(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?/, ""));
    } else if (EXCLUSION_PHRASE.test(line)) {
      items = line.split(/[|;]/).filter((clause) => EXCLUSION_PHRASE.test(clause));
    }
    for (const item of items.map((text) => text.trim().replace(/^\*+|\*+$/g, "").trim()).filter(Boolean)) {
      if (!NOTHING.test(item) && !HUMAN_SOURCE.test(item)) uncited.push(item);
    }
  }
  return uncited;
}

/** Items of a list line; a trailing citation clause ("..., per operator ruling") stays with its item. */
function splitItems(text) {
  const items = [];
  for (const part of text.split(/;\s*|,\s*(?:and\s+)?|\s+and\s+(?=[A-Z]{2,}-\d)/)) {
    if (items.length > 0 && /^\s*(?:\(|per\b|source\b|see\b|as ruled\b|ruled\b|approved by\b)/i.test(part)) items[items.length - 1] += `, ${part}`;
    else items.push(part);
  }
  return items;
}

/** Problems with a plan read through get-document: uncited exclusions in a plan no human approved. */
export function planProblems(doc, body = doc?.version?.content) {
  const name = doc?.slug ?? "plan";
  if (doc?.approverId) return [];
  if (typeof body !== "string" || (body === doc?.version?.content && doc?.version?.contentTruncated)) {
    return [`${name}: pass its full latest version text with --plan-body`];
  }
  const unmarked = ["APPROVED", "EXECUTED"].includes(doc?.status) && !SELF_APPROVED.test(body)
    ? [`${name} is ${doc.status} with no human approver and is not marked self-approved; publish it from session-plan.mjs, which renders the marker, or have a human approve it`]
    : [];
  return [...unmarked, ...uncitedExclusions(body).map((item) =>
    `${name} is ${doc?.status ?? "unapproved"} with no human approver, so its exclusion "${item.slice(0, 160)}" is not a ruling; cite a ticket AC, PRD or operator ruling for it, or build it or escalate it`)];
}

function normalize(text) {
  return text.replace(/["“”']/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The decisions recorded in a QA record or resume log. */
export function recordRulings(text) {
  return [...text.matchAll(RECORD_RULING)].map((match) => match[1]);
}

/** Problems between the rulings in `records` and the ticket body. */
export function rulingProblems(ticket, records) {
  const entries = [...ticket.matchAll(TICKET_RULING)].map((match) => match[1]);
  const problems = entries.filter((entry) => !AMENDS.test(entry))
    .map((entry) => `ticket ruling "${entry}" names no amended criteria; end it with "; amends: <criteria, or none>"`);
  const decisions = entries.map((entry) => normalize(entry.replace(AMENDS, "")));
  for (const ruling of records.flatMap(recordRulings)) {
    if (!decisions.some((decision) => decision.includes(normalize(ruling)))) {
      problems.push(`ruling "${ruling}" is not on the ticket; add it under Scope and acceptance criteria as - Ruling <date> (<who>): "<decision>"; amends: <criteria>`);
    }
  }
  return problems;
}

/** Problems with the program-wide ruling index and the records it reconciles. */
export function programRulingProblems(program, records) {
  const entries = [...program.matchAll(PROGRAM_RULING)].map((match) => match[4]);
  const rulingLines = program.split("\n").filter((line) => /^\s*[-*]\s*Ruling\b/.test(line));
  const problems = rulingLines.length === entries.length ? [] : [
    "each program ruling must be `- Ruling YYYY-MM-DD (operator message|AskUserQuestion|ticket: <source>): <decision>`",
  ];
  const decisions = entries.map(normalize);
  for (const ruling of records.flatMap(recordRulings)) {
    if (!decisions.some((decision) => decision.includes(normalize(ruling)))) {
      problems.push(`ruling "${ruling}" is not in the program rulings index`);
    }
  }
  return problems;
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    ticket: { type: "string" }, program: { type: "string" }, record: { type: "string", multiple: true },
    plan: { type: "string", multiple: true }, "plan-body": { type: "string", multiple: true },
  } });
  const plans = values.plan ?? [];
  const bodies = values["plan-body"] ?? [];
  const rulingMode = Boolean(values.ticket || values.program);
  if ((rulingMode && (!values.record?.length || (values.ticket && values.program))) || (!rulingMode && plans.length === 0) || bodies.length > plans.length) {
    throw new Error("Usage: rulings-check.mjs (--ticket <ticket body .md> | --program <rulings.md>) --record <file>... | --plan <get-document JSON> [--plan-body <text>]...");
  }
  const records = (values.record ?? []).map((file) => readFileSync(file, "utf8"));
  const problems = [];
  if (values.program) problems.push(...programRulingProblems(readFileSync(values.program, "utf8"), records));
  else if (values.ticket) problems.push(...rulingProblems(readFileSync(values.ticket, "utf8"), records));
  plans.forEach((file, index) => {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    problems.push(...planProblems(doc, bodies[index] === undefined ? undefined : readFileSync(bodies[index], "utf8")));
  });
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`);
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
