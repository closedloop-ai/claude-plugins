import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { regularJson } from "./owned-state.mjs";

/** The one account queue a test home holds. */
export function queueFile(home) {
  const queues = path.join(home, ".codex", "vibe", "cloud", "validation-queues");
  const dirs = readdirSync(queues);
  assert.equal(dirs.length, 1, "one account queue");
  return path.join(queues, dirs[0], "queue.json");
}

/** That queue's current state. */
export const queueState = (home) => regularJson(queueFile(home));

/** A routine service whose every read fails. */
export const unreadableProvider = (action) => { throw new Error(`RemoteTrigger ${action} failed: HTTP 500`); };

/** A routine service whose reads succeed and show only another launch's run and launch marker. */
export const markerlessProvider = (action) => action === "list_runs" ? { data: [{ id: "run-other", session_id: "cse_other", status: "completed" }] }
  : { log: "[2026-11-25T00:01:00Z] assistant: VIBE_VALIDATION_LAUNCH another-launch" };
