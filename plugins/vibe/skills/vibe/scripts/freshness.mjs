#!/usr/bin/env node
// Freshness verification: the checkout path, HEAD and the fetched origin/main SHA, recorded before any claim
// about current code (the wrong-checkout error class named in the target repository's AGENTS.md).
//
// Usage: freshness.mjs --worktree <path> [--remote origin] [--branch main] [--expect-path <path>] [--no-fetch]
//
// Prints {"path","head","branch","remote","remoteRef","originMain","fetched","fetchSkipped","sessionBase","aheadOfMain","behindMain","problems","ok"}
// and exits 1 on any problem. A value it could not establish is null, never guessed: originMain is only ever a
// freshly fetched SHA, because a cached origin/main is not evidence of the remote's state.
// When the fetch fails or is skipped (Codex's default sandbox has no network) and the session recorded the commit it
// branched from, the counts are taken against that sessionBase, fetchSkipped is true and it is not a problem: a claim
// is then about the session's base, not current main. Without a recorded base the missing fetch is a problem. In the
// Codex sandbox a failed fetch also prints {"escalate":true,"justification"}: run the same command escalated for the
// current main (the same convention as plugin-version.mjs).

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { escalation } = await vibeCore("lib/vibe/scripts/sandbox-refusal.mjs");
const { readSessionRecord } = await vibeCore("lib/vibe/scripts/session-record.mjs");

const FETCH_TIMEOUT_MS = 60_000;

function git(worktree, args, options = {}) {
  return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function tryGit(worktree, args, options) {
  try {
    return git(worktree, args, options);
  } catch {
    return null;
  }
}

/** Reads the checkout; fetches the remote branch unless `fetch` is false. */
export function freshness({ worktree, remote = "origin", branch = "main", expectPath = null, fetch = true }) {
  const problems = [];
  const top = tryGit(worktree, ["rev-parse", "--show-toplevel"]);
  const checkoutPath = top === null ? null : realpathSync(top);
  if (checkoutPath === null) problems.push(`${worktree} is not inside a git checkout`);
  const head = tryGit(worktree, ["rev-parse", "HEAD"]);
  const currentBranch = tryGit(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (expectPath !== null && checkoutPath !== null) {
    let expected = expectPath;
    try { expected = realpathSync(expectPath); } catch { /* compared as given */ }
    if (expected !== checkoutPath) problems.push(`the checkout is ${checkoutPath}, not the expected ${expectPath}`);
  }
  let fetched = false;
  let fetchProblem = null;
  let escalate = null;
  if (fetch && checkoutPath !== null) {
    try {
      git(worktree, ["fetch", "--quiet", remote, branch], { timeout: FETCH_TIMEOUT_MS });
      fetched = true;
    } catch (error) {
      fetchProblem = `could not fetch ${remote} ${branch}: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`;
      if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1") escalate = escalation(error, "Check the current state of main");
    }
  } else if (!fetch) {
    fetchProblem = "the fetch was skipped; origin/main is a cached ref, not the remote's current state";
  }
  const sessionBase = fetched || checkoutPath === null ? null : recordedBase(worktree);
  if (fetchProblem !== null && sessionBase === null) problems.push(fetchProblem);
  const remoteRef = `${remote}/${branch}`;
  const originMain = fetched ? tryGit(worktree, ["rev-parse", "--verify", "--quiet", `FETCH_HEAD^{commit}`]) : null;
  if (fetched && originMain === null) problems.push(`${remoteRef} could not be resolved after the fetch`);
  const compareTo = originMain ?? sessionBase;
  const counts = compareTo === null || head === null ? null : tryGit(worktree, ["rev-list", "--left-right", "--count", `${compareTo}...${head}`]);
  const [behindMain, aheadOfMain] = counts === null ? [null, null] : counts.split(/\s+/).map(Number);
  return {
    path: checkoutPath, head, branch: currentBranch, remote, remoteRef, originMain, fetched, fetchSkipped: fetchProblem !== null && sessionBase !== null, sessionBase,
    aheadOfMain, behindMain, problems, ok: problems.length === 0, ...(escalate ?? {}),
  };
}

/** The commit the session branched from, when the session recorded one that this checkout still has. */
function recordedBase(worktree) {
  try {
    const base = readSessionRecord(worktree)?.baseCommit;
    return typeof base === "string" && base !== "" ? tryGit(worktree, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) : null;
  } catch {
    return null;
  }
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { worktree: { type: "string" }, remote: { type: "string" }, branch: { type: "string" }, "expect-path": { type: "string" }, "no-fetch": { type: "boolean" } } });
  if (!values.worktree) throw new Error("Usage: freshness.mjs --worktree <path> [--remote origin] [--branch main] [--expect-path <path>] [--no-fetch]");
  const report = freshness({ worktree: values.worktree, remote: values.remote, branch: values.branch, expectPath: values["expect-path"] ?? null, fetch: !values["no-fetch"] });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
