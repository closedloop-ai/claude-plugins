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
//     "pullRequests": [{"url", "state": "MERGED" | "OPEN" | "CLOSED"}]}]}],
//    "outOfScope": [{"slug", "reason": "<who ruled it out, and where>"}]}
// For each child: a merged pull request means DONE; an open pull request or an
// assigned writer means IN_PROGRESS or IN_REVIEW; not DONE or CANCELED with
// neither means UNOWNED. Prints `MISMATCH <slug> <status>, expected <status>
// (<evidence>)`, `UNOWNED <slug> <status>` and `OUT-OF-SCOPE <slug>: <reason>`
// lines, then `status audit: <n> children, <m> mismatched, <u> unowned`; exits
// 1 until every mismatch is fixed or ruled out of scope with a reason.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ACTIVE = ["IN_PROGRESS", "IN_REVIEW"];
const FINISHED = new Set(["DONE", "CANCELED"]);

/** What the evidence says one child's status should be, or null when it agrees. */
export function childFinding(child) {
  const pulls = Array.isArray(child?.pullRequests) ? child.pullRequests : [];
  const merged = pulls.find((pull) => pull?.state === "MERGED");
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

/** Every child that disagrees with its evidence, and every one ruled out of scope. */
export function auditStatuses(snapshot) {
  const ruled = new Map((Array.isArray(snapshot?.outOfScope) ? snapshot.outOfScope : [])
    .filter((entry) => typeof entry?.slug === "string" && typeof entry.reason === "string" && entry.reason.trim() !== "")
    .map((entry) => [entry.slug, entry.reason.trim()]));
  const children = (Array.isArray(snapshot?.prds) ? snapshot.prds : []).flatMap((prd) => (Array.isArray(prd?.children) ? prd.children : []));
  const findings = [];
  const outOfScope = [];
  for (const child of children) {
    const finding = childFinding(child);
    if (!finding) continue;
    if (ruled.has(child.slug)) outOfScope.push({ slug: child.slug, reason: ruled.get(child.slug) });
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
  for (const finding of findings) {
    process.stdout.write(finding.kind === "UNOWNED"
      ? `UNOWNED ${finding.slug} ${finding.status}\n`
      : `MISMATCH ${finding.slug} ${finding.status}, expected ${finding.expected} (${finding.evidence})\n`);
  }
  for (const entry of outOfScope) process.stdout.write(`OUT-OF-SCOPE ${entry.slug}: ${entry.reason}\n`);
  const mismatched = findings.filter((finding) => finding.kind === "MISMATCH").length;
  process.stdout.write(`status audit: ${children} children, ${mismatched} mismatched, ${findings.length - mismatched} unowned\n`);
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
