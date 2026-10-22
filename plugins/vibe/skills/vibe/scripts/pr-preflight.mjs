#!/usr/bin/env node
// The pull request title and body checks a code host gate would run, before
// the pull request opens or its title or body changes. A fix pull request once
// failed the metadata gate on a 73-character title: the squash subject is the
// title plus the ` (#<n>)` the host appends, and the limit counts both. Another
// merged on a regenerated baseline called "pixel-identical" to CI from a broken
// compare; it differed by about 3,900 pixels. So a line claiming a result is
// identical, matches or shows no difference carries the measured count.
//
// Usage: pr-preflight.mjs --title "<title>" [--body-file <file>] [--pr <number, when it exists>] [--max <72>]
//
// Without --pr the suffix is counted at five digits. Prints {"ok","problems"}
// and exits 1 on any problem.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const CLAIM = /\b(?:(?:pixel|byte)[- ]identical|identical to|no (?:visual |pixel )?(?:diffs?|differences?)\b|match(?:es|ing)? (?:the )?(?:CI|baseline|snapshot|reference|golden|Linux|main)\b)/i;
const MEASURED = /\b\d[\d,.]*\s*(?:%|px\b|pixels?\b|bytes?\b|lines?\b|differ\w*|diffs?\b|of\s+\d)/i;

/** Problems with a pull request title: its length with the ` (#<n>)` suffix the host appends. */
export function titleProblems(title, { pr = null, max = 72 } = {}) {
  const suffix = ` (#${pr ?? "99999"})`.length;
  const total = title.trim().length + suffix;
  return total > max ? [`title is ${total} characters with the ${suffix}-character " (#n)" suffix; the limit is ${max}`] : [];
}

/** Body lines that claim an identical or matching result without the measured count. */
export function claimProblems(body) {
  return body.split("\n").filter((line) => CLAIM.test(line) && !MEASURED.test(line))
    .map((line) => `an "identical/matches" claim names no measured count (for example "0 of 1,048,576 pixels differ"): ${line.trim().slice(0, 160)}`);
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { title: { type: "string" }, "body-file": { type: "string" }, pr: { type: "string" }, max: { type: "string" } } });
  if (!values.title?.trim()) throw new Error("Usage: pr-preflight.mjs --title <title> [--body-file <file>] [--pr <number>] [--max <72>]");
  const problems = [
    ...titleProblems(values.title, { pr: values.pr ?? null, max: Number(values.max ?? 72) }),
    ...(values["body-file"] ? claimProblems(readFileSync(values["body-file"], "utf8")) : []),
  ];
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems })}\n`);
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
