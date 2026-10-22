#!/usr/bin/env node
// The writer shepherds its own pull request in the final stage (after QA,
// once final-merge mode is set): it polls the pull request every two minutes
// and stops at the first thing it must act on, so a conflict with main is
// merged at once instead of waiting for someone to notice it. A pull request
// that went conflicting once sat for hours with nobody watching it. Armed
// auto-merge is not the end: two approved pull requests once sat blocked for
// hours on new threads while their writers waited for the merge.
// One review round per pull request (operator ruling, 2026-10-22): a thread
// opened before the round-one fixes were pushed (`--round-one-fixed-at`) is
// fixed here; a later one is triaged, never fixed here and never a merge
// blocker: a valid finding joins the pull request's one follow-up ticket
// (review-followup.mjs), the thread gets a reply with that ticket's link or
// why it is invalid, and is resolved. The single round holds only during the
// delivery phase: once the program's core work is done the ruling is retired
// (operator, 2026-10-22) and every valid finding is fixed in its pull request,
// every round. So `--round-one-fixed-at` needs `--single-review-ruling <the
// ruling in force>`; without it every thread is fixed here.
//
// Usage: shepherd.mjs --pr <number> --repo <owner/repo> [--round-one-fixed-at <iso time> --single-review-ruling "<who, date, where>"] [--interval-seconds 120] [--max-polls <n>]
//
// Prints one JSON object when it stops:
//   {"event":"merged"}                         exit 0
//   {"event":"closed"}                         exit 2
//   {"event":"waiting","polls":n}              exit 3  (--max-polls reached)
//   {"event":"conflict","head":sha}            exit 10 (merge main now in final-merge mode, push, run shepherd again)
//   {"event":"checks-failed","failed":[...]}   exit 11 (fix on the branch, push, run shepherd again)
//   {"event":"threads","unresolved":n}         exit 13 (round one: fix or answer each thread, then run shepherd again)
//   {"event":"later-threads","unresolved":n}   exit 14 (triage each into the follow-up ticket, reply, resolve, run again)
//   {"event":"unreadable","error":...}         exit 12 (three reads in a row failed)
// `gh` is read from PATH; a single failed read is retried on the next poll.
// Threads whose latest comment is the writer's (`gh api user`) wait on the
// reviewer and do not stop the shepherd.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readThreads } from "./pr-threads.mjs";

const FIELDS = "state,mergeable,headRefOid,statusCheckRollup";
const FAILED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"]);
const MAX_READ_FAILURES = 3;
export const EXIT = { merged: 0, closed: 2, waiting: 3, conflict: 10, "checks-failed": 11, unreadable: 12, threads: 13, "later-threads": 14 };

/** What one pull request read asks the writer to do, or null to keep waiting. */
export function shepherdEvent(pr) {
  if (pr.state === "MERGED") return { event: "merged" };
  if (pr.state === "CLOSED") return { event: "closed" };
  if (pr.mergeable === "CONFLICTING") return { event: "conflict", head: pr.headRefOid };
  const failed = (pr.statusCheckRollup ?? [])
    .filter((check) => FAILED.has(check.conclusion ?? check.state))
    .map((check) => check.name ?? check.context);
  if (failed.length > 0) return { event: "checks-failed", head: pr.headRefOid, failed };
  if (pr.waitingThreads > 0) return { event: "threads", head: pr.headRefOid, unresolved: pr.waitingThreads };
  return pr.laterThreads > 0 ? { event: "later-threads", head: pr.headRefOid, unresolved: pr.laterThreads } : null;
}

/** Polls until an event; resolves with it. */
export async function shepherd({ pr, repo, intervalSeconds = 120, maxPolls = Infinity, roundOneFixedAt = null, read = readPr }) {
  let failures = 0;
  for (let polls = 1; ; polls++) {
    try {
      const event = shepherdEvent(read(pr, repo, roundOneFixedAt));
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

let writerLogin;

/** Unresolved threads the writer did not answer last, split at the round-one fix push (all round one before it). */
export function splitThreads(threads, writer, roundOneFixedAt) {
  const cutoff = roundOneFixedAt ? Date.parse(roundOneFixedAt) : Number.POSITIVE_INFINITY;
  const waiting = threads.filter((thread) => !thread.resolved && thread.lastAuthor !== writer);
  const later = waiting.filter((thread) => Date.parse(thread.createdAt ?? "") >= cutoff);
  return { waitingThreads: waiting.length - later.length, laterThreads: later.length };
}

function readPr(pr, repo, roundOneFixedAt) {
  const view = JSON.parse(execFileSync("gh", ["pr", "view", String(pr), "--repo", repo, "--json", FIELDS], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  writerLogin ??= execFileSync("gh", ["api", "user", "-q", ".login"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const threads = readThreads(repo, pr);
  if (threads === null) {
    throw new Error("gh could not read the review threads");
  }
  return { ...view, ...splitThreads(threads, writerLogin, roundOneFixedAt) };
}

async function main() {
  const { values } = parseArgs({
    options: { pr: { type: "string" }, repo: { type: "string" }, "interval-seconds": { type: "string" }, "max-polls": { type: "string" }, "round-one-fixed-at": { type: "string" }, "single-review-ruling": { type: "string" } },
  });
  if (!/^\d+$/.test(values.pr ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(values.repo ?? "") || (values["round-one-fixed-at"] !== undefined && !Number.isFinite(Date.parse(values["round-one-fixed-at"])))) {
    process.stdout.write(`${JSON.stringify({ event: "usage", error: "--pr <number> and --repo <owner/repo> are required" })}\n`);
    process.exit(64);
  }
  if (values["round-one-fixed-at"] !== undefined && !values["single-review-ruling"]?.trim()) {
    process.stdout.write(`${JSON.stringify({ event: "usage", error: "--round-one-fixed-at needs --single-review-ruling: after core work every valid finding is fixed here, every round" })}\n`);
    process.exit(64);
  }
  const interval = Number(values["interval-seconds"] ?? 120);
  const result = await shepherd({
    pr: Number(values.pr),
    repo: values.repo,
    intervalSeconds: Number.isFinite(interval) && interval >= 0 ? interval : 120,
    maxPolls: values["max-polls"] ? Math.max(1, Number(values["max-polls"])) : Infinity,
    roundOneFixedAt: values["round-one-fixed-at"] ?? null,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(EXIT[result.event]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
