#!/usr/bin/env node
// Bounded usage state for one fleet program. Each runtime and machine retains its latest reading, latest good
// reading, and a short recent history in <workDir>/usage-readings.json. Writers serialize updates and replace
// the file atomically, so concurrent readers never observe a partial document. The status command judges
// freshness from the last good reading.
//
// Usage:
//   usage-state.mjs status <workDir> [--stale-seconds <n>] [--now <iso>]
//   usage-state.mjs watch-lines <workDir> [--stale-seconds <n>] [--now <iso>]
//   usage-state.mjs record-json <workDir>   # reads one reading, or { reading }, from stdin

import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readConfig, resolveWorkDir } from "./work-dir.mjs";

export const DEFAULT_STALE_SECONDS = 30 * 60;
export const DEFAULT_CLAUDE_USAGE_INTERVAL_SECONDS = 600;
export const USAGE_HISTORY_LIMIT = 100;
export const USAGE_READINGS_FILE = "usage-readings.json";
const USAGE_LOCK_FILE = ".usage-readings.lock";
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const RUNTIMES = new Set(["codex", "claude"]);
const STATUSES = new Set(["ok", "readfail"]);

/** The private fallback used by a standalone vibe usage check outside a fleet program. */
export function defaultUsageWorkDir() {
  return path.join(os.homedir(), ".codex", "vibe");
}

/** Persist one usage probe; an optional callback can act on its committed state before the lock is released. */
export function recordUsageReading(workDir, reading, afterRecord) {
  const normalized = normalizeReading(reading);
  const dir = resolveWorkDir(workDir).dir;
  mkdirSync(dir, { recursive: true });
  return withStateLock(dir, () => {
    const file = path.join(dir, USAGE_READINGS_FILE);
    const state = readUsageState(file);
    const key = `${normalized.runtime}:${normalized.machine}`;
    const previous = state.entries[key] ?? { latest: null, lastGood: null, recent: [] };
    const latest = newer(previous.latest, normalized);
    const lastGood = normalized.status === "ok" ? newer(previous.lastGood, normalized) : previous.lastGood;
    const recent = [...previous.recent, normalized].slice(-USAGE_HISTORY_LIMIT);
    state.entries[key] = { latest, lastGood, recent };
    writeUsageState(file, state);
    return afterRecord ? afterRecord({ latest, lastGood, consecutiveFailures: consecutiveReadFailures(recent, normalized.runtime, normalized.machine) }) : normalized;
  });
}

/** Read the bounded recent probes plus separately retained latest and last-good readings. */
export function readUsageReadings(workDir) {
  const file = path.join(resolveWorkDir(workDir).dir, USAGE_READINGS_FILE);
  if (!existsSync(file)) return [];
  return Object.values(readUsageState(file).entries).flatMap((entry) => uniqueReadings([
    ...entry.recent, entry.latest, entry.lastGood,
  ].filter(Boolean)));
}

/** Latest attempt and latest good reading per runtime and machine, sorted for stable reports. */
export function latestUsageReadings(readings) {
  const latest = new Map();
  for (const reading of readings) {
    let normalized;
    try { normalized = normalizeReading(reading); } catch { continue; }
    const key = `${normalized.runtime}:${normalized.machine}`;
    const entry = latest.get(key) ?? { latest: null, lastGood: null };
    if (!entry.latest || Date.parse(normalized.readAt) >= Date.parse(entry.latest.readAt)) entry.latest = normalized;
    if (normalized.status === "ok" && (!entry.lastGood || Date.parse(normalized.readAt) >= Date.parse(entry.lastGood.readAt))) {
      entry.lastGood = normalized;
    }
    latest.set(key, entry);
  }
  return [...latest.values()].sort((a, b) => a.latest.runtime.localeCompare(b.latest.runtime)
    || a.latest.machine.localeCompare(b.latest.machine));
}

/** Structured freshness rows used by the CLI and board.mjs. */
export function usageStatuses(readings, { now = Date.now(), staleSeconds = DEFAULT_STALE_SECONDS } = {}) {
  requireStaleSeconds(staleSeconds);
  return latestUsageReadings(readings).map(({ latest, lastGood }) => {
    const readAgeSeconds = ageSeconds(latest.readAt, now);
    const goodAgeSeconds = lastGood ? ageSeconds(lastGood.readAt, now) : null;
    return {
      ...latest,
      readAgeSeconds,
      lastGoodAt: lastGood?.readAt ?? null,
      lastGoodSource: lastGood?.source ?? null,
      lastGoodLine: lastGood?.line ?? null,
      lastGoodAgeSeconds: goodAgeSeconds,
      stale: goodAgeSeconds === null || goodAgeSeconds > staleSeconds,
      staleSeconds,
      consecutiveFailures: consecutiveReadFailures(readings, latest.runtime, latest.machine),
    };
  });
}

