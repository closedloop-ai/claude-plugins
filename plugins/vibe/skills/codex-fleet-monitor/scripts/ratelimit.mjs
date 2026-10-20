// Usage: node ratelimit.mjs <label>
// Prints "codex-usage <label> <band>% <state> resets=<n>" from account/rateLimits/read, or
// "codex-usage <label> unreadable READFAIL". Band is the used percent floored to 10.
// Needs liveness.mjs beside it; snapshot.sh ships both files to the remote host.
import { connectViaProxy, daemonSocket, exitAfterTotalTimeout, isEntryPoint } from './liveness.mjs';

export function usageState(response) {
  const limits = response?.rateLimits;
  if (!limits?.rateLimitReachedType) return 'ok';
  if (response.ordinaryUsageAllowed) return 'LIMIT';
  return limits.credits?.hasCredits ? 'LIMIT-SPENDING-CREDITS' : 'LIMIT-STOPPED';
}

export function usageLine(label, response) {
  const used = response?.rateLimits?.primary?.usedPercent;
  const band = Number.isFinite(used) ? `${Math.floor(used / 10) * 10}%` : '?%';
  const resets = response?.rateLimitResetCredits?.availableCount ?? 0;
  return `codex-usage ${label} ${band} ${usageState(response)} resets=${resets}`;
}

export async function readUsage(client, label) {
  try {
    return usageLine(label, await client.request('account/rateLimits/read', {}));
  } catch {
    return `codex-usage ${label} unreadable READFAIL`;
  }
}

async function main() {
  exitAfterTotalTimeout();
  const label = process.argv[2] ?? 'local';
  const client = connectViaProxy(daemonSocket());
  try {
    await client.initialize();
    console.log(await readUsage(client, label));
  } catch {
    console.log(`codex-usage ${label} unreadable READFAIL`);
  }
  client.close();
  process.exit(0);
}

if (isEntryPoint(import.meta.url)) await main();
