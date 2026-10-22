#!/usr/bin/env node
// The writer shepherds its own pull request in the final stage (after QA,
// once final-merge mode is set): it polls the pull request every two minutes
// and stops at the first thing it must act on, so a conflict with main is
// merged at once instead of waiting for someone to notice it. A pull request
// that went conflicting once sat for hours with nobody watching it.
//
// Usage: shepherd.mjs --pr <number> --repo <owner/repo> [--interval-seconds 120] [--max-polls <n>]
//
// Prints one JSON object when it stops:
//   {"event":"merged"}                         exit 0
//   {"event":"closed"}                         exit 2
//   {"event":"waiting","polls":n}              exit 3  (--max-polls reached)
//   {"event":"conflict","head":sha}            exit 10 (merge main now in final-merge mode, push, run shepherd again)
//   {"event":"checks-failed","failed":[...]}   exit 11 (fix on the branch, push, run shepherd again)
//   {"event":"unreadable","error":...}         exit 12 (three reads in a row failed)
// `gh` is read from PATH; a single failed read is retried on the next poll.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const FIELDS = "state,mergeable,headRefOid,statusCheckRollup";
const FAILED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"]);
const MAX_READ_FAILURES = 3;
export const EXIT = { merged: 0, closed: 2, waiting: 3, conflict: 10, "checks-failed": 11, unreadable: 12 };

/** What one pull request read asks the writer to do, or null to keep waiting. */
export function shepherdEvent(pr) {
  if (pr.state === "MERGED") return { event: "merged" };
  if (pr.state === "CLOSED") return { event: "closed" };
  if (pr.mergeable === "CONFLICTING") return { event: "conflict", head: pr.headRefOid };
  const failed = (pr.statusCheckRollup ?? [])
    .filter((check) => FAILED.has(check.conclusion ?? check.state))
    .map((check) => check.name ?? check.context);
  return failed.length > 0 ? { event: "checks-failed", head: pr.headRefOid, failed } : null;
}

/** Polls until an event; resolves with it. */
export async function shepherd({ pr, repo, intervalSeconds = 120, maxPolls = Infinity, read = readPr }) {
  let failures = 0;
  for (let polls = 1; ; polls++) {
    try {
      const event = shepherdEvent(read(pr, repo));
      failures = 0;
      if (event) return event;
    } catch (error) {
      failures++;
      if (failures >= MAX_READ_FAILURES) {
        return { event: "unreadable", error: String(error?.message ?? error).split("\n")[0] };
      }
    }
    if (polls >= maxPolls) return { event: "waiting", polls };
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

function readPr(pr, repo) {
  return JSON.parse(execFileSync("gh", ["pr", "view", String(pr), "--repo", repo, "--json", FIELDS], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

async function main() {
  const { values } = parseArgs({
    options: { pr: { type: "string" }, repo: { type: "string" }, "interval-seconds": { type: "string" }, "max-polls": { type: "string" } },
  });
  if (!/^\d+$/.test(values.pr ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(values.repo ?? "")) {
    process.stdout.write(`${JSON.stringify({ event: "usage", error: "--pr <number> and --repo <owner/repo> are required" })}\n`);
    process.exit(64);
  }
  const interval = Number(values["interval-seconds"] ?? 120);
  const result = await shepherd({
    pr: Number(values.pr),
    repo: values.repo,
    intervalSeconds: Number.isFinite(interval) && interval >= 0 ? interval : 120,
    maxPolls: values["max-polls"] ? Math.max(1, Number(values["max-polls"])) : Infinity,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(EXIT[result.event]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
