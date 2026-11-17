import { createHash } from "node:crypto";
import { qaImpactRequest, QaImpact } from "./qa-impact.mjs";
import { REVIEW_ROLES } from "../../../../vibe-core/lib/handoff/scripts/review-receipts.mjs";

const CLEAN_DIFF = createHash("sha256").digest("hex");

/** Roles whose earlier clean review remains valid for one recomputed delta. */
export function reusableRolesForImpact(impact) {
  if (impact.outcome === QaImpact.None) return new Set(REVIEW_ROLES);
  if (impact.outcome === QaImpact.LanesOnly) return new Set(["vibe-storybook-decomposer"]);
  return new Set();
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
        roles = reusableRolesForImpact(impact);
      } catch {
        roles = new Set();
      }
      byBoundary.set(receipt.source.head, roles);
    }
    if (roles.has(receipt.role)) reusable.add(receipt.role);
  }
  return reusable;
}
