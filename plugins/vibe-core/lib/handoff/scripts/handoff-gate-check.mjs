// The read side of the handoff gate: whether the exact source that passed the
// final pull-request inventory, with its body and verifier run evidence, is
// still what a pull request would open. The PR-create guard and the cloud
// worker read it; vibe's handoff-gate.mjs records the witness.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { sameSource, sourceIdentity } from "../../vibe/scripts/tested-head.mjs";
import { evidenceFingerprint } from "./handoff-evidence.mjs";
import { reviewReceiptProblems } from "./review-receipts.mjs";

const GATE_FILE = "vibe-handoff-gate.json";
export const EVIDENCE_KEYS = Object.freeze(["body", "runs", "ticket", "audit", "matrix"]);

/** The parsed review receipts the given files fingerprint. */
export function readReviewReceipts(files) {
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
    if (currentBase.name !== "main") {
      const currentMain = resolvePrBase(worktree, "main");
      if (record.main?.oid !== currentMain.oid) return "handoff gate is stale for current main";
    }
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

/** Resolve both refs once so the merge check and its witness use the same immutable commits. */
export function mergeTargets(worktree, base) {
  const resolvedBase = resolvePrBase(worktree, base);
  const resolvedMain = resolvedBase.name === "main" ? null : resolvePrBase(worktree, "main");
  return { base: resolvedBase, main: resolvedMain };
}

/** Git's merge engine checks exact commits, never mutable remote ref names. */
export function checkedMergeProblem(worktree, targets) {
  const selected = [targets.base, ...(targets.main ? [targets.main] : [])];
  for (const target of selected) {
    const result = spawnSync("git", ["-C", worktree, "merge-tree", "--write-tree", target.oid, "HEAD"], { encoding: "utf8" });
    if (result.status !== 0) return `branch does not merge cleanly with ${target.name}: ${result.stderr || result.stdout}`;
  }
  return null;
}

/** A read-only preflight; publication uses recordHandoffGate, which fetches main first. */
export function mergeabilityProblem(worktree, base) {
  try { return checkedMergeProblem(worktree, mergeTargets(worktree, base)); }
  catch (error) { return `current base or main cannot be verified: ${error.message}`; }
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
