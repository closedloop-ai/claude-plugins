import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { regularJson, writeAtomic } from '../../../lib/vibe/scripts/owned-state.mjs';
import { isEntryPoint } from '../../../shared/plugin-roots.mjs';
import { latestUsageReadings, readUsageReadings } from './usage-state.mjs';

const CHECKPOINT = 'watch-usage-state.json';
const FAILURE_LIMIT = 2;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const BAND = /^(?:unknown|\?%|under\d+(?:\.\d+)?%|HIGH\(\d+%\))$/;

function readTime(value) {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value))) return null;
  const normalized = new Date(value).toISOString();
  const expected = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction = '') => `.${fraction.padEnd(3, '0')}Z`);
  return normalized === expected ? normalized : null;
}

function validBand(band) {
  return typeof band?.session === 'string' && typeof band.week === 'string' && BAND.test(band.session) && BAND.test(band.week);
}

function parseProbe(line) {
  const [, machine, body] = /^claude-usage (\S+) (.+)$/.exec(line) ?? [];
  if (!machine) return null;
  const [, time] = /(?:^| )read=(\S*)/.exec(body) ?? [];
  const readAt = readTime(time);
  if (time !== undefined && readAt === null) return null;
  if (/^unreadable READFAIL(?: |$)/.test(body)) {
    return readAt && /^unreadable READFAIL read=\S+ source=\S+$/.test(body) ? { machine, readAt, band: null } : null;
  }
  const [, session, week] = /^session=(\S+) week=(\S+)(?: |$)/.exec(body) ?? [];
  const band = { session, week };
  return validBand(band) ? { machine, readAt, band } : null;
}

function parseSnapshot(snapshot) {
  const probes = new Map();
  const stale = new Set();
  for (const line of snapshot.split('\n')) {
    const probe = parseProbe(line);
    if (probe) probes.set(probe.machine, probe);
    const [, machine, lastGood] = /^usage claude (\S+) (?:READFAIL,)?STALE last-good=(\S+)$/.exec(line) ?? [];
    if (machine && readTime(lastGood)) stale.add(machine);
  }
  return { probes, stale };
}

function loadCheckpoint(file) {
  try {
    const { version, machines } = regularJson(file) ?? {};
    if (version !== 1 || !machines || typeof machines !== 'object' || Array.isArray(machines)) return null;
    const rows = Object.entries(machines);
    return rows.every(([, state]) => state && (state.lastGoodBand === null || validBand(state.lastGoodBand))
      && (state.lastProbeAt === null || readTime(state.lastProbeAt) === state.lastProbeAt)
      && Number.isInteger(state.consecutiveFailures) && state.consecutiveFailures >= 0
      && state.consecutiveFailures <= FAILURE_LIMIT && typeof state.stale === 'boolean') ? new Map(rows) : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function usageHistory(workDir) {
  try { return readUsageReadings(workDir); }
  catch { return []; }
}

function seedCheckpoint(workDir, before, reset) {
  const { probes, stale } = parseSnapshot(before);
  const history = !reset && [...probes.values()].some(({ band }) => band === null) ? usageHistory(workDir) : [];
  return new Map([...probes].map(([machine, { band, readAt }]) => {
    const lastGood = latestUsageReadings(history.filter((reading) => reading.runtime === 'claude'
      && reading.machine === machine && reading.readAt < readAt))[0]?.lastGood;
    const lastGoodBand = band ?? (lastGood ? parseProbe(lastGood.line)?.band ?? null : null);
    return [machine, { lastGoodBand, lastProbeAt: readAt, consecutiveFailures: band ? 0 : 1,
      stale: Boolean(lastGoodBand && stale.has(machine)) }];
  }));
}

function bandLine(machine, { session, week }) {
  return `claude-usage ${machine} session=${session} week=${week}`;
}

/** Evaluate one snapshot under watch.sh's lock, preserving the raw telemetry for other readers. */
export function watchUsageEvents(workDir, before, current, { reset = false } = {}) {
  const file = join(workDir, CHECKPOINT);
  const saved = loadCheckpoint(file);
  const machines = !reset && saved ? new Map(saved) : seedCheckpoint(workDir, before, reset);
  const { probes, stale } = parseSnapshot(current);
  const events = [];
  for (const [machine, { band, readAt }] of probes) {
    const prior = machines.get(machine) ?? { lastGoodBand: null, lastProbeAt: null, consecutiveFailures: 0, stale: false };
    if (prior.lastProbeAt !== null && (readAt === null || readAt < prior.lastProbeAt)) continue;
    const next = { ...prior };
    // The producer reprints cached probe lines. Only a new read can advance an episode.
    if (prior.lastProbeAt === null || readAt > prior.lastProbeAt) {
      next.lastProbeAt = readAt;
      if (band) {
        if (prior.lastGoodBand && (band.session !== prior.lastGoodBand.session || band.week !== prior.lastGoodBand.week)) {
          events.push(`< ${bandLine(machine, prior.lastGoodBand)}`, `> ${bandLine(machine, band)}`);
        }
        next.lastGoodBand = band;
        next.consecutiveFailures = 0;
      } else if (prior.consecutiveFailures < FAILURE_LIMIT) {
        next.consecutiveFailures++;
        if (next.consecutiveFailures === FAILURE_LIMIT) {
          events.push(`> claude-usage ${machine} unreadable READFAIL consecutive=${FAILURE_LIMIT}`);
        }
      }
    }
    // Freshness can cross its own threshold even when the last probe is cached.
    next.stale = Boolean(next.lastGoodBand && stale.has(machine));
    if (next.stale && !prior.stale) events.push(`> usage claude ${machine} STALE`);
    machines.set(machine, next);
  }
  const rows = Object.fromEntries(machines);
  if ((machines.size || saved?.size) && JSON.stringify(rows) !== JSON.stringify(Object.fromEntries(saved ?? []))) {
    writeAtomic(file, { version: 1, machines: rows }, { createParent: false });
  }
  return events;
}

if (isEntryPoint(import.meta.url)) {
  const [, , workDir, mode] = process.argv;
  const [before, current, extra] = readFileSync(0, 'utf8').split('\0');
  if (!workDir || current === undefined || extra !== undefined || (mode !== undefined && mode !== 'reset')) {
    throw new Error('watch usage needs a work directory and the previous and current snapshots');
  }
  for (const line of watchUsageEvents(workDir, before, current, { reset: mode === 'reset' })) console.log(line);
}
