#!/usr/bin/env node
// Decides which pull request review threads may be resolved after a fix pass
// (handoff section 10; operator lesson, 2026-10-19: twelve threads were marked
// resolved while three were only partly fixed or not fixed). A thread is
// resolved only when the writer reports it fixed with the fixing commit AND a
// reviewer other than the writer verified that fix against the thread. A
// partial fix or a reasoned answer gets a reply and stays open. A fix behind a
// feature flag also names the test, or the missing-tests entry, that pins the
// flag-off behavior to main. With the unresolved threads read from the pull
// request, every one of them needs a result, so none is left unanswered.
//
// Usage:
//   review-threads.mjs check --results <results.json> [--threads <threads.json>]
//
// results.json: {"writer": "<writer id>", "threads": [{"threadId", "commentId",
//   "result": "fixed"|"partial"|"reason", "fixingCommit", "remaining", "reason",
//   "verification": {"by", "verdict": "verified"|"not-verified", "evidence"},
//   "flagGated", "flagOffEqualsMain": "test:<path>"|"missing-test:<entry>"}]}
// threads.json: the environment worker's `reviewThreads: read` list, each with
//   at least `threadId`.
// Prints {"ok", "resolve": [threadId], "replyOnly": [threadId], "problems": [..]}
// and exits 1 when any problem is found.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const WRITER_ROLE = "vibe-change-worker";
const COMMIT = /^[0-9a-f]{40}$/;
const FLAG_OFF_EVIDENCE = /^(?:test|missing-test):\S/;
const RESULTS = new Set(["fixed", "partial", "reason"]);

/** Splits threads into the ones to resolve and the ones that only get a reply, with every problem found. */
export function checkThreads(results, unresolved = []) {
  const problems = [];
  const resolve = [];
  const replyOnly = [];
  const writer = typeof results?.writer === "string" ? results.writer : "";
  const threads = Array.isArray(results?.threads) ? results.threads : [];
  if (!writer) problems.push("results name no writer");
  if (threads.length === 0) problems.push("results list no threads");
  for (const thread of threads) {
    const id = typeof thread?.threadId === "string" && thread.threadId ? thread.threadId : undefined;
    if (!id || !Number.isInteger(thread?.commentId)) {
      problems.push(`a thread result lacks threadId or a numeric commentId: ${JSON.stringify(thread)}`);
      continue;
    }
    const threadProblems = problemsFor(thread, writer);
    problems.push(...threadProblems.map((problem) => `${id}: ${problem}`));
    if (threadProblems.length) continue;
    if (thread.result === "fixed") resolve.push(id);
    else replyOnly.push(id);
  }
  const answered = new Set(threads.map((thread) => thread?.threadId));
  for (const thread of unresolved) {
    if (thread?.threadId && !answered.has(thread.threadId)) problems.push(`${thread.threadId}: unresolved thread has no result`);
  }
  return { ok: problems.length === 0, resolve, replyOnly, problems };
}

function problemsFor(thread, writer) {
  const problems = [];
  if (!RESULTS.has(thread.result)) return [`result must be fixed, partial or reason, not ${JSON.stringify(thread.result)}`];
  if (thread.result === "partial" && !nonEmpty(thread.remaining)) problems.push("a partial fix names what remains");
  if (thread.result === "reason" && !nonEmpty(thread.reason)) problems.push("a reasoned answer carries its reason");
  if (thread.result === "fixed") {
    if (!COMMIT.test(thread.fixingCommit ?? "")) problems.push("a fixed thread names the full fixing commit SHA");
    const verification = thread.verification ?? {};
    if (!nonEmpty(verification.by) || verification.by === writer || verification.by === WRITER_ROLE) {
      problems.push("a fix is verified by a reviewer other than the writer");
    } else if (verification.verdict !== "verified") {
      problems.push(`the reviewer did not verify the fix (${verification.verdict ?? "no verdict"}); it stays open`);
    } else if (!nonEmpty(verification.evidence)) {
      problems.push("the verification cites its evidence");
    }
  }
  if (thread.flagGated === true && !FLAG_OFF_EVIDENCE.test(thread.flagOffEqualsMain ?? "")) {
    problems.push("a flag-gated change names the flag-off-equals-main test or its missing-tests entry");
  }
  return problems;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== "check") throw new Error("command must be check");
  const { values } = parseArgs({ args: rest, options: { results: { type: "string" }, threads: { type: "string" } } });
  if (!values.results) throw new Error("--results is required");
  const unresolved = values.threads ? readJson(values.threads) : [];
  return checkThreads(readJson(values.results), Array.isArray(unresolved) ? unresolved : unresolved.threads ?? []);
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
