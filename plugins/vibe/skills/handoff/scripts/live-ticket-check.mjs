#!/usr/bin/env node
// Checks a vibe session's live ticket body (ISS-12057) is complete before
// handoff: every section is present and filled, no template placeholder or
// `Pending.` marker is left, and the sections rendered from the session
// record carry their URLs, flag table, keys to see the work, and session ids. With
// `--base-commit` (the handoff inventory's `baseCommit`), the Environment
// section must name that commit as the branch's base, so a branch that merged
// main since the session started is not handed off with its old base.
// With `--worktree`, a session that has local plans must have its PLN
// recorded, and handoff must have left it APPROVED (operator ruling,
// 2026-10-19); the ticket worker checks its links on ClosedLoop before this.
// It also needs the session's flag keys recorded, each proposed key approved
// by the person for its current proposal and read by a file (operator ruling,
// 2026-10-20).
// With `--child-evidence <map>` (needs `--worktree` and `--base-commit`), it
// also gates a source PRD's claimed children (vibe lessons ledger: symphony-alpha
// #8947, #8953, #8958, #8959, #8960, #8963 and PRD-729 moved children to
// IN_REVIEW with design review, device runs, hosted URLs or ledgers unbuilt,
// on the writer's own audit): only `children.inReview` may move to IN_REVIEW.
// Prints one JSON object; exits 0 when complete and 1 otherwise. Changes
// nothing. The sections are the headings of ../../vibe/references/ticket-template.md.
//
// Usage: live-ticket-check.mjs --file <ticket body .md> [--base-commit <sha>] [--worktree <path>]
//          [--child-evidence <map .json>] [--now <iso>]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { flagKeyProblems } from "../../vibe/scripts/flag-keys.mjs";
import { isOwnedPrototypeSession, requirePrototypePublication } from "../../vibe/scripts/prototype-session.mjs";
import { pointerProblems } from "../../vibe/scripts/publishable-text.mjs";
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
  "Production flag snapshot": [
    [/^\| Flag \| Value \|$/m, "has no flag table"],
    // The keys a person must turn on to see the work (operator ruling, 2026-10-20).
    [/^### Keys to see this work$/m, "lists no keys to see the work"],
  ],
  Sessions: [[/\(orchestrator\): `[^`]+`/, "lists no orchestrator session id"]],
  "Scope and acceptance criteria": [
    [/^- Newest ruling: (?:none found \(searched: [^)\n]+\)|.*\b\d{4}-\d{2}-\d{2}\b)/m, "has no Newest ruling line (a dated ruling, or none found with the searches run)"],
    [/^- Prior removal: (?:none found \(searched: [^)\n]+\)|.*\b(?:ISS|PRD|PLN|FEA)-\d+)/m, "has no Prior removal line (the removing ticket, or none found with the searches run)"],
  ],
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
  // Operator ruling, 2026-10-20: no path on the operator's machine, and no plan pointed at by path.
  problems.push(...pointerProblems(body).map(({ line, kind }) => ({ section: "Body", problem: `line ${line}: ${kind}` })));
  // Operator ruling, 2026-10-20: every proposed flag key needs the person's recorded yes.
  problems.push(...flagKeyProblems(record).map((problem) => ({ section: "Flag keys", problem })));
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
    options: {
      file: { type: "string" },
      "base-commit": { type: "string" },
      worktree: { type: "string" },
      "child-evidence": { type: "string" },
      now: { type: "string" },
    },
  });
  try {
    if (!values.file) {
      throw new Error("--file is required.");
    }
    const record = values.worktree ? readSessionRecord(values.worktree) : undefined;
    const result = checkLiveTicket(readFileSync(path.resolve(values.file), "utf8"), {
      baseCommit: values["base-commit"],
      record,
      branch: values.worktree ? git(values.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]) : undefined,
      headSha: values.worktree ? git(values.worktree, ["rev-parse", "HEAD"]) : undefined,
      planCount: values.worktree ? localPlanFiles(path.resolve(values.worktree)).length : 0,
    });
    if (values["child-evidence"]) {
      result.children = checkChildren(values, record);
      result.ok = result.ok && result.children.ok;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  }
}

function checkChildren(values, record) {
  if (!values.worktree || !values["base-commit"]) {
    throw new Error("--child-evidence needs --worktree and --base-commit.");
  }
  const now = values.now ? Date.parse(values.now) : Date.now();
  if (!Number.isFinite(now)) throw new Error("--now is not a date.");
  const facts = readFacts(path.resolve(values.worktree), values["base-commit"], {
    now,
    liveTicket: record?.liveTicket,
    livePlan: record?.livePlan,
    operator: record?.operator?.email,
  });
  return checkChildEvidence(JSON.parse(readFileSync(path.resolve(values["child-evidence"]), "utf8")), facts);
}

export const CLASSIFICATIONS = ["delivered", "active-elsewhere", "superseded", "uncovered"];
export const EVIDENCE_KINDS = ["diff", "tracked", "merged-pr", "report"];
const WRITER = "vibe-change-worker";
const SLUG = /^(?:ISS|FEA|PRD|PLN)-\d+$/;
const PULL_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const HTTPS_URL = /^https:\/\/\S+$/;
const SHA = /^[0-9a-f]{7,40}$/;
const UNFINISHED = /\b(?:pending|awaiting|running|in progress|todo|tbd|not run|not yet|unbuilt|to do)\b/i;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Checks one evidence map against the worktree facts; pure apart from the injected `facts`. */
export function checkChildEvidence(map, facts) {
  const problems = [];
  const report = (slug, problem, item) => problems.push({ slug, ...(item ? { item } : {}), problem });
  const result = { inReview: [], activeElsewhere: [], superseded: [], uncovered: [] };
  if (!map || typeof map !== "object") {
    return { ok: false, ...result, problems: [{ slug: null, problem: "the map is not a JSON object" }] };
  }
  if (typeof map.reviewer !== "string" || !map.reviewer.trim()) {
    report(null, "names no reviewer; the map comes from an independent reviewer");
  } else if (map.reviewer.trim() === WRITER) {
    report(null, "was written by the writer; its own audit never moves a child");
  }
  if (!Array.isArray(map.children)) {
    report(null, "has no children array");
    return { ok: false, ...result, problems };
  }
  for (const child of map.children) {
    const slug = typeof child?.slug === "string" ? child.slug : null;
    if (!slug || !SLUG.test(slug)) {
      report(slug, "has no ClosedLoop slug");
      continue;
    }
    const before = problems.length;
    switch (child.classification) {
      case "delivered":
        checkDelivered(child, facts, (problem, item) => report(slug, problem, item));
        if (problems.length === before) result.inReview.push(slug);
        break;
      case "active-elsewhere":
        checkActivity(child.activity, facts, (problem) => report(slug, problem));
        if (problems.length === before) result.activeElsewhere.push(slug);
        break;
      case "superseded":
        checkRuling(child.ruling, facts, (problem) => report(slug, problem));
        if (problems.length === before) result.superseded.push(slug);
        break;
      case "uncovered":
        result.uncovered.push(slug);
        break;
      default:
        report(slug, `has classification ${JSON.stringify(child.classification)}; use one of ${CLASSIFICATIONS.join(", ")}`);
    }
  }
  return { ok: problems.length === 0, ...result, problems };
}

function checkDelivered(child, facts, report) {
  const items = Array.isArray(child.items) ? child.items : [];
  if (items.length === 0) {
    report("lists no acceptance criteria or work items; map every one from the child's own text");
    return;
  }
  const evidencedPaths = new Set();
  for (const item of items) {
    const id = typeof item?.id === "string" && item.id.trim() ? item.id : null;
    if (!id) {
      report("has an item without an id");
      continue;
    }
    if (typeof item.text !== "string" || !item.text.trim()) {
      report("does not quote the item's words from the child", id);
    }
    if (item.result !== "met") {
      report(`is ${JSON.stringify(item.result ?? null)}, not met; the child stays where it is and is listed uncovered`, id);
    }
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    if (evidence.length === 0) {
      report("has no evidence", id);
    }
    for (const entry of evidence) {
      const problem = evidenceProblem(entry, facts);
      if (problem) report(problem, id);
      if (typeof entry?.path === "string") evidencedPaths.add(entry.path);
      if ([entry?.status, entry?.note].some((field) => typeof field === "string" && UNFINISHED.test(field))) {
        report("cites evidence that is still unfinished (pending, awaiting, running, not run)", id);
      }
    }
  }
  for (const named of Array.isArray(child.namedEvidencePaths) ? child.namedEvidencePaths : []) {
    if (!evidencedPaths.has(named)) {
      report(`names evidence path ${named} in its text with no item evidenced there`);
    }
  }
}

function evidenceProblem(entry, facts) {
  const kind = entry?.kind;
  switch (kind) {
    case "diff": {
      if (typeof entry.path !== "string" || !Number.isInteger(entry.line) || entry.line < 1) {
        return "cites diff evidence without a path and a positive line";
      }
      const lines = facts.addedLines.get(entry.path);
      if (!lines) return `cites ${entry.path}, which this branch did not change`;
      if (!lines.has(entry.line)) return `cites ${entry.path}:${entry.line}, which is not an added or changed line`;
      return null;
    }
    case "tracked": {
      if (typeof entry.path !== "string") return "cites tracked evidence without a path";
      if (!facts.trackedPaths.has(entry.path)) return `cites ${entry.path}, which is not tracked (a gitignored or local file is not evidence)`;
      if (!facts.addedLines.has(entry.path)) return `cites ${entry.path}, which this branch did not change`;
      return null;
    }
    case "merged-pr": {
      if (typeof entry.url !== "string" || !PULL_URL.test(entry.url)) return "cites a merged pull request without its URL";
      if (typeof entry.commit !== "string" || !SHA.test(entry.commit)) return `cites ${entry.url} without its merge commit`;
      if (!facts.isAncestor(entry.commit)) return `cites merge commit ${entry.commit}, which is not in this branch's history`;
      return null;
    }
    case "report": {
      const located = (typeof entry.url === "string" && HTTPS_URL.test(entry.url))
        || (typeof entry.path === "string" && facts.fileExists(entry.path));
      if (!located) return "cites a report with no https URL or existing file";
      if (entry.commit !== facts.head) return "cites a report that was not produced on the final commit";
      return null;
    }
    default:
      return `cites evidence of kind ${JSON.stringify(kind ?? null)}; use one of ${EVIDENCE_KINDS.join(", ")}`;
  }
}

