#!/usr/bin/env node
// Every ruling made during the work reaches the ticket, with the acceptance
// criteria it amends. Rulings once lived only in chat, QA records and review
// threads, so a later audit against the written criteria reported deliberate
// changes as misses.
//
// Usage: rulings-check.mjs --ticket <ticket body .md> --record <QA record or resume log> [--record <file>]...
//        rulings-check.mjs --program <rulings.md> --record <orchestrator transcript or QA record> [--record <file>]...
//
// A ruling in a record is a line `Ruling <anything>: <decision>` (the resume
// log's `- Ruling (operator): ...`, or the same line in a QA record). The
// ticket's Scope and acceptance criteria section carries each one as
// `- Ruling <date> (<who>): "<decision>"; amends: <criteria, or none>`. Prints
// {"ok","problems"} and exits 1 when a record's ruling is missing from the
// ticket or a ticket ruling names no amended criteria.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const RECORD_RULING = /^\s*[-*]?\s*Ruling\b[^:\n]*:\s*(.+?)\s*$/gm;
const TICKET_RULING = /^\s*[-*]\s*Ruling\b[^:\n]*:\s*(.+?)\s*$/gm;
const AMENDS = /;\s*amends:\s*(\S.*)$/;
const PROGRAM_RULING = /^\s*[-*]\s*Ruling\s+(\d{4}-\d{2}-\d{2})\s+\((operator message|AskUserQuestion|ticket):\s*(\S.*?)\):\s*(\S.*)$/gm;

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
  } });
  if ((!values.ticket && !values.program) || !values.record?.length || (values.ticket && values.program)) {
    throw new Error("Usage: rulings-check.mjs (--ticket <ticket body .md> | --program <rulings.md>) --record <file> [--record <file>]...");
  }
  const records = values.record.map((file) => readFileSync(file, "utf8"));
  const problems = values.program
    ? programRulingProblems(readFileSync(values.program, "utf8"), records)
    : rulingProblems(readFileSync(values.ticket, "utf8"), records);
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
