#!/usr/bin/env node
// One review round per pull request (operator ruling, 2026-10-22). A valid
// finding from a thread raised after the round-one fixes were pushed is never
// fixed in the pull request: it becomes an acceptance criterion on exactly one
// follow-up ticket for that pull request. Later rounds append criteria to the
// same ticket (a new document version), never a second ticket; each thread is
// then answered with the ticket's link (or why it is invalid) and resolved.
// The single round holds only during the delivery phase; once the program's
// core work is done the ruling is retired (operator, 2026-10-22) and every
// valid finding is fixed in its pull request, so `plan` needs
// `--single-review-ruling <the ruling in force>`.
//
// Usage:
//   review-followup.mjs plan   --worktree <path> --pr <n> --pr-ticket <slug> --findings <findings.json> --single-review-ruling "<who, date, where>" [--found <search.json>]
//   review-followup.mjs record --worktree <path> --pr <n> --slug <ticket slug>
//
// findings.json: [{"thread": "<thread url or id>", "finding": "<one checkable line>"}], the valid ones only.
// search.json: the documents a search for the plan's title returned, `[{"slug", "title"}]`, used before the
// first `record`. `plan` prints {"action": "create"|"append", "slug"?, "title", "criteria": [...]};
// `record` saves the created ticket's slug in the session's git dir and refuses a second, different one.
// Changes no ticket; the ticket worker or the orchestrator makes the write.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "./session-record.mjs";

const RECORD = "vibe-review-followups.json";

/** The follow-up ticket's title for a pull request. */
export function followupTitle(prTicket, pr) {
  return `${prTicket}: follow-ups from #${pr} review`;
}

/** Create the one follow-up ticket, or append to the one already recorded or found by its title. */
export function planFollowup({ recorded, found = [], pr, prTicket, findings }) {
  const title = followupTitle(prTicket, pr);
  const criteria = findings.map((entry) => {
    if (typeof entry?.finding !== "string" || !entry.finding.trim() || typeof entry.thread !== "string" || !entry.thread.trim()) {
      throw new Error("each finding needs a thread and a one-line finding");
    }
    return `- [ ] ${entry.finding.trim()} (review thread: ${entry.thread.trim()})`;
  });
  if (criteria.length === 0) {
    throw new Error("no valid findings: reply to each thread with why it is not valid and resolve it; no ticket is needed");
  }
  if (recorded) {
    return { action: "append", slug: recorded, title, criteria };
  }
  const matches = found.filter((doc) => doc?.title === title);
  if (matches.length > 1) {
    throw new Error(`${matches.map((doc) => doc.slug).join(", ")} all carry the title "${title}"; keep one, cancel the others, then record it`);
  }
  return matches.length === 1 ? { action: "append", slug: matches[0].slug, title, criteria } : { action: "create", title, criteria };
}

function recordFile(worktree) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), RECORD);
}

function readRecords(worktree) {
  const file = recordFile(worktree);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: {
    worktree: { type: "string" }, pr: { type: "string" }, "pr-ticket": { type: "string" }, findings: { type: "string" }, found: { type: "string" }, slug: { type: "string" }, "single-review-ruling": { type: "string" },
  } });
  if (!values.worktree || !/^\d+$/.test(values.pr ?? "")) {
    throw new Error("--worktree and --pr <number> are required");
  }
  const records = readRecords(values.worktree);
  if (command === "plan") {
    if (!values["pr-ticket"] || !values.findings) throw new Error("plan needs --pr-ticket and --findings");
    if (!values["single-review-ruling"]?.trim()) throw new Error("plan needs --single-review-ruling: after core work every valid finding is fixed in its pull request, every round, with no follow-up ticket");
    return planFollowup({
      recorded: records[values.pr]?.slug,
      found: values.found ? JSON.parse(readFileSync(values.found, "utf8")) : [],
      pr: values.pr,
      prTicket: values["pr-ticket"],
      findings: JSON.parse(readFileSync(values.findings, "utf8")),
    });
  }
  if (command === "record") {
    if (!values.slug) throw new Error("record needs --slug");
    const existing = records[values.pr]?.slug;
    if (existing && existing !== values.slug) {
      throw new Error(`#${values.pr} already has its follow-up ticket ${existing}; append to it, never create a second`);
    }
    records[values.pr] = { slug: values.slug, at: records[values.pr]?.at ?? new Date().toISOString() };
    writeFileSync(recordFile(values.worktree), `${JSON.stringify(records, null, 2)}\n`);
    return { recorded: values.slug };
  }
  throw new Error("Usage: review-followup.mjs plan|record ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...main(process.argv.slice(2)) }, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  }
}
