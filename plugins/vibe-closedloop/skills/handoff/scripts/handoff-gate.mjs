#!/usr/bin/env node
// A pull request may open only for the exact source that passed the final
// pull-request inventory, including its body and verifier run evidence. This
// records that witness; lib/handoff/scripts/handoff-gate-check.mjs reads it.
// A fleet unit's member tickets (`--member <slug>=<body>`) are
// audited with the session's ticket and bound into the witness the same way.
// With members recorded on the session, the gate needs `--title`, and the
// body must name every member; the witness keeps the member list,
// so a member added afterwards (`vibe-sessions.mjs touch --member-ticket`)
// makes it stale. At PR creation the hook passes the command's `--title`, which
// the witness binds; the body, not the title, names the members.
// A unit (member tickets or a PRD) also needs `--review <review.json>` and its
// PRD as `--prd <slug>=<body>` (and any plan as `--plan`): the criteria audit
// runs unit-review.mjs over them, so the PR opens only once every member and
// PRD criterion passed code review and visual QA on each page and surface it
// names. Their fingerprints join the witness, and `unitReviewPassed` records it
// for vibe's ticket status guard.
// A diff under the repository's UI paths also needs `--visual-qa <findings.json>` for this source's tree with
// every touched-surface finding disposed of (lib/vibe/scripts/required-visual-qa.mjs); the witness records the verdict and the
// findings fingerprint, which vibe's PR-create hook checks.
// Evidence that cites a targeted-tests ruling from the program's rulings file
// (targeted-tests-ruling.mjs) needs that file as `--rulings`; it is bound too.

import { capturedJson } from "../../../lib/vibe/scripts/captured-json.mjs";
import { readGitInventory } from "../../../lib/vibe/scripts/git-inventory.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";
import { reusableReviewRoles } from "./review-impact.mjs";

const { sameSource, sourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const { evidenceFingerprint, readEvidence } = await vibeCore("lib/handoff/scripts/handoff-evidence.mjs");
const { reviewReceiptProblems } = await vibeCore("lib/handoff/scripts/review-receipts.mjs");
const { EVIDENCE_KEYS, checkedMergeProblem, gatePath, memberNameProblems, mergeTargets, readReviewEvidence, reviewFindingProblems, sessionMembers } = await vibeCore("lib/handoff/scripts/handoff-gate-check.mjs");
const { exitOnProviderBroken, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { changedPaths, readVisualQaFindings, visualQaRequired } = await vibeCore("lib/vibe/scripts/required-visual-qa.mjs");
const { placementLineProblem } = await vibeCore("lib/fleet-orchestrator/scripts/delivery-placement.mjs");
const { readSessionRecord } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { OVERRIDE_CHECKS, overriddenChecks, readPrBodyEvidence } = await vibeCore("lib/handoff/scripts/gate-override.mjs");

/** Refresh the actual main branch before a publication witness can be recorded. */
function fetchCurrentMain(worktree) {
  const result = spawnSync("git", ["-C", worktree, "fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`current main fetch failed: ${String(result.stderr || result.error?.message || result.stdout).trim().split("\n")[0]}`);
  }
}

/** The criteria audit's unit review arguments: the review of the completed work and the PRD and plan bodies it reads. */
export function unitReviewArgs({ review, prds = [], plans = [] }) {
  return [...(review ? ["--review", review] : []), ...prds.flatMap((prd) => ["--prd", prd]),
    ...plans.flatMap((plan) => ["--plan", plan])];
}

/** Parse verifier evidence without allowing duplicate importer envelopes to disappear in JSON.parse. */
export function parseRunsEvidence(file, bytes = readEvidence(file).text) {
  let index = 0;
  const whitespace = () => { while (/\s/.test(bytes[index] ?? "")) index += 1; };
  const string = () => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < bytes.length) {
      const char = bytes[index++];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') return JSON.parse(bytes.slice(start, index));
    }
    throw new Error("unterminated JSON string");
  };
  const value = () => {
    whitespace();
    if (bytes[index] === '"') { string(); return; }
    if (bytes[index] === "{") { object(); return; }
    if (bytes[index] === "[") { array(); return; }
    const start = index;
    while (index < bytes.length && !/[\s,}\]]/.test(bytes[index])) index += 1;
    if (start === index) throw new Error("invalid JSON value");
  };
  const array = () => {
    index += 1;
    whitespace();
    if (bytes[index] === "]") { index += 1; return; }
    while (index < bytes.length) {
      value();
      whitespace();
      if (bytes[index] === "]") { index += 1; return; }
      if (bytes[index++] !== ",") throw new Error("invalid JSON array");
    }
    throw new Error("unterminated JSON array");
  };
  const object = () => {
    index += 1;
    const keys = new Set();
    whitespace();
    if (bytes[index] === "}") { index += 1; return; }
    while (index < bytes.length) {
      whitespace();
      if (bytes[index] !== '"') throw new Error("invalid JSON object key");
      const key = string();
      if (keys.has(key)) throw new Error(`verifier evidence has duplicate JSON key ${key}`);
      keys.add(key);
      whitespace();
      if (bytes[index++] !== ":") throw new Error("invalid JSON object");
      value();
      whitespace();
      if (bytes[index] === "}") { index += 1; return; }
      if (bytes[index++] !== ",") throw new Error("invalid JSON object");
    }
    throw new Error("unterminated JSON object");
  };
  value();
  whitespace();
  if (index !== bytes.length) throw new Error("trailing JSON input");
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`invalid verifier evidence JSON: ${error.message}`);
  }
}

