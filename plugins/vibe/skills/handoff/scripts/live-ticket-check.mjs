#!/usr/bin/env node
// Checks a vibe session's live ticket body (ISS-12057) is complete before
// handoff: every section is present and filled, no template placeholder or
// `Pending.` marker is left, and the sections rendered from the session
// record carry their URLs, flag table, and session ids. With
// `--base-commit` (the handoff inventory's `baseCommit`), the Environment
// section must name that commit as the branch's base, so a branch that merged
// main since the session started is not handed off with its old base.
// With `--worktree`, a session that has local plans must have its PLN
// recorded, and handoff must have left it APPROVED (operator ruling,
// 2026-10-19); the ticket worker checks its links on ClosedLoop before this.
// Prints one JSON object; exits 0 when complete and 1 otherwise. Changes
// nothing. The sections are the headings of ../../vibe/references/ticket-template.md.
//
// Usage: live-ticket-check.mjs --file <ticket body .md> [--base-commit <sha>] [--worktree <path>]

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isOwnedPrototypeSession, requirePrototypePublication } from "../../vibe/scripts/prototype-session.mjs";
import { localPlanFiles } from "../../vibe/scripts/session-plan.mjs";
import { git, readSessionRecord } from "../../vibe/scripts/session-record.mjs";

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
  "Design Review",
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

export function checkLiveTicket(body, { baseCommit, record, headSha, branch, planCount = 0 } = {}) {
  const sections = parseSections(body);
  const problems = [];
  const prototype = isOwnedPrototypeSession(record);
  if (prototype) {
    if (branch !== undefined && !isOwnedPrototypeSession(record, branch)) {
      problems.push({ section: "Environment", problem: "worktree is not on its owned prototype branch" });
    }
    try { requirePrototypePublication(record, headSha); }
    catch (error) { problems.push({ section: "Environment", problem: error.message }); }
  }
  for (const heading of TICKET_SECTIONS) {
    const content = sections.get(heading);
    if (content === undefined) {
      problems.push({ section: heading, problem: "missing" });
      continue;
    }
    problems.push(...checkSection(heading, content, prototype));
    if (prototype && heading === "Environment") {
      for (const line of [
        `- Branch: \`${record.branch}\``,
        `- Prototype: \`${record.slug}\``,
        `- Preview: ${record.prototype?.previewUrl}`,
        `- Last deployed: \`${record.prototype?.deployedCommit}\` at ${record.prototype?.verifiedAt}`,
      ]) {
        if (!content.split("\n").some((actual) => actual === line || (line.startsWith("- Branch:") && actual.startsWith(`${line} (base:`)))) {
          problems.push({ section: heading, problem: "does not match the recorded prototype publication" });
        }
      }
    }
    if (heading === "Environment" && baseCommit) {
      problems.push(...checkBaseCommit(content, baseCommit));
    }
  }
  problems.push(...checkSessionPlan(record, planCount));
  return { ok: problems.length === 0, problems };
}

/** The session plan is published as a PLN and, once handoff runs, APPROVED (or EXECUTED after the merge). */
function checkSessionPlan(record, planCount) {
  if (!record || planCount === 0) {
    return [];
  }
  if (!record.livePlan) {
    return [{ section: "Session plan", problem: "the session has a local plan but no PLN is recorded" }];
  }
  if (record.livePlanStatus !== "APPROVED" && record.livePlanStatus !== "EXECUTED") {
    return [{ section: "Session plan", problem: `${record.livePlan} is ${record.livePlanStatus ?? "unrecorded"}, not APPROVED` }];
  }
  return [];
}

function checkSection(heading, content, prototype) {
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
  const requirements = prototype && (heading === "Environment" || heading === "Production flag snapshot")
    ? [] : REQUIRED_CONTENT[heading] ?? [];
  for (const [pattern, problem] of requirements) {
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
    options: { file: { type: "string" }, "base-commit": { type: "string" }, worktree: { type: "string" } },
  });
  try {
    if (!values.file) {
      throw new Error("--file is required.");
    }
    const result = checkLiveTicket(readFileSync(path.resolve(values.file), "utf8"), {
      baseCommit: values["base-commit"],
      record: values.worktree ? readSessionRecord(values.worktree) : undefined,
      branch: values.worktree ? git(values.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]) : undefined,
      headSha: values.worktree ? git(values.worktree, ["rev-parse", "HEAD"]) : undefined,
      planCount: values.worktree ? localPlanFiles(path.resolve(values.worktree)).length : 0,
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
