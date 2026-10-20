#!/usr/bin/env node
// The Codex usage check a vibe session runs before it spawns workers or starts
// a long turn, and again when a turn stalls. It asks the Codex App Server for
// the signed-in account's rate limits (`account/rateLimits/read`) and says
// whether the session may continue. When the account has reached a limit
// (`rateLimitReachedType` is set), the session stops and tells the person
// instead of carrying on with paid credits, unless the person explicitly
// allowed credits for this session (`--allow-credits`).
//
// Usage: codex-usage.mjs check [--allow-credits] [--codex <CLI>] [--timeout-ms <n>]
//
// Prints one JSON object:
//   {"status":"ok", ...}               continue
//   {"status":"stop", ...}             a limit is reached: stop and tell the person (exit 3)
//   {"status":"credits_allowed", ...}  a limit is reached, the person allowed credits: continue
//   {"status":"unknown","reason":...}  the limits could not be read: continue
// Every status but `unknown` also carries `rateLimitReachedType`, `resetsAt`
// (ISO time or null), `primary` and `secondary` window usage, and
// `ordinaryUsageAllowed` as the App Server reported them.

import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { findCodex } from "./plugin-version.mjs";

export const UsageStatus = Object.freeze({
  Ok: "ok",
  Stop: "stop",
  CreditsAllowed: "credits_allowed",
  Unknown: "unknown",
});
export const STOP_EXIT = 3;
const DEFAULT_TIMEOUT_MS = 20_000;
const INITIALIZE_ID = 1;
const RATE_LIMITS_ID = 2;

/** Turns an `account/rateLimits/read` result into the session's decision. */
export function decideUsage(result, { allowCredits = false } = {}) {
  const snapshot = result?.rateLimits;
  if (!snapshot || typeof snapshot !== "object") {
    return { status: UsageStatus.Unknown, reason: "The App Server returned no rate limits." };
  }
  const reached = typeof snapshot.rateLimitReachedType === "string" ? snapshot.rateLimitReachedType : null;
  const details = {
    rateLimitReachedType: reached,
    resetsAt: resetTime(snapshot),
    primary: windowUsage(snapshot.primary),
    secondary: windowUsage(snapshot.secondary),
    ordinaryUsageAllowed: typeof result.ordinaryUsageAllowed === "boolean" ? result.ordinaryUsageAllowed : null,
  };
  if (!reached) {
    return { status: UsageStatus.Ok, ...details };
  }
  return { status: allowCredits ? UsageStatus.CreditsAllowed : UsageStatus.Stop, ...details };
}

/** Reads the account's rate limits through a short-lived `codex app-server` on stdio. */
export function readRateLimits({ codex = findCodex(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const child = spawn(codex, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    const finish = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ error: `No answer from the App Server within ${timeoutMs}ms.` }), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.once("error", (error) => finish({ error: `Could not start ${codex}: ${error.message}` }));
    child.once("close", () => finish({ error: "The App Server exited before it answered." }));
    child.stdin.on("error", () => finish({ error: "The App Server closed its input before it answered." }));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let boundary = buffer.indexOf("\n");
      while (boundary >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf("\n");
        const message = parseLine(line);
        if (message?.id === INITIALIZE_ID) {
          if (message.error) {
            finish({ error: `initialize failed: ${message.error.message ?? "unknown error"}` });
            return;
          }
          send({ method: "initialized" });
          send({ id: RATE_LIMITS_ID, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
        } else if (message?.id === RATE_LIMITS_ID) {
          finish(message.error
            ? { error: `account/rateLimits/read failed: ${message.error.message ?? "unknown error"}` }
            : { result: message.result });
          return;
        }
      }
    });
    send({ id: INITIALIZE_ID, method: "initialize", params: { clientInfo: { name: "vibe_usage", title: "Vibe usage check", version: "1.0.0" } } });
  });
}

/** Reads the limits and decides; an unreadable answer is `unknown`, never a guessed `ok` or `stop`. */
export async function checkUsage({ codex, timeoutMs, allowCredits = false } = {}) {
  const outcome = await readRateLimits({ codex, timeoutMs });
  if (outcome.error) {
    return { status: UsageStatus.Unknown, reason: outcome.error };
  }
  return decideUsage(outcome.result, { allowCredits });
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
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
