/**
 * The cloud receipt shapes cloud-worker.mjs writes and cloud-routines.mjs reads: the end states a run can reach
 * and the receipt file names in a worktree's Git metadata. One owner, so a new state or name reaches both.
 */

/** A run in one of these states never runs again; its routine may be removed. */
export const TERMINAL = new Set(["completed", "failed", "canceled", "cancelled", "abandoned"]);

/** A dispatch receipt's file name for one ticket. */
export function dispatchReceiptName(ticket) { return `cloud-worker-${ticket.toLowerCase()}.json`; }

/** A validation receipt's file name for one commit and request digest. */
export function validationReceiptName(commit, digest) { return `cloud-validate-${commit.slice(0, 12)}-${digest.slice(0, 12)}.json`; }

/** Either receipt name. */
export const RECEIPT_NAME = /^cloud-(?:worker-.+|validate-[0-9a-f]{12}-[0-9a-f]{12})\.json$/;

/** The name older vibe versions gave a receipt's routine: `validate <sha12>` or `<TICKET> cloud worker`. */
export function legacyRoutineName(file) {
  const validate = /^cloud-validate-([0-9a-f]{12})-/.exec(file);
  if (validate) return `validate ${validate[1]}`;
  const dispatch = /^cloud-worker-(.+)\.json$/.exec(file);
  return dispatch ? `${dispatch[1].toUpperCase()} cloud worker` : null;
}
