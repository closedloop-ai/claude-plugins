#!/usr/bin/env node
// Do the tickets' statuses match the evidence? Assigned tickets sat in
// BACKLOG, children of merged pull requests stayed IN_PROGRESS or IN_REVIEW,
// and open children had no writer; the operator noticed each one first.
// Run it at every merge and every writer assignment.
//
// Usage: status-audit.mjs --snapshot <snapshot.json> [--at assignment|merge|report] [--board <orchDir>]
//
// With `--board`, each open unit on the board (board.mjs unit; closed units
// are skipped) is delivered by one PR, the one on its writer's board row. Each
// member is judged against that PR alone, found by number among the members'
// pullRequests: IN_PROGRESS while the writer has no PR, IN_REVIEW while it is
// open, DONE once it merges and the member's own criteria are checked. The
// orchestrator makes those moves with update-document; this audit finds the
// drift. A member missing from the snapshot prints `UNREAD-MEMBER <slug>`
// (put a member with no PRD under `{"slug": null}`). `UNIT-PR-UNREAD <unit>`,
// with the unit's members left unjudged, means the writer's PR is in no
// member's pullRequests, or the writer row has no PR while a member lists an
// open one.
//
// `--at report` with FLEET_TRIM_STATUS_AUDIT=1 (off by default) prints
// `status audit: skipped at report` and exits 0 without reading the snapshot, so the
// audit runs at assignments and merges only. Without the variable, or at any other
// point, it audits as before.
//
// snapshot.json, gathered from the ticket tool and the code host:
//   {"prds": [{"slug", "children": [{"slug", "status", "writer": <name or null>,
//     "pullRequests": [{"url", "state": "MERGED" | "OPEN" | "CLOSED"}],
//     "body": "<the ticket's latest text>", "plans": [{"slug", "status"}],
//     "absorbedBy": {"slug", "status"} (the umbrella ticket that absorbed it)}]}],
//    "outOfScope": [{"slug", "reason": "<who ruled it out, and where>"}],
//    "programRulings": "<current rulings.md>", "pullRequestTickets": {"123": "ISS-1"},
//    "artifactLinks": [{"source": "ISS-1", "target": "ISS-2", "linkType": "BLOCKS"}]}
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
// It also prints SEQUENCING-UNRESOLVED or SEQUENCING-BLOCKS-MISSING when a
// sourced human sequencing ruling cannot be resolved or lacks its graph edge.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ticketProblems } from "../../handoff/scripts/executed-check.mjs";
import { rulingNamesScope, sequencingRequirements } from "../../handoff/scripts/rulings-check.mjs";
import { readBoard } from "./ticket-units.mjs";
import { resolveWorkDir } from "../../codex-fleet-monitor/scripts/work-dir.mjs";

const ACTIVE = ["IN_PROGRESS", "IN_REVIEW"];
const FINISHED = new Set(["DONE", "CANCELED"]);
const PLAN_CLOSED = new Set(["EXECUTED", "OBSOLETE"]);

export const TRIM_ENV = "FLEET_TRIM_STATUS_AUDIT";
export const AuditPoint = Object.freeze({ Assignment: "assignment", Merge: "merge", Report: "report" });

/** Whether this run is skipped: only a `report` run, and only with the trim switch on. */
export function skipsAudit(at, env = process.env) {
  if (at !== undefined && !Object.values(AuditPoint).includes(at)) throw new Error("--at must be assignment, merge or report");
  return at === AuditPoint.Report && env[TRIM_ENV] === "1";
}

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
  if (child?.unit && (open || child.writer)) {
    const expected = open ? "IN_REVIEW" : "IN_PROGRESS";
    return child.status === expected ? null : {
      kind: "MISMATCH",
      expected,
      evidence: open ? `${open.url ?? "a pull request"} open for unit ${child.unit}` : `writer ${child.writer} started unit ${child.unit}`,
    };
  }
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

