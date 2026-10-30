import { spawnSync } from "node:child_process";

/** A process's raw start time and command, preserving the helper-ledger compatibility format. */
export function readProcessIdentity(pid, { run = spawnSync, env = process.env } = {}) {
  const result = run("ps", ["-o", "lstart=,command=", "-p", String(pid)], {
    encoding: "utf8", env: { ...env, LC_ALL: "C" },
  });
  const identity = result.stdout?.trim();
  return result.status === 0 && identity ? identity : null;
}
