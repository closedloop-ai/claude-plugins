import assert from "node:assert/strict";
import test from "node:test";
import { emptyTelemetry, telemetryWithDefaults, withLaunch, withMeasures, withSlotWait, withTokens } from "./session-telemetry.mjs";

const AT = "2026-10-28T10:00:00.000Z";

test("a session nothing has measured reads as null, never zero", () => {
  assert.deepEqual(telemetryWithDefaults(undefined), emptyTelemetry());
  assert.deepEqual(telemetryWithDefaults("junk"), emptyTelemetry());
  const empty = emptyTelemetry();
  for (const [field, value] of Object.entries(empty)) assert.equal(value, null, field);
});

test("stored values that are not valid measures read as null", () => {
  const read = telemetryWithDefaults({
    workerLaunches: -1, slotAcquisitions: 1.5, wallTimeMs: "12", environmentMinutes: Number.NaN, slotWaitMs: 40,
    workers: { good: 2, bad: -3 }, tokens: { input: "x", output: null },
  });
  assert.equal(read.workerLaunches, null);
  assert.equal(read.slotAcquisitions, null);
  assert.equal(read.wallTimeMs, null);
  assert.equal(read.environmentMinutes, null);
  assert.equal(read.slotWaitMs, 40);
  assert.deepEqual(read.workers, { good: 2 });
  assert.equal(read.tokens, null);
});

test("launches count per worker and keep the first and last time", () => {
  let telemetry = withLaunch(undefined, { worker: "vibe:vibe-change-worker", at: AT });
  telemetry = withLaunch(telemetry, { worker: "vibe:vibe-change-worker", at: "2026-10-28T10:05:00.000Z" });
  telemetry = withLaunch(telemetry, { at: "2026-10-28T10:06:00.000Z" });
  assert.equal(telemetry.workerLaunches, 3);
  assert.deepEqual(telemetry.workers, { "vibe:vibe-change-worker": 2 });
  assert.equal(telemetry.firstLaunchAt, AT);
  assert.equal(telemetry.lastLaunchAt, "2026-10-28T10:06:00.000Z");
  assert.equal(telemetry.tokens, null, "a launch measures nothing else");
});

test("slot waits add up and count acquisitions; a bad wait is refused", () => {
  let telemetry = withSlotWait(undefined, 1500, AT);
  telemetry = withSlotWait(telemetry, 0, AT);
  assert.equal(telemetry.slotWaitMs, 1500);
  assert.equal(telemetry.slotAcquisitions, 2);
  assert.throws(() => withSlotWait(telemetry, -1), /slotWaitMs/);
  assert.throws(() => withSlotWait(telemetry, Number.NaN), /slotWaitMs/);
});

test("tokens replace the totals so a rerun does not double count, and need all four numbers", () => {
  const tokens = { input: 10, output: 5, cacheRead: 100, cacheWrite: 7 };
  const once = withTokens(undefined, tokens, "claude-transcript", AT);
  const twice = withTokens(once, tokens, "claude-transcript", AT);
  assert.deepEqual(twice.tokens, tokens);
  assert.equal(twice.tokenSource, "claude-transcript");
  assert.throws(() => withTokens(undefined, { input: 1 }, "claude-transcript"), /tokens\.output/);
});

test("wall time is replaced and environment minutes add; unset measures stay as they were", () => {
  let telemetry = withMeasures(undefined, { environmentMinutes: 12.5 }, AT);
  assert.equal(telemetry.wallTimeMs, null);
  telemetry = withMeasures(telemetry, { wallTimeMs: 9000, environmentMinutes: 7.5 }, AT);
  telemetry = withMeasures(telemetry, { wallTimeMs: 12000 }, AT);
  assert.equal(telemetry.wallTimeMs, 12000);
  assert.equal(telemetry.environmentMinutes, 20);
  assert.throws(() => withMeasures(telemetry, { wallTimeMs: Number.NaN }), /wallTimeMs/);
});