/** Each unit member is judged by the unit writer's PR and writer; members the snapshot lacks are UNREAD-MEMBER. */
export function applyUnits(children, units, writers = {}) {
  const findings = [];
  for (const [name, unit] of Object.entries(units)) {
    const members = children.filter(({ child }) => unit.tickets.includes(child?.slug));
    for (const slug of unit.tickets.filter((ticket) => !members.some(({ child }) => child.slug === ticket))) {
      findings.push({ slug, status: "?", kind: "UNREAD-MEMBER", unit: name });
    }
    const row = writers[unit.writer] ?? {};
    const listed = members.flatMap(({ child }) => (Array.isArray(child.pullRequests) ? child.pullRequests : []));
    let pulls = [];
    let unread = null;
    if (row.pr) {
      const match = listed.find((pull) => isWriterPull(pull?.url, row));
      if (match) pulls = [match];
      else unread = `no member lists the writer's PR ${row.repo ?? ""}#${row.pr}; add its state to the snapshot`;
    } else {
      // A member's own merged PR from before it folded in is not the unit's; only an open one can be.
      const live = listed.filter((pull) => pull?.state === "OPEN").map((pull) => pull.url ?? "a pull request");
      if (live.length) unread = `the writer row records no PR, but members list open ${[...new Set(live)].join(", ")}; record the unit's PR with board.mjs writer ${unit.writer ?? "<writer>"} --pr <n>`;
    }
    // Without the unit's PR state, judging would push members backwards; report it instead.
    if (unread) findings.push({ slug: name, status: "?", kind: "UNIT-PR-UNREAD", unit: name, why: unread });
    for (const entry of members) {
      entry.child = { ...entry.child, unit: name, pullRequests: pulls, writer: entry.child.writer ?? unit.writer ?? null, ...(unread ? { unitUnread: true } : {}) };
    }
  }
  return findings;
}

