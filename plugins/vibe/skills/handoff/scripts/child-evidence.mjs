#!/usr/bin/env node
// Gates every ClosedLoop status move of a source PRD's claimed children
// (vibe ledger, symphony-alpha #8947, #8953, #8958, #8959, #8960, #8963 and
// PRD-729: children moved to IN_REVIEW with design review, device runs, hosted
// URLs or ledgers still unbuilt, on the writer's own audit). The map is the
// adversarial reviewer's, never the writer's: every acceptance criterion and
// work item of each delivered child carries evidence this script verifies
// against the worktree. Only the slugs in `inReview` may move to IN_REVIEW.
//
// Prints one JSON object; exits 0 when the map passes and 1 otherwise.
// Changes nothing.
//
// Usage: child-evidence.mjs --worktree <wt> --base <sha> --map <json>
//          [--live-ticket <slug>] [--live-plan <slug>] [--now <iso>]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

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

function main() {
  const { values } = parseArgs({
    options: {
      worktree: { type: "string" },
      base: { type: "string" },
      map: { type: "string" },
      "live-ticket": { type: "string" },
      "live-plan": { type: "string" },
      operator: { type: "string" },
      now: { type: "string" },
    },
  });
  try {
    if (!values.worktree || !values.base || !values.map) {
      throw new Error("--worktree, --base and --map are required.");
    }
    const now = values.now ? Date.parse(values.now) : Date.now();
    if (!Number.isFinite(now)) throw new Error("--now is not a date.");
    const facts = readFacts(path.resolve(values.worktree), values.base, {
      now,
      liveTicket: values["live-ticket"],
      livePlan: values["live-plan"],
      operator: values.operator,
    });
    const result = checkChildEvidence(JSON.parse(readFileSync(path.resolve(values.map), "utf8")), facts);
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
