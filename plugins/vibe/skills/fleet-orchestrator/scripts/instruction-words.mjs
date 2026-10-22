#!/usr/bin/env node
// The net change in instruction words a lessons release reports. A changelog
// once said "about 930 words shorter" from a count taken before the release's
// last commits, when the merged change was 832 shorter. Run it at the final
// head, and with --changelog it fails when the version's entry states a number
// that differs from the measured one.
//
// Usage: instruction-words.mjs --base <ref of the release to compare against> [--head <ref, default HEAD>]
//          [--path <dir, default plugins/vibe>] [--changelog <CHANGELOG.md> --version <x.y.z>] [--repo <dir, default .>]
//
// Counts whitespace-separated words on added and removed Markdown lines under
// --path. Prints `added <a> removed <r> net <n>`. With --changelog, the entry
// `### vibe v<version>` must say "about <N> words shorter" (net below zero) or
// "about <N> words longer" with N within 2% (at least 10 words) of the net;
// exits 1 otherwise.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Added and removed words on the changed Markdown lines of a unified diff. */
export function countWords(diff) {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    const words = line.slice(1).split(/\s+/).filter(Boolean).length;
    if (line.startsWith("+")) added += words;
    else if (line.startsWith("-")) removed += words;
  }
  return { added, removed, net: added - removed };
}

/** Problems with the number a changelog entry states for `net`. */
export function changelogProblems(changelog, version, net) {
  const start = changelog.indexOf(`### vibe v${version}`);
  if (start < 0) return [`no "### vibe v${version}" entry`];
  const next = changelog.indexOf("\n### ", start + 1);
  const entry = changelog.slice(start, next < 0 ? changelog.length : next);
  const stated = /about ([\d,]+) words (shorter|longer)/.exec(entry);
  if (!stated) return [`the v${version} entry states no "about <N> words shorter|longer"`];
  const number = Number(stated[1].replace(/,/g, ""));
  const signed = stated[2] === "shorter" ? -number : number;
  const tolerance = Math.max(10, Math.abs(net) * 0.02);
  return Math.abs(signed - net) <= tolerance ? [] : [`the v${version} entry says about ${stated[1]} words ${stated[2]}; the measured net is ${net}`];
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    base: { type: "string" }, head: { type: "string" }, path: { type: "string" }, changelog: { type: "string" }, version: { type: "string" }, repo: { type: "string" },
  } });
  if (!values.base || (values.changelog && !values.version)) {
    throw new Error("Usage: instruction-words.mjs --base <ref> [--head <ref>] [--path <dir>] [--changelog <file> --version <x.y.z>]");
  }
  const diff = execFileSync("git", ["-C", values.repo ?? ".", "diff", "-U0", values.base, values.head ?? "HEAD", "--", `${values.path ?? "plugins/vibe"}/**/*.md`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const { added, removed, net } = countWords(diff);
  process.stdout.write(`added ${added} removed ${removed} net ${net}\n`);
  if (!values.changelog) return 0;
  const problems = changelogProblems(readFileSync(values.changelog, "utf8"), values.version, net);
  for (const problem of problems) process.stdout.write(`${problem}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
