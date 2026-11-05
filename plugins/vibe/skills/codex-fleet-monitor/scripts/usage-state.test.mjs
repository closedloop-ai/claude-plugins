import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatUsageStatus,
  recordUsageReading,
  readUsageReadings,
  usageStatuses,
  usageWatchLines,
  USAGE_HISTORY_LIMIT,
  USAGE_READINGS_FILE,
} from "./usage-state.mjs";

const SCRIPT = fileURLToPath(new URL("./usage-state.mjs", import.meta.url));

const reading = (readAt, status = "ok", source = "snapshot") => ({
  runtime: "codex", machine: "local", source, status, readAt,
  line: status === "ok" ? "codex-usage local under80% ok" : "codex-usage local unreadable READFAIL",
});

test("stale readings are flagged and fresh readings are not", () => {
  const now = Date.parse("2026-11-03T18:00:00.000Z");
  const rows = usageStatuses([
    reading("2026-11-03T17:29:59.000Z"),
    { ...reading("2026-11-03T17:45:00.000Z"), machine: "remote" },
  ], { now, staleSeconds: 1800 });
  assert.equal(rows.find((row) => row.machine === "local").stale, true);
  assert.equal(rows.find((row) => row.machine === "remote").stale, false);
  assert.deepEqual(usageWatchLines(rows), ["usage codex local STALE last-good=2026-11-03T17:29:59.000Z"]);
});

test("READFAIL keeps the last good reading time visible and does not refresh its age", () => {
  const rows = usageStatuses([
    reading("2026-11-03T16:00:00.000Z", "ok", "supervisor"),
    reading("2026-11-03T17:59:50.000Z", "readfail", "snapshot"),
  ], { now: Date.parse("2026-11-03T18:00:00.000Z"), staleSeconds: 1800 });
  assert.equal(rows[0].lastGoodAt, "2026-11-03T16:00:00.000Z");
  assert.equal(rows[0].lastGoodAgeSeconds, 7200);
  assert.equal(rows[0].stale, true);
  assert.match(formatUsageStatus(rows[0]), /READFAIL read=2026-11-03T17:59:50\.000Z age=10s source=snapshot/);
  assert.match(formatUsageStatus(rows[0]), /last-good=2026-11-03T16:00:00\.000Z last-good-age=2h0m/);
});

test("each good and failed reading is persisted with its read time and source", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-usage-state-"));
  recordUsageReading(dir, reading("2026-11-03T16:00:00.000Z", "ok", "supervisor"));
  recordUsageReading(dir, reading("2026-11-03T16:01:00.000Z", "readfail", "snapshot"));
  assert.equal(readUsageReadings(dir).length, 2);
  const persisted = JSON.parse(readFileSync(path.join(dir, USAGE_READINGS_FILE), "utf8"));
  assert.deepEqual(persisted.entries["codex:local"].recent.map(({ readAt, source, status }) => ({ readAt, source, status })), [
    { readAt: "2026-11-03T16:00:00.000Z", source: "supervisor", status: "ok" },
    { readAt: "2026-11-03T16:01:00.000Z", source: "snapshot", status: "readfail" },
  ]);
});

test("a failure-only key remains valid when another runtime records a good reading", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-usage-no-good-"));
  recordUsageReading(dir, reading("2026-11-03T16:00:00.000Z", "readfail"));
  recordUsageReading(dir, {
    runtime: "claude", machine: "local", source: "snapshot", status: "ok",
    readAt: "2026-11-03T16:01:00.000Z", line: "claude-usage local session=under80% week=under80%",
  });
  const rows = usageStatuses(readUsageReadings(dir), { now: Date.parse("2026-11-03T16:02:00.000Z") });
  assert.equal(rows.find((row) => row.runtime === "codex").lastGoodAt, null);
  assert.equal(rows.find((row) => row.runtime === "claude").lastGoodAt, "2026-11-03T16:01:00.000Z");
});

test("compaction stays bounded and preserves latest, last good, and status rows", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-usage-bounded-"));
  const all = [reading("2026-11-03T12:00:00.000Z", "ok", "supervisor")];
  recordUsageReading(dir, all[0]);
  for (let index = 1; index <= USAGE_HISTORY_LIMIT + 150; index += 1) {
    const failed = reading(new Date(Date.parse("2026-11-03T12:00:00.000Z") + index * 60_000).toISOString(), "readfail", "snapshot");
    all.push(failed);
    recordUsageReading(dir, failed);
  }
  const options = { now: Date.parse("2026-11-03T18:00:00.000Z"), staleSeconds: 1800 };
  assert.deepEqual(usageStatuses(readUsageReadings(dir), options), usageStatuses(all, options));
  const file = path.join(dir, USAGE_READINGS_FILE);
  const persisted = JSON.parse(readFileSync(file, "utf8"));
  const entry = persisted.entries["codex:local"];
  assert.equal(entry.recent.length, USAGE_HISTORY_LIMIT);
  assert.equal(entry.latest.readAt, all.at(-1).readAt);
  assert.equal(entry.lastGood.readAt, "2026-11-03T12:00:00.000Z", "READFAIL compaction retains the older good reading");
  assert.ok(statSync(file).size < 50_000, `bounded usage state is ${statSync(file).size} bytes`);
  assert.deepEqual(readdirSync(dir), [USAGE_READINGS_FILE], "atomic temporary and lock files are removed");
});

test("the status command prints age and honors the configured stale threshold", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-usage-command-"));
  recordUsageReading(dir, reading("2026-11-03T17:29:00.000Z"));
  const stale = spawnSync(process.execPath, [SCRIPT, "status", dir, "--now", "2026-11-03T18:00:00.000Z"], { encoding: "utf8" });
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /age=31m source=snapshot STALE\(>1800s\)/);
  const fresh = spawnSync(process.execPath, [SCRIPT, "status", dir, "--now", "2026-11-03T18:00:00.000Z", "--stale-seconds", "3600"], { encoding: "utf8" });
  assert.equal(fresh.status, 0);
  assert.doesNotMatch(fresh.stdout, /STALE/);
});
