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
// Usage: kill-guard.mjs own <pid>... | stop <pid> | apply-approved <program> <receipt.json> <literal original command>

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandSegments } from "./command-segments.mjs";
import { deny, eventCwd } from "./hook-dispatch.mjs";
import { isEntryPoint } from "../shared/plugin-roots.mjs";

const SIGNAL_OPTION = /^-(?:[A-Za-z][A-Za-z0-9+-]*|\d+)$/;
const BY_NAME = /^p?kill(?:all)?$/;
const APPROVAL_HINT = "Ask the fleet orchestrator for approval of its own workers' recorded targets, or the operator for other targets. Run only the approved literal PID snapshot.";
const APPROVED_SIGNALS = new Set(["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"]);

/** The file recording the pids each session called its own. */
export function ledgerFile(home = os.homedir()) {
  return path.join(home, ".claude", "vibe", "owned-pids.json");
}

/** Problems with the signal-sending commands in `command`; `isOwn(pid)` says whether a pid is recorded as this session's. */
export function killProblems(command, isOwn) {
  const problems = [];
  for (const { words, remote, hasSubstitution } of commandSegments(command, { expandShellPayloads: true })) {
    const name = path.basename(words[0] ?? "");
    if (name !== "kill" && BY_NAME.test(name)) {
      problems.push(`${name} signals by pattern, which can end other sessions' processes; ${APPROVAL_HINT}`);
    } else if (name === "xargs" && words.slice(1).some((word) => path.basename(word) === "kill")) {
      problems.push(`xargs kill signals whatever a search matched; ${APPROVAL_HINT}`);
    } else if (name === "kill") {
      if (hasSubstitution) {
        problems.push(`kill with a command substitution signals whatever a search matched; ${APPROVAL_HINT}`);
      }
      if (!remote) problems.push(...killTargets(words.slice(1), isOwn));
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

/** Stop one previously recorded PID without importing or requiring any installed plugin version. */
export function stopOwnedPid(pid, { cwd = process.cwd(), ledger = readLedger(ledgerFile()), startOf = startTimeOf, signal = process.kill } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid || !recordedOwn(ledger, pid, cwd, startOf)) {
    throw new Error("stop needs one live PID this session started and recorded");
  }
  signal(pid, "SIGTERM");
}

/** Verify a single exact command receipt against its ruling and the process identities it approved. */
export function approvedSignalTargets(record, { command, rulings, owns, clock = Date.now, startOf = startTimeOf }) {
  if (record?.version !== 1 || record.command !== command || !APPROVED_SIGNALS.has(record.signal)
    || !["operator", "orchestrator"].includes(record.authority) || !Array.isArray(record.targets) || !record.targets.length) {
    throw new Error("the recorded approval does not match this command, authority, signal and PID snapshot");
  }
  const expires = Date.parse(record.expiresAt);
  if (!Number.isFinite(expires) || expires < clock()) throw new Error("the signal approval expired");
  const digest = createHash("sha256").update(JSON.stringify([record.command, record.authority, record.signal, record.expiresAt, record.targets])).digest("hex");
  if (!rulings.split(/\r?\n/).some((line) => line.trim() === `Signal approval: ${record.authority} ${digest}`)) {
    throw new Error("the fleet program contains no ruling for this exact approval snapshot");
  }
  const seen = new Set();
  for (const target of record.targets) {
    if (!Number.isSafeInteger(target?.pid) || target.pid <= 1 || target.pid === process.pid || target.pid === process.ppid
      || seen.has(target.pid) || typeof target.started !== "string" || startOf(target.pid) !== target.started
      || (record.authority === "orchestrator" && !owns(target))) {
      throw new Error("the approval includes an unowned, expired, duplicate or unrecognized process identity");
    }
    seen.add(target.pid);
  }
  return record.targets;
}

/** Consume the operator-owned receipt before sending any signal, and never execute its command string. */
function applyApproved(program, file, command) {
  const directory = realpathSync(program);
  const approvals = path.join(directory, "approved-signals");
  const st = lstatSync(approvals);
  if (!st.isDirectory() || realpathSync(approvals) !== approvals) throw new Error("use the fleet program's owned approval directory");
  if (!/^[a-zA-Z0-9_.-]+\.json$/.test(file)) throw new Error("use the approval receipt's basename");
  const approval = path.join(approvals, file);
  const receipt = lstatSync(approval);
  if (!receipt.isFile() || receipt.uid !== process.getuid() || (receipt.mode & 0o077) || receipt.size > 32768) {
    throw new Error("the approval receipt is not an owned private regular file");
  }
  const record = JSON.parse(readFileSync(approval, "utf8"));
  const rulings = readFileSync(path.join(directory, "rulings.md"), "utf8");
  const board = JSON.parse(readFileSync(path.join(directory, "board.json"), "utf8"));
  const ledger = readLedger(ledgerFile());
  const roots = Object.values(board.writers ?? {}).filter((writer) => !writer.retiredAt && writer.worktree).map((writer) => writer.worktree);
  const owns = ({ pid, cwd }) => typeof cwd === "string" && roots.some((root) => cwd === root || cwd.startsWith(root + path.sep))
    && recordedOwn(ledger, pid, cwd);
  const targets = approvedSignalTargets(record, { command, rulings, owns });
  renameSync(approval, `${approval}.used`);
  for (const { pid, started } of targets) {
    if (startTimeOf(pid) !== started) throw new Error(`recorded process ${pid} changed before it could be signaled`);
    process.kill(pid, record.signal);
  }
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

if (isEntryPoint(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === "own" && args.length) recordOwn(args, process.cwd());
    else if (action === "stop" && args.length === 1 && /^\d+$/.test(args[0])) stopOwnedPid(Number(args[0]));
    else if (action === "apply-approved" && args.length === 3) applyApproved(...args);
    else throw new Error("usage: kill-guard.mjs own <pid>... | stop <pid> | apply-approved <program> <receipt.json> <literal original command>");
  } catch (error) {
    process.stderr.write(`kill-guard: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
