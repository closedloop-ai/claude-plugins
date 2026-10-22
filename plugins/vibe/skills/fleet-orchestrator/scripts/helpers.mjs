#!/usr/bin/env node
// The orchestrator's helper ledger. Idle helper panes hide the active ones
// from the operator, so a helper (reviewer, verifier, QA prep, poller) stops
// as soon as its result is accepted and a fresh one is launched from its saved
// brief at the next trigger. `status` lists every helper whose result was
// accepted more than --idle-minutes ago and that is not recorded as stopped.
//
// Usage: helpers.mjs <orchDir> start <name> [--brief <file>] [--stack <stack>]
//        helpers.mjs <orchDir> pid <name> <pid...> [--group]
//        helpers.mjs <orchDir> accepted <name>
//        helpers.mjs <orchDir> stopped <name> [--grace-seconds <n, default 10>]
//        helpers.mjs <orchDir> hand <stack> --to <guide>
//        helpers.mjs <orchDir> unhand <stack>
//        helpers.mjs <orchDir> status [--idle-minutes <n, default 5>] [--now <iso>]
//
// `pid` records processes a helper started (dev servers, app stacks); the
// helper records its own. Pass `--group` only for a process the helper spawned
// detached, so it leads its own process group. `stopped` ends every recorded
// process that is still alive and ours (SIGTERM, then SIGKILL after the grace)
// and records the helper stopped only when none is left; otherwise it prints
// `ALIVE <name> <pids>` and exits 1. A whole group is signalled only for a
// `--group` pid whose process group id still equals the pid; any other pid is
// signalled alone. A pid of 1 or lower, this process or its parent is never
// recorded or signalled, and neither is a pid the system says is not ours
// (EPERM). A recorded pid can be reused, even by one of the user's own apps,
// so `pid` stores each process's start time and command (`ps -o
// lstart=,command=`), refusing one it cannot read, and every signal re-reads
// them first: a pid whose identity differs, cannot be read, or was never
// recorded is treated as not ours and never signalled, alone or as a group.
// `stopped` also refuses, before ending anything, a helper that owns a standing
// duty on the fleet board (board.mjs `duty`): it prints `OWNS <duty>` and exits
// 1 until the duty has another owner. Main's post-merge health once went
// unwatched for an hour after its watcher was stopped with no replacement.
// `hand` marks a running app stack (a worktree path, port or URL) as handed to
// a human QA guide; `start --stack` on a handed stack exits 1, so a rerun that
// toggles flags or moves data launches its own stack.
//
// `status` prints `STOP <name> accepted <n>m ago` and `ORPHAN <name> <pids> still running`
// lines, then `helpers: <active> active, <stop> to stop, <orphans> orphaned`,
// and exits 1 when any helper should be stopped or left processes running.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveWorkDir } from "../../codex-fleet-monitor/scripts/work-dir.mjs";

const LEDGER = "helpers.json";
const STACKS = "#stacks";
const DEFAULT_IDLE_MINUTES = 5;
const DEFAULT_GRACE_SECONDS = 10;
const POLL_MS = 200;

/** Helpers to stop: accepted more than `idleMinutes` before `now` and never recorded stopped. */
export function stopCandidates(ledger, now, idleMinutes = DEFAULT_IDLE_MINUTES) {
  return helperEntries(ledger)
    .filter(([, helper]) => helper.acceptedAt && !helper.stoppedAt && now - Date.parse(helper.acceptedAt) > idleMinutes * 60_000)
    .map(([name, helper]) => ({ name, minutes: Math.floor((now - Date.parse(helper.acceptedAt)) / 60_000), brief: helper.brief ?? null }));
}

/** Stopped helpers whose recorded processes still run. Stopped QA agents once left dev servers running for 13 to 16 hours on a loaded machine. */
export function orphans(ledger, alive = isAlive) {
  return helperEntries(ledger)
    .filter(([, helper]) => helper.stoppedAt)
    .map(([name, helper]) => ({ name, pids: (helper.pids ?? []).filter(alive) }))
    .filter((helper) => helper.pids.length > 0);
}

