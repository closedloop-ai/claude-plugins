// Usage: node ratelimit.mjs <label> [--work-dir <orchDir>] [--source <name>] [--json]
// Prints "codex-usage <label> <band>% <state> resets=<n> read=<iso> source=<name>" from
// account/rateLimits/read, or "codex-usage <label> unreadable READFAIL ...". Band is `under<N>%`
// below N percent used (USAGE_HIGH_PERCENT,
// default 80), so ordinary use is not an event, and `HIGH(<used percent floored to 10>%)` from N up.
// Needs liveness.mjs beside it; snapshot.sh ships both files to the remote host.
// Also the plugin's one reader and classifier of Codex usage: vibe/scripts/codex-usage.mjs imports it.
import { connectStdio, connectViaProxy, daemonSocket, exitAfterTotalTimeout, isEntryPoint } from './liveness.mjs';
import { parseArgs } from 'node:util';
import { defaultUsageWorkDir, recordUsageReading } from './usage-state.mjs';
import { resolveWorkDir } from './work-dir.mjs';

export const UsageState = Object.freeze({
  Ok: 'ok',
  Limit: 'LIMIT',
  SpendingCredits: 'LIMIT-SPENDING-CREDITS',
  Stopped: 'LIMIT-STOPPED',
  Unknown: 'unknown',
});

// `daemon` starts the managed App Server if needed and leaves it running; `stdio` starts a private one per read.
export const UsageTransport = Object.freeze({ Daemon: 'daemon', Stdio: 'stdio' });

// The available reset count stays in the answer; only the separate detail lookup is skipped.
const READ_PARAMS = { excludeResetCreditDetails: true };

/**
 * LIMIT: a limit is reached but ordinary usage is still allowed. LIMIT-SPENDING-CREDITS: ordinary
 * usage is not allowed (or unreported) and turns are drawing on paid credits. LIMIT-STOPPED: no credits either.
 */
export function classifyUsage(response) {
  const limits = response?.rateLimits;
  if (!limits || typeof limits !== 'object') return UsageState.Unknown;
  if (!limits.rateLimitReachedType) return UsageState.Ok;
  if (response.ordinaryUsageAllowed === true) return UsageState.Limit;
  return limits.credits?.hasCredits ? UsageState.SpendingCredits : UsageState.Stopped;
}

/** Resolves `{ result }` or `{ error }`; never throws. */
export async function readRateLimits({ transport = UsageTransport.Daemon, codex = 'codex', timeoutMs } = {}) {
  const client = transport === UsageTransport.Stdio ? connectStdio(codex) : connectViaProxy(daemonSocket(codex), codex);
  try {
    try {
      await client.initialize(timeoutMs);
    } catch (error) {
      return { error: `initialize failed: ${error.message}`, readAt: new Date().toISOString() };
    }
    try {
      const result = await client.request('account/rateLimits/read', READ_PARAMS, timeoutMs);
      return { result, readAt: new Date().toISOString() };
    } catch (error) {
      return { error: `account/rateLimits/read failed: ${error.message}`, readAt: new Date().toISOString() };
    }
  } finally {
    client.close();
  }
}

/**
 * At or above this used percent (USAGE_HIGH_PERCENT, default 80) the band shows and changes per 10;
 * below it every value prints the same.
 */
export const HIGH_USAGE_PERCENT = 80;

export function usageBand(used, high = HIGH_USAGE_PERCENT) {
  if (!Number.isFinite(used)) return '?%';
  if (used < high) return `under${high}%`;
  return `HIGH(${Math.floor(used / 10) * 10}%)`;
}

export function highUsagePercent(env = process.env) {
  const value = Number(env.USAGE_HIGH_PERCENT);
  return env.USAGE_HIGH_PERCENT && Number.isFinite(value) && value > 0 ? value : HIGH_USAGE_PERCENT;
}

export function usageLine(label, response, high = HIGH_USAGE_PERCENT, metadata = null) {
  const band = usageBand(response?.rateLimits?.primary?.usedPercent, high);
  const resets = response?.rateLimitResetCredits?.availableCount ?? 0;
  const suffix = metadata ? ` read=${metadata.readAt} source=${metadata.source}` : '';
  return `codex-usage ${label} ${band} ${classifyUsage(response)} resets=${resets}${suffix}`;
}

/** Persistable result for one Codex usage probe. */
export function rateLimitReading(label, outcome, { source = 'ratelimit', high = HIGH_USAGE_PERCENT } = {}) {
  const readAt = outcome.readAt ?? new Date().toISOString();
  const status = outcome.error || classifyUsage(outcome.result) === UsageState.Unknown ? 'readfail' : 'ok';
  const line = outcome.error
    ? `codex-usage ${label} unreadable READFAIL read=${readAt} source=${source}`
    : usageLine(label, outcome.result, high, { readAt, source });
  return { runtime: 'codex', machine: label, source, status, readAt, line };
}

async function main() {
  exitAfterTotalTimeout();
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true,
    options: { json: { type: 'boolean', default: false }, source: { type: 'string' }, 'work-dir': { type: 'string' } },
  });
  const label = positionals[0] ?? 'local';
  const source = values.source ?? 'ratelimit';
  const reading = rateLimitReading(label, await readRateLimits(), { source, high: highUsagePercent() });
  const workDir = values['work-dir'] ? resolveWorkDir(values['work-dir']).dir : defaultUsageWorkDir();
  recordUsageReading(workDir, reading);
  console.log(values.json ? JSON.stringify({ line: reading.line, reading }) : reading.line);
  process.exit(0);
}

if (isEntryPoint(import.meta.url)) await main();
