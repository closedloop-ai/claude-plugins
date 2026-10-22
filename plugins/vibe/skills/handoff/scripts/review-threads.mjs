#!/usr/bin/env node
// Resolves pull request review threads after a fix pass, and only after the
// verification check below passes in this same process (operator lessons,
// 2026-10-19 and 2026-10-20: threads were resolved while partly fixed, and
// again before their verification had run). A thread is resolved only when the
// writer reports it fixed with the full fixing SHA and a reviewer other than
// the writer verified the fix. Partial, reasoned and unverified answers keep
// their reply and stay open. A flag-gated fix names the test or missing-tests
// entry pinning flag-off behavior to main. Every unresolved thread read from
// the pull request needs a result. Any problem resolves nothing.
// One review round per pull request (operator ruling, 2026-10-22): a thread
// raised after the round-one fixes were pushed (`"round": "later"`) is never
// fixed in it; its result is `followup` (`followupUrl`, the pull request's one
// follow-up ticket, from review-followup.mjs) or `invalid` (`reason`), and it
// is resolved after that reply, so it never blocks the merge. That holds only
// during the delivery phase: once the program's core work is done the ruling
// is retired (operator, 2026-10-22) and every valid finding is fixed here, so
// a `later` result needs `singleReviewRuling` (the ruling in force) in results.json.
//
// Usage:
//   review-threads.mjs resolve --results <results.json> --threads <threads.json> [--gh <gh CLI>]
//
// results.json: {"writer": "<writer id>", "threads": [{"threadId", "commentId",
//   "result": "fixed"|"partial"|"reason", "fixingCommit", "remaining", "reason",
//   "round": "later" with "result": "followup"|"invalid" and "followupUrl" or "reason",
//   "verification": {"by", "verdict": "verified"|"not-verified", "evidence"},
//   "flagGated", "flagOffEqualsMain": "test:<path>"|"missing-test:<entry>"}], "singleReviewRuling"}
// threads.json: the environment worker's `reviewThreads: read` list.
// Prints {"ok", "resolved", "replyOnly", "problems"}; exits 1 on any problem.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const WRITER_ROLE = "vibe-change-worker";
const COMMIT = /^[0-9a-f]{40}$/;
const FLAG_OFF_EVIDENCE = /^(?:test|missing-test):\S/;
const RESOLVE = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}";

/** Splits threads into the ones to resolve and the ones that only get a reply, with every problem found. */
export function checkThreads(results, unresolved) {
  const problems = [];
  const resolve = [];
  const replyOnly = [];
  const writer = typeof results?.writer === "string" ? results.writer : "";
  const threads = Array.isArray(results?.threads) ? results.threads : [];
  if (!writer) problems.push("results name no writer");
  for (const thread of threads) {
    const id = typeof thread?.threadId === "string" && thread.threadId ? thread.threadId : undefined;
    if (!id || !Number.isInteger(thread?.commentId)) {
      problems.push(`a thread result lacks threadId or a numeric commentId: ${JSON.stringify(thread)}`);
      continue;
    }
    const found = problemsFor(thread, writer);
    if (thread.round === "later" && !text(results.singleReviewRuling)) {
      found.push("a later round is deferred only while the single-review ruling is in force (singleReviewRuling); after core work, fix it here");
    }
    problems.push(...found.map((problem) => `${id}: ${problem}`));
    if (!found.length) (thread.result === "fixed" || thread.round === "later" ? resolve : replyOnly).push(id);
  }
  const answered = new Set(threads.map((thread) => thread?.threadId));
  for (const thread of unresolved) {
    if (thread?.threadId && !answered.has(thread.threadId)) problems.push(`${thread.threadId}: unresolved thread has no result`);
  }
  return { ok: problems.length === 0, resolve, replyOnly, problems };
}

/** Runs the check, then resolves its threads through `gh`; a failed check makes no call at all. */
export function resolveThreads(results, unresolved, gh = "gh") {
  const checked = checkThreads(results, unresolved);
  if (!checked.ok) return { ok: false, resolved: [], replyOnly: checked.replyOnly, problems: checked.problems };
  const resolved = [];
  for (const id of checked.resolve) {
    const call = spawnSync(gh, ["api", "graphql", "-f", `query=${RESOLVE}`, "-f", `id=${id}`], { encoding: "utf8" });
    if (call.error || call.status !== 0) {
      return { ok: false, resolved, replyOnly: checked.replyOnly, problems: [`${id}: resolve failed: ${(call.stderr ?? "").trim().slice(0, 300)}`] };
    }
    resolved.push(id);
  }
  return { ok: true, resolved, replyOnly: checked.replyOnly, problems: [] };
}

function problemsFor(thread, writer) {
  if (thread.round === "later") {
    if (thread.result === "followup") return /^https:\/\/\S+$/.test(thread.followupUrl ?? "") ? [] : ["a later-round finding replies with its follow-up ticket's link (followupUrl)"];
    if (thread.result === "invalid") return text(thread.reason) ? [] : ["an invalid later-round finding carries its reason"];
    return ["a later-round thread is never fixed in this pull request; its result is followup (the one follow-up ticket) or invalid"];
  }
  if (!["fixed", "partial", "reason"].includes(thread.result)) return [`result must be fixed, partial or reason, not ${JSON.stringify(thread.result)}`];
  const problems = [];
  if (thread.result === "partial" && !text(thread.remaining)) problems.push("a partial fix names what remains");
  if (thread.result === "reason" && !text(thread.reason)) problems.push("a reasoned answer carries its reason");
  if (thread.result === "fixed") {
    const verification = thread.verification ?? {};
    if (!COMMIT.test(thread.fixingCommit ?? "")) problems.push("a fixed thread names the full fixing commit SHA");
    if (!text(verification.by) || verification.by === writer || verification.by === WRITER_ROLE) {
      problems.push("a fix is verified by a reviewer other than the writer");
    } else if (verification.verdict !== "verified" || !text(verification.evidence)) {
      problems.push("the reviewer has not verified the fix with evidence; reply and leave it open");
    }
  }
  if (thread.flagGated === true && !FLAG_OFF_EVIDENCE.test(thread.flagOffEqualsMain ?? "")) {
    problems.push("a flag-gated change names the flag-off-equals-main test or its missing-tests entry");
  }
  return problems;
}

function text(value) {
  return typeof value === "string" && value.trim() !== "";
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== "resolve") throw new Error("command must be resolve");
  const { values } = parseArgs({ args: rest, options: { results: { type: "string" }, threads: { type: "string" }, gh: { type: "string" } } });
  if (!values.results || !values.threads) throw new Error("--results and --threads are required");
  const unresolved = JSON.parse(readFileSync(values.threads, "utf8"));
  return resolveThreads(JSON.parse(readFileSync(values.results, "utf8")),
    Array.isArray(unresolved) ? unresolved : unresolved.threads ?? [], values.gh);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
