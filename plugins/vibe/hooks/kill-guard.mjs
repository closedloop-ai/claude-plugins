#!/usr/bin/env node
// PreToolUse guard for Bash: a session signals only processes it recorded as
// its own. A writer once killed a shared laptop's test runs by pattern
// (`-f "turbo test --filter"`), which can end other sessions' runs, and a
// plugin test's kill(-1) once ended every app on the operator's machine; a
// written rule against both already existed. So the by-name killers (the p
// and all variants of kill), `xargs kill`, and `kill` with a pattern, a
// variable, a command substitution, or a pid of 1 or lower (zero and negative
// pids signal whole process groups) are refused. `kill <pid>`
// passes only for a pid recorded here as this session's own, still running the
// process that was recorded.
//
// The hook runs from pre-tool-use.mjs.
// Usage (record): kill-guard.mjs own <pid>...   (run from the session's working directory, for example with $!)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandSegments } from "./command-segments.mjs";
import { deny, eventCwd, isMain } from "./hook-dispatch.mjs";

const SIGNAL_OPTION = /^-(?:[A-Za-z][A-Za-z0-9+-]*|\d+)$/;
const SUBSTITUTED_KILL = /(?:^|[\s;&|(])kill\b[^;&|\n]*(?:\$\(|`)/;
const BY_NAME = /^p?kill(?:all)?$/;

/** The file recording the pids each session called its own. */
export function ledgerFile(home = os.homedir()) {
  return path.join(home, ".claude", "vibe", "owned-pids.json");
}

/** Problems with the signal-sending commands in `command`; `isOwn(pid)` says whether a pid is recorded as this session's. */
export function killProblems(command, isOwn) {
  const problems = SUBSTITUTED_KILL.test(command)
    ? ["kill with a command substitution signals whatever a search matched; kill only a pid you recorded as your own"]
    : [];
  for (const { words } of commandSegments(command)) {
    const name = path.basename(words[0] ?? "");
    if (name !== "kill" && BY_NAME.test(name)) {
      problems.push(`${name} signals by pattern, which can end other sessions' processes; record your own pid when you start a process and run kill <pid>`);
    } else if (name === "xargs" && words.slice(1).some((word) => path.basename(word) === "kill")) {
      problems.push("xargs kill signals whatever a search matched; kill only a pid you recorded as your own");
    } else if (name === "kill") {
      problems.push(...killTargets(words.slice(1), isOwn));
    }
  }
  return problems;
}

function killTargets(args, isOwn) {
  if (args.some((arg) => arg === "-l" || arg === "-L")) return [];
  const targets = [];
  let signalSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      targets.push(...args.slice(index + 1));
      break;
    }
    if (!signalSeen && (arg === "-s" || arg === "-n")) {
      signalSeen = true;
      index += 1;
    } else if (!signalSeen && SIGNAL_OPTION.test(arg)) {
      signalSeen = true;
    } else {
      targets.push(arg);
    }
  }
  const problems = [];
  for (const target of targets) {
    if (/^%\d+$/.test(target)) continue;
    if (!/^-?\d+$/.test(target)) {
      problems.push(`kill ${target}: name the pid as a number this session recorded as its own, never a pattern, variable or command substitution`);
    } else if (Number(target) <= 1) {
      problems.push(`kill ${target}: a pid of 1 or lower signals every process or a whole process group`);
    } else if (!isOwn(Number(target))) {
      problems.push(`kill ${target}: pid ${target} is not recorded as this session's own; record a process you start with \`node <vibe plugin>/hooks/kill-guard.mjs own <pid>\``);
    }
  }
  return problems;
}

/** A process's start time as ps reports it, or null when it is not running. */
export function startTimeOf(pid) {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** Whether `pid` is recorded for a directory containing `cwd` and still runs the recorded process. */
export function recordedOwn(ledger, pid, cwd, startOf = startTimeOf) {
  const entry = ledger[String(pid)];
  if (!entry || !(cwd === entry.cwd || cwd.startsWith(`${entry.cwd}${path.sep}`))) return false;
  const started = startOf(pid);
  return started !== null && started === entry.started;
}

function readLedger(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  } catch {
    return {};
  }
}

function recordOwn(pids, cwd, file = ledgerFile()) {
  const ledger = readLedger(file);
  for (const text of pids) {
    const pid = Number(text);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) {
      throw new Error(`refusing to record ${text}: only a pid above 1 that this session started`);
    }
    const started = startTimeOf(pid);
    if (started === null) throw new Error(`pid ${pid} is not running`);
    ledger[String(pid)] = { cwd, started };
  }
  for (const key of Object.keys(ledger)) if (startTimeOf(Number(key)) !== ledger[key].started) delete ledger[key];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** The PreToolUse result for a Bash call: a deny naming every signal it may not send, or null. */
export function killGuard(event) {
  const command = event?.tool_input?.command;
  if (typeof command !== "string") return null;
  const ledger = readLedger(ledgerFile());
  const cwd = eventCwd(event);
  const problems = killProblems(command, (pid) => recordedOwn(ledger, pid, cwd));
  return problems.length === 0 ? null : deny(`Signal only processes this session started and recorded: ${problems.join("; ")}`);
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv[2] !== "own") throw new Error("usage: kill-guard.mjs own <pid>...");
    recordOwn(process.argv.slice(3), process.cwd());
  } catch (error) {
    process.stderr.write(`kill-guard: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