/** Whether a pull request URL is the writer row's PR: its number, and its repository when the row names one. */
function isWriterPull(url, row) {
  const match = /\/([^/]+\/[^/]+)\/pull\/(\d+)(?:$|[/?#])/.exec(url ?? "");
  return Boolean(match) && match[2] === String(row.pr) && (!row.repo || match[1] === row.repo);
}

/** Every child that disagrees with its evidence, and every one ruled out of scope. */
export function auditStatuses(snapshot, units = {}, writers = {}) {
  const ruled = new Map((Array.isArray(snapshot?.outOfScope) ? snapshot.outOfScope : [])
    .filter((entry) => typeof entry?.slug === "string" && typeof entry.reason === "string" && entry.reason.trim() !== "")
    .map((entry) => [entry.slug, entry.reason.trim()]));
  const children = (Array.isArray(snapshot?.prds) ? snapshot.prds : [])
    .flatMap((prd) => (Array.isArray(prd?.children) ? prd.children : []).map((child) => ({ child, prdSlug: prd?.slug })));
  const findings = [...sequencingFindings(snapshot), ...applyUnits(children, units, writers)];
  const outOfScope = [];
  for (const { child, prdSlug } of children) {
    findings.push(...sweepFindings(child).map((found) => ({ slug: child.slug, status: child.status, ...found })));
    const finding = child?.unitUnread ? null : childFinding(child, prdSlug);
    if (!finding) continue;
    const reason = ruled.get(child.slug);
    if (reason && rulingNamesScope(reason, [child.slug, prdSlug])) outOfScope.push({ slug: child.slug, reason });
    else if (reason) findings.push({ slug: child.slug, status: child.status, kind: "UNSCOPED", reason });
    else findings.push({ slug: child.slug, status: child.status, ...finding });
  }
  return { children: children.length, findings, outOfScope };
}

/** Missing or unresolved BLOCKS edges implied by the program's recorded sequencing rulings. */
function sequencingFindings(snapshot) {
  if (typeof snapshot?.programRulings !== "string") return [];
  const { edges, unresolved } = sequencingRequirements(snapshot.programRulings, snapshot.pullRequestTickets ?? {});
  const links = new Set((Array.isArray(snapshot.artifactLinks) ? snapshot.artifactLinks : [])
    .filter((link) => link?.linkType === "BLOCKS")
    .map((link) => `${link.sourceSlug ?? link.source}>${link.targetSlug ?? link.target}`));
  return [
    ...unresolved.map((entry) => ({ kind: "SEQUENCING-UNRESOLVED", ...entry })),
    ...edges.filter((edge) => !links.has(`${edge.blocker}>${edge.blocked}`))
      .map((edge) => ({ kind: "SEQUENCING-BLOCKS-MISSING", ...edge })),
  ];
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { snapshot: { type: "string" }, at: { type: "string" }, board: { type: "string" } } });
  if (!values.snapshot) {
    throw new Error("Usage: status-audit.mjs --snapshot <snapshot.json> [--at assignment|merge|report]");
  }
  if (skipsAudit(values.at)) {
    process.stdout.write("status audit: skipped at report\n");
    return 0;
  }
  const board = values.board ? readBoard(resolveWorkDir(values.board).dir) : { units: {}, writers: {} };
  const { children, findings, outOfScope } = auditStatuses(JSON.parse(readFileSync(values.snapshot, "utf8")), board.units, board.writers);
  const lines = {
    UNOWNED: (finding) => `UNOWNED ${finding.slug} ${finding.status}`,
    "PLAN-OPEN": (finding) => `PLAN-OPEN ${finding.slug}: ${finding.plan} is ${finding.planStatus}; a DONE ticket's plan is EXECUTED`,
    "ABSORBED-OPEN": (finding) => `ABSORBED-OPEN ${finding.slug} ${finding.status}: absorbed by ${finding.umbrella}, which is DONE; close it in the same step with that merge as evidence`,
    UNSCOPED: (finding) => `UNSCOPED ${finding.slug} ${finding.status}: the out-of-scope ruling "${finding.reason.slice(0, 120)}" names neither the ticket nor its PRD`,
    "UNIT-PR-UNREAD": (finding) => `UNIT-PR-UNREAD ${finding.unit}: ${finding.why}; its members are not judged until then`,
    "UNREAD-MEMBER": (finding) => `UNREAD-MEMBER ${finding.slug}: a ticket of unit ${finding.unit} is not in the snapshot; add it so its status moves with the unit`,
    UNREAD: (finding) => `UNREAD ${finding.slug} ${finding.status}: no ticket body in the snapshot; read it so its acceptance criteria are checked`,
    UNCHECKED: (finding) => `UNCHECKED ${finding.slug} ${finding.status}: ${finding.criteria}; check each against the merged code, or name its follow-up or human exclusion, before DONE (executed-check.mjs --kind ticket)`,
    MISMATCH: (finding) => `MISMATCH ${finding.slug} ${finding.status}, expected ${finding.expected} (${finding.evidence})`,
    "SEQUENCING-UNRESOLVED": (finding) => `SEQUENCING-UNRESOLVED ${finding.reference}: cannot resolve the recorded ruling "${finding.ruling.slice(0, 160)}" to ticket dependencies`,
    "SEQUENCING-BLOCKS-MISSING": (finding) => `SEQUENCING-BLOCKS-MISSING ${finding.blocker} blocks ${finding.blocked}: the recorded sequencing ruling has no matching BLOCKS link`,
  };
  for (const finding of findings) process.stdout.write(`${lines[finding.kind](finding)}\n`);
  for (const entry of outOfScope) process.stdout.write(`OUT-OF-SCOPE ${entry.slug}: ${entry.reason}\n`);
  const count = (kind) => findings.filter((finding) => finding.kind === kind).length;
  process.stdout.write(`status audit: ${children} children, ${count("MISMATCH")} mismatched, ${count("UNOWNED")} unowned, ${count("UNREAD") + count("UNCHECKED") + count("UNREAD-MEMBER") + count("UNIT-PR-UNREAD")} unchecked, ${count("UNSCOPED")} unscoped, ${count("PLAN-OPEN")} open plans, ${count("ABSORBED-OPEN")} absorbed open\n`);
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
