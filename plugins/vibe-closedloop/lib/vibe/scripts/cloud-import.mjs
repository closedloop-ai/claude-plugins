// The receiving half of a cloud dispatch (cloud-worker.mjs): bring a completed result into the Vibe worktree (by
// `import`, or by git with `import-from-git`), complete a receipt from its verified cloud commit when poll could not
// (`complete-from-commit`), and hold PR progression until the import witness, handoff gate and independent review
// match. cloud-worker.mjs re-exports every entry point here and owns the CLI.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readSessionRecord } from "./session-record.mjs";
import { gatePath, handoffGateProblem } from "../../handoff/scripts/handoff-gate-check.mjs";
import { decisionTableProblems } from "../../handoff/scripts/decision-table-gate.mjs";
import { verifiedReviewModel } from "../../handoff/scripts/review-receipts.mjs";
import { FABLE_REVIEW_MODELS } from "./review-models.mjs";
import { sameSource, sourceIdentity, validSourceIdentity } from "./tested-head.mjs";
import { COMMAND_MS, evidencePath, firstLine, git, gitDir, hydrateCloudRequest, importWitnessPath, readReceipt, receiptPath, requestDigest, requireVibeSession,
  runCodex, runCommand, saveReceipt, sha256, verifyAuthor, verifyRepository } from "./cloud-worker.mjs";

function requireClean(worktree) {
  if (git(worktree, ["status", "--porcelain"])) throw new Error("Vibe worktree must be clean before cloud import");
}

/** Import only the cloud delta as local uncommitted changes for Vibe's normal commit and gate. */
export function importResult(request, receipt, { run = runCommand, gitRead = git } = {}) {
  const record = requireVibeSession(request.worktree, request.ticket);
  request = hydrateCloudRequest(request, { requireCurrentSource: false });
  verifyRepository(request.worktree, request.repository);
  if (receipt.status !== "completed" || receipt.provider !== request.provider) throw new Error("completed matching cloud task receipt is required");
  const saved = JSON.parse(readFileSync(receiptPath(request.worktree, request.ticket), "utf8"));
  if (!isDeepStrictEqual(saved, receipt) || receipt.requestDigest !== requestDigest(request) || !/^[a-f0-9]{64}$/.test(receipt.requestDigest ?? "")) throw new Error("cloud import requires the exact completed dispatch receipt");
  if (existsSync(importWitnessPath(request.worktree))) throw new Error("cloud result was already imported into this Vibe session");
  requireClean(request.worktree);
  let result;
  if (request.provider === "claude") {
    const branch = verifiedCloudBranch(request, receipt, record, { run, gitRead });
    result = { commit: branch.tip, diffSha256: sha256(branch.patch) };
    const applied = spawnSync("git", ["-C", request.worktree, "apply", "--index", "-"], { cwd: request.worktree, input: branch.patch, encoding: "utf8", timeout: COMMAND_MS, maxBuffer: 8 * 1024 * 1024 });
    if (applied.status !== 0) throw new Error(`Claude cloud diff did not apply: ${firstLine(applied.stderr || applied.error?.message)}`);
  } else {
    const diff = runCodex(["cloud", "diff", receipt.taskId], { run, cwd: request.worktree });
    if (diff.status !== 0 || !diff.stdout.trim()) throw new Error("Codex cloud returned no diff");
    result = { diffSha256: sha256(diff.stdout) };
    const applied = runCodex(["cloud", "apply", receipt.taskId], { run, cwd: request.worktree });
    if (applied.status !== 0) throw new Error(`Codex cloud apply failed: ${firstLine(applied.stderr || applied.error?.message)}`);
  }
  writeImportWitness(request, receipt, result);
  return importedResult(request, gitRead);
}

