#!/usr/bin/env node
// Checks a ClosedLoop issue write before it is made (operator rulings,
// 2026-10-21): a new or follow-up ticket goes in the current sprint project,
// never a past one, and is never linked under a parent that is already
// EXECUTED, OBSOLETE, DONE or CANCELED; an issue moves to IN_REVIEW only with the pull request
// that delivers it. Prints one JSON object; exits 0 when the write may go
// ahead and 1 otherwise. Changes nothing.
//
// Usage: ticket-write-check.mjs [--project-name <name>] [--project-end <iso date>]
//          [--parent <SLUG>:<STATUS>]... [--status <status> [--pull-request <url>]] [--today <iso date>]
//
// A sprint project's end comes from `--project-end`, or from a `M/D-M/D` date
// range in its name.

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const CLOSED_PARENT = new Set(["EXECUTED", "OBSOLETE", "DONE", "CANCELED"]);
const RANGE = /(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})/;
const PULL_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_YEAR_MS = 183 * DAY_MS;

/** Problems with a ticket write; `parents` are `{slug, status}`, dates are ISO strings. */
export function ticketWriteProblems({ projectName, projectEnd, parents = [], status, pullRequest, today }) {
  const now = Date.parse(today ?? new Date().toISOString().slice(0, 10));
  const problems = parents.filter((parent) => CLOSED_PARENT.has(parent.status))
    .map((parent) => `${parent.slug} is ${parent.status}; a follow-up is never linked under a finished parent, so file it in the current sprint without that link`);
  if (projectName !== undefined || projectEnd !== undefined) {
    const end = projectEnd === undefined ? endFromName(projectName, now) : Date.parse(projectEnd);
    if (!Number.isFinite(end)) {
      problems.push(`project ${JSON.stringify(projectName)} has no date range; pass --project-end, or file the ticket in the current sprint project`);
    } else if (end + DAY_MS <= now) {
      problems.push(`project ${JSON.stringify(projectName ?? projectEnd)} ended ${new Date(end).toISOString().slice(0, 10)}; set the current sprint project explicitly instead of the default`);
    }
  }
  if (status === "IN_REVIEW" && !PULL_URL.test(pullRequest ?? "")) {
    problems.push("IN_REVIEW needs the pull request that delivers the ticket (--pull-request); without one it stays open");
  }
  return problems;
}

/** The end of a `M/D-M/D` sprint name, in the year that puts it nearest `now`. */
function endFromName(name, now) {
  const match = RANGE.exec(name ?? "");
  if (!match) {
    return Number.NaN;
  }
  const year = new Date(now).getUTCFullYear();
  const startMonth = Number(match[1]);
  const endMonth = Number(match[3]);
  const candidates = [year - 1, year, year + 1].map((startYear) =>
    Date.UTC(endMonth < startMonth ? startYear + 1 : startYear, endMonth - 1, Number(match[4])));
  return candidates.find((end) => Math.abs(end - now) <= HALF_YEAR_MS) ?? candidates[1];
}

function main() {
  const { values } = parseArgs({
    options: {
      "project-name": { type: "string" },
      "project-end": { type: "string" },
      parent: { type: "string", multiple: true },
      status: { type: "string" },
      "pull-request": { type: "string" },
      today: { type: "string" },
    },
  });
  const parents = (values.parent ?? []).map((entry) => {
    const [slug, status] = entry.split(":");
    return { slug, status: (status ?? "").toUpperCase() };
  });
  const problems = ticketWriteProblems({
    projectName: values["project-name"],
    projectEnd: values["project-end"],
    parents,
    status: values.status?.toUpperCase(),
    pullRequest: values["pull-request"],
    today: values.today,
  });
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
