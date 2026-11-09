import { spawnSync } from "node:child_process";

/** A process's raw start time and command, preserving the helper-ledger compatibility format. */
export function readProcessIdentity(pid, { run = spawnSync, env = process.env } = {}) {
  const result = run("ps", ["-o", "lstart=,command=", "-p", String(pid)], {
    encoding: "utf8", env: { ...env, LC_ALL: "C" }, timeout: 5_000,
  });
  const identity = result.stdout?.trim();
  return result.status === 0 && identity ? identity : null;
}

/** Process birth time stays constant when a shell execs its launcher. */
export function readProcessStart(pid, { run = spawnSync, env = process.env } = {}) {
  const result = run("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8", env: { ...env, LC_ALL: "C" }, timeout: 5_000,
  });
  const started = result.stdout?.trim();
  return result.status === 0 && started ? started : null;
}

/** Distinguish an exact live process from a dead or reused PID; unreadable identity stays unknown. */
export function processIdentityStatus(pid, identity, { identityOf = readProcessIdentity, signal = process.kill } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || typeof identity !== 'string' || !identity) return 'unknown';
  try { signal(pid, 0); } catch (error) { return error?.code === 'ESRCH' ? 'dead' : 'unknown'; }
  let actual;
  try { actual = identityOf(pid); } catch { return 'unknown'; }
  if (!actual) return 'unknown';
  return actual === identity ? 'live' : 'dead';
}
