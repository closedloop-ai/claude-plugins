// Usage: node ratelimit.mjs <label>
// Prints "codex-usage <label> <band>% <state> resets=<n>" from account/rateLimits/read, or
// "codex-usage <label> unreadable READFAIL". Band is `under<N>%` below N percent used (USAGE_HIGH_PERCENT,
// default 80), so ordinary use is not an event, and `HIGH(<used percent floored to 10>%)` from N up.
// Needs liveness.mjs beside it; snapshot.sh ships both files to the remote host.
// Also the plugin's one reader and classifier of Codex usage: vibe/scripts/codex-usage.mjs imports it.
import { connectStdio, connectViaProxy, daemonSocket, exitAfterTotalTimeout, isEntryPoint } from './liveness.mjs';

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
      return { error: `initialize failed: ${error.message}` };
    }
    try {
      return { result: await client.request('account/rateLimits/read', READ_PARAMS, timeoutMs) };
    } catch (error) {
      return { error: `account/rateLimits/read failed: ${error.message}` };
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

export function usageLine(label, response, high = HIGH_USAGE_PERCENT) {
  const band = usageBand(response?.rateLimits?.primary?.usedPercent, high);
  const resets = response?.rateLimitResetCredits?.availableCount ?? 0;
  return `codex-usage ${label} ${band} ${classifyUsage(response)} resets=${resets}`;
}

async function main() {
  exitAfterTotalTimeout();
  const label = process.argv[2] ?? 'local';
  const { result, error } = await readRateLimits();
  console.log(error ? `codex-usage ${label} unreadable READFAIL` : usageLine(label, result, highUsagePercent()));
  process.exit(0);
}

if (isEntryPoint(import.meta.url)) await main();