/** Why a pull-request inventory result cannot be recorded as passing, or null; a body-only result is never inventory evidence. */
export function inventoryGateProblem(inventory, allowDiffRuleOverride = false) {
  if (inventory.inventory === null) return `pull-request inventory is missing: ${inventory.inventoryProblem}`;
  if (!inventory.blocking?.prBody || !inventory.blocking?.prEvidence
    || (!inventory.ok && !(allowDiffRuleOverride && onlyDiffRulesBlocked(inventory)))) {
    return "pull-request inventory did not pass body and verifier evidence checks";
  }
  return null;
}

/** A ticketed inventory override does not cover any other failed check or missing result. */
function onlyDiffRulesBlocked(inventory) {
  return inventory.blocking?.diffRulesClear === false
    && Array.isArray(inventory.diffRules?.blocking) && inventory.diffRules.blocking.length > 0
    && Object.entries(inventory.blocking).every(([name, passed]) => name === "diffRulesClear" || passed === true);
}

/**
 * The visual QA verdict for the source at `head` against `baseOid` ({ required, reason, problems }): a diff
 * under the repository's UI paths needs `findings` for this source's tree (lib/vibe/scripts/required-visual-qa.mjs). Uncommitted
 * UI files cannot be covered, because visual QA runs on a commit.
 */
export function visualQaGate(worktree, baseOid, head, findings, binding = sessionBinding(worktree), body) {
  const git = (...args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  const listed = (...args) => git(...args, "-z").split("\0").filter(Boolean);
  const uncommitted = [...listed("diff", "--name-only", "--no-renames", "HEAD"), ...readGitInventory(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]).trim().split("\0").filter(Boolean)];
  const verdict = visualQaRequired(binding, [...changedPaths(git, baseOid, head), ...uncommitted]);
  if (!verdict.required) return { ...verdict, problems: [] };
  const open = visualQaRequired(binding, uncommitted).paths;
  const problems = open.length ? [`uncommitted UI changes (${open.join(", ")}) have no visual QA: commit them, then run visual QA on that head`] : [];
  const checked = readVisualQaFindings(findings, head, git, binding, { paths: verdict.paths, body }, worktree);
  return { ...verdict, fingerprint: checked.fingerprint, problems: [...problems, ...checked.problems] };
}

