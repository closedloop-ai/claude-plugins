#!/usr/bin/env node
// The commit that added a path, for attributing a file's origin or a first
// failure. In a shallow clone the oldest visible commit looks like the origin,
// so this refuses there: deepen the history, or ask the code host's commits
// API for the path, first.
//
// Usage: history-origin.mjs --repo <path> --path <file>
// Prints {"ok":true,"commit":"<sha>","subject":"..."} or {"ok":false,"reason":"..."} (exit 1).

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** `{commit, subject}` of the commit that added `file`, or `{reason}` when history cannot say. */
export function historyOrigin(repo, file) {
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    return { reason: "the clone is shallow, so its oldest visible commit is not the origin; run `git fetch --unshallow` (or ask the code host's commits API for the path) first" };
  }
  const added = git(["log", "--follow", "--diff-filter=A", "--format=%H %s", "--", file]).split("\n").filter(Boolean).at(-1);
  if (!added) {
    return { reason: `no commit adds ${file}` };
  }
  const [commit, ...subject] = added.split(" ");
  return { commit, subject: subject.join(" ") };
}

function main() {
  const { values } = parseArgs({ options: { repo: { type: "string" }, path: { type: "string" } } });
  if (!values.repo || !values.path) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: "--repo and --path are required." })}\n`);
    process.exit(1);
  }
  const origin = historyOrigin(values.repo, values.path);
  process.stdout.write(`${JSON.stringify({ ok: !origin.reason, ...origin })}\n`);
  process.exit(origin.reason ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
