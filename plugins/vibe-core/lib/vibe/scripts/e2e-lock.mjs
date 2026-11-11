#!/usr/bin/env node
// One containerized e2e stack per machine. A repository's containerized e2e stack (one
// repository's compose file, run directly or through Dagger) uses one
// fixed compose project name, fixed host ports and shared Dagger cache
// volumes, so two vibe sessions that start it at the same time break each
// other's run. Every vibe e2e command runs through this lock: it waits for the
// stack to be free, runs the command, and releases the lock when the command
// ends. A lock left by a process that no longer exists is taken over.
//
// Usage: e2e-lock.mjs run --head <sha> [--source-hash <treeSha256>] [--owner <writer>] [--ticket <slug>] [--wait-seconds <n>] [--lock-dir <dir>] [--foreign-compose <project>]... <command> [args...]
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
// A run overlapped a stack another tool started on the same fixed compose
// project and ports, and its teardown removed that live stack. So `run` gives
// the command its own compose project (`COMPOSE_PROJECT_NAME=vibe-e2e-<id>`,
// unless the caller already set one), and a teardown inside it removes only
// the project it created. Each `--foreign-compose <project>` (or the
// comma-separated `VIBE_E2E_FOREIGN_COMPOSE`) names a stack started outside
// this lock: while `docker compose ls` shows it running, the stack counts as
// busy. Without Docker, or when the listing fails, nothing is checked.
//
// `run` checks HEAD against `--head`, fingerprints uncommitted inputs
// (tested-head.mjs), prints both identities and fails (exit 1) when either moves: runs once went on at an old commit
// after every checkout failed, and passes were reported for a commit never tested.
// Accepted runs retain HEAD plus diff/tree hashes under <gitdir>/vibe-e2e-results.
// A `--no-build` run also needs its compose project's images recorded as built
// from that HEAD in that worktree (image-head.mjs, beside the lock folder), and a
// passing build records them.
// Generated Compose projects start empty. A verified containerized build checks
// the Docker backing disk after lock acquisition, then uses a run-owned Buildx
// builder and Turbo cache. Exact Docker resources, local image tags, builder
// and cache are reconciled in that order; a refusal retains a private pending
// record. Caller and foreign projects stay.
//
// `run` exits with the command's own code. When the stack stays busy past
// `--wait-seconds` (default 3600) it runs nothing, prints
// {"status":"busy","holder":{...}} and exits 75. `status` prints
// {"status":"free"} or {"status":"held","holder":{...}}.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { escalation, isSandboxRefusal } from "./sandbox-refusal.mjs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as pause } from 'node:timers/promises';
import { imageProblem, recordImages } from "./image-head.mjs";
import { readProcessIdentity } from "../../../shared/process-identity.mjs";
import { testedSource, sameSource, withStableSource } from "./tested-head.mjs";

import { isContainerizedBuild, measureDockerDisk, requireDockerDisk } from './docker-disk-admission.mjs';
import { installOwnedBuildShim, ownedBuildEnvironment, prepareRunOwnedBuild, recordBuiltTags } from './owned-builder.mjs';
import { hasPendingOwnedCleanups, pendingOwnedCleanups, registerFleetWriterRetirements,
  registerWorktreeRetirement, remainingCleanupBudget, sweepOwnedCleanups } from './owned-cleanup.mjs';
import { captureOwnedDockerResources, plannedLocalTags, reconcileGeneratedE2E, recordE2EChild,
  removeOwnedDockerResources, reserveGeneratedE2E } from './owned-docker.mjs';
import { e2eWaitersDir, readE2eWaiters, waitForReloadFence, writeAtomic } from './owned-state.mjs';

export { isContainerizedBuild, measureDockerDisk, requireDockerDisk } from './docker-disk-admission.mjs';
export { installOwnedBuildShim, ownedBuildEnvironment, prepareRunOwnedBuild, recordBuiltTags } from './owned-builder.mjs';
export { cleanupDir } from './owned-state.mjs';
export { hasPendingOwnedCleanups, pendingOwnedCleanups, registerFleetWriterRetirements,
  registerWorktreeRetirement, remainingCleanupBudget, sweepOwnedCleanups } from './owned-cleanup.mjs';
export { captureOwnedDockerResources, plannedLocalTags, reconcileGeneratedE2E, recordE2EChild,
  removeOwnedDockerResources, reserveGeneratedE2E } from './owned-docker.mjs';

