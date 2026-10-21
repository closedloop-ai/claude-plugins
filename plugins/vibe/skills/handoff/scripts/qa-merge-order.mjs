#!/usr/bin/env node
// The state check behind "QA, then one main merge, then enqueue" (operator
// ruling, 2026-10-21): on a fast-moving main a head kept current before QA goes
// stale during QA. QA runs on the feature-complete head; after it the branch
// may gain exactly one merge of main (its conflict resolution included) and
// nothing else before it is enqueued. Prints one JSON object; exits 0 when the
// branch may be enqueued now and 1 otherwise. Changes nothing.
//
// Usage: qa-merge-order.mjs --worktree <path> --qa-head <sha the QA ran on> [--main <ref, default origin/main>]
//                           [--evidence <vibe-pr-evidence.json>]
//
// Every e2e spec file the branch adds or changes also needs a passing run at
// the head, in the lane that will run it (a `testRuns` entry with `path`,
// `status: "passed"`, `commit` equal to HEAD and a non-empty `lane`, such as
// the displayless Desktop lane or the browser e2e lane). PR and merge-queue
// CI skip the heavy e2e lanes, so two merged specs first ran, and failed,
// after merge: one needed a server its lane never starts.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isE2ePath, TEST_SPEC_PATTERN } from "../../vibe/scripts/test-files.mjs";

/** Problems with enqueueing `worktree`'s HEAD after QA on `qaHead`. */
export function qaMergeOrderProblems(worktree, qaHead, main = "origin/main") {
  const git = (args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const isAncestor = (commit, of) => {
    try {
      git(["merge-base", "--is-ancestor", commit, of]);
      return true;
    } catch {
      return false;
    }
  };
  if (!isAncestor(qaHead, "HEAD")) {
    return [`the QA'd head ${qaHead} is not in this branch; QA the current head`];
  }
  const commits = git(["rev-list", "--first-parent", "--parents", `${qaHead}..HEAD`]).split("\n").filter(Boolean).map((line) => line.split(" "));
  const mainMerges = commits.filter(([, , second]) => second && isAncestor(second, main));
  const other = commits.length - mainMerges.length;
  const problems = [];
  if (other > 0) {
    problems.push(`${other} commit(s) after the QA'd head are not a merge of main; QA the new head again`);
  }
  if (mainMerges.length > 1) {
    problems.push(`main was merged ${mainMerges.length} times after QA; merge it once, right before enqueue`);
  }
  return problems;
}

/** E2E spec files the branch adds or changes that have no passing run at HEAD in a named lane. */
export function changedSpecRunProblems(worktree, evidence, main = "origin/main") {
  const git = (args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
  const specs = git(["diff", "--name-only", "--diff-filter=AMR", `${main}...HEAD`]).split("\n")
    .filter((file) => file && isE2ePath(file) && TEST_SPEC_PATTERN.test(file));
  if (specs.length === 0) {
    return [];
  }
  const head = git(["rev-parse", "HEAD"]);
  const runs = Array.isArray(evidence?.testRuns) ? evidence.testRuns : null;
  if (!runs) {
    return [`${specs.length} changed e2e spec file(s) and no testRuns evidence; pass --evidence with a run of each at ${head} in its lane`];
  }
  return specs.filter((spec) => !runs.some((run) => run?.path === spec && run.status === "passed" && run.commit === head && typeof run.lane === "string" && run.lane.trim() !== ""))
    .map((spec) => `${spec}: no passing run at ${head} in the lane that runs it (a testRuns entry with its lane)`);
}

function main() {
  const { values } = parseArgs({ options: { worktree: { type: "string" }, "qa-head": { type: "string" }, main: { type: "string" }, evidence: { type: "string" } } });
  if (!values.worktree || !values["qa-head"]) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "--worktree and --qa-head are required." })}\n`);
    process.exit(1);
  }
  const evidence = values.evidence ? JSON.parse(readFileSync(values.evidence, "utf8")) : undefined;
  const problems = [...qaMergeOrderProblems(values.worktree, values["qa-head"], values.main), ...changedSpecRunProblems(values.worktree, evidence, values.main)];
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
