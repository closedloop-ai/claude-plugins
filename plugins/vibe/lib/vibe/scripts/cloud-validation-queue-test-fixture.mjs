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