/** Run the canonical inventory with PR body and verifier evidence before recording readiness. */
export function recordHandoffGate({ worktree, body, runs, ticket, rulings, base, receipts, audit, matrix, members = [], prds = [], plans = [], review, title, visualQa }, { runScript = spawnSync } = {}) {
  const witness = gatePath(worktree);
  if (existsSync(witness)) unlinkSync(witness);
  fetchCurrentMain(worktree);
  const targets = mergeTargets(worktree, base);
  const mergeProblem = checkedMergeProblem(worktree, targets);
  if (mergeProblem) throw new Error(mergeProblem);
  const session = readSessionRecord(worktree);
  if (session?.prBodyStale) throw new Error(`PR body is stale after a scope change (${session.prBodyStale.reason}); refresh it with env-ctl pr-update before recording readiness`);
  const source = sourceIdentity(worktree);
  const bodyEvidence = readPrBodyEvidence(body);
  const bodyText = bodyEvidence.text;
  const binding = sessionBinding(worktree);
  const allowDiffRuleOverride = overriddenChecks(bodyText, binding).has(OVERRIDE_CHECKS.HandoffGate);
  const receiptEvidence = readReviewEvidence(receipts);
  const parsedReceipts = receiptEvidence.map((entry) => entry.receipt);
  const checkedRuns = readEvidence(runs);
  const runsEvidence = parseRunsEvidence(runs, checkedRuns.text);
  const reusableRoles = reusableReviewRoles(worktree, parsedReceipts, runsEvidence.qaImpactRequest);
  const verified = reviewReceiptProblems(parsedReceipts, source, { reusableRoles, worktree });
  const reviewProblems = [...verified.problems, ...reviewFindingProblems({ source, findings: verified.findings }, source)];
  if (reviewProblems.length) throw new Error(reviewProblems.join("; "));
  const visual = visualQaGate(worktree, targets.base.oid, source.head, visualQa, binding, bodyText);
  if (visual.problems.length) throw new Error(`visual QA is required (${visual.reason}): ${visual.problems.join("; ")}`);
  if (ticket && (!audit || !matrix)) throw new Error("criteria audit and matrix are required with a ticket");
  const memberTickets = sessionMembers(worktree);
  const naming = memberNameProblems(memberTickets, title, bodyText);
  if (naming.length) throw new Error(naming.join("; "));
  // The PR-create hook refuses an active session's PR without one placement line; checking it here keeps the gated body final.
  const placement = session?.status === "active" ? placementLineProblem(bodyText) : null;
  if (placement) throw new Error(placement);
  const evidenceInputs = { body, runs, ticket, rulings, audit, matrix, review };
  const evidence = { body: bodyEvidence.fingerprint, runs: checkedRuns.fingerprint };
  const manifest = new Map();
  for (const key of EVIDENCE_KEYS) {
    const file = evidenceInputs[key];
    if (!file) continue;
    evidence[key] ??= evidenceFingerprint(file);
    manifest.set(path.resolve(file), evidence[key]);
  }
  for (const [key, entries] of [["members", members], ["prds", prds], ["plans", plans]]) {
    if (!entries.length) continue;
    evidence[key] = entries.map(entry => {
      const file = entry.slice(entry.indexOf("=") + 1);
      const saved = evidenceFingerprint(file);
      manifest.set(path.resolve(file), saved);
      return saved;
    });
  }
  const childOptions = { encoding: "utf8", input: JSON.stringify([...manifest]) };
  if (ticket) {
    const criteria = runScript(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "criteria-audit.mjs"),
      "--bound-inputs", "--worktree", worktree, "--ticket", ticket, "--audit", audit, "--matrix", matrix, "--at", "head",
      ...members.flatMap((member) => ["--member", member]), ...unitReviewArgs({ review, prds, plans })], childOptions);
    if (criteria.status !== 0) throw new Error(`acceptance criteria audit failed: ${criteria.stdout || criteria.stderr}`);
  }
  const args = [path.join(path.dirname(fileURLToPath(import.meta.url)), "handoff-inventory.mjs"),
    "--bound-inputs", "--worktree", worktree, "--phase", "pull-request", "--body", body, "--runs", checkedRuns.fingerprint.path, "--runs-sha256", checkedRuns.fingerprint.sha256,
    "--commit", execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ...(ticket ? ["--ticket", ticket] : []), ...(rulings ? ["--rulings", rulings] : []), ...members.flatMap((member) => ["--ticket", member.slice(member.indexOf("=") + 1)])];
  const result = runScript(process.execPath, args, { ...childOptions, maxBuffer: 64 * 1024 * 1024 });
  let inventory;
  try { inventory = capturedJson(result.stdout); }
  catch { throw new Error(`pull-request inventory failed: ${result.stderr || result.stdout}`); }
  const overridden = result.status === 1 && allowDiffRuleOverride && onlyDiffRulesBlocked(inventory);
  if (result.status !== 0 && !overridden) throw new Error(`pull-request inventory failed: ${result.stderr || result.stdout}`);
  const problem = inventoryGateProblem(inventory, overridden);
  if (problem) throw new Error(problem);
  const branch = execFileSync("git", ["-C", worktree, "branch", "--show-current"], { encoding: "utf8" }).trim();
  if (!sameSource(source, sourceIdentity(worktree))) throw new Error("source changed while the handoff gate ran");
  if (evidenceFingerprint(body).sha256 !== bodyEvidence.fingerprint.sha256) throw new Error("PR body changed while the handoff gate ran");
  const boundReceipts = receiptEvidence.map((entry) => entry.fingerprint);
  const finalMergeProblem = checkedMergeProblem(worktree, targets);
  if (finalMergeProblem) throw new Error(finalMergeProblem);
  const current = mergeTargets(worktree, base);
  if (current.base.oid !== targets.base.oid) throw new Error("PR base moved during the handoff gate");
  if (current.main?.oid !== targets.main?.oid) throw new Error("current main moved during the handoff gate");
  writeFileSync(witness, `${JSON.stringify({ branch, source, base: targets.base, main: targets.main, evidence, receipts: boundReceipts,
    reviewCarry: [...reusableRoles].sort(), memberTickets, unitReviewPassed: Boolean(review),
    visualQa: { required: visual.required, reason: visual.reason, findings: visual.required ? visual.fingerprint : null }, inventoryPassed: true,
    prBodyPassed: true, prEvidencePassed: true, reviewPassed: true, ...(overridden ? { inventoryOverride: "diffRulesClear" } : {}) })}\n`, { mode: 0o600 });
  return { branch, source };
}

