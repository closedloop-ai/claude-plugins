#!/usr/bin/env node
// How long a worktree's work has waited unpushed. A writer kept a validated
// checkpoint unpushed for hours while each review pass added scope, so QA
// could not start; a tested checkpoint is pushed at least every 45 minutes of
// active work (operator ruling, 2026-10-22: an open PR once went six hours
// with no push), and review findings after that go out as follow-up commits.
//
// Usage: push-cadence.mjs --worktree <path> [--limit-minutes <n, default 45>] [--now <iso>]
//
// The age is measured from the oldest work not on the remote: the committer
// time of the oldest commit missing from the upstream (or from origin/<branch>,
// or, with no remote branch at all, from every remote ref), and the oldest
// modification time of a changed or untracked file. Prints one JSON object
// {"minutes","due","since","reason"}; exits 1 when the push is due and 2 on an
// error. Changes nothing.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_LIMIT_MINUTES = 45;

/** Minutes since the oldest unpushed work in `worktree`, and whether a push is due. */
export function unpushedAge(worktree, { now = Date.now(), limitMinutes = DEFAULT_LIMIT_MINUTES, ignore = [] } = {}) {
  const commit = oldestUnpushedCommit(worktree);
  const file = oldestChangedFile(worktree, ignore);
  const candidates = [commit, file].filter(Boolean).sort((a, b) => a.at - b.at);
  if (candidates.length === 0) {
    return { minutes: 0, due: false, since: null, reason: "nothing unpushed" };
  }
  const oldest = candidates[0];
  const minutes = Math.max(0, Math.floor((now - oldest.at) / 60_000));
  return { minutes, due: minutes >= limitMinutes, since: new Date(oldest.at).toISOString(), reason: oldest.reason };
}

function git(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
}

function tryGit(worktree, args) {
  try {
    return git(worktree, args);
  } catch {
    return null;
  }
}

/** The unpushed commit range: upstream, then origin/<branch>, then every remote ref. */
function unpushedRange(worktree) {
  if (tryGit(worktree, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])) {
    return ["@{upstream}..HEAD"];
  }
  const branch = tryGit(worktree, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branch && tryGit(worktree, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`])) {
    return [`refs/remotes/origin/${branch}..HEAD`];
  }
  return ["HEAD", "--not", "--remotes"];
}

function oldestUnpushedCommit(worktree) {
  const times = (tryGit(worktree, ["log", "--format=%ct", ...unpushedRange(worktree)]) ?? "")
    .split("\n").filter(Boolean).map(Number).filter(Number.isFinite);
  if (times.length === 0) {
    return null;
  }
  return { at: Math.min(...times) * 1000, reason: `${times.length} unpushed commit(s)` };
}

function oldestChangedFile(worktree, ignore) {
  const entries = git(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]).split("\0").filter(Boolean);
  let oldest = null;
  let count = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status.startsWith("R") || status.startsWith("C")) {
      index += 1;
    }
    if (status.includes("D") || ignore.some((skip) => file === skip || file.startsWith(`${skip}/`))) {
      continue;
    }
    let mtime;
    try {
      mtime = statSync(path.join(worktree, file)).mtimeMs;
    } catch {
      continue;
    }
    count += 1;
    if (!oldest || mtime < oldest) {
      oldest = mtime;
    }
  }
  return oldest === null ? null : { at: oldest, reason: `${count} uncommitted file(s)` };
}

function main() {
  const { values } = parseArgs({ options: { worktree: { type: "string" }, "limit-minutes": { type: "string" }, now: { type: "string" } } });
  if (!values.worktree) {
    throw new Error("--worktree is required.");
  }
  const limit = values["limit-minutes"] === undefined ? DEFAULT_LIMIT_MINUTES : Number(values["limit-minutes"]);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("--limit-minutes must be a positive number.");
  }
  const now = values.now ? Date.parse(values.now) : Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("--now must be an ISO time.");
  }
  const result = unpushedAge(path.resolve(values.worktree), { now, limitMinutes: limit });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.due ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(2);
  }
}