function checkActivity(activity, facts, report) {
  const openPr = typeof activity?.pr === "string" && PULL_URL.test(activity.pr) && activity.prState === "OPEN";
  const committedAt = Date.parse(activity?.branchCommitAt ?? "");
  const recentCommit = Number.isFinite(committedAt) && facts.now - committedAt <= ACTIVITY_WINDOW_MS && committedAt <= facts.now;
  const ownedElsewhere = activity?.ownerStatus === "IN_PROGRESS"
    && typeof activity.owner === "string" && activity.owner.trim() !== ""
    && activity.owner !== facts.operator;
  if (!openPr && !recentCommit && !ownedElsewhere) {
    report("is called active elsewhere without an open pull request, a branch commit in the last 7 days or another owner's IN_PROGRESS status; list it uncovered");
  }
}

function checkRuling(ruling, facts, report) {
  if (!ruling || typeof ruling.by !== "string" || typeof ruling.where !== "string" || typeof ruling.quote !== "string"
    || !ruling.by.trim() || !ruling.where.trim() || !ruling.quote.trim()) {
    report("is called superseded without a human ruling (who, where, the quoted words)");
    return;
  }
  const sessionSources = [facts.liveTicket, facts.livePlan].filter(Boolean);
  if (sessionSources.some((slug) => ruling.where.includes(slug)) || /\b(?:local plan|decision table)\b/i.test(ruling.where)) {
    report("cites the session's own ticket, plan or table as the supersession ruling; that is an agent decision");
  }
}

/** Worktree facts the check reads: added lines per changed file, tracked paths, history and HEAD. */
export function readFacts(worktree, base, { now = Date.now(), liveTicket, livePlan, operator } = {}) {
  const run = (args) => execFileSync("git", ["-C", worktree, ...args], {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    addedLines: parseAddedLines(run(["diff", "-U0", "--no-color", "--no-renames", base])),
    trackedPaths: new Set(run(["ls-files", "-z"]).split("\0").filter(Boolean)),
    head: run(["rev-parse", "HEAD"]).trim(),
    isAncestor: (commit) => {
      try {
        run(["merge-base", "--is-ancestor", commit, "HEAD"]);
        return true;
      } catch {
        return false;
      }
    },
    fileExists: (file) => existsSync(path.resolve(worktree, file)),
    now,
    liveTicket,
    livePlan,
    operator,
  };
}

/** Maps each file in a `git diff -U0` to the set of its added or changed line numbers on the new side. */
export function parseAddedLines(diff) {
  const files = new Map();
  let current = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      current = target === "/dev/null" ? null : target.replace(/^b\//, "");
      if (current && !files.has(current)) files.set(current, new Set());
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let offset = 0; offset < count; offset += 1) files.get(current).add(start + offset);
    }
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
