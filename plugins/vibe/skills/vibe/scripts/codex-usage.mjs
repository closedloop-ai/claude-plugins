#!/usr/bin/env node
// The Codex usage check a vibe session runs before it spawns workers or starts
// a long turn, and again when a turn stalls. It asks the Codex App Server for
// the signed-in account's rate limits (`account/rateLimits/read`) and says
// whether the session may continue. The read and its classification belong to
// codex-fleet-monitor's ratelimit.mjs; this script only gates on them. When the
// account has reached a limit and ordinary usage is no longer allowed, the
// session stops and tells the person instead of carrying on with paid credits,
// unless the person explicitly allowed credits for this session
// (`--allow-credits`). It reads through a private `codex app-server` on stdio,
// so a check never starts or depends on the managed daemon.
//
// Usage: codex-usage.mjs check [--allow-credits] [--codex <CLI>] [--timeout-ms <n>]
//
// Prints one JSON object:
//   {"status":"ok", ...}               continue (also when a limit is reached but ordinary
//                                      usage is still allowed, `state` LIMIT)
//   {"status":"stop", ...}             a limit is reached and ordinary usage is not allowed:
//                                      stop and tell the person (exit 3)
//   {"status":"credits_allowed", ...}  a limit is reached, credits remain and the person allowed
//                                      them: continue (no credits left is always `stop`)
//   {"status":"unknown","reason":...}  the limits could not be read: continue
// Every status but `unknown` also carries `state` (ratelimit.mjs's
// UsageState), `rateLimitReachedType`, `resetsAt`
// (ISO time or null), `primary` and `secondary` window usage, and
// `ordinaryUsageAllowed` as the App Server reported them.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { classifyUsage, readRateLimits, UsageState, UsageTransport } from "../../codex-fleet-monitor/scripts/ratelimit.mjs";
import { findCodex } from "./plugin-version.mjs";

export const UsageStatus = Object.freeze({
  Ok: "ok",
  Stop: "stop",
  CreditsAllowed: "credits_allowed",
  Unknown: "unknown",
});
export const STOP_EXIT = 3;
const DEFAULT_TIMEOUT_MS = 20_000;

/** Turns an `account/rateLimits/read` result into the session's decision. */
export function decideUsage(result, { allowCredits = false } = {}) {
  const state = classifyUsage(result);
  if (state === UsageState.Unknown) {
    return { status: UsageStatus.Unknown, reason: "The App Server returned no rate limits." };
  }
  const snapshot = result.rateLimits;
  const details = {
    state,
    rateLimitReachedType: typeof snapshot.rateLimitReachedType === "string" ? snapshot.rateLimitReachedType : null,
    resetsAt: resetTime(snapshot),
    primary: windowUsage(snapshot.primary),
    secondary: windowUsage(snapshot.secondary),
    ordinaryUsageAllowed: typeof result.ordinaryUsageAllowed === "boolean" ? result.ordinaryUsageAllowed : null,
  };
  if (state === UsageState.Ok || state === UsageState.Limit) {
    return { status: UsageStatus.Ok, ...details };
  }
  // With no credits left, allowing them cannot make a turn run.
  const creditsUsable = allowCredits && state === UsageState.SpendingCredits;
  return { status: creditsUsable ? UsageStatus.CreditsAllowed : UsageStatus.Stop, ...details };
}

/** Reads the limits and decides; an unreadable answer is `unknown`, never a guessed `ok` or `stop`. */
export async function checkUsage({ codex, timeoutMs, allowCredits = false } = {}) {
  const outcome = await readRateLimits({ transport: UsageTransport.Stdio, codex: codex ?? findCodex(), timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS });
  if (outcome.error) {
    return { status: UsageStatus.Unknown, reason: outcome.error };
  }
  return decideUsage(outcome.result, { allowCredits });
}

function windowUsage(window) {
  if (!window || !Number.isFinite(window.usedPercent)) {
    return null;
  }
  return {
    usedPercent: window.usedPercent,
    resetsAt: epochToIso(window.resetsAt),
    windowDurationMins: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null,
  };
}

// The reached window is the one at 100 percent; with none, the earliest reset.
function resetTime(snapshot) {
  const windows = [snapshot.primary, snapshot.secondary].filter((window) => window && Number.isFinite(window.resetsAt));
  const full = windows.find((window) => window.usedPercent >= 100);
  const chosen = full ?? windows.sort((a, b) => a.resetsAt - b.resetsAt)[0];
  return chosen ? epochToIso(chosen.resetsAt) : null;
}

function epochToIso(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "allow-credits": { type: "boolean", default: false },
      codex: { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  if (positionals[0] !== "check") {
    throw new Error("Usage: codex-usage.mjs check [--allow-credits] [--codex <CLI>] [--timeout-ms <n>]");
  }
  const timeoutMs = values["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : Number(values["timeout-ms"]);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("--timeout-ms must be a positive number of milliseconds.");
  }
  const decision = await checkUsage({ codex: values.codex, timeoutMs, allowCredits: values["allow-credits"] });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  return decision.status === UsageStatus.Stop ? STOP_EXIT : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    }
  );
}