/** Whether endProcesses may signal a pid: kill(-1) reaches every process the user owns and kill(0) the caller's own group. */
export function safePid(pid) {
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;
}

/** Parses recorded pids, refusing anything that is not an integer above 1. */
export function parsePids(texts) {
  const pids = texts.map(Number);
  if (pids.length === 0 || !pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)) {
    throw new Error("pid needs one or more process ids above 1.");
  }
  return pids;
}

/** `alive`, `gone`, or `foreign` when the process exists but is not ours (EPERM). */
export function probe(pid, kill = defaultKill) {
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    return error?.code === "EPERM" ? "foreign" : "gone";
  }
}

/** Whether a process exists, ours or not. */
export function isAlive(pid) {
  return probe(pid) !== "gone";
}

/** A process's start time and command (`ps -o lstart=,command=`), or null when it cannot be read. */
export function readIdentity(pid) {
  const result = spawnSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const identity = result.stdout?.trim();
  return result.status === 0 && identity ? identity : null;
}

/** The process group id of `pid`, or null when it cannot be read. */
export function readGroupId(pid) {
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  const group = Number(result.stdout?.trim());
  return result.status === 0 && Number.isSafeInteger(group) ? group : null;
}

/**
 * Ends `targets` ({ pid, group, identity }), SIGKILLs what outlives the
 * grace, and returns the pids still alive and ours. Unsafe and foreign pids
 * are never signalled; a pid is ours only while `identityOf` still returns
 * the identity recorded for it. `kill`, `groupOf` and `identityOf` are
 * injectable so tests can check every decision without sending a real signal.
 */
