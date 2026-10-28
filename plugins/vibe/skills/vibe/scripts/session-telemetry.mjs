// Measured cost kept in the vibe session record's `telemetry` object (WS0 M4).
// A measure nothing has recorded is null, never 0 and never an estimate: zero
// launches and "launches were never counted" are different answers. Writers:
//   - hooks/post-tool-use.mjs         worker launches (Claude Code Agent calls)
//   - e2e-lock.mjs                    heavy-slot wait, once the stack is acquired
//   - vibe-sessions.mjs telemetry     tokens (Claude transcripts), wall time, environment minutes
// Codex worker sessions have no verified source here, so their measures stay null.

import { readSessionRecord, writeSessionRecord } from "./session-record.mjs";

export const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];

/** The telemetry of a session nothing has measured yet. */
export function emptyTelemetry() {
  return {
    workerLaunches: null, workers: null, firstLaunchAt: null, lastLaunchAt: null,
    tokens: null, tokenSource: null,
    wallTimeMs: null, environmentMinutes: null,
    slotWaitMs: null, slotAcquisitions: null,
    updatedAt: null,
  };
}

/** Reads a stored telemetry value, keeping only valid measures; older records without one read as all null. */
export function telemetryWithDefaults(stored) {
  const base = emptyTelemetry();
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return base;
  for (const field of ["workerLaunches", "slotAcquisitions"]) base[field] = count(stored[field]);
  for (const field of ["wallTimeMs", "environmentMinutes", "slotWaitMs"]) base[field] = measure(stored[field]);
  if (stored.workers && typeof stored.workers === "object" && !Array.isArray(stored.workers)) {
    base.workers = Object.fromEntries(Object.entries(stored.workers).filter(([, value]) => count(value) !== null));
  }
  if (stored.tokens && typeof stored.tokens === "object") {
    const tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, count(stored.tokens[field])]));
    base.tokens = TOKEN_FIELDS.some((field) => tokens[field] !== null) ? tokens : null;
  }
  for (const field of ["tokenSource", "firstLaunchAt", "lastLaunchAt", "updatedAt"]) {
    base[field] = typeof stored[field] === "string" ? stored[field] : null;
  }
  return base;
}

/** One worker launch; `worker` is the subagent type, or null when the call did not name one. */
export function withLaunch(stored, { worker = null, at = new Date().toISOString() } = {}) {
  const next = telemetryWithDefaults(stored);
  next.workerLaunches = (next.workerLaunches ?? 0) + 1;
  if (typeof worker === "string" && worker.trim()) {
    next.workers = { ...(next.workers ?? {}), [worker]: (next.workers?.[worker] ?? 0) + 1 };
  }
  next.firstLaunchAt ??= at;
  next.lastLaunchAt = at;
  next.updatedAt = at;
  return next;
}

/** Adds one acquired heavy-slot wait. */
export function withSlotWait(stored, waitedMs, at = new Date().toISOString()) {
  const next = telemetryWithDefaults(stored);
  next.slotWaitMs = (next.slotWaitMs ?? 0) + required(waitedMs, "slotWaitMs");
  next.slotAcquisitions = (next.slotAcquisitions ?? 0) + 1;
  next.updatedAt = at;
  return next;
}

/** Replaces the token totals with a fresh transcript parse, so re-running it never double counts. */
export function withTokens(stored, tokens, source, at = new Date().toISOString()) {
  const next = telemetryWithDefaults(stored);
  next.tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, required(tokens?.[field], `tokens.${field}`)]));
  next.tokenSource = source;
  next.updatedAt = at;
  return next;
}

/** Sets the session's wall time, or adds environment minutes (a session can request several environments). */
export function withMeasures(stored, { wallTimeMs, environmentMinutes }, at = new Date().toISOString()) {
  const next = telemetryWithDefaults(stored);
  if (wallTimeMs !== undefined) next.wallTimeMs = required(wallTimeMs, "wallTimeMs");
  if (environmentMinutes !== undefined) next.environmentMinutes = (next.environmentMinutes ?? 0) + required(environmentMinutes, "environmentMinutes");
  next.updatedAt = at;
  return next;
}

/**
 * Applies `change(telemetry)` to the session record in `worktree` and returns the
 * new telemetry, or null when the worktree has no vibe session record. The record
 * is re-read here and every other field is written back unchanged.
 */
export function updateSessionTelemetry(worktree, change) {
  const record = readSessionRecord(worktree);
  if (!record) return null;
  const telemetry = change(record.telemetry);
  writeSessionRecord(worktree, { ...record, telemetry });
  return telemetry;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function measure(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function required(value, name) {
  if (measure(value) === null) throw new Error(`${name} must be a non-negative finite number, got ${JSON.stringify(value)}.`);
  return value;
}
