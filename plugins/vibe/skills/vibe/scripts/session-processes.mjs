// Stops the local processes a vibe session recorded on its stack: its
// Storybook (`storybookPid`) and its Desktop launch (`desktopPid`). Only a
// process that is still the one the session started is signalled: it must be
// alive, its command line must be that kind of process, and it must run in the
// session's worktree. A stale or reused process id is left alone (ISS-13321: a
// session's Storybook had to be stopped by hand when the hook refused a worker
// signalling a recorded pid on another machine).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { ledgerFile, recordedOwn, startTimeOf } from "../../../hooks/kill-guard.mjs";

const KINDS = Object.freeze({
  storybook: { pidKey: "storybookPid", identityKey: "storybookIdentity", clear: ["storybookPid", "storybookIdentity", "storybookUrl"], command: /\bstorybook\b/i },
  desktop: { pidKey: "desktopPid", identityKey: "desktopIdentity", clear: ["desktopPid", "desktopIdentity", "desktopLog", "desktopBrowserUrl"], command: /vibe:profile|vibe-profile|dev-launch\.mjs/ },
});
const STOP_WAIT_MS = 60_000;
const POLL_MS = 250;

/** The command, working directory and process birth time of `pid`, or null when it is not running. */
export function processInfo(pid) {
  if (!alive(pid)) return null;
  let row = "";
  try { row = execFileSync("ps", ["-o", "stat=,command=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return null; }
  const [stat, ...command] = row.split(/\s+/);
  // A zombie has exited and only waits for its parent to collect it.
  if (!stat || stat.startsWith("Z")) return null;
  return { command: command.join(" "), cwd: processCwd(pid), started: startTimeOf(pid) };
}

/** A private fingerprint of the PID's observed lifetime, command and worktree at recording time. */
function processIdentity(pid, info) {
  if (!info?.started || !info.cwd) return null;
  try {
    return createHash("sha256").update(JSON.stringify([pid, info.started, info.command, realpathSync(info.cwd)])).digest("hex");
  } catch { return null; }
}

/** Older records have no stack witness; use the existing owner-only kill ledger's birth record when present. */
function legacyRecordedOwn(pid, worktree, info) {
  if (!info?.started) return false;
  try {
    const file = ledgerFile();
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const ledger = JSON.parse(readFileSync(file, "utf8"));
    if (!ownershipWorktree({ cwd: ledger[String(pid)]?.cwd }, worktree)) return false;
    return recordedOwn(ledger, pid, info.cwd, () => info.started);
  } catch { return false; }
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
  if (!ownershipWorktree(info, worktree)) return { owned: false, reason: "it does not run in the session's worktree" };
  return { owned: true };
}

/** Captures new PIDs while preserving a prior PID's witness so a later stack update cannot promote its reuse. */
export function captureSessionProcessIdentities(worktree, stack, { read = processInfo, previous } = {}) {
  const next = { ...(stack ?? {}) };
  for (const [kind, spec] of Object.entries(KINDS)) {
    delete next[spec.identityKey];
    const pid = next[spec.pidKey];
    if (pid === undefined || pid === null) continue;
    if (previous?.[spec.pidKey] === pid) {
      if (previous[spec.identityKey]) next[spec.identityKey] = previous[spec.identityKey];
      continue;
    }
    const info = read(pid);
    if (ownership(kind, info, worktree).owned) {
      const identity = processIdentity(pid, info);
      if (identity) next[spec.identityKey] = identity;
    }
  }
  return next;
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
 * A verified process that survives the wait rejects the stop, so confirmed discard retains its worktree.
 */
export async function stopSessionProcesses(worktree, stack, { read = processInfo, signal = process.kill, waitMs = STOP_WAIT_MS } = {}) {
  const results = [];
  const next = { ...(stack ?? {}) };
  for (const [kind, spec] of Object.entries(KINDS)) {
    const pid = stack?.[spec.pidKey];
    if (pid === undefined || pid === null) continue;
    const info = read(pid);
    const { owned, reason } = ownership(kind, info, worktree);
    const recordedIdentity = stack?.[spec.identityKey];
    const matches = (current) => recordedIdentity
      ? processIdentity(pid, current) === recordedIdentity
      : legacyRecordedOwn(pid, worktree, current);
    if (!owned || !matches(info)) {
      results.push({ kind, pid, result: info ? "left-alone" : "not-running",
        reason: !owned ? reason : recordedIdentity ? "its recorded process identity changed" : "no matching legacy birth record" });
      if (!info) spec.clear.forEach((key) => delete next[key]);
      continue;
    }
    for (const member of tree(pid)) {
      const current = read(member);
      // Descendants can run another ticket's command. Signal only those still in this session's worktree.
      if (!current || (member === pid ? !matches(current)
        : !ownershipWorktree(current, worktree))) continue;
      try { signal(member, "SIGTERM"); } catch { /* already gone */ }
    }
    const deadline = Date.now() + waitMs;
    while (read(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const stopped = !read(pid);
    results.push({ kind, pid, result: stopped ? "stopped" : "still-running" });
    if (stopped) spec.clear.forEach((key) => delete next[key]);
  }
  if (results.some((entry) => entry.result === "still-running")) {
    throw new Error("The session's recorded process is still running; its worktree was retained.");
  }
  return { results, stack: next };
}

function ownershipWorktree(info, worktree) {
  try {
    const root = realpathSync(worktree);
    const cwd = realpathSync(info.cwd);
    return cwd === root || cwd.startsWith(`${root}${path.sep}`);
  } catch { return false; }
}