/** Human-readable latest rows. READFAIL reports keep the last good reading and its age visible. */
export function formatUsageStatus(row) {
  const current = `usage ${row.runtime} ${row.machine} ${row.status === "ok" ? "OK" : "READFAIL"} read=${row.readAt} age=${formatAge(row.readAgeSeconds)} source=${row.source}`;
  const good = row.status === "readfail"
    ? ` last-good=${row.lastGoodAt ?? "none"} last-good-age=${row.lastGoodAgeSeconds === null ? "unknown" : formatAge(row.lastGoodAgeSeconds)}${row.lastGoodSource ? ` last-good-source=${row.lastGoodSource}` : ""}`
    : "";
  return `${current}${good}${row.stale ? ` STALE(>${row.staleSeconds}s)` : ""}`;
}

/** Stable watcher flags. Read attempt times are deliberately absent so a failed retry is not an event every tick. */
export function usageWatchLines(rows, { claudeIntervalSeconds = DEFAULT_CLAUDE_USAGE_INTERVAL_SECONDS } = {}) {
  return rows.filter((row) => row.stale || (row.status === "readfail" && !(
    row.runtime === "claude" && row.consecutiveFailures === 1
      && isRecentClaudeGood(row.lastGoodAt, row.readAt, claudeIntervalSeconds)
  ))).map((row) => {
    const flags = [row.status === "readfail" ? "READFAIL" : null, row.stale ? "STALE" : null].filter(Boolean).join(",");
    return `usage ${row.runtime} ${row.machine} ${flags} last-good=${row.lastGoodAt ?? "none"}`;
  });
}

/** Whether a successful Claude reading is inside the one-failure retry window at the failed read time. */
export function isRecentClaudeGood(lastGoodAt, readAt, intervalSeconds) {
  const ageMilliseconds = Date.parse(readAt) - Date.parse(lastGoodAt);
  return Number.isFinite(ageMilliseconds) && ageMilliseconds >= 0 && ageMilliseconds < 2 * intervalSeconds * 1000;
}

function consecutiveReadFailures(readings, runtime, machine) {
  const matching = readings.filter((reading) => reading.runtime === runtime && reading.machine === machine)
    .sort((a, b) => Date.parse(b.readAt) - Date.parse(a.readAt));
  let count = 0;
  for (const reading of matching) {
    if (reading.status !== "readfail") break;
    count += 1;
  }
  return Math.min(count, 2);
}

/** Board failures with exact evidence and a stable kind for each condition. */
export function usageProblems(rows) {
  return rows.flatMap((row) => {
    const problems = [];
    if (row.status === "readfail") {
      problems.push(`USAGE-READFAIL ${row.runtime} ${row.machine}: read failed at ${row.readAt} from ${row.source}; last good ${row.lastGoodAt ?? "none"}`);
    }
    if (row.stale) {
      problems.push(`STALE-USAGE ${row.runtime} ${row.machine}: last good ${row.lastGoodAt ?? "none"}${row.lastGoodAgeSeconds === null ? "" : ` (${formatAge(row.lastGoodAgeSeconds)} ago)`}; threshold ${row.staleSeconds}s`);
    }
    return problems;
  });
}

/** Resolve the configured threshold. USAGE_STALE_SECONDS belongs in the fleet's config.env; absent means 1800. */
export function configuredStaleSeconds(workDir, explicit) {
  if (explicit !== undefined) return requireStaleSeconds(Number(explicit));
  const configured = readConfig(resolveWorkDir(workDir)).USAGE_STALE_SECONDS;
  return configured === undefined || configured === "" ? DEFAULT_STALE_SECONDS : requireStaleSeconds(Number(configured));
}

/** Resolve the existing Claude probe interval from config.env or the inherited process environment. */
function configuredClaudeUsageIntervalSeconds(workDir) {
  const configured = readConfig(resolveWorkDir(workDir)).CLAUDE_USAGE_SECONDS ?? process.env.CLAUDE_USAGE_SECONDS;
  const seconds = Number(configured);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_CLAUDE_USAGE_INTERVAL_SECONDS;
}

