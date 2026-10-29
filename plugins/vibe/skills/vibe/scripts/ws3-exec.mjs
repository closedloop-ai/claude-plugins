// One bounded way for the WS3 control scripts (setup-ctl, env-ctl, verify-run,
// guardrails-gate, graph-pack, req-gather, prototype-share, ticket-ctl) to run
// a command. Each script takes this as an injectable `run`, so its tests run
// without git, gh, pnpm or the network. No shell: arguments are never joined.

import { spawnSync } from "node:child_process";

const MAX_BUFFER = 64 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Runs `command` with `args` and returns `{ status, stdout, stderr }`; a spawn failure or time out is status 124 or 127 with the reason on stderr. */
export function execCommand(command, args, { cwd, input, timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  const result = spawnSync(command, args, {
    cwd, input, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: timeoutMs,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.error) {
    const timedOut = result.error.code === "ETIMEDOUT";
    return { status: timedOut ? 124 : 127, stdout: result.stdout ?? "", stderr: `${command}: ${result.error.message}` };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Parses `text` as JSON, or returns `fallback` when it is not. */
export function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** The last `count` non-empty lines of `text`, for a failure's evidence. */
export function tailLines(text, count = 12) {
  return text.split("\n").filter((line) => line.trim() !== "").slice(-count).join("\n");
}
