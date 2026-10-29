// Stops the local processes a vibe session recorded on its stack: its
// Storybook (`storybookPid`) and its Desktop launch (`desktopPid`). Only a
// process that is still the one the session started is signalled: it must be
// alive, its command line must be that kind of process, and it must run in the
// session's worktree. A stale or reused process id is left alone (ISS-13321: a
// session's Storybook had to be stopped by hand when the hook refused a worker
// signalling a recorded pid on another machine).

import { execFileSync } from "node:child_process";
import { readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

const KINDS = Object.freeze({
  storybook: { pidKey: "storybookPid", clear: ["storybookPid", "storybookUrl"], command: /\bstorybook\b/i },
  desktop: { pidKey: "desktopPid", clear: ["desktopPid", "desktopLog", "desktopBrowserUrl"], command: /vibe:profile|vibe-profile|dev-launch\.mjs/ },
});
const STOP_WAIT_MS = 60_000;
const POLL_MS = 250;

/** The command line and working directory of `pid`, or null when it is not running. */
export function processInfo(pid) {
  if (!alive(pid)) return null;
  let row = "";
  try { row = execFileSync("ps", ["-o", "stat=,command=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return null; }
  const [stat, ...command] = row.split(/\s+/);
  // A zombie has exited and only waits for its parent to collect it.
  if (!stat || stat.startsWith("Z")) return null;
  return { command: command.join(" "), cwd: processCwd(pid) };
}

function processCwd(pid) {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { /* not Linux */ }
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/** Whether `info` (a running process) is the session's own process of `kind`, with why not. */
export function ownership(kind, info, worktree) {
  if (!info) return { owned: false, reason: "not running" };
  if (!KINDS[kind].command.test(info.command)) return { owned: false, reason: "its command line is not the session's " + kind };
  const root = realpathSync(worktree);
  const inside = (dir) => Boolean(dir) && (dir === root || dir.startsWith(`${root}${path.sep}`));
  if (!inside(info.cwd) && !info.command.includes(root)) return { owned: false, reason: "it does not run in the session's worktree" };
  return { owned: true };
}

/** `pid` and every process under it, deepest first, so children stop before the parent that would restart them. */
function tree(pid) {
  let rows = [];
  try {
    rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
  } catch { return [pid]; }
  const found = [];
  const walk = (parent) => {
    for (const [child, ppid] of rows) if (ppid === parent && !found.includes(child)) { walk(child); found.push(child); }
  };
  walk(pid);
  return [...found, pid];
}

/**
 * Stops each recorded process the session owns and returns, per kind, what happened and the stack with the
 * stopped or already gone entries cleared. Never signals a process it cannot prove is the session's.
 */
export async function stopSessionProcesses(worktree, stack, { read = processInfo, signal = process.kill, waitMs = STOP_WAIT_MS } = {}) {
  const results = [];
  const next = { ...(stack ?? {}) };
  for (const [kind, spec] of Object.entries(KINDS)) {
    const pid = stack?.[spec.pidKey];
    if (pid === undefined || pid === null) continue;
    const info = read(pid);
    const { owned, reason } = ownership(kind, info, worktree);
    if (!owned) {
      results.push({ kind, pid, result: info ? "left-alone" : "not-running", reason });
      if (!info) spec.clear.forEach((key) => delete next[key]);
      continue;
    }
    for (const member of tree(pid)) {
      try { signal(member, "SIGTERM"); } catch { /* already gone */ }
    }
    const deadline = Date.now() + waitMs;
    while (read(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const stopped = !read(pid);
    results.push({ kind, pid, result: stopped ? "stopped" : "still-running" });
    if (stopped) spec.clear.forEach((key) => delete next[key]);
  }
  return { results, stack: next };
}
