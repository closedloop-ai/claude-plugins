#!/usr/bin/env node
// One containerized e2e stack per machine. symphony-alpha's e2e stack
// (`e2e/compose.yml`, run directly or through `dagger call e-2-e`) uses one
// fixed compose project name, fixed host ports and shared Dagger cache
// volumes, so two vibe sessions that start it at the same time break each
// other's run. Every vibe e2e command runs through this lock: it waits for the
// stack to be free, runs the command, and releases the lock when the command
// ends. A lock left by a process that no longer exists is taken over.
//
// Usage: e2e-lock.mjs run [--wait-seconds <n>] [--lock-dir <dir>] <command> [args...]
//        e2e-lock.mjs status [--lock-dir <dir>]
//
// The lock's own options come first; the first other word starts the command,
// so the command keeps every flag of its own.
//
// One session takes one entry per head: a `run` from a worktree that already
// holds or waits for the stack runs nothing, prints {"status":"duplicate",...}
// and exits 76, so a session batches its selected specs into one run instead
// of queueing one entry per spec.
//
// `run` exits with the command's own code. When the stack stays busy past
// `--wait-seconds` (default 3600) it runs nothing, prints
// {"status":"busy","holder":{...}} and exits 75. `status` prints
// {"status":"free"} or {"status":"held","holder":{...}}.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BUSY_EXIT = 75;
export const DUPLICATE_EXIT = 76;
const DEFAULT_WAIT_SECONDS = 3600;
const POLL_MS = 5_000;
const OWNER_FILE = "owner.json";
const OWNERLESS_GRACE_MS = 60_000;

/** The machine-wide lock folder, shared by every worktree and both harnesses. */
export function defaultLockDir(home = os.homedir()) {
  return path.join(home, ".codex", "vibe", "locks", "e2e-stack");
}

/** Takes the lock once; returns the owner record on success, or the current holder when it is held. */
export function tryAcquire(lockDir, owner) {
  mkdirSync(path.dirname(lockDir), { recursive: true });
  if (createLock(lockDir, owner)) {
    return { acquired: true, holder: owner };
  }
  const holder = readHolder(lockDir);
  if (holder ? isAlive(holder.pid) : isRecent(lockDir)) {
    return { acquired: false, holder };
  }
  // Remove only the stale lock that was just read, never one a peer took in the meantime.
  if (readHolder(lockDir)?.token === holder?.token) {
    rmSync(lockDir, { recursive: true, force: true });
  }
  return createLock(lockDir, owner)
    ? { acquired: true, holder: owner }
    : { acquired: false, holder: readHolder(lockDir) };
}

/** Releases the lock only when this owner still holds it. */
export function release(lockDir, owner) {
  if (readHolder(lockDir)?.token === owner.token) {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** Waits for the lock up to `waitSeconds`, polling every `pollMs`. */
export async function acquire(lockDir, owner, { waitSeconds = DEFAULT_WAIT_SECONDS, pollMs = POLL_MS } = {}) {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const attempt = tryAcquire(lockDir, owner);
    if (attempt.acquired || Date.now() >= deadline) {
      return attempt;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

/** A live holder or waiter of the lock started from `worktree`, or null. */
export function sameWorktreeEntry(lockDir, worktree) {
  const entries = [readHolder(lockDir), ...readWaiters(lockDir)];
  return entries.find((entry) => entry && (entry.worktree ?? entry.cwd) === worktree && isAlive(entry.pid)) ?? null;
}

function waitersDir(lockDir) {
  return `${lockDir}.waiters`;
}

function readWaiters(lockDir) {
  try {
    return readdirSync(waitersDir(lockDir)).map((name) => {
      try {
        const waiter = JSON.parse(readFileSync(path.join(waitersDir(lockDir), name), "utf8"));
        return Number.isSafeInteger(waiter?.pid) ? waiter : null;
      } catch {
        return null;
      }
    });
  } catch {
    return [];
  }
}

function worktreeOf(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return cwd;
  }
}

/** The lock's current holder, or null when it is free or its owner record is unreadable. */
export function readHolder(lockDir) {
  try {
    const holder = JSON.parse(readFileSync(path.join(lockDir, OWNER_FILE), "utf8"));
    return Number.isSafeInteger(holder?.pid) && typeof holder.token === "string" ? holder : null;
  } catch {
    return null;
  }
}

function createLock(lockDir, owner) {
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  writeFileSync(path.join(lockDir, OWNER_FILE), JSON.stringify(owner), { mode: 0o600 });
  return true;
}

// A lock folder whose owner record is not written yet belongs to a peer that is still taking it.
function isRecent(lockDir) {
  try {
    return Date.now() - statSync(lockDir).mtimeMs < OWNERLESS_GRACE_MS;
  } catch {
    return false;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

const OWN_OPTIONS = new Set(["--wait-seconds", "--lock-dir"]);

// The action, then the lock's own `--option value` pairs, then the command and its arguments untouched.
function parseCommandLine(argv) {
  const [action, ...rest] = argv;
  const values = {};
  let index = 0;
  while (OWN_OPTIONS.has(rest[index])) {
    if (rest[index + 1] === undefined) {
      throw new Error(`${rest[index]} needs a value.`);
    }
    values[rest[index].slice(2)] = rest[index + 1];
    index += 2;
  }
  const [command, ...args] = rest.slice(index);
  return { action, values, command, args };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    const forward = (signal) => child.kill(signal);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(code ?? 128 + (os.constants.signals[signal] ?? 0));
    });
  });
}

async function main(argv) {
  const { action, values, command, args } = parseCommandLine(argv);
  const lockDir = path.resolve(values["lock-dir"] ?? defaultLockDir());
  if (action === "status") {
    const holder = readHolder(lockDir);
    const held = holder && isAlive(holder.pid);
    process.stdout.write(`${JSON.stringify(held ? { status: "held", holder } : { status: "free" })}\n`);
    return 0;
  }
  if (action !== "run" || !command) {
    throw new Error("Usage: e2e-lock.mjs run [--wait-seconds <n>] [--lock-dir <dir>] <command> [args...]");
  }
  const waitSeconds = values["wait-seconds"] === undefined ? DEFAULT_WAIT_SECONDS : Number(values["wait-seconds"]);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    throw new Error("--wait-seconds must be zero or a positive number of seconds.");
  }
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    cwd: process.cwd(),
    worktree: worktreeOf(process.cwd()),
    command: [command, ...args].join(" ").slice(0, 500),
    startedAt: new Date().toISOString(),
  };
  const duplicate = sameWorktreeEntry(lockDir, owner.worktree);
  if (duplicate) {
    process.stdout.write(`${JSON.stringify({ status: "duplicate", entry: duplicate, reason: "this worktree already holds or waits for the stack; put every selected spec in one run per head" })}\n`);
    return DUPLICATE_EXIT;
  }
  const waiter = path.join(waitersDir(lockDir), `${owner.token}.json`);
  mkdirSync(waitersDir(lockDir), { recursive: true });
  writeFileSync(waiter, JSON.stringify(owner), { mode: 0o600 });
  let attempt;
  try {
    attempt = await acquire(lockDir, owner, { waitSeconds });
  } finally {
    rmSync(waiter, { force: true });
  }
  if (!attempt.acquired) {
    process.stdout.write(`${JSON.stringify({ status: "busy", holder: attempt.holder })}\n`);
    return BUSY_EXIT;
  }
  try {
    return await runCommand(command, args);
  } finally {
    release(lockDir, owner);
  }
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
