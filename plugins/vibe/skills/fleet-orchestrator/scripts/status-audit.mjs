#!/usr/bin/env node
// Do the tickets' statuses match the evidence? Assigned tickets sat in
// BACKLOG, children of merged pull requests stayed IN_PROGRESS or IN_REVIEW,
// and open children had no writer; the operator noticed each one first.
// Run it at every merge and every writer assignment.
//
// Usage: status-audit.mjs --snapshot <snapshot.json>
//
// snapshot.json, gathered from the ticket tool and the code host:
//   {"prds": [{"slug", "children": [{"slug", "status", "writer": <name or null>,
//     "pullRequests": [{"url", "state": "MERGED" | "OPEN" | "CLOSED"}],
//     "body": "<the ticket's latest text>", "plans": [{"slug", "status"}],
//     "absorbedBy": {"slug", "status"} (the umbrella ticket that absorbed it)}]}],
//    "outOfScope": [{"slug", "reason": "<who ruled it out, and where>"}]}
// For each child: a merged pull request means DONE; an open pull request or an
// assigned writer means IN_PROGRESS or IN_REVIEW; not DONE or CANCELED with
// neither means UNOWNED. A merged pull request is not DONE on its own: a child
// that is DONE or has one merged needs its `body`, and every acceptance
// criterion in it checked, followed up or excluded by a human (executed-check
// --kind ticket); about sixty children were swept to DONE minutes after their
// merges with criteria unchecked. Prints `MISMATCH <slug> <status>, expected
// <status> (<evidence>)`, `UNOWNED <slug> <status>`, `UNREAD <slug> <status>`,
// `UNCHECKED <slug> <status>: <criteria>` and `OUT-OF-SCOPE <slug>: <reason>`
// lines, then `status audit: <n> children, <m> mismatched, <u> unowned,
// <c> unchecked, <s> unscoped`; exits 1 until every finding is fixed or ruled
// out of scope by a reason that names the child or its PRD (`UNSCOPED`
// otherwise: rollout tickets were once closed on a ruling about another surface).
// It is also the program's status sweep, run at every merge and every status
// report (the board's `status-sweep` duty): `PLAN-OPEN <slug>: <plan> <status>`
// for a DONE ticket whose plan is not EXECUTED, and `ABSORBED-OPEN <slug>
// <status>: absorbed by <umbrella> DONE` for a child still open after the
// umbrella that absorbed it closed; close those children in the same step as
// the umbrella, with its merge as evidence. Plans stayed open behind DONE
// tickets and absorbed children stayed IN_PROGRESS until the operator noticed.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ticketProblems } from "../../handoff/scripts/executed-check.mjs";
import { rulingNamesScope } from "../../handoff/scripts/rulings-check.mjs";

const ACTIVE = ["IN_PROGRESS", "IN_REVIEW"];
const FINISHED = new Set(["DONE", "CANCELED"]);
const PLAN_CLOSED = new Set(["EXECUTED", "OBSOLETE"]);

/** Plan and absorption drift for one child: its plans behind a DONE ticket, or an absorbed child left open. */
export function sweepFindings(child) {
  const findings = [];
  if (child?.status === "DONE") {
    for (const plan of Array.isArray(child.plans) ? child.plans : []) {
      if (!PLAN_CLOSED.has(plan?.status)) findings.push({ kind: "PLAN-OPEN", plan: plan?.slug ?? "?", planStatus: plan?.status ?? "missing" });
    }
  }
  if (child?.absorbedBy?.status === "DONE" && !FINISHED.has(child.status)) {
    findings.push({ kind: "ABSORBED-OPEN", umbrella: child.absorbedBy.slug ?? "?" });
  }
  return findings;
}

/** What the evidence says one child's status should be, or null when it agrees. */
export function childFinding(child, prdSlug) {
  const pulls = Array.isArray(child?.pullRequests) ? child.pullRequests : [];
  const merged = pulls.find((pull) => pull?.state === "MERGED");
  if (merged || child?.status === "DONE") {
    const criteria = criteriaFinding(child, prdSlug);
    if (criteria) return criteria;
  }
  if (merged) {
    return child.status === "DONE" ? null : { kind: "MISMATCH", expected: "DONE", evidence: `${merged.url ?? "a pull request"} merged` };
  }
  const open = pulls.find((pull) => pull?.state === "OPEN");
  if (open || child?.writer) {
    return ACTIVE.includes(child.status) ? null : {
      kind: "MISMATCH",
      expected: ACTIVE.join(" or "),
      evidence: open ? `${open.url ?? "a pull request"} open` : `writer ${child.writer} assigned`,
    };
  }
  return FINISHED.has(child?.status) ? null : { kind: "UNOWNED" };
}

