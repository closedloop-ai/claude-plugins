#!/usr/bin/env node
// A pull request may open only for the exact source that passed the final
// pull-request inventory, including its body and verifier run evidence.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sameSource, sourceIdentity } from "../../vibe/scripts/tested-head.mjs";
import { evidenceFingerprint } from "./handoff-evidence.mjs";
import { reviewReceiptProblems } from "./review-receipts.mjs";

const GATE_FILE = "vibe-handoff-gate.json";
const EVIDENCE_KEYS = Object.freeze(["body", "runs", "ticket", "audit", "matrix"]);

function readReviewReceipts(files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  return files.map(file => JSON.parse(readFileSync(evidenceFingerprint(file).path, "utf8")));
}

function git(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Resolve an explicit base or the fetched origin default, rejecting the feature branch and HEAD. */
export function resolvePrBase(worktree, base) {
  const branch = git(worktree, ["branch", "--show-current"]);
  let name = base;
  if (!name) {
    const symbolic = git(worktree, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    name = symbolic.replace(/^refs\/remotes\/origin\//, "");
  }
  if (typeof name !== "string" || !/^[A-Za-z0-9._/-]+$/.test(name) || name === "HEAD" || name.startsWith("-") || name.startsWith("refs/") || name.includes("..")) {
    throw new Error("name the fetched default or explicit PR base branch");
  }
  const branchName = name.replace(/^origin\//, "");
  if (branchName === branch) throw new Error("the PR base cannot be the current feature branch");
  const ref = `refs/remotes/origin/${branchName}`;
  return { name: branchName, ref, oid: git(worktree, ["rev-parse", "--verify", `${ref}^{commit}`]) };
}

/** Private witness path belonging to the exact worktree, not the repository. */
export function gatePath(worktree) {
  const gitDir = execFileSync("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  return path.join(gitDir, GATE_FILE);
}

/** Current gate problem, or null when the final inventory covered this source. */
export function handoffGateProblem(worktree, { base, bodyFile } = {}) {
  let record;
  try {
    const file = gatePath(worktree);
    if (!existsSync(file)) return "handoff gate has not passed";
    record = JSON.parse(readFileSync(file, "utf8"));
    const branch = execFileSync("git", ["-C", worktree, "branch", "--show-current"], { encoding: "utf8" }).trim();
    if (record.branch !== branch || !record.inventoryPassed || !record.prBodyPassed || !record.prEvidencePassed || !record.reviewPassed) {
      return "handoff gate has no passing pull-request inventory for this branch";
    }
    if (!sameSource(record.source, sourceIdentity(worktree))) return "handoff gate is stale for the current source";
    if (base && base.replace(/^origin\//, "") !== record.base?.name) return "PR base does not match the handoff gate";
    const currentBase = resolvePrBase(worktree, base);
    if (record.base?.name !== currentBase.name || record.base?.oid !== currentBase.oid) return "handoff gate is stale for the PR base";
    if (!bodyFile || realpathSync(bodyFile) !== record.evidence?.body?.path) return "PR body file does not match the handoff gate";
    for (const key of EVIDENCE_KEYS) {
      const saved = record.evidence?.[key];
      if (saved && JSON.stringify(evidenceFingerprint(saved.path)) !== JSON.stringify(saved)) return `handoff ${key} evidence changed`;
    }
    if (!Array.isArray(record.receipts) || record.receipts.some(saved => JSON.stringify(evidenceFingerprint(saved.path)) !== JSON.stringify(saved))) return "handoff review receipt changed";
    if (reviewReceiptProblems(readReviewReceipts(record.receipts.map(item => item.path)), sourceIdentity(worktree)).problems.length) return "handoff review evidence is stale or incomplete";
    return null;
  } catch {
    return "handoff gate could not verify the current source";
  }
}

/** Git's merge engine checks the current base without changing the worktree. */
export function mergeabilityProblem(worktree, base) {
  let resolved;
  try { resolved = resolvePrBase(worktree, base); }
  catch (error) { return error.message; }
  const result = spawnSync("git", ["-C", worktree, "merge-tree", "--write-tree", resolved.ref, "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) return `branch does not merge cleanly with ${resolved.name}: ${result.stderr || result.stdout}`;
  return null;
}

/** A current blocking review finding must be fixed and independently rechecked. */
export function reviewFindingProblems(report, source) {
  if (!Array.isArray(report?.findings) || !sameSource(report.source ?? {}, source)) {
    return ["review findings report must cover the current source and list findings"];
  }
  return report.findings.flatMap((finding, index) => {
    if (finding?.blocking !== true) return [];
    return [`blocking review finding ${finding?.id ?? index + 1} remains on the current source`];
  });
}

/** Run the canonical inventory with PR body and verifier evidence before recording readiness. */
export function recordHandoffGate({ worktree, body, runs, ticket, base, receipts, audit, matrix }, { runScript = spawnSync } = {}) {
  const witness = gatePath(worktree);
  if (existsSync(witness)) unlinkSync(witness);
  const mergeProblem = mergeabilityProblem(worktree, base);
  if (mergeProblem) throw new Error(mergeProblem);
  const source = sourceIdentity(worktree);
  const verified = reviewReceiptProblems(readReviewReceipts(receipts), source);
  const reviewProblems = [...verified.problems, ...reviewFindingProblems({ source, findings: verified.findings }, source)];
  if (reviewProblems.length) throw new Error(reviewProblems.join("; "));
  if (ticket && (!audit || !matrix)) throw new Error("criteria audit and matrix are required with a ticket");
  if (ticket) {
    const criteria = runScript(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "criteria-audit.mjs"),
      "--ticket", ticket, "--audit", audit, "--matrix", matrix], { encoding: "utf8" });
    if (criteria.status !== 0) throw new Error(`acceptance criteria audit failed: ${criteria.stdout || criteria.stderr}`);
  }
  const args = [path.join(path.dirname(fileURLToPath(import.meta.url)), "handoff-inventory.mjs"),
    "--worktree", worktree, "--phase", "pull-request", "--body", body, "--runs", runs,
    "--commit", execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ...(ticket ? ["--ticket", ticket] : [])];
  const result = runScript(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`pull-request inventory failed: ${result.stderr || result.stdout}`);
  const inventory = JSON.parse(result.stdout);
  if (!inventory.ok || !inventory.blocking?.prBody || !inventory.blocking?.prEvidence) {
    throw new Error("pull-request inventory did not pass body and verifier evidence checks");
  }
  const branch = execFileSync("git", ["-C", worktree, "branch", "--show-current"], { encoding: "utf8" }).trim();
  if (!sameSource(source, sourceIdentity(worktree))) throw new Error("source changed while the handoff gate ran");
  const evidenceInputs = { body, runs, ticket, audit, matrix };
  const evidence = Object.fromEntries(EVIDENCE_KEYS.filter(key => evidenceInputs[key]).map(key => [key, evidenceFingerprint(evidenceInputs[key])]));
  const boundReceipts = receipts.map(evidenceFingerprint);
  const resolvedBase = resolvePrBase(worktree, base);
  writeFileSync(witness, `${JSON.stringify({ branch, source, base: resolvedBase, evidence, receipts: boundReceipts, inventoryPassed: true, prBodyPassed: true, prEvidencePassed: true, reviewPassed: true })}\n`, { mode: 0o600 });
  return { branch, source };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { worktree: { type: "string" }, body: { type: "string" }, runs: { type: "string" }, ticket: { type: "string" }, base: { type: "string" }, receipt: { type: "string", multiple: true }, audit: { type: "string" }, matrix: { type: "string" } } });
  if (!values.worktree || !values.body || !values.runs || !values.base || !values.receipt?.length) throw new Error("Usage: handoff-gate.mjs --worktree <wt> --base <current base ref> --body <file> --runs <file> --receipt <reviewer.json> (repeat for each role) [--ticket <file> --audit <file> --matrix <file>]");
  values.receipts = values.receipt;
  process.stdout.write(`${JSON.stringify(recordHandoffGate(values))}\n`);
}
