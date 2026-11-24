/** Fleet ledger and the unique helper name for one independent review. */
interface ReviewOwner { orchDir: string; helper: string }

/** The canonical definition and input files bound to the read-only thread. */
interface LaunchReview extends ReviewOwner {
  worktree: string;
  role: string;
  agentDefinition?: string;
  model: string;
  capabilities: string;
  brief: string;
}

export function runManagedReviewer(input: LaunchReview): Promise<{ threadId: string; report: string; deliverable: string } | { threadId: string; visualQa: string }>;
export function acceptManagedReviewer(input: ReviewOwner & { report: string }): Promise<{ threadId: string; receipt: string }>;
