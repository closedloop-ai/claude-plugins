// A write under ~/.codex/vibe that Codex's default sandbox refused. The startup
// version check once swallowed that refusal (ISS-13315); the other vibe scripts
// that write there report it the same way, so the orchestrator reruns the same
// command escalated (one "Allow once") instead of reading a generic failure
// (ISS-13321). Codex sets CODEX_SANDBOX_NETWORK_DISABLED for every command of
// such a turn, escalated ones included, so the variable alone never decides it.

const REFUSED = new Set(["EPERM", "EACCES", "EROFS"]);
const REFUSED_TEXT = /\b(?:EPERM|EACCES|EROFS)\b|Operation not permitted|Permission denied|read-only file system/i;

/** Whether `error` is a write the Codex sandbox refused. */
export function isSandboxRefusal(error, env = process.env) {
  if (env.CODEX_SANDBOX_NETWORK_DISABLED !== "1") return false;
  return REFUSED.has(error?.code) || REFUSED_TEXT.test(String(error?.message ?? error ?? ""));
}

/** The fields a refused run prints, so the orchestrator reruns it escalated with this justification. */
export function escalation(error, justification) {
  return { escalate: true, justification, error: error instanceof Error ? error.message : String(error) };
}