export async function endProcesses(targets, graceSeconds = DEFAULT_GRACE_SECONDS, { kill = defaultKill, groupOf = readGroupId, identityOf = readIdentity } = {}) {
  const owned = targets.filter((target) => safePid(target.pid));
  const same = (target) => typeof target.identity === "string" && target.identity !== "" && identityOf(target.pid) === target.identity;
  const live = () => owned.filter((target) => probe(target.pid, kill) === "alive" && same(target));
  const signal = (target, name) => {
    const { pid, group } = target;
    // Checked again here so no edit to the filter above can ever reach kill(-1).
    if (!(pid > 1)) return;
    // Re-read right before the signal: the pid may have been reused since the last check.
    if (!same(target)) return;
    const wholeGroup = group === true && groupOf(pid) === pid;
    try {
      kill(wholeGroup ? -pid : pid, name);
    } catch {
      // Already gone.
    }
  };
  for (const target of live()) signal(target, "SIGTERM");
  const deadline = Date.now() + graceSeconds * 1000;
  while (live().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  for (const target of live()) signal(target, "SIGKILL");
  const killDeadline = Date.now() + 2000;
  while (live().length > 0 && Date.now() < killDeadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return live().map((target) => target.pid);
}

function defaultKill(pid, name) {
  process.kill(pid, name);
}

function helperEntries(ledger) {
  return Object.entries(ledger).filter(([name]) => name !== STACKS);
}

function read(orchDir) {
  const file = path.join(orchDir, LEDGER);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function write(orchDir, ledger) {
  const file = path.join(orchDir, LEDGER);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** Standing duties on the fleet board (board.json) that `name` owns. */
export function ownedDuties(orchDir, name) {
  const file = path.join(orchDir, "board.json");
  const duties = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).duties ?? {} : {};
  return Object.entries(duties).filter(([, duty]) => duty?.owner === name).map(([duty]) => duty);
}

function requireName(action, name) {
  if (!name) {
    throw new Error(`${action} needs a name.`);
  }
  if (name === STACKS) {
    throw new Error(`${name} is reserved.`);
  }
  return name;
}

async function main(argv) {
  const [workDir, action, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      brief: { type: "string" },
      stack: { type: "string" },
      to: { type: "string" },
      "idle-minutes": { type: "string" },
      "grace-seconds": { type: "string" },
      group: { type: "boolean" },
      now: { type: "string" },
    },
  });
  if (!workDir || !["start", "pid", "accepted", "stopped", "hand", "unhand", "status"].includes(action)) {
    throw new Error("Usage: helpers.mjs <orchDir> start|pid|accepted|stopped|hand|unhand <name> | status [--idle-minutes <n>]");
  }
  const orchDir = resolveWorkDir(workDir).dir;
  const ledger = read(orchDir);
  const now = values.now ? Date.parse(values.now) : Date.now();
  const at = new Date(now).toISOString();
  if (action === "status") {
    const stop = stopCandidates(ledger, now, values["idle-minutes"] === undefined ? DEFAULT_IDLE_MINUTES : Number(values["idle-minutes"]));
    for (const helper of stop) {
      process.stdout.write(`STOP ${helper.name} accepted ${helper.minutes}m ago${helper.brief ? `; relaunch from ${helper.brief}` : ""}\n`);
    }
    const left = orphans(ledger);
    for (const helper of left) {
      process.stdout.write(`ORPHAN ${helper.name} ${helper.pids.join(" ")} still running\n`);
    }
    const active = helperEntries(ledger).filter(([, helper]) => !helper.stoppedAt).length;
    process.stdout.write(`helpers: ${active} active, ${stop.length} to stop, ${left.length} orphaned\n`);
    return stop.length + left.length === 0 ? 0 : 1;
  }
  const name = requireName(action, positionals[0]);
  const stacks = ledger[STACKS] ?? {};
  if (action === "hand" || action === "unhand") {
    if (action === "hand") {
      if (!values.to) {
        throw new Error("hand needs --to <guide>.");
      }
      stacks[name] = { guide: values.to, handedAt: at };
    } else {
      delete stacks[name];
    }
    ledger[STACKS] = stacks;
    write(orchDir, ledger);
    return 0;
  }
  if (action === "start") {
    // A QA rerun must never change the stack a human is testing on.
    if (values.stack && stacks[values.stack]) {
      process.stderr.write(`stack ${values.stack} is handed to ${stacks[values.stack].guide}; launch this helper on its own stack\n`);
      return 1;
    }
    ledger[name] = { startedAt: at, ...(values.brief ? { brief: values.brief } : {}), ...(values.stack ? { stack: values.stack } : {}) };
  } else if (action === "pid") {
    const pids = parsePids(positionals.slice(1));
    const identities = Object.fromEntries(pids.map((pid) => [pid, readIdentity(pid)]));
    const unreadable = pids.filter((pid) => !identities[pid]);
    if (unreadable.length > 0) {
      throw new Error(`cannot read the start time and command of ${unreadable.join(" ")}; record only a running process this helper started.`);
    }
    const entry = ledger[name] ?? {};
    const groups = values.group ? [...new Set([...(entry.groups ?? []), ...pids])] : (entry.groups ?? []);
    ledger[name] = {
      ...entry,
      pids: [...new Set([...(entry.pids ?? []), ...pids])],
      identities: { ...(entry.identities ?? {}), ...identities },
      ...(groups.length > 0 ? { groups } : {}),
    };
  } else if (action === "accepted") {
    ledger[name] = { ...(ledger[name] ?? {}), acceptedAt: at };
  } else {
    const owned = ownedDuties(orchDir, name);
    if (owned.length > 0) {
      for (const duty of owned) {
        process.stdout.write(`OWNS ${duty}; give it a new owner first: board.mjs <orchDir> duty ${duty} --owner <replacement>\n`);
      }
      return 1;
    }
    const grace = values["grace-seconds"] === undefined ? DEFAULT_GRACE_SECONDS : Number(values["grace-seconds"]);
    const entry = ledger[name] ?? {};
    const groups = new Set(entry.groups ?? []);
    const survivors = await endProcesses((entry.pids ?? []).map((pid) => ({ pid, group: groups.has(pid), identity: entry.identities?.[pid] })), grace);
    if (survivors.length > 0) {
      process.stdout.write(`ALIVE ${name} ${survivors.join(" ")}\n`);
      return 1;
    }
    ledger[name] = { ...(ledger[name] ?? {}), stoppedAt: at };
  }
  write(orchDir, ledger);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    }
  );
}