if (isEntryPoint(import.meta.url)) {
  exitOnProviderBroken();
  const { values } = parseArgs({ options: { worktree: { type: "string" }, body: { type: "string" }, runs: { type: "string" }, ticket: { type: "string" }, rulings: { type: "string" }, base: { type: "string" }, receipt: { type: "string", multiple: true }, audit: { type: "string" }, matrix: { type: "string" }, member: { type: "string", multiple: true }, prd: { type: "string", multiple: true }, plan: { type: "string", multiple: true }, review: { type: "string" }, title: { type: "string" }, "visual-qa": { type: "string" } } });
  if (!values.worktree || !values.body || !values.runs || !values.base || !values.receipt?.length) throw new Error("Usage: handoff-gate.mjs --worktree <wt> --base <current base ref> --body <file> --runs <file> --receipt <reviewer.json> (repeat for each role) [--ticket <file> --audit <file> --matrix <file> [--member <slug>=<file> ...] [--prd <slug>=<file> ...] [--plan <slug>=<file> ...] [--review <review.json>] [--title <PR title>]] [--rulings <program rulings file>] [--visual-qa <findings.json for this head>]");
  values.receipts = values.receipt;
  values.visualQa = values["visual-qa"];
  values.members = values.member ?? [];
  values.prds = values.prd ?? [];
  values.plans = values.plan ?? [];
  if ((values.prds.length || values.plans.length || values.review) && !values.ticket) throw new Error("--prd, --plan and --review need --ticket, --audit and --matrix: the unit review runs inside the criteria audit");
  if (values.members.length && !values.ticket) throw new Error("--member needs --ticket, --audit and --matrix: member criteria are audited with the session's own ticket");
  process.stdout.write(`${JSON.stringify(recordHandoffGate(values))}\n`);
}
