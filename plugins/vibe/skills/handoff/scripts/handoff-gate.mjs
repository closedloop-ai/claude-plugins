#!/usr/bin/env node
// A pull request may open only for the exact source that passed the final
// pull-request inventory, including its body and verifier run evidence. This
// records that witness; vibe-core's handoff-gate-check.mjs reads it.
// A fleet unit's member tickets (`--member <slug>=<body>`) are
// audited with the session's ticket and bound into the witness the same way.
// With members recorded on the session, the gate needs `--title`, and the
// title and body must name every member; the witness keeps the member list,
// so a member added afterwards (`vibe-sessions.mjs touch --member-ticket`)
// makes it stale. At PR creation the hook passes the command's `--title`, and
// a title that leaves a member unnamed (or none) is refused there too.
// A unit (member tickets or a PRD) also needs `--review <review.json>` and its
// PRD as `--prd <slug>=<body>` (and any plan as `--plan`): the criteria audit
// runs unit-review.mjs over them, so the PR opens only once every member and
// PRD criterion passed code review and visual QA on each page and surface it
// names. Their fingerprints join the witness, and `unitReviewPassed` records it
// for vibe-core's ticket status guard.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { sameSource, sourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const { evidenceFingerprint } = await vibeCore("lib/handoff/scripts/handoff-evidence.mjs");
const { reviewReceiptProblems } = await vibeCore("lib/handoff/scripts/review-receipts.mjs");
const { EVIDENCE_KEYS, checkedMergeProblem, gatePath, memberNameProblems, mergeTargets, readReviewReceipts, reviewFindingProblems, sessionMembers } = await vibeCore("lib/handoff/scripts/handoff-gate-check.mjs");