/** Write the witness the PR guard reads for an imported cloud result; `extra` says how it was brought in when not by `import`. */
function writeImportWitness(request, receipt, result, extra = {}) {
  const witness = {
    schema: "vibe.cloud-import/1", ticket: request.ticket, provider: request.provider, taskId: receipt.taskId,
    runId: receipt.runId ?? null, sessionId: receipt.sessionId ?? null, requestDigest: receipt.requestDigest,
    receiptSha256: sha256(readFileSync(receiptPath(request.worktree, request.ticket))), result,
    importedSource: sourceIdentity(request.worktree), importedAt: new Date().toISOString(), ...extra,
  };
  writeFileSync(importWitnessPath(request.worktree), `${JSON.stringify(witness, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

/** What an import reports: the changed files, the witness and the handoff step that comes next. */
function importedResult(request, gitRead) {
  const tableProblems = decisionTableProblems(request.worktree);
  return { provider: request.provider, worktree: request.worktree, changed: gitRead(request.worktree, ["status", "--short"]), witness: importWitnessPath(request.worktree),
    handoff: { decisionTableCurrent: tableProblems.length === 0, decisionTableProblems: tableProblems },
    next: tableProblems.length ? "Reconcile the session decision table against the imported code before handoff."
      : "Run Vibe handoff, the independent review (Codex or Fable 5.2 for a Claude import, Claude for a Codex import) and full local lanes before ready or PR." };
}

/**
 * The Claude cloud branch, fetched and checked as `import` checks it: from `base` (the merge base with HEAD when not
 * given), its commits stay within the one-commit-per-turn bound and each is the operator's. Returns the branch tip and
 * the binary diff from `base` to it.
 */
function verifiedCloudBranch(request, receipt, record, { run, gitRead, base = null, baseFrom = "HEAD" }) {
  const ref = `refs/remotes/origin/${request.branch}`;
  const fetched = run("git", ["-C", request.worktree, "fetch", "origin", `refs/heads/${request.branch}:${ref}`], { cwd: request.worktree, timeout: COMMAND_MS });
  if (fetched.status !== 0) throw new Error(`cloud branch fetch failed: ${firstLine(fetched.stderr || fetched.error?.message)}`);
  const from = base ?? gitRead(request.worktree, ["merge-base", baseFrom, ref]);
  const commits = gitRead(request.worktree, ["rev-list", "--reverse", `${from}..${ref}`]).split("\n").filter(Boolean);
  if (commits.length < 1 || commits.length > 1 + (receipt.followups ?? 0)) throw new Error(`Claude cloud branch has ${commits.length} commits, outside the one-commit-per-turn bound`);
  for (const commit of commits) verifyAuthor(request.worktree, commit, record.operator, { gitRead });
  const patch = run("git", ["-C", request.worktree, "diff", "--binary", from, ref], { cwd: request.worktree, timeout: COMMAND_MS });
  if (patch.status !== 0 || !patch.stdout) throw new Error("Claude cloud branch has no readable diff");
  return { base: from, tip: gitRead(request.worktree, ["rev-parse", ref]), patch: patch.stdout };
}

/** The local HEAD recorded with the request's cloud evidence, before dispatch: a merge base taken with it stays put when the result is brought in. */
function dispatchHead(request) {
  return JSON.parse(readFileSync(evidencePath(request.worktree, request.evidenceSha256), "utf8")).source.head;
}

/** A state change asked for without --confirm: what it would do, changing nothing; the CLI exits non-zero on it. */
export function unconfirmed(action, plan) {
  return { confirmRequired: true, action, changed: false, wouldChange: plan, next: `rerun ${action} with --confirm to make this change` };
}

// A receipt whose task may have finished without poll seeing it: no recorded status (the poll stopped on this machine),
// still running, overdue, or abandoned by a probe.
const COMPLETABLE = new Set([undefined, "pending", "queued", "running", "in_progress", "overdue", "abandoned"]);

/**
 * Mark a Claude cloud receipt completed from its commit when poll could not: the cloud branch's tip is exactly
 * `commit`, its commits pass import's bound and author checks, and the receipt belongs to this request.
 */
export function completeFromCommit(request, { commit, confirm = false, run = runCommand, gitRead = git, now = Date.now } = {}) {
  const record = requireVibeSession(request.worktree, request.ticket);
  request = hydrateCloudRequest(request, { requireCurrentSource: false });
  verifyRepository(request.worktree, request.repository);
  if (request.provider !== "claude") throw new Error("complete-from-commit reads a Claude cloud branch; a Codex task completes through poll");
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("--commit <the full 40-character commit SHA> is required");
  const receipt = readReceipt(request.worktree, request.ticket);
  if (receipt.requestDigest !== requestDigest(request) || receipt.provider !== request.provider) throw new Error("cloud receipt belongs to another request");
  if (!COMPLETABLE.has(receipt.status)) throw new Error(`cloud receipt is ${receipt.status}; only a running, overdue or abandoned receipt completes from its commit`);
  if (existsSync(importWitnessPath(request.worktree))) throw new Error("cloud result was already imported into this Vibe session");
  const branch = verifiedCloudBranch(request, receipt, record, { run, gitRead, baseFrom: dispatchHead(request) });
  if (branch.tip !== commit) throw new Error(`cloud branch ${request.branch} is at ${branch.tip}, not ${commit}; complete from the commit the branch holds`);
  const completed = { ...receipt, status: "completed", finishedAt: new Date(now()).toISOString(),
    completedFrom: { commit, branch: request.branch, base: branch.base, priorStatus: receipt.status ?? null } };
  if (!confirm) return unconfirmed("complete-from-commit", { receipt: receiptPath(request.worktree, request.ticket), from: receipt.status ?? null, to: "completed", completedFrom: completed.completedFrom });
  saveReceipt(request.worktree, request.ticket, completed);
  return completed;
}

/**
 * Record a completed Claude result the writer already brought in by git: the worktree's diff from the base equals
 * `commit`'s diff from it, and `commit` is the verified cloud branch tip. Writes the witness `import` writes.
 */
export function importFromGit(request, receipt, { commit, confirm = false, run = runCommand, gitRead = git } = {}) {
  const record = requireVibeSession(request.worktree, request.ticket);
  request = hydrateCloudRequest(request, { requireCurrentSource: false });
  verifyRepository(request.worktree, request.repository);
  if (request.provider !== "claude") throw new Error("import-from-git reads a Claude cloud branch; a Codex result imports through import");
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("--commit <the full 40-character commit SHA> is required");
  if (receipt.requestDigest !== requestDigest(request) || receipt.provider !== request.provider) throw new Error("cloud receipt belongs to another request");
  if (receipt.status !== "completed") throw new Error(`cloud receipt is ${receipt.status ?? "still running"}; record the completion first (poll, or complete-from-commit --commit ${commit})`);
  if (existsSync(importWitnessPath(request.worktree))) throw new Error("cloud result was already imported into this Vibe session");
  // The base the commit's diff is read from: the one complete-from-commit recorded, else the merge base with the
  // dispatch-time HEAD, which bringing the commit in by git does not move.
  const branch = verifiedCloudBranch(request, receipt, record, { run, gitRead, base: receipt.completedFrom?.base ?? null, baseFrom: dispatchHead(request) });
  const base = branch.base;
  if (branch.tip !== commit) throw new Error(`cloud branch ${request.branch} is at ${branch.tip}, not ${commit}`);
  const local = run("git", ["-C", request.worktree, "diff", "--binary", base], { cwd: request.worktree, timeout: COMMAND_MS });
  if (local.status !== 0) throw new Error(`worktree diff failed: ${firstLine(local.stderr || local.error?.message)}`);
  if (sha256(local.stdout) !== sha256(branch.patch)) throw new Error(`the worktree's diff from ${base} is not ${commit}'s diff; bring in exactly that commit (staged or committed) and nothing else`);
  const result = { commit, diffSha256: sha256(branch.patch) };
  if (!confirm) return unconfirmed("import-from-git", { witness: importWitnessPath(request.worktree), base, result });
  writeImportWitness(request, receipt, result, { importedBy: "git" });
  return importedResult(request, gitRead);
}

/** Each handoff review receipt's harness, the model its trace proves (null when unproven) and its session identities. */
function reviewRuntimes(worktree) {
  const handoff = JSON.parse(readFileSync(gatePath(worktree), "utf8"));
  return (handoff.receipts ?? []).map((item) => {
    const receipt = JSON.parse(readFileSync(item.path, "utf8"));
    return { runtime: receipt.runtime, model: verifiedReviewModel(receipt), identities: [receipt.sessionId, receipt.workerId].filter(Boolean) };
  });
}

/** Every identity the session's persistent writer has had, so its own review never counts as independent. */
function writerIdentities(worktree) {
  const file = path.join(gitDir(worktree), "vibe-writer.json");
  if (!existsSync(file)) return [];
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  return [ledger.workerId, ...(ledger.migrations ?? []).map((item) => item?.previous?.workerId)].filter(Boolean);
}

/**
 * A Claude import needs a Codex review or a review whose trace proves the Fable 5.2 model (operator ruling, 2026-11-11:
 * "Accept a Fable review instead"), neither from the session's writer; a Codex import still needs Claude.
 */
function independentReviewProblem(worktree, provider, reviews) {
  const found = reviews(worktree);
  if (provider !== "claude") return found.some((review) => review.runtime === "claude") ? null : "independent claude review is missing";
  const writer = new Set(writerIdentities(worktree));
  const accepted = found.some((review) => (review.runtime === "codex" || (review.runtime === "claude" && FABLE_REVIEW_MODELS.includes(review.model)))
    && !(review.identities ?? []).some((identity) => writer.has(identity)));
  return accepted ? null : `independent codex or Fable 5.2 (${FABLE_REVIEW_MODELS.join(" or ")}) review is missing`;
}
function importMatchesReceipt(witness, receipt, ticket, receiptBytes) {
  return receipt.status === "completed" && witness.schema === "vibe.cloud-import/1" && witness.ticket === ticket
    && witness.provider === receipt.provider && witness.taskId === receipt.taskId && witness.requestDigest === receipt.requestDigest
    && witness.runId === (receipt.runId ?? null) && witness.sessionId === (receipt.sessionId ?? null)
    && witness.receiptSha256 === sha256(receiptBytes) && /^[a-f0-9]{64}$/.test(witness.result?.diffSha256 ?? "")
    && (receipt.provider !== "claude" || /^[a-f0-9]{40}$/.test(witness.result?.commit ?? ""))
    && validSourceIdentity(witness.importedSource);
}

/** Bind the cloud import to the exact source that passed the existing local handoff gate. */
export function refreshImportWitness(worktree, { bodyFile, title, base = "main", gate = handoffGateProblem, reviews = reviewRuntimes } = {}) {
  const record = readSessionRecord(worktree);
  if (!record?.liveTicket) throw new Error("cloud import requires a Vibe ticket");
  requireVibeSession(worktree, record.liveTicket);
  const witness = JSON.parse(readFileSync(importWitnessPath(worktree), "utf8"));
  const receiptFile = receiptPath(worktree, record.liveTicket);
  const receiptBytes = readFileSync(receiptFile);
  const receipt = JSON.parse(receiptBytes);
  if (!importMatchesReceipt(witness, receipt, record.liveTicket, receiptBytes)) throw new Error("cloud import witness does not match the completed provider result");
  verifyAuthor(worktree, "HEAD", record.operator);
  const problem = gate(worktree, { base, bodyFile, title });
  if (problem) throw new Error(`cloud import cannot refresh: ${problem}`);
  const missing = independentReviewProblem(worktree, witness.provider, reviews);
  if (missing) throw new Error(`cloud import cannot refresh: ${missing}`);
  const updated = { ...witness, reviewedSource: sourceIdentity(worktree), handoffGateSha256: sha256(readFileSync(gatePath(worktree))), reviewedAt: new Date().toISOString() };
  writeFileSync(importWitnessPath(worktree), `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  return updated;
}

/** PR-hook admission for cloud work; ordinary Vibe sessions have no cloud receipt. */
export function cloudPrProblem(worktree, { base = "main", bodyFile, title, gate = handoffGateProblem, reviews = reviewRuntimes } = {}) {
  try {
    const record = readSessionRecord(worktree);
    const ticket = record?.liveTicket;
    if (!ticket) return existsSync(importWitnessPath(worktree)) || readdirSync(gitDir(worktree)).some((file) => /^cloud-worker-.+\.json$/.test(file)) ? "cloud result has no recorded Vibe ticket" : null;
    const receiptFile = receiptPath(worktree, ticket);
    const witnessFile = importWitnessPath(worktree);
    if (!existsSync(receiptFile) && !existsSync(witnessFile)) return null;
    requireVibeSession(worktree, ticket);
    if (!existsSync(receiptFile) || !existsSync(witnessFile)) return "completed cloud task has no imported source witness";
    const receiptBytes = readFileSync(receiptFile);
    const receipt = JSON.parse(receiptBytes);
    const witness = JSON.parse(readFileSync(witnessFile, "utf8"));
    if (!importMatchesReceipt(witness, receipt, ticket, receiptBytes)) return "cloud import witness does not match the completed provider result";
    if (!witness.reviewedSource || !sameSource(witness.reviewedSource, sourceIdentity(worktree))) return "cloud import witness is stale for the current source; refresh after handoff";
    if (witness.handoffGateSha256 !== sha256(readFileSync(gatePath(worktree)))) return "cloud import witness is stale for the handoff gate";
    verifyAuthor(worktree, "HEAD", record.operator);
    const problem = gate(worktree, { base, bodyFile, title });
    if (problem) return problem;
    return independentReviewProblem(worktree, receipt.provider, reviews);
  } catch (error) { return `cloud PR readiness could not be verified: ${firstLine(error?.message ?? error)}`; }
}

/** Refuse PR progression until author, independent review and final handoff evidence match. */
export function readyForPr(request, { bodyFile, title, gate = handoffGateProblem, reviews = reviewRuntimes, receiptReader = readReceipt } = {}) {
  const record = requireVibeSession(request.worktree, request.ticket);
  request = hydrateCloudRequest(request, { requireCurrentSource: false });
  verifyRepository(request.worktree, request.repository);
  const receipt = receiptReader(request.worktree, request.ticket);
  if (receipt.provider !== request.provider || receipt.requestDigest !== requestDigest(request) || receipt.status !== "completed") throw new Error("PR refused: completed matching cloud receipt is missing");
  const problem = cloudPrProblem(request.worktree, { base: "main", bodyFile, title, gate, reviews });
  if (problem) throw new Error(`PR refused: ${problem}`);
  return { ready: true, branch: record.branch };
}
