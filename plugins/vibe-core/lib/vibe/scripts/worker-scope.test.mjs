import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { launcherWorker, recordWorkerScope } from "./worker-scope.mjs";

test("a launcher record marks only its own session, for 7 days, and old records are swept", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "vibe-worker-scope-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = recordWorkerScope("old-worker", "/w", home, new Date("2026-01-01T00:00:00Z"));
  utimesSync(old, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  recordWorkerScope("worker-1", "/w", home);
  assert.equal(launcherWorker("worker-1", home), true);
  assert.equal(launcherWorker("worker-2", home), false, "another session cannot borrow it");
  assert.equal(launcherWorker("worker-1", home, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)), false);
  assert.deepEqual(readdirSync(path.join(home, ".vibe-hook-scope", "workers")), ["worker-1.json"]);
  assert.throws(() => recordWorkerScope("../escape", "/w", home), /unusable worker session id/);
});