function normalizeReading(reading) {
  if (!reading || typeof reading !== "object") throw new Error("a usage reading must be an object");
  const runtime = String(reading.runtime ?? "").toLowerCase();
  const machine = String(reading.machine ?? "").trim();
  const source = String(reading.source ?? "").trim();
  const status = String(reading.status ?? "").toLowerCase();
  const readAt = String(reading.readAt ?? "");
  const line = String(reading.line ?? "").trim();
  if (!RUNTIMES.has(runtime)) throw new Error("runtime must be codex or claude");
  if (!machine || /\s/.test(machine)) throw new Error("machine must be one non-empty word");
  if (!source || /\s/.test(source)) throw new Error("source must be one non-empty word");
  if (!STATUSES.has(status)) throw new Error("status must be ok or readfail");
  if (!Number.isFinite(Date.parse(readAt))) throw new Error("readAt must be an ISO timestamp");
  if (!line) throw new Error("line must be non-empty");
  return { runtime, machine, source, status, readAt: new Date(readAt).toISOString(), line };
}

function emptyUsageState() {
  return { version: 1, entries: {} };
}

function readUsageState(file) {
  if (!existsSync(file)) return emptyUsageState();
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value?.version !== 1 || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) {
    throw new Error(`${USAGE_READINGS_FILE} has an unsupported shape`);
  }
  const entries = {};
  for (const [key, entry] of Object.entries(value.entries)) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.recent)) {
      throw new Error(`${USAGE_READINGS_FILE} entry ${key} has an unsupported shape`);
    }
    const latest = entry.latest ? normalizeReading(entry.latest) : null;
    const lastGood = entry.lastGood ? normalizeReading(entry.lastGood) : null;
    const recent = entry.recent.map(normalizeReading).slice(-USAGE_HISTORY_LIMIT);
    if (!latest || `${latest.runtime}:${latest.machine}` !== key || (lastGood && `${lastGood.runtime}:${lastGood.machine}` !== key)) {
      throw new Error(`${USAGE_READINGS_FILE} entry ${key} does not match its readings`);
    }
    if ((lastGood && lastGood.status !== "ok") || recent.some((reading) => `${reading.runtime}:${reading.machine}` !== key)) {
      throw new Error(`${USAGE_READINGS_FILE} entry ${key} has inconsistent reading state`);
    }
    entries[key] = { latest, lastGood, recent };
  }
  return { version: 1, entries };
}

function writeUsageState(file, state) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function withStateLock(dir, action) {
  const lock = path.join(dir, USAGE_LOCK_FILE);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lock, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!lockOwnerAlive(lock)) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${USAGE_LOCK_FILE}`);
      Atomics.wait(WAIT_ARRAY, 0, 0, LOCK_WAIT_MS);
    }
  }
  try {
    writeFileSync(descriptor, `${process.pid}\n`);
  } catch (error) {
    closeSync(descriptor);
    rmSync(lock, { force: true });
    throw error;
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    rmSync(lock, { force: true });
  }
}

function lockOwnerAlive(file) {
  let pid;
  try {
    pid = Number(readFileSync(file, "utf8").trim());
  } catch {
    try { return Date.now() - statSync(file).mtimeMs < LOCK_TIMEOUT_MS; } catch { return false; }
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    try { return Date.now() - statSync(file).mtimeMs < LOCK_TIMEOUT_MS; } catch { return false; }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function newer(current, candidate) {
  return !current || Date.parse(candidate.readAt) >= Date.parse(current.readAt) ? candidate : current;
}

function uniqueReadings(readings) {
  const seen = new Set();
  return readings.filter((reading) => {
    const key = JSON.stringify(reading);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ageSeconds(at, now) {
  return Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
}

function formatAge(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function requireStaleSeconds(value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error("stale seconds must be a positive number");
  return value;
}

async function stdinText() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(argv) {
  const [command, workDir, ...rest] = argv;
  if (!workDir || !["status", "watch-lines", "record-json"].includes(command)) {
    throw new Error("Usage: usage-state.mjs status|watch-lines|record-json <workDir> [options]");
  }
  if (command === "record-json") {
    const value = JSON.parse(await stdinText());
    recordUsageReading(workDir, value.reading ?? value);
    return 0;
  }
  const { values } = parseArgs({
    args: rest,
    options: { "stale-seconds": { type: "string" }, now: { type: "string" } },
  });
  const now = values.now === undefined ? Date.now() : Date.parse(values.now);
  if (!Number.isFinite(now)) throw new Error("--now must be an ISO timestamp");
  const staleSeconds = configuredStaleSeconds(workDir, values["stale-seconds"]);
  const rows = usageStatuses(readUsageReadings(workDir), { now, staleSeconds });
  const lines = command === "status" ? rows.map(formatUsageStatus)
    : usageWatchLines(rows, { claudeIntervalSeconds: configuredClaudeUsageIntervalSeconds(workDir) });
  if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
  return command === "status" && rows.some((row) => row.stale || row.status === "readfail") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
