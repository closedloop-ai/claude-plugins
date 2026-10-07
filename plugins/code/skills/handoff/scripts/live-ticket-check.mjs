#!/usr/bin/env node
// Checks a vibe session's live ticket body (ISS-12057) is complete before
// handoff: every section is present and filled, no template placeholder or
// `Pending.` marker is left, and the sections rendered from the session
// record carry their URLs, flag table, and session ids. With
// `--base-commit` (the handoff inventory's `baseCommit`), the Environment
// section must name that commit as the branch's base, so a branch that merged
// main since the session started is not handed off with its old base.
// Prints one JSON object; exits 0 when complete and 1 otherwise. Changes
// nothing. The sections are the headings of ../../vibe/references/ticket-template.md.
//
// Usage: live-ticket-check.mjs --file <ticket body .md> [--base-commit <sha>]

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Every section of the live ticket, in template order. */
export const TICKET_SECTIONS = [
  "What this is",
  "Scope and acceptance criteria",
  "Environment",
  "Progress",
  "Backend built",
  "Backend still missing",
  "Production flag snapshot",
  "Sessions",
  "Handoff",
  "Grading",
  "Engineering checklist",
];

const SECTION_HEADING = /^## (.+?)\s*$/;
const PENDING_MARKER = /(^|\s)Pending\.\s*$/m;
const PLACEHOLDER = /<[a-z][^<>\n]*>/i;
const FENCED_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const ENVIRONMENT_BASE = /^- Branch: .*\(base: [^)]* at `([0-9a-f]+)`\)/m;
const SHORT_SHA_LENGTH = 10;
const REQUIRED_CONTENT = {
  Environment: [
    [/^- App: https:\/\/\S+/m, "has no App URL"],
    [/^- API: https:\/\/\S+/m, "has no API URL"],
    [/^- Storybook: https:\/\/\S+/m, "has no Storybook URL"],
  ],
  "Production flag snapshot": [[/^\| Flag \| Value \|$/m, "has no flag table"]],
  Sessions: [[/\(orchestrator\): `[^`]+`/, "lists no orchestrator session id"]],
};

/** Splits a markdown body into its `## ` sections (heading to body text). */
export function parseSections(body) {
  const sections = new Map();
  let current = null;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
    }
    const match = inFence ? null : SECTION_HEADING.exec(line);
    if (match) {
      current = match[1];
      sections.set(current, sections.has(current) ? `${sections.get(current)}\n` : "");
    } else if (current !== null) {
      sections.set(current, `${sections.get(current)}${line}\n`);
    }
  }
  return sections;
}

export function checkLiveTicket(body, { baseCommit } = {}) {
  const sections = parseSections(body);
  const problems = [];
  for (const heading of TICKET_SECTIONS) {
    const content = sections.get(heading);
    if (content === undefined) {
      problems.push({ section: heading, problem: "missing" });
      continue;
    }
    problems.push(...checkSection(heading, content));
    if (heading === "Environment" && baseCommit) {
      problems.push(...checkBaseCommit(content, baseCommit));
    }
  }
  return { ok: problems.length === 0, problems };
}

function checkSection(heading, content) {
  if (content.trim() === "") {
    return [{ section: heading, problem: "empty" }];
  }
  const problems = [];
  const prose = content.replace(FENCED_BLOCK, "").replace(INLINE_CODE, "");
  if (PENDING_MARKER.test(prose)) {
    problems.push({ section: heading, problem: "still has a Pending. marker" });
  }
  const placeholder = PLACEHOLDER.exec(prose);
  if (placeholder) {
    problems.push({ section: heading, problem: `still has the template placeholder ${placeholder[0].slice(0, 60)}` });
  }
  for (const [pattern, problem] of REQUIRED_CONTENT[heading] ?? []) {
    if (!pattern.test(content)) {
      problems.push({ section: heading, problem });
    }
  }
  return problems;
}

/** The Environment section names the branch's current base, not the commit the session started from. */
function checkBaseCommit(content, baseCommit) {
  const expected = baseCommit.slice(0, SHORT_SHA_LENGTH);
  const named = ENVIRONMENT_BASE.exec(content)?.[1];
  if (!named) {
    return [{ section: "Environment", problem: `names no base commit; the branch's base is ${expected}` }];
  }
  if (!baseCommit.startsWith(named) && !named.startsWith(baseCommit)) {
    return [{ section: "Environment", problem: `names base ${named}, but the branch's base is ${expected}` }];
  }
  return [];
}

function main() {
  const { values } = parseArgs({
    options: { file: { type: "string" }, "base-commit": { type: "string" } },
  });
  try {
    if (!values.file) {
      throw new Error("--file is required.");
    }
    const result = checkLiveTicket(readFileSync(path.resolve(values.file), "utf8"), {
      baseCommit: values["base-commit"],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
