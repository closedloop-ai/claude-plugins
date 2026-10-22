/** Canonical compatibility read shared with the bundled worker launchers. */
export function sessionLiveTicket(record: { liveTicket?: string | null; handoffTicket?: string | null }): string | null;
/** Shared bounded Git operations; callers may bind a finite operation deadline. */
export function git(cwd: string, args: string[], options?: { timeout?: number }): string;
/** Canonical raw compatibility read; consumers validate the representation they use. */
export function readSessionRecord(worktree: string): unknown;