export const BUSY_EXIT = 75;
export const DUPLICATE_EXIT = 76;
const DEFAULT_WAIT_SECONDS = 3600;
const POLL_MS = 5_000;
const OWNER_FILE = "owner.json";
const OWNERLESS_GRACE_MS = 60_000;
const COMPOSE_PREFIX = "vibe-e2e-";

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
  if (holder ? isAlive(holder.pid) || pendingChildGroupAlive(lockDir, holder) : isRecent(lockDir)) {
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

/** A dead wrapper cannot release its lock while its recorded detached command group is still alive. */
function pendingChildGroupAlive(lockDir, holder) {
  try {
    const record = JSON.parse(readFileSync(path.join(path.dirname(lockDir), `e2e-cleanup-${holder.token}.json`), 'utf8'));
    if (record.owner?.token !== holder.token || !Number.isSafeInteger(record.child?.pgid) || record.child.pgid <= 1) return false;
    process.kill(-record.child.pgid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Releases the lock only when this owner still holds it. */
export function release(lockDir, owner) {
  if (readHolder(lockDir)?.token === owner.token) {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** Waits for the lock up to `waitSeconds`, polling every `pollMs`. */
export async function acquire(lockDir, owner, { waitSeconds = DEFAULT_WAIT_SECONDS, pollMs = POLL_MS, signal } = {}) {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    signal?.throwIfAborted();
    const attempt = tryAcquire(lockDir, owner);
    if (attempt.acquired || Date.now() >= deadline) {
      return attempt;
    }
    await pause(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}

/** A live holder or waiter of the lock started from `worktree`, or null. */
export function sameWorktreeEntry(lockDir, worktree) {
  const entries = [readHolder(lockDir), ...readE2eWaiters(lockDir).map(record => record.owner)
    .filter(waiter => Number.isSafeInteger(waiter?.pid))];
  return entries.find((entry) => entry && (entry.worktree ?? entry.cwd) === worktree && isAlive(entry.pid)) ?? null;
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

const OWN_OPTIONS = new Set(["--source-hash", "--head", "--owner", "--ticket", "--wait-seconds", "--lock-dir", "--foreign-compose"]);
const REPEATED_OPTIONS = new Set(["--foreign-compose"]);

/** The first of `projects` that `docker compose ls` lists as running, or null; no Docker means none. */
export function runningForeignCompose(projects, docker = process.env.VIBE_E2E_DOCKER || "docker") {
  if (projects.length === 0) {
    return null;
  }
  const listed = spawnSync(docker, ["compose", "ls", "--format", "json"], { encoding: "utf8", timeout: 30_000 });
  if (listed.error || listed.status !== 0) {
    return null;
  }
  let stacks;
  try {
    stacks = JSON.parse(listed.stdout || "[]");
  } catch {
    return null;
  }
  const running = new Set((Array.isArray(stacks) ? stacks : [])
    .filter((stack) => /running/i.test(String(stack?.Status ?? "")))
    .map((stack) => stack.Name));
  return projects.find((project) => running.has(project)) ?? null;
}

/** The compose project a run's command gets: the caller's own, or one named for this run. */
export function composeProjectFor(env, token) {
  return env.COMPOSE_PROJECT_NAME || `${COMPOSE_PREFIX}${token.replace(/-/g, "")}`;
}

// The action, then the lock's own `--option value` pairs, then the command and its arguments untouched.
function parseCommandLine(argv) {
  const [action, ...rest] = argv;
  const values = { "foreign-compose": [] };
  let index = 0;
  while (OWN_OPTIONS.has(rest[index])) {
    if (rest[index + 1] === undefined) {
      throw new Error(`${rest[index]} needs a value.`);
    }
    const key = rest[index].slice(2);
    if (REPEATED_OPTIONS.has(rest[index])) {
      values[key].push(rest[index + 1]);
    } else {
      values[key] = rest[index + 1];
    }
    index += 2;
  }
  const [command, ...args] = rest.slice(index);
  return { action, values, command, args };
}

function runCommand(command, args, env, record) {
  return new Promise((resolve, reject) => {
    // The child gate cannot execute the command until its process group has a
    // durable birth witness. A crash before the release file leaves only a
    // gate that times out; no untracked Docker command can begin.
    const gate = record && path.join(path.dirname(record.file), `e2e-gate-${record.token}.ready`);
    if (record) {
      record.launchPending = true;
      writeAtomic(record.file, record);
    }
    const child = record
      ? spawn(process.execPath, [path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), 'e2e-lock.mjs'),
        'child-gate', gate, command, ...args], { stdio: 'inherit', env, detached: true })
      : spawn(command, args, { stdio: 'inherit', env });
    try {
      if (record) {
        recordE2EChild(record, child.pid);
        writeFileSync(gate, record.token, { mode: 0o600, flag: 'wx' });
        record.launchPending = false;
        writeAtomic(record.file, record);
      }
    }
    catch (error) {
      if (record && child.pid > 1) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
      child.once("close", () => reject(error));
      return;
    }
    let signalForwarded = false;
    const forward = (signal) => {
      if (signalForwarded) {
        if (record && child.pid > 1) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Group already drained. */ } }
        else child.kill('SIGKILL');
        return;
      }
      signalForwarded = true;
      if (record && child.pid > 1) { try { process.kill(-child.pid, signal); } catch { /* Group exited. */ } }
      else child.kill(signal);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    process.on("SIGHUP", forward);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      process.off("SIGHUP", forward);
      resolve(code ?? 128 + (os.constants.signals[signal] ?? 0));
    });
  });
}

function ticketFromBranch(worktree) {
  try {
    const branch = execFileSync("git", ["-C", worktree, "branch", "--show-current"], { encoding: "utf8" }).trim();
    return /\bISS-\d+\b/i.exec(branch)?.[0].toUpperCase() ?? null;
  } catch { return null; }
}

async function main(argv) {
  const { action, values, command, args } = parseCommandLine(argv);
  const lockDir = path.resolve(values["lock-dir"] ?? defaultLockDir());
  if (action === "status") {
    const holder = readHolder(lockDir);
    const held = holder && (isAlive(holder.pid) || pendingChildGroupAlive(lockDir, holder));
    process.stdout.write(`${JSON.stringify(held ? { status: "held", holder } : { status: "free" })}\n`);
    return 0;
  }
  if (action !== "run" || !command) {
    throw new Error("Usage: e2e-lock.mjs run --head <sha> [--owner <writer>] [--ticket <slug>] [--wait-seconds <n>] [--lock-dir <dir>] [--foreign-compose <project>]... <command> [args...]");
  }
  const worktree = worktreeOf(process.cwd());
  const enteredSource = testedSource(worktree, values.head);
  const tested = enteredSource.head;
  const waitSeconds = values["wait-seconds"] === undefined ? DEFAULT_WAIT_SECONDS : Number(values["wait-seconds"]);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    throw new Error("--wait-seconds must be zero or a positive number of seconds.");
  }
  const owner = {
    pid: process.pid,
    identity: readProcessIdentity(process.pid),
    token: randomUUID(),
    cwd: process.cwd(),
    worktree,
    name: values.owner ?? path.basename(worktree),
    ticket: values.ticket ?? ticketFromBranch(worktree),
    command: [command, ...args].join(" ").slice(0, 500),
    startedAt: new Date().toISOString(),
  };
  if (!owner.identity) throw new Error("The e2e lock owner has no process birth witness.");
  const duplicate = sameWorktreeEntry(lockDir, owner.worktree);
  if (duplicate) {
    process.stdout.write(`${JSON.stringify({ status: "duplicate", entry: duplicate, reason: "this worktree already holds or waits for the stack; put every selected spec in one run per head" })}\n`);
    return DUPLICATE_EXIT;
  }
  const foreign = [...values["foreign-compose"], ...(process.env.VIBE_E2E_FOREIGN_COMPOSE ?? "").split(",")]
    .map((name) => name.trim()).filter(Boolean);
  const waiter = path.join(e2eWaitersDir(lockDir), `${owner.token}.json`);
  const deadline = Date.now() + waitSeconds * 1000;
  let attempt;
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error('e2e admission interrupted'));
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  try {
    mkdirSync(e2eWaitersDir(lockDir), { recursive: true });
    writeFileSync(waiter, JSON.stringify(owner), { mode: 0o600 });
    for (;;) {
      const admission = await waitForReloadFence(worktree, { recordFile: waiter, owner, deadline, signal: abort.signal });
      if (!admission.ready) { attempt = { acquired: false, holder: { reloadFence: admission.fence } }; break; }
      attempt = await acquire(lockDir, owner, { waitSeconds: Math.max(0, (deadline - Date.now()) / 1000), signal: abort.signal });
      if (!attempt.acquired) {
        break;
      }
      const busyProject = runningForeignCompose(foreign);
      if (!busyProject) {
        break;
      }
      release(lockDir, owner);
      attempt = { acquired: false, holder: { composeProject: busyProject } };
      if (Date.now() >= deadline) {
        break;
      }
      await pause(Math.min(POLL_MS, Math.max(1, deadline - Date.now())), undefined, { signal: abort.signal });
    }
    abort.signal.throwIfAborted();
  } catch (error) {
    if (attempt?.acquired) release(lockDir, owner);
    throw error;
  } finally {
    rmSync(waiter, { force: true });
    process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
  }
  if (!attempt.acquired) {
    process.stdout.write(`${JSON.stringify({ status: "busy", holder: attempt.holder })}\n`);
    return BUSY_EXIT;
  }
  // Admission follows the queue: another build can consume space while this
  // run waits. Caller-owned projects and verified --no-build runs are exempt.
  if (!process.env.COMPOSE_PROJECT_NAME && isContainerizedBuild(command, args)) {
    try { requireDockerDisk(); }
    catch (error) { release(lockDir, owner); throw error; }
  }
  // Fingerprint after waiting: queued edits must not be reported as the command's inputs.
  let source;
  try {
    source = testedSource(worktree, tested);
    if (!sameSource(enteredSource, source)) throw new Error(`SOURCE-MOVED while queued ${JSON.stringify(enteredSource)} -> ${JSON.stringify(source)}`);
    if (values['source-hash'] !== undefined && values['source-hash'] !== source.treeSha256) {
      throw new Error('SOURCE-HASH-MISMATCH --source-hash must identify the current working tree');
    }
  }
  catch (error) { release(lockDir, owner); throw error; }
  const composeProject = composeProjectFor(process.env, owner.token);
  const generatedProject = !process.env.COMPOSE_PROJECT_NAME;
  const containerizedBuild = generatedProject && isContainerizedBuild(command, args)
    && [command, ...args].some((word) => /(?:^|\/)run-containerized\.sh$/.test(word));
  const dockerReady = generatedProject && spawnSync(process.env.VIBE_E2E_DOCKER || "docker", ["version"],
    { encoding: "utf8", timeout: 10_000 }).status === 0;
  if (containerizedBuild && !dockerReady) { release(lockDir, owner); throw new Error("Owned E2E build needs Docker."); }
  const cleanupFile = path.join(path.dirname(lockDir), `e2e-cleanup-${owner.token}.json`);
  let cleanupRecord;
  const managedHome = lockDir === defaultLockDir() ? os.homedir() : undefined;
  if (dockerReady) {
    try {
      const docker = process.env.VIBE_E2E_DOCKER || "docker";
      cleanupRecord = reserveGeneratedE2E({ token: owner.token.replace(/-/g, ""), project: composeProject, owner,
        startedAt: new Date().toISOString(), plannedTags: plannedLocalTags(docker, composeProject, worktree, command, args),
        discoverImages: generatedProject, file: cleanupFile },
      { home: managedHome });
      if (containerizedBuild) cleanupRecord.requiredBuiltTags = [];
    } catch (error) {
      release(lockDir, owner);
      throw error;
    }
  }
  process.stderr.write(`e2e-lock: compose project ${composeProject}\ne2e-lock: testing ${tested}\ne2e-lock: source ${JSON.stringify(source)}\n`);
  const images = { project: composeProject, worktree: owner.worktree, head: tested, source, command: [command, ...args].join(" "),
    records: path.join(path.dirname(lockDir), "e2e-images") };
  let outcome;
  try {
    outcome = await withStableSource(worktree, async current => {
      if (!sameSource(source, current)) throw new Error('SOURCE-MOVED before E2E command startup');
      const stale = imageProblem(images);
      if (stale) {
        process.stderr.write(`${stale}\n`);
        return { exitCode: 1, executed: false };
      }
      let childEnv = { ...process.env, COMPOSE_PROJECT_NAME: composeProject };
      if (containerizedBuild) {
        prepareRunOwnedBuild(cleanupRecord, { home: managedHome });
        const docker = process.env.VIBE_E2E_DOCKER || "docker";
        const dockerBinary = path.isAbsolute(docker) ? docker
          : execFileSync("which", [docker], { encoding: "utf8", timeout: 10_000 }).trim();
        installOwnedBuildShim(cleanupRecord, dockerBinary);
        childEnv = ownedBuildEnvironment(cleanupRecord, childEnv);
      }
      return { exitCode: await runCommand(command, args, childEnv, cleanupRecord), executed: true };
    }, { head: tested });
    if (cleanupRecord) cleanupRecord.buildFinished = outcome.executed && outcome.exitCode === 0;
    if (containerizedBuild && outcome.executed) {
      recordBuiltTags(cleanupRecord);
    }
    if (outcome.executed && outcome.exitCode === 0) recordImagesOrSay(images);
    return outcome.exitCode;
  } catch (error) {
    if (!error.message.startsWith('SOURCE-MOVED')) throw error;
    outcome = { exitCode: 1, startedSource: source, error: error.message };
    process.stderr.write(`${error.message} during the run\n`);
    const after = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (after !== tested) process.stderr.write(`HEAD-MOVED from ${tested.slice(0, 12)} to ${after.slice(0, 12)} during the run\n`);
    return 1;
  } finally {
    try {
      if (dockerReady) {
        try { reconcileGeneratedE2E(cleanupRecord, { allowCurrentOwner: true, home: managedHome }); }
        catch (error) {
          process.stderr.write(`LEFTOVER ${composeProject}: ${String(error instanceof Error ? error.message : error)}\n`);
        }
      }
      if (outcome) {
        const gitDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
        const receipts = path.join(gitDir, 'vibe-e2e-results');
        mkdirSync(receipts, { recursive: true });
        writeFileSync(path.join(receipts, `${owner.token}.json`), `${JSON.stringify({ command: owner.command, startedAt: owner.startedAt, ...outcome }, null, 2)}\n`, { mode: 0o600 });
      }
    } finally {
      release(lockDir, owner);
    }
  }
}

/** The image record is optional: a refused write is said, never fails a run that passed. */
function recordImagesOrSay(images) {
  try { recordImages(images); }
  catch (error) {
    process.stderr.write(`IMAGES-NOT-RECORDED ${error instanceof Error ? error.message : String(error)}; the next run builds fresh\n`);
  }
}

export const ESCALATION_JUSTIFICATION = "Reserve the shared setup for the automatic checks";

async function runChildGate([gate, command, ...args]) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      const token = readFileSync(gate, 'utf8');
      if (/^[a-f0-9]{32}$/i.test(token) && gate.endsWith(`e2e-gate-${token}.ready`)) {
        return new Promise((resolve, reject) => {
          const child = spawn(command, args, { stdio: 'inherit', env: process.env });
          const waitForGroupSignal = () => {};
          for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, waitForGroupSignal);
          child.once('error', reject);
          child.once('close', (code, signal) => {
            for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, waitForGroupSignal);
            resolve(code ?? 128 + (os.constants.signals[signal] ?? 0));
          });
        });
      }
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('E2E child launch was never acknowledged');
}

