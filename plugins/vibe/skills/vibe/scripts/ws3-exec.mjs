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

// Output that says the tool itself never ran (missing install, missing binary, a runner that reports it did not run),
// as opposed to a tool that ran and failed. Such a result is never a finding and never a pass.
const DID_NOT_RUN = [
  [/DID NOT RUN/i, "the runner reported that it did not run"],
  [/command not found|: not found\b/i, "a required command is not installed"],
  [/Command "?[\w@./-]+"? not found/i, "a required command is not installed in the workspace"],
  [/node_modules (?:is )?missing|node_modules.*not (?:found|installed)|dependencies? (?:are )?not installed|run ["'`]?pnpm install/i, "dependencies are not installed (no node_modules)"],
  [/ERR_PNPM_(?:NO_IMPORTER_MANIFEST|RECURSIVE_EXEC_FIRST_FAIL|FETCH|OUTDATED_LOCKFILE)|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package) /i, "the toolchain is not installed or is incomplete"],
  [/\bspawn \S+ ENOENT\b|\bENOENT\b.*\bspawn\b/i, "the command could not be started"],
];

/** The reason a wrapped command's result means it never ran (`status` 127 included), or null when it ran, passed or failed. */
export function toolDidNotRun(result) {
  if (result.status === 0) return null;
  if (result.status === 127) return `could not run: ${tailLines(result.stderr, 1) || "command missing"}`;
  const text = `${result.stdout}\n${result.stderr}`;
  const hit = DID_NOT_RUN.find(([pattern]) => pattern.test(text));
  return hit ? `${hit[1]}: ${tailLines(text, 1)}` : null;
}