/** Refresh the actual main branch before a publication witness can be recorded. */
function fetchCurrentMain(worktree) {
  const result = spawnSync("git", ["-C", worktree, "fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`current main fetch failed: ${String(result.stderr || result.error?.message || result.stdout).trim().split("\n")[0]}`);
  }
}

/** The criteria audit's unit review arguments: the review of the completed work and the PRD and plan bodies it reads. */
export function unitReviewArgs({ review, prds = [], plans = [] }) {
  return [...(review ? ["--review", review] : []), ...prds.flatMap((prd) => ["--prd", prd]), ...plans.flatMap((plan) => ["--plan", plan])];
}

/** Run the canonical inventory with PR body and verifier evidence before recording readiness. */
export function recordHandoffGate({ worktree, body, runs, ticket, base, receipts, audit, matrix, members = [], prds = [], plans = [], review, title }, { runScript = spawnSync } = {}) {
  const witness = gatePath(worktree);
  if (existsSync(witness)) unlinkSync(witness);
  fetchCurrentMain(worktree);
  const targets = mergeTargets(worktree, base);
  const mergeProblem = checkedMergeProblem(worktree, targets);
  if (mergeProblem) throw new Error(mergeProblem);
  const source = sourceIdentity(worktree);
  const verified = reviewReceiptProblems(readReviewReceipts(receipts), source);
  const reviewProblems = [...verified.problems, ...reviewFindingProblems({ source, findings: verified.findings }, source)];
  if (reviewProblems.length) throw new Error(reviewProblems.join("; "));
  if (ticket && (!audit || !matrix)) throw new Error("criteria audit and matrix are required with a ticket");
  const memberTickets = sessionMembers(worktree);
  const naming = memberNameProblems(memberTickets, title, readFileSync(body, "utf8"));
  if (naming.length) throw new Error(naming.join("; "));
  if (ticket) {
    const criteria = runScript(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "criteria-audit.mjs"),
      "--worktree", worktree, "--ticket", ticket, "--audit", audit, "--matrix", matrix, "--at", "head",
      ...members.flatMap((member) => ["--member", member]), ...unitReviewArgs({ review, prds, plans })], { encoding: "utf8" });
    if (criteria.status !== 0) throw new Error(`acceptance criteria audit failed: ${criteria.stdout || criteria.stderr}`);
  }
  const args = [path.join(path.dirname(fileURLToPath(import.meta.url)), "handoff-inventory.mjs"),
    "--worktree", worktree, "--phase", "pull-request", "--body", body, "--runs", runs,
    "--commit", execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ...(ticket ? ["--ticket", ticket] : []), ...members.flatMap((member) => ["--ticket", member.slice(member.indexOf("=") + 1)])];
  const result = runScript(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`pull-request inventory failed: ${result.stderr || result.stdout}`);
  const inventory = JSON.parse(result.stdout);
  if (!inventory.ok || !inventory.blocking?.prBody || !inventory.blocking?.prEvidence) {
    throw new Error("pull-request inventory did not pass body and verifier evidence checks");
  }
  const branch = execFileSync("git", ["-C", worktree, "branch", "--show-current"], { encoding: "utf8" }).trim();
  if (!sameSource(source, sourceIdentity(worktree))) throw new Error("source changed while the handoff gate ran");
  const evidenceInputs = { body, runs, ticket, audit, matrix, review };
  const evidence = Object.fromEntries(EVIDENCE_KEYS.filter(key => evidenceInputs[key]).map(key => [key, evidenceFingerprint(evidenceInputs[key])]));
  for (const [key, entries] of [["members", members], ["prds", prds], ["plans", plans]]) {
    if (entries.length) evidence[key] = entries.map((entry) => evidenceFingerprint(entry.slice(entry.indexOf("=") + 1)));
  }
  const boundReceipts = receipts.map(evidenceFingerprint);
  const finalMergeProblem = checkedMergeProblem(worktree, targets);
  if (finalMergeProblem) throw new Error(finalMergeProblem);
  const current = mergeTargets(worktree, base);
  if (current.base.oid !== targets.base.oid) throw new Error("PR base moved during the handoff gate");
  if (current.main?.oid !== targets.main?.oid) throw new Error("current main moved during the handoff gate");
  writeFileSync(witness, `${JSON.stringify({ branch, source, base: targets.base, main: targets.main, evidence, receipts: boundReceipts, memberTickets, unitReviewPassed: Boolean(review), inventoryPassed: true, prBodyPassed: true, prEvidencePassed: true, reviewPassed: true })}\n`, { mode: 0o600 });
  return { branch, source };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { worktree: { type: "string" }, body: { type: "string" }, runs: { type: "string" }, ticket: { type: "string" }, base: { type: "string" }, receipt: { type: "string", multiple: true }, audit: { type: "string" }, matrix: { type: "string" }, member: { type: "string", multiple: true }, prd: { type: "string", multiple: true }, plan: { type: "string", multiple: true }, review: { type: "string" }, title: { type: "string" } } });
  if (!values.worktree || !values.body || !values.runs || !values.base || !values.receipt?.length) throw new Error("Usage: handoff-gate.mjs --worktree <wt> --base <current base ref> --body <file> --runs <file> --receipt <reviewer.json> (repeat for each role) [--ticket <file> --audit <file> --matrix <file> [--member <slug>=<file> ...] [--prd <slug>=<file> ...] [--plan <slug>=<file> ...] [--review <review.json>] [--title <PR title>]]");
  values.receipts = values.receipt;
  values.members = values.member ?? [];
  values.prds = values.prd ?? [];
  values.plans = values.plan ?? [];
  if ((values.prds.length || values.plans.length || values.review) && !values.ticket) throw new Error("--prd, --plan and --review need --ticket, --audit and --matrix: the unit review runs inside the criteria audit");
  if (values.members.length && !values.ticket) throw new Error("--member needs --ticket, --audit and --matrix: member criteria are audited with the session's own ticket");
  process.stdout.write(`${JSON.stringify(recordHandoffGate(values))}\n`);
}
