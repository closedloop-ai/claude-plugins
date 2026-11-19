import { createHash } from "node:crypto";
import { normalizeImporters, qaImpactRequest, QaImpact } from "./qa-impact.mjs";
import { REVIEW_ROLES } from "../../../lib/handoff/scripts/review-receipts.mjs";

const CLEAN_DIFF = createHash("sha256").digest("hex");
const SOURCE_LIKE = /\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|css|scss|sass|less|html?)$/i;
const STORY_FILE = /\.stories\.[cm]?[jt]sx?$/i;

/** Roles whose earlier clean review remains valid for one recomputed delta. */
export function reusableRolesForImpact(impact, importers = null) {
  const files = Array.isArray(impact.changedFiles) ? impact.changedFiles : [];
  const storyReach = importerStoryReach(files, importers);
  if (impact.outcome === QaImpact.None) {
    const roles = new Set(REVIEW_ROLES);
    if (files.some((file) => SOURCE_LIKE.test(file))) roles.delete("vibe-guardrails-reviewer");
    if (!storyReach.complete || storyReach.reached) roles.delete("vibe-storybook-decomposer");
    return roles;
  }
  if (impact.outcome === QaImpact.LanesOnly && storyReach.complete && !storyReach.reached) return new Set(["vibe-storybook-decomposer"]);
  return new Set();
}

function importerStoryReach(files, importers) {
  if (files.some((file) => STORY_FILE.test(file))) return { complete: true, reached: true };
  const source = importers?.importers ?? importers?.files ?? importers;
  if (!Array.isArray(source)) return { complete: false, reached: false };
  const graph = normalizeImporters(importers);
  if (!graph) return { complete: false, reached: false };
  const queue = [...files];
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!graph.has(file) || !Array.isArray(graph.get(file))) return { complete: false, reached: false };
    for (const importer of graph.get(file)) {
      if (STORY_FILE.test(importer)) return { complete: true, reached: true };
      if (!seen.has(importer)) queue.push(importer);
    }
  }
  return { complete: true, reached: false };
}

/**
 * Recompute the delta from each clean reviewed commit. Dirty review baselines cannot be reconstructed,
 * so they are reusable only when the source identity still matches exactly in reviewReceiptProblems.
 */
export function reusableReviewRoles(worktree, receipts, request) {
  if (!request || !Array.isArray(receipts)) return new Set();
  const reusable = new Set();
  const byBoundary = new Map();
  for (const receipt of receipts) {
    if (receipt?.source?.diffSha256 !== CLEAN_DIFF || typeof receipt.source.head !== "string") continue;
    let roles = byBoundary.get(receipt.source.head);
    if (!roles) {
      try {
        const impact = qaImpactRequest(worktree, { ...request,
          lastQa: { ...(request.lastQa ?? {}), boundary: receipt.source.head } });
        roles = reusableRolesForImpact(impact, request.graphImporters ?? null);
      } catch {
        roles = new Set();
      }
      byBoundary.set(receipt.source.head, roles);
    }
    if (roles.has(receipt.role)) reusable.add(receipt.role);
  }
  return reusable;
}