/** Bounded cleanup CLI entry shared by root handoff and fleet terminal events. */
async function runCleanupSweep(argv) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true,
    options: { 'orch-dir': { type: 'string' }, where: { type: 'string' }, 'state-dir': { type: 'string' } } });
  const [action] = positionals;
  if (action === 'status') return { pending: pendingOwnedCleanups() };
  if (action !== 'sweep') throw new Error('Usage: e2e-lock.mjs cleanup-sweep status|sweep [--orch-dir <fleet directory>]');
  if (values.where && !['local', 'remote'].includes(values.where)) throw new Error('--where must be local or remote');
  const deadline = Date.now() + 30_000;
  const fleet = values['orch-dir'] ? await registerFleetWriterRetirements(values['orch-dir'],
    { deadline, where: values.where ?? 'local', ...(values['state-dir'] ? { stateDir: values['state-dir'] } : {}) })
    : { registered: [], leftover: [], visited: 0 };
  const result = await sweepOwnedCleanups({ forceDiscovery: true, deadline, maxRecords: remainingCleanupBudget(fleet.visited) });
  return { ...result, registered: fleet.registered, leftover: [...fleet.leftover, ...result.leftover] };
}

async function diskCommand([action, command, ...args]) {
  if (action === 'intent') return isContainerizedBuild(command, args) ? 0 : 1;
  if (action !== 'check') throw new Error('Unknown disk admission action');
  process.stdout.write(JSON.stringify(requireDockerDisk()) + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const task = process.argv[2] === 'child-gate'
    ? runChildGate(process.argv.slice(3))
    : process.argv[2] === 'cleanup-sweep'
      ? runCleanupSweep(process.argv.slice(3))
      : ['check', 'intent'].includes(process.argv[2])
        ? diskCommand(process.argv.slice(2)) : main(process.argv.slice(2));
  task.then(
    (code) => {
      if (typeof code === 'number') process.exit(code);
      process.stdout.write(JSON.stringify(code) + '\n');
    },
    (error) => {
      if (isSandboxRefusal(error)) process.stdout.write(`${JSON.stringify(escalation(error, ESCALATION_JUSTIFICATION))}\n`);
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    }
  );
}