/** A DONE or merged child whose body was not read, or whose criteria are not all checked. */
function criteriaFinding(child, prdSlug) {
  if (typeof child?.body !== "string" || child.body.trim() === "") {
    return { kind: "UNREAD" };
  }
  const unchecked = ticketProblems(child.body, [child.slug, prdSlug].filter(Boolean));
  return unchecked.length === 0 ? null : { kind: "UNCHECKED", criteria: unchecked.map((problem) => problem.split(" ")[0]).join(", ") };
}

/** Every child that disagrees with its evidence, and every one ruled out of scope. */
export function auditStatuses(snapshot) {
  const ruled = new Map((Array.isArray(snapshot?.outOfScope) ? snapshot.outOfScope : [])
    .filter((entry) => typeof entry?.slug === "string" && typeof entry.reason === "string" && entry.reason.trim() !== "")
    .map((entry) => [entry.slug, entry.reason.trim()]));
  const children = (Array.isArray(snapshot?.prds) ? snapshot.prds : [])
    .flatMap((prd) => (Array.isArray(prd?.children) ? prd.children : []).map((child) => ({ child, prdSlug: prd?.slug })));
  const findings = [];
  const outOfScope = [];
  for (const { child, prdSlug } of children) {
    findings.push(...sweepFindings(child).map((found) => ({ slug: child.slug, status: child.status, ...found })));
    const finding = childFinding(child, prdSlug);
    if (!finding) continue;
    const reason = ruled.get(child.slug);
    if (reason && rulingNamesScope(reason, [child.slug, prdSlug])) outOfScope.push({ slug: child.slug, reason });
    else if (reason) findings.push({ slug: child.slug, status: child.status, kind: "UNSCOPED", reason });
    else findings.push({ slug: child.slug, status: child.status, ...finding });
  }
  return { children: children.length, findings, outOfScope };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { snapshot: { type: "string" } } });
  if (!values.snapshot) {
    throw new Error("Usage: status-audit.mjs --snapshot <snapshot.json>");
  }
  const { children, findings, outOfScope } = auditStatuses(JSON.parse(readFileSync(values.snapshot, "utf8")));
  const lines = {
    UNOWNED: (finding) => `UNOWNED ${finding.slug} ${finding.status}`,
    "PLAN-OPEN": (finding) => `PLAN-OPEN ${finding.slug}: ${finding.plan} is ${finding.planStatus}; a DONE ticket's plan is EXECUTED`,
    "ABSORBED-OPEN": (finding) => `ABSORBED-OPEN ${finding.slug} ${finding.status}: absorbed by ${finding.umbrella}, which is DONE; close it in the same step with that merge as evidence`,
    UNSCOPED: (finding) => `UNSCOPED ${finding.slug} ${finding.status}: the out-of-scope ruling "${finding.reason.slice(0, 120)}" names neither the ticket nor its PRD`,
    UNREAD: (finding) => `UNREAD ${finding.slug} ${finding.status}: no ticket body in the snapshot; read it so its acceptance criteria are checked`,
    UNCHECKED: (finding) => `UNCHECKED ${finding.slug} ${finding.status}: ${finding.criteria}; check each against the merged code, or name its follow-up or human exclusion, before DONE (executed-check.mjs --kind ticket)`,
    MISMATCH: (finding) => `MISMATCH ${finding.slug} ${finding.status}, expected ${finding.expected} (${finding.evidence})`,
  };
  for (const finding of findings) process.stdout.write(`${lines[finding.kind](finding)}\n`);
  for (const entry of outOfScope) process.stdout.write(`OUT-OF-SCOPE ${entry.slug}: ${entry.reason}\n`);
  const count = (kind) => findings.filter((finding) => finding.kind === kind).length;
  process.stdout.write(`status audit: ${children} children, ${count("MISMATCH")} mismatched, ${count("UNOWNED")} unowned, ${count("UNREAD") + count("UNCHECKED")} unchecked, ${count("UNSCOPED")} unscoped, ${count("PLAN-OPEN")} open plans, ${count("ABSORBED-OPEN")} absorbed open\n`);
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
