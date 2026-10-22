#!/usr/bin/env node
// Is a lessons PR already open? Lessons ship as one combined PR per plugin
// repo, added to until it merges; four stacked lessons PRs once conflicted
// with main and had to be restacked. Run it before opening a lessons PR.
//
// Usage: lessons-pr.mjs --repo <owner/repo> [--match <regex, default "lesson">]
//
// Lists your open PRs in the repo whose title or branch matches. Prints
// `OPEN <url> <branch>: push this batch onto that branch` for each and exits 1;
// prints `no open lessons PR` and exits 0 when none matches, and exits 2 when
// gh cannot answer. `LESSONS_GH` overrides the gh binary.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Open PRs whose title or branch matches `pattern`. */
export function openLessonsPrs(prs, pattern) {
  return prs.filter((pr) => pattern.test(pr?.title ?? "") || pattern.test(pr?.headRefName ?? ""));
}

function listOpen(repo) {
  const out = execFileSync(process.env.LESSONS_GH || "gh", ["pr", "list", "-R", repo, "--state", "open", "--author", "@me", "--json", "number,title,headRefName,url"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  return JSON.parse(out);
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { repo: { type: "string" }, match: { type: "string" } } });
  if (!values.repo) {
    throw new Error("Usage: lessons-pr.mjs --repo <owner/repo> [--match <regex>]");
  }
  const open = openLessonsPrs(listOpen(values.repo), new RegExp(values.match ?? "lesson", "i"));
  for (const pr of open) process.stdout.write(`OPEN ${pr.url} ${pr.headRefName}: push this batch onto that branch\n`);
  if (open.length === 0) process.stdout.write("no open lessons PR\n");
  return open.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
