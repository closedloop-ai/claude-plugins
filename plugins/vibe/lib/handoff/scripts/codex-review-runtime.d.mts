/** Fleet ledger and the unique helper name for one independent review. */
interface ReviewOwner { orchDir: string; helper: string }

/** The canonical definition and input files bound to the read-only thread. */
interface LaunchReview extends ReviewOwner {
  worktree: string;
  role: string;
  model: string;
  capabilities: string;
  brief: string;
}

export function runManagedReviewer(input: LaunchReview): Promise<{ threadId: string; report: string; deliverable: string }>;
export function acceptManagedReviewer(input: ReviewOwner & { report: string }): Promise<{ threadId: string; receipt: string }>;

/** Begin an independent QA guide and return its operator-resumable thread and durable state. */
export function launchQaGuide(input: ReviewOwner & {
  worktree: string; writerThread: string; model: string; brief: string;
}): Promise<{ threadId: string; turnId: string; stateFile: string }>;
