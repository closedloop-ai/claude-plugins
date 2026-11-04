#!/usr/bin/env node
// One containerized e2e stack per machine. symphony-alpha's e2e stack
// (`e2e/compose.yml`, run directly or through `dagger call e-2-e`) uses one
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
import { imageProblem, recordImages } from "./image-head.mjs";
import { readProcessIdentity } from "../../../shared/process-identity.mjs";
import { testedSource, sameSource, withStableSource } from "./tested-head.mjs";
import { readSessionRecord } from "./session-record.mjs";

export const BUSY_EXIT = 75;
export const DUPLICATE_EXIT = 76;
const DEFAULT_WAIT_SECONDS = 3600;
const POLL_MS = 5_000;
const OWNER_FILE = "owner.json";
const OWNERLESS_GRACE_MS = 60_000;
const COMPOSE_PREFIX = "vibe-e2e-";
const VERSION = 1;
const MAX_RECORDS = 20;
const MAX_MS = 30_000;
const OPEN_PR_BACKOFF_MS = 30 * 60_000;
const SHA = /^[a-f0-9]{40}$/i;

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

/** Reserve private service tags; only the child shim's selected waves can create them. */
export function plannedLocalTags(docker, project, worktree, command, args = [], env = process.env) {
  if (args.includes('--no-build') || ![command, ...args].some((word) => /(?:^|\/)run-containerized\.sh$/.test(word))) return [];
  const composeArgs = ["compose", "-p", project, "-f", path.join(worktree, "e2e", "compose.yml")];
  const ghcr = env.E2E_GHCR_CONTENT_IMAGES === "1";
  if (ghcr) composeArgs.push("-f", path.join(worktree, "e2e", "compose.ghcr.yml"));
  composeArgs.push("--profile", "*", "config", "--format", "json");
  const result = spawnSync(docker, composeArgs, { encoding: "utf8", timeout: 30_000, env });
  if (result.error || result.status !== 0) throw new Error("Could not resolve local E2E build tags.");
  const services = JSON.parse(result.stdout).services;
  if (!services || typeof services !== "object") throw new Error("Resolved Compose services are missing.");
  return Object.entries(services).filter(([, service]) => service.build)
    .map(([name]) => project + "-" + name);
}

const DOCKER_KINDS = Object.freeze([
  { key: "containers", noun: "container", list: ["container", "ls", "-aq", "--no-trunc"], remove: ["container", "rm", "-f"] },
  { key: "volumes", noun: "volume", list: ["volume", "ls", "-q"], remove: ["volume", "rm"] },
  { key: "networks", noun: "network", list: ["network", "ls", "--no-trunc", "-q"], remove: ["network", "rm"] },
]);

function dockerRunner(args) {
  return spawnSync(process.env.VIBE_E2E_DOCKER || "docker", args, { encoding: "utf8", timeout: 30_000 });
}

function dockerOutput(args, run, { missing = false } = {}) {
  const result = run(args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = String(result.stderr ?? "").trim();
    const id = args.at(-1);
    const notFound = {
      container: `Error response from daemon: No such container: ${id}`,
      volume: `Error response from daemon: get ${id}: no such volume`,
      network: `Error response from daemon: network ${id} not found`,
    }[args[0]];
    if (missing && result.status === 1 && message === notFound) return null;
    throw new Error(`Docker ${args[0]} ${args[1]} failed: ${String(result.stderr ?? "").trim()}`);
  }
  return String(result.stdout ?? "").trim();
}

function resourceWitness(kind, id, run) {
  if (kind.key === "containers" && !/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker container needs a full container ID.");
  const raw = dockerOutput([kind.noun, "inspect", id], run, { missing: true });
  if (raw === null) return null;
  const parsed = JSON.parse(raw);
  const value = Array.isArray(parsed) ? parsed[0] : null;
  const labels = kind.key === "containers" ? value?.Config?.Labels : value?.Labels;
  const created = value?.Created ?? value?.CreatedAt;
  const identity = kind.key === "volumes" ? value?.Name : value?.Id;
  if (identity !== id) throw new Error(`Docker ${kind.noun} ${id} resolved ID changed identity.`);
  if (typeof created !== "string" || !Number.isFinite(Date.parse(created))) {
    throw new Error(`Docker ${kind.noun} ${id} has no parseable creation witness.`);
  }
  const project = labels?.["com.docker.compose.project"];
  if (typeof project !== "string" || !project) throw new Error(`Docker ${kind.noun} ${id} has no project ownership label.`);
  const ownerToken = labels?.["vibe.owner-token"];
  return { id: identity, created, project, ...(typeof ownerToken === "string" ? { ownerToken } : {}) };
}

/** Capture exact Docker identities, including stopped containers, before later cleanup. */
export function captureOwnedDockerResources({ project = null, containers, volumes, networks }, { run = dockerRunner } = {}) {
  if (project !== null && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error("Invalid recorded Compose project.");
  const record = { project, containers: [], volumes: [], networks: [] };
  for (const kind of DOCKER_KINDS) {
    const ids = { containers, volumes, networks }[kind.key] ?? (project
      ? dockerOutput([...kind.list, "--filter", `label=com.docker.compose.project=${project}`], run).split("\n").filter(Boolean)
      : []);
    for (const id of ids) {
      const witness = resourceWitness(kind, id, run);
      if (!witness || (project && witness.project !== project)) throw new Error(`Docker ${kind.noun} ${id} is not in the recorded project.`);
      record[kind.key].push(witness);
    }
  }
  return record;
}

/** Remove only resources whose exact ID, creation witness and project still match the record. */
export function removeOwnedDockerResources(record, { run = dockerRunner } = {}) {
  const targets = [];
  if (record?.project) {
    const currentProject = captureOwnedDockerResources({ project: record.project }, { run });
    for (const kind of DOCKER_KINDS) {
      const recorded = new Set((record[kind.key] ?? []).map((entry) => entry.id));
      if (currentProject[kind.key].some((entry) => !recorded.has(entry.id))) {
        throw new Error(`Docker ${kind.noun} in the project was not recorded; cleanup refused.`);
      }
    }
  }
  for (const kind of DOCKER_KINDS) {
    for (const saved of record?.[kind.key] ?? []) {
      if (!saved?.id || typeof saved?.created !== "string" || !Number.isFinite(Date.parse(saved.created))
        || typeof saved?.project !== "string" || !saved.project) {
        throw new Error(`Unrecorded Docker ${kind.noun} has no exact creation witness and project ownership.`);
      }
      const current = resourceWitness(kind, saved.id, run);
      if (current && (current.id !== saved.id || current.created !== saved.created || current.project !== saved.project
        || (record.project && current.project !== record.project)
        || (saved.ownerToken && current.ownerToken !== saved.ownerToken))) {
        throw new Error(`Docker ${kind.noun} ${saved.id} changed identity; left alone.`);
      }
      if (current) targets.push({ kind, saved });
    }
  }
  for (const { kind, saved } of targets) {
    dockerOutput([...kind.remove, saved.id], run);
    if (resourceWitness(kind, saved.id, run)) throw new Error(`Docker ${kind.noun} ${saved.id} remains after cleanup.`);
  }
  return { removed: targets.map(({ kind, saved }) => ({ kind: kind.noun, id: saved.id })) };
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
    const forward = (signal) => {
      if (record && child.pid > 1) { try { process.kill(-child.pid, signal); } catch { /* Group exited. */ } }
      else child.kill(signal);
    };
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
    const held = holder && isAlive(holder.pid);
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
  const waiter = path.join(waitersDir(lockDir), `${owner.token}.json`);
  mkdirSync(waitersDir(lockDir), { recursive: true });
  writeFileSync(waiter, JSON.stringify(owner), { mode: 0o600 });
  const deadline = Date.now() + waitSeconds * 1000;
  let attempt;
  try {
    for (;;) {
      attempt = await acquire(lockDir, owner, { waitSeconds: Math.max(0, (deadline - Date.now()) / 1000) });
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
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(1, deadline - Date.now()))));
    }
  } finally {
    rmSync(waiter, { force: true });
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
        startedAt: new Date().toISOString(), plannedTags: plannedLocalTags(docker, composeProject, worktree, command, args), file: cleanupFile },
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
        reconcileGeneratedE2E(cleanupRecord, { allowCurrentOwner: true, home: managedHome });
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
          child.once('error', reject);
          child.once('close', (code, signal) => resolve(code ?? 128 + (os.constants.signals[signal] ?? 0)));
        });
      }
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('E2E child launch was never acknowledged');
}

/** Bounded cleanup CLI entry shared by root handoff and fleet terminal events. */
export async function runCleanupSweep(argv) {
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

/** Refuse malformed fleet accounting before it can disable pending cleanup. */
export function remainingCleanupBudget(visits) {
  if (!Number.isSafeInteger(visits) || visits < 0 || visits > MAX_RECORDS) {
    throw new Error('Fleet cleanup visit count is not finite and bounded');
  }
  return MAX_RECORDS - visits;
}

async function diskCommand([action, command, ...args]) {
  if (action === 'intent') return isContainerizedBuild(command, args) ? 0 : 1;
  if (action !== 'check') throw new Error('Unknown disk admission action');
  process.stdout.write(JSON.stringify(requireDockerDisk()) + '\n');
  return 0;
}

/** Machine-local private state stays outside any worktree it may retire. */
export function cleanupDir(home = os.homedir()) {
  return path.join(home, '.codex', 'vibe', 'cleanup');
}

function recordsDir(home) { return path.join(cleanupDir(home), 'records'); }
function marker(home) { return path.join(cleanupDir(home), 'pending'); }
function cursorFile(home) { return path.join(cleanupDir(home), 'sweep.cursor'); }

function sweepLock(home) { return path.join(cleanupDir(home), 'sweep.lock'); }

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim();
}

function gitBytes(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
}

function regularJson(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('cleanup record is not a regular file');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

function acquireSweepLock(home) {
  const lock = sweepLock(home);
  const owner = { pid: process.pid, identity: readProcessIdentity(process.pid), token: randomUUID() };
  if (!owner.identity) throw new Error('sweep process birth identity is unreadable');
  mkdirSync(cleanupDir(home), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock);
      writeAtomic(path.join(lock, 'owner.json'), owner);
      return () => {
        try {
          if (regularJson(path.join(lock, 'owner.json')).token === owner.token) rmSync(lock, { recursive: true });
        } catch { /* A peer's lock is never removed on release. */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let saved;
      try { saved = regularJson(path.join(lock, 'owner.json')); } catch { saved = null; }
      if (saved?.identity && readProcessIdentity(saved.pid) === saved.identity) return null;
      if (!saved && Date.now() - statSync(lock).mtimeMs < 60_000) return null;
      // Re-read before reclaiming a stale lock; never remove a newly replaced one.
      let current;
      try { current = regularJson(path.join(lock, 'owner.json')); } catch { current = null; }
      if (current?.token !== saved?.token) return null;
      rmSync(lock, { recursive: true });
    }
  }
  return null;
}

function recordPath(home, worktree) {
  const digest = createHash('sha256').update(worktree).digest('hex');
  return path.join(recordsDir(home), `${digest}.json`);
}

function refreshMarker(home) {
  const dir = recordsDir(home);
  const worktreePending = existsSync(dir) && readdirSync(dir).some((name) => {
    try {
      const record = regularJson(path.join(dir, name));
      return record.state !== 'complete';
    } catch { return true; }
  });
  const e2eDir = path.dirname(defaultLockDir(home));
  const e2ePending = existsSync(e2eDir) && readdirSync(e2eDir).filter((name) => /^e2e-cleanup-[\w-]+\.json$/.test(name))
    .some((name) => { try { return regularJson(path.join(e2eDir, name)).state !== 'complete'; } catch { return true; } });
  const scratchDir = path.join(cleanupDir(home), 'scratch-programs');
  const scratchPending = existsSync(scratchDir) && readdirSync(scratchDir).some((name) => name.endsWith('.json'));
  if (worktreePending || e2ePending || scratchPending) {
    mkdirSync(cleanupDir(home), { recursive: true, mode: 0o700 });
    writeAtomic(marker(home), { pending: true });
  } else rmSync(marker(home), { force: true });
}

function markPending(home) {
  mkdirSync(cleanupDir(home), { recursive: true, mode: 0o700 });
  writeAtomic(marker(home), { pending: true });
}

/** Cheap marker used by the always-on supervisor before any ledger or PR read. */
export function hasPendingOwnedCleanups({ home = os.homedir() } = {}) {
  return existsSync(marker(home));
}

/** Register a verified published checkout without trusting branch-name patterns. */
export function registerWorktreeRetirement({ worktree, repo, pr, proof, ticket = null }, { home = os.homedir() } = {}) {
  if (!pr || !/^[\w.-]+\/[\w.-]+$/.test(pr.repo ?? '') || !Number.isSafeInteger(pr.number) || pr.number <= 0
    || !SHA.test(pr.head ?? '') || typeof pr.branch !== 'string') throw new Error('retirement needs exact PR repo, number, head and branch');
  if (proof?.kind !== 'vibe' && proof?.kind !== 'fleet') throw new Error('retirement needs a session proof kind');
  if (proof.kind === 'fleet' && (!proof.stateDir || !proof.sessionName || !proof.endedAt || !proof.archivedAt)) {
    throw new Error('fleet retirement needs ended and archived session witnesses');
  }
  const root = realpathSync(worktree);
  const retained = realpathSync(repo);
  if (root === retained) throw new Error('retirement cannot remove its retained checkout');
  if (git(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error('worktree path changed');
  const branch = git(root, ['branch', '--show-current']);
  const head = git(root, ['rev-parse', 'HEAD']);
  if (branch !== pr.branch || head !== pr.head) throw new Error('PR head or branch differs from the worktree');
  const commonDir = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (commonDir !== realpathSync(git(retained, ['rev-parse', '--path-format=absolute', '--git-common-dir']))) {
    throw new Error('worktree belongs to another Git repository');
  }
  verifyOrigin({ repo: retained, branch, head }, pr.state ?? 'OPEN');
  const file = recordPath(home, root);
  const record = { version: VERSION, kind: 'worktree', state: 'pending', id: path.basename(file, '.json'),
    worktree: root, repo: retained, commonDir, branch, head, pr: { repo: pr.repo, number: pr.number, head: pr.head, branch },
    proof, ticket, createdAt: new Date().toISOString(), nextCheckAt: null };
  const release = acquireSweepLock(home);
  if (!release) throw new Error('cleanup sweep holds the retirement ledger');
  try {
    markPending(home);
    writeAtomic(file, record);
    refreshMarker(home);
  } finally { release(); }
  return record;
}

function currentPr(repo, number, { timeoutMs = 30_000 } = {}) {
  const raw = execFileSync('gh', ['api', `repos/${repo}/pulls/${number}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.min(30_000, Math.max(1, timeoutMs)) });
  const value = JSON.parse(raw);
  return { repo: value.base?.repo?.full_name, number: value.number, head: value.head?.sha,
    branch: value.head?.ref, state: value.merged_at ? 'MERGED' : String(value.state ?? '').toUpperCase() };
}

/** Import only the fleet board's exact writer/PR evidence after a live terminal read. */
export async function registerFleetWriterRetirements(orchDir, { home = os.homedir(), readPr = currentPr,
  now = Date.now(), where = 'local', stateDir = process.env.LOCAL_STATE_DIR || path.join(orchDir, 'sessions'),
  deadline = Date.now() + MAX_MS, clock = Date.now, maxRecords = MAX_RECORDS } = {}) {
  const boardFile = path.join(orchDir, 'board.json');
  if (!existsSync(boardFile)) return { registered: [], leftover: [], visited: 0 };
  const board = regularJson(boardFile);
  const registered = [];
  const leftover = [];
  const cacheFile = path.join(cleanupDir(home), 'board-checks.json');
  let checks = {};
  try { checks = regularJson(cacheFile); } catch { /* First run or malformed cache retries conservatively. */ }
  const writers = Object.entries(board.writers ?? {});
  const offset = writers.length ? (Number(checks.__cursor) || 0) % writers.length : 0;
  const selected = Array.from({ length: Math.min(MAX_RECORDS, writers.length) }, (_, index) => writers[(offset + index) % writers.length]);
  let visits = 0;
  for (const [name, row] of selected) {
    if (visits >= maxRecords || clock() >= deadline) break;
    visits += 1;
    if (!row.pr || !row.repo || !row.worktree || row.where !== where) continue;
    try {
      if (regularJson(recordPath(home, path.resolve(row.worktree))).state === 'complete') continue;
    } catch { /* This writer has no completed retirement receipt. */ }
    const key = `${row.repo}#${row.pr}`;
    if (checks[key] && now < Date.parse(checks[key])) continue;
    try {
      if (row.runtime === 'codex') {
        const state = regularJson(path.join(stateDir, `${name}.json`));
        if (state.cwd !== row.worktree || !state.ended || !state.archivedAt) throw new Error('fleet writer session is live');
      } else if (row.runtime === 'claude') {
        const session = readSessionRecord(row.worktree);
        if (session?.status !== 'handed-off') throw new Error('fleet Claude writer session is not handed off');
      } else throw new Error('fleet writer runtime cannot be verified');
      if (clock() >= deadline) { visits -= 1; break; }
      const live = await readPr(row.repo, Number(row.pr), { timeoutMs: deadline - clock() });
      if (!['MERGED', 'CLOSED'].includes(live.state)) {
        checks[key] = new Date(now + OPEN_PR_BACKOFF_MS).toISOString();
        continue;
      }
      if (live.repo !== row.repo || Number(live.number) !== Number(row.pr)
        || live.head !== row.head || live.branch !== git(row.worktree, ['branch', '--show-current'])) {
        throw new Error('fleet board PR identity changed');
      }
      const commonDir = git(row.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const proof = row.runtime === 'codex'
        ? { kind: 'fleet', stateDir, sessionName: name, endedAt: regularJson(path.join(stateDir, `${name}.json`)).ended.at,
          archivedAt: regularJson(path.join(stateDir, `${name}.json`)).archivedAt }
        : { kind: 'vibe' };
      const record = registerWorktreeRetirement({ worktree: row.worktree, repo: path.dirname(commonDir),
        pr: { repo: row.repo, number: Number(row.pr), head: live.head, branch: live.branch, state: live.state },
        proof, ticket: row.ticket ?? null }, { home });
      registered.push(record.worktree);
      delete checks[key];
    } catch (error) {
      leftover.push(`LEFTOVER ${name}: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
      checks[key] = new Date(now + OPEN_PR_BACKOFF_MS).toISOString();
    }
  }
  checks.__cursor = writers.length ? (offset + visits) % writers.length : 0;
  writeAtomic(cacheFile, checks);
  return { registered, leftover, visited: visits };
}

function activePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function defaultLockHeld(worktree) {
  return Boolean(sameWorktreeEntry(defaultLockDir(), worktree));
}

function generatedIgnored(relative) {
  const clean = relative.replace(/\/$/, '');
  return clean === 'node_modules' || clean === '.turbo'
    || /^(?:apps|packages)\/[^/]+\/(?:node_modules|\.turbo|\.next)$/.test(clean);
}

function ignoredPaths(worktree) {
  const raw = gitBytes(worktree, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  return raw.toString('utf8').split('\0').filter(Boolean);
}

function cleanGit(worktree) {
  return gitBytes(worktree, ['status', '--porcelain=v1', '-z']).length === 0;
}

function savedSessionSafe(record, processAlive) {
  const { worktree } = record;
  if (record.proof?.kind === 'fleet') {
    try {
      const state = regularJson(path.join(record.proof.stateDir, `${record.proof.sessionName}.json`));
      if (state.cwd !== worktree || state.ended?.at !== record.proof.endedAt
        || state.archivedAt !== record.proof.archivedAt) return false;
    } catch { return false; }
  } else if (record.proof?.kind !== 'vibe') return false;
  let session;
  try { session = readSessionRecord(worktree); }
  catch { return false; }
  if (!session) return record.proof.kind === 'fleet';
  if (session.status !== 'handed-off') return false;
  if (record.proof.kind === 'vibe' && (session.pullRequest?.repo !== record.pr.repo
    || session.pullRequest?.number !== record.pr.number || session.pullRequest?.head !== record.pr.head)) return false;
  for (const pid of [session.stack?.storybookPid, session.stack?.desktopPid]) {
    if (pid !== undefined && pid !== null && processAlive(Number(pid))) return false;
  }
  return true;
}

function matchPr(saved, live) {
  return live && live.repo === saved.repo && Number(live.number) === saved.number
    && live.head === saved.head && live.branch === saved.branch;
}

function verifyOrigin(record, state) {
  git(record.repo, ['remote', 'get-url', 'origin']);
  const remote = git(record.repo, ['ls-remote', '--heads', 'origin', record.branch]);
  if (!remote && state !== 'MERGED') throw new Error('remote branch is not published');
  if (remote && !remote.startsWith(`${record.head}\t`)) throw new Error('remote branch changed head');
}

function pendingScratchForWorktree(record, home) {
  const registry = path.join(cleanupDir(home), 'scratch-programs');
  if (!existsSync(registry)) return false;
  for (const name of readdirSync(registry).filter((item) => item.endsWith('.json'))) {
    const program = regularJson(path.join(registry, name));
    const expected = createHash('sha256').update(path.resolve(program.orchDir)).digest('hex') + '.json';
    if (name !== expected) throw new Error('scratch program identity changed');
    const ledgerFile = path.join(program.orchDir, 'helpers.json');
    if (!existsSync(ledgerFile)) continue;
    const ledger = regularJson(ledgerFile);
    if (Object.values(ledger).some((helper) => helper?.kind === 'scratch'
      && helper.worktree === record.worktree && !helper.stoppedAt)) return true;
  }
  return false;
}

function verifyWorktree(record, processAlive, lockHeld, home) {
  if (!SHA.test(record.head ?? '') || !existsSync(record.worktree)) throw new Error('worktree witness missing');
  const root = realpathSync(record.worktree);
  if (root !== record.worktree || realpathSync(record.repo) === root) throw new Error('worktree identity changed');
  const executionRoot = realpathSync(process.cwd());
  if (executionRoot === root || executionRoot.startsWith(`${root}${path.sep}`)) throw new Error('cleanup must run outside its target worktree');
  if (realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== record.commonDir
    || git(root, ['rev-parse', '--show-toplevel']) !== root
    || git(root, ['branch', '--show-current']) !== record.branch
    || git(root, ['rev-parse', 'HEAD']) !== record.head) throw new Error('Git worktree branch, head or common dir changed');
  const listed = git(record.repo, ['worktree', 'list', '--porcelain']);
  if (!listed.split('\n').includes(`worktree ${root}`)) throw new Error('worktree is not registered with retained clone');
  if (!savedSessionSafe(record, processAlive) || lockHeld(root)) throw new Error('session proof missing, changed or active');
  if (pendingScratchForWorktree(record, home)) throw new Error('registered scratch stack must retire before its worktree');
  if (!cleanGit(root)) throw new Error('worktree has dirty or untracked files');
  const ignored = ignoredPaths(root);
  if (ignored.some((relative) => !generatedIgnored(relative))) throw new Error('worktree has unknown ignored data');
  for (const relative of ignored) {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`) || lstatSync(absolute).isSymbolicLink()) {
      throw new Error('generated path escaped or became a symlink');
    }
  }
  return ignored;
}

/** List pending, malformed and legacy records without promoting any to ownership. */
export function pendingOwnedCleanups({ home = os.homedir() } = {}) {
  const root = cleanupDir(home);
  const names = existsSync(root) ? readdirSync(root).filter((name) => name.endsWith('.json') && name !== 'board-checks.json') : [];
  const dir = recordsDir(home);
  const modern = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join('records', name)) : [];
  const legacyDir = path.dirname(defaultLockDir(home));
  const legacy = existsSync(legacyDir) ? readdirSync(legacyDir).filter((name) => /^e2e-cleanup-[\w-]+\.json$/.test(name))
    .map((name) => path.join(legacyDir, name)) : [];
  return [...names, ...modern].filter((name) => {
    try { return regularJson(path.join(root, name)).state !== 'complete'; }
    catch { return true; }
  }).map((name) => `LEFTOVER ${name}`).concat(legacy.filter((file) => {
    try { return regularJson(file).state !== 'complete'; } catch { return true; }
  }).map((file) => `LEFTOVER ${path.basename(file)}`));
}

/** Reconcile up to one bounded batch; every target is rechecked before non-forced removal. */
export async function sweepOwnedCleanups({ home = os.homedir(), readPr = currentPr,
  processAlive = activePid, lockHeld = defaultLockHeld, beforeRemove = () => {},
  docker = dockerRun, now = Date.now(), maxRecords = MAX_RECORDS, forceDiscovery = false,
  deadline = Date.now() + MAX_MS, clock = Date.now, scratchSweep } = {}) {
  const result = { removed: [], leftover: [] };
  const dir = recordsDir(home);
  if (!forceDiscovery && !hasPendingOwnedCleanups({ home })) return result;
  if (clock() >= deadline || maxRecords <= 0) return result;
  const release = acquireSweepLock(home);
  if (!release) return { removed: [], leftover: ['LEFTOVER sweep lock is held'] };
  try {
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
  let offset = 0;
  try { offset = Number(regularJson(cursorFile(home)).next) || 0; } catch { /* Start at the first record. */ }
  const selected = Array.from({ length: Math.min(maxRecords, 8, names.length) },
    (_, index) => names[(offset + index) % names.length]);
  let worktreeVisits = 0;
  for (const name of selected) {
    if (clock() >= deadline) break;
    worktreeVisits += 1;
    const file = path.join(dir, name);
    let record;
    try { record = regularJson(file); }
    catch { result.leftover.push(`LEFTOVER ${name}: unreadable record`); continue; }
    if (record.version !== VERSION || record.kind !== 'worktree') {
      result.leftover.push(`LEFTOVER ${name}: unsupported ownership record`); continue;
    }
    if (record.state === 'complete' || (record.nextCheckAt && now < Date.parse(record.nextCheckAt))) continue;
    let readingPr = false;
    try {
      if (!existsSync(record.worktree)) {
        const listed = git(record.repo, ['worktree', 'list', '--porcelain']);
        if (listed.split('\n').includes(`worktree ${record.worktree}`)) throw new Error('missing worktree is still registered');
        record.state = 'complete';
        record.completedAt = new Date().toISOString();
        record.outcome = 'already absent';
        writeAtomic(file, record);
        continue;
      }
      if (clock() >= deadline) { worktreeVisits -= 1; break; }
      readingPr = true;
      const live = await readPr(record.pr.repo, record.pr.number, { timeoutMs: deadline - clock() });
      readingPr = false;
      if (!matchPr(record.pr, live)) throw new Error('live PR identity changed');
      if (!['MERGED', 'CLOSED'].includes(live.state)) {
        record.nextCheckAt = new Date(now + OPEN_PR_BACKOFF_MS).toISOString();
        writeAtomic(file, record);
        result.leftover.push(`LEFTOVER ${name}: PR remains open`);
        continue;
      }
      verifyOrigin(record, live.state);
      const ignored = verifyWorktree(record, processAlive, lockHeld, home);
      for (const relative of ignored) rmSync(path.join(record.worktree, relative), { recursive: true });
      await beforeRemove(record);
      verifyWorktree(record, processAlive, lockHeld, home);
      if (clock() >= deadline) throw new Error('cleanup deadline reached before final PR read');
      readingPr = true;
      const latest = await readPr(record.pr.repo, record.pr.number, { timeoutMs: deadline - clock() });
      readingPr = false;
      if (!matchPr(record.pr, latest) || !['MERGED', 'CLOSED'].includes(latest.state)) throw new Error('PR changed before removal');
      verifyOrigin(record, latest.state);
      git(record.repo, ['worktree', 'remove', record.worktree]);
      record.state = 'complete';
      record.completedAt = new Date().toISOString();
      writeAtomic(file, record);
      result.removed.push(record.worktree);
    } catch (error) {
      record.state = 'leftover';
      record.lastError = String(error instanceof Error ? error.message : error).slice(0, 200);
      // A timed-out GitHub read must not consume every supervisor deadline.
      if (readingPr) record.nextCheckAt = new Date(now + OPEN_PR_BACKOFF_MS).toISOString();
      writeAtomic(file, record);
      result.leftover.push(`LEFTOVER ${name}: ${record.lastError}`);
    }
  }
  if (names.length) writeAtomic(cursorFile(home), { next: (offset + worktreeVisits) % names.length });
  const scratchDir = path.join(cleanupDir(home), 'scratch-programs');
  const scratchNames = existsSync(scratchDir) ? readdirSync(scratchDir).filter((name) => name.endsWith('.json')).sort() : [];
  let scratchOffset = 0;
  try { scratchOffset = Number(regularJson(path.join(cleanupDir(home), 'scratch.cursor')).next) || 0; } catch { /* First pass. */ }
  let scratchVisits = 0;
  let programsVisited = 0;
  const runScratch = scratchSweep ?? (async (orchDir, options) => {
    const { sweepScratchHelpers } = await import('../../fleet-orchestrator/scripts/helpers.mjs');
    return sweepScratchHelpers(orchDir, options);
  });
  for (let index = 0; index < Math.min(scratchNames.length, 6); index += 1) {
    if (clock() >= deadline || worktreeVisits + scratchVisits >= maxRecords || scratchVisits >= 6) break;
    const name = scratchNames[(scratchOffset + index) % scratchNames.length];
    programsVisited += 1;
    try {
      const program = regularJson(path.join(scratchDir, name));
      const expected = createHash('sha256').update(path.resolve(program.orchDir)).digest('hex') + '.json';
      if (name !== expected) throw new Error('scratch program identity changed');
      const remaining = Math.min(6 - scratchVisits, maxRecords - worktreeVisits - scratchVisits);
      if (remaining <= 0) break;
      const outcome = await runScratch(program.orchDir, { home, deadline, clock, maxRecords: remaining, now });
      if (!Number.isSafeInteger(outcome.visited) || outcome.visited < 0 || outcome.visited > remaining) {
        throw new Error('scratch cleanup visit count is invalid');
      }
      scratchVisits += outcome.visited;
      result.removed.push(...(outcome.removed ?? []));
      result.leftover.push(...(outcome.leftover ?? []));
    } catch (error) { result.leftover.push('LEFTOVER scratch program ' + name + ': ' + error.message); }
  }
  if (scratchNames.length) writeAtomic(path.join(cleanupDir(home), 'scratch.cursor'),
    { next: (scratchOffset + programsVisited) % scratchNames.length });
  const e2eDir = path.dirname(defaultLockDir(home));
  const e2eNames = existsSync(e2eDir) ? readdirSync(e2eDir).filter((name) => /^e2e-cleanup-[a-f0-9-]+\.json$/i.test(name)).sort() : [];
  let e2eOffset = 0;
  try { e2eOffset = Number(regularJson(path.join(cleanupDir(home), 'e2e.cursor')).next) || 0; } catch { /* First pass. */ }
  const e2eSelected = Array.from({ length: Math.min(e2eNames.length, 6, Math.max(0, maxRecords - worktreeVisits - scratchVisits)) },
    (_, index) => e2eNames[(e2eOffset + index) % e2eNames.length]);
  let e2eVisits = 0;
  for (const name of e2eSelected) {
    if (clock() >= deadline) break;
    e2eVisits += 1;
    const file = path.join(e2eDir, name);
    let record;
    try { record = regularJson(file); } catch { result.leftover.push('LEFTOVER ' + name + ': unreadable E2E record'); continue; }
    if (record.state === 'complete') continue;
    const owner = { pid: process.pid, identity: readProcessIdentity(process.pid), token: randomUUID() };
    const attempt = tryAcquire(defaultLockDir(home), owner);
    if (!attempt.acquired) { result.leftover.push('LEFTOVER ' + name + ': E2E lock is live'); continue; }
    try {
      if (record.version !== VERSION || record.kind !== 'e2e' || record.absentAtReservation !== true) {
        throw new Error('Legacy E2E reservation has no exact ownership proof');
      }
      const ownerToken = record.owner?.token;
      if (typeof ownerToken !== 'string' || ownerToken.replace(/-/g, '') !== record.token
        || name !== 'e2e-cleanup-' + ownerToken + '.json') throw new Error('E2E record token and path differ');
      record.file = file;
      const cleaned = reconcileGeneratedE2E(record, { run: docker,
        ownerAlive: (saved) => readProcessIdentity(saved.pid) === saved.identity,
        lockHeld: () => false, home });
      result.removed.push(...cleaned.removed.map((entry) => entry.id));
    } catch (error) {
      result.leftover.push('LEFTOVER ' + name + ': ' + String(error instanceof Error ? error.message : error).slice(0, 160));
    } finally { release(defaultLockDir(home), owner); }
  }
  if (e2eNames.length) writeAtomic(path.join(cleanupDir(home), 'e2e.cursor'),
    { next: (e2eOffset + e2eVisits) % e2eNames.length });
  refreshMarker(home);
  return result;
  } finally { release(); }
}

function dockerRun(args) {
  return spawnSync(process.env.VIBE_E2E_DOCKER || 'docker', args, { encoding: 'utf8', timeout: 30_000 });
}

function dockerResult(args, run) {
  const result = run(args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker ${args.slice(0, 2).join(' ')} failed: ${String(result.stderr ?? '').trim()}`);
  return String(result.stdout ?? '').trim();
}

function sameImageTag(saved, actual) {
  const normalized = saved.includes(':') && saved.lastIndexOf(':') > saved.lastIndexOf('/') ? saved : saved + ':latest';
  return actual === saved || actual === normalized;
}

function imageWitness(tag, run) {
  const result = run(['image', 'inspect', tag]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const failure = String(result.stderr ?? '').trim();
    const missing = 'Error response from daemon: No such image: ';
    if (result.status === 1 && failure.startsWith(missing) && sameImageTag(tag, failure.slice(missing.length))) return null;
    throw new Error(`Docker image inspect failed: ${failure}`);
  }
  const image = JSON.parse(String(result.stdout ?? ''))[0];
  if (!/^sha256:[a-f0-9]{64}$/i.test(image?.Id ?? '') || !Number.isFinite(Date.parse(image?.Created ?? ''))
    || !Array.isArray(image.RepoTags) || !image.RepoTags.some((value) => sameImageTag(tag, value))) {
    throw new Error('Image tag has no exact ID, creation or tag witness');
  }
  return { tag, id: image.Id, created: image.Created, tags: image.RepoTags };
}

function projectResources(project, run) {
  return captureOwnedDockerResources({ project }, { run });
}

function projectHasRunningContainers(resources, run) {
  for (const witness of resources.containers) {
    const value = JSON.parse(dockerResult(['container', 'inspect', witness.id], run))[0];
    if (typeof value?.State?.Running !== 'boolean' || value.State.Running) {
      throw new Error('E2E project container is running or has unreadable state');
    }
  }
}

function resourceCount(resources) {
  return resources.containers.length + resources.volumes.length + resources.networks.length;
}

/** Reserve an empty full-token Compose project and absent exact local tags before launching a creator. */
export function reserveGeneratedE2E({ token, project, owner, startedAt, plannedTags = [], file },
  { run = dockerRun, home } = {}) {
  if (!/^[a-f0-9]{32}$/i.test(token ?? '') || project !== `vibe-e2e-${token}`
    || !Number.isFinite(Date.parse(startedAt ?? '')) || !owner?.identity
    || typeof owner.token !== 'string' || owner.token.replace(/-/g, '') !== token || !file) {
    throw new Error('Generated E2E reservation needs a full random project, owner and creation time');
  }
  if (new Set(plannedTags).size !== plannedTags.length
    || plannedTags.some((tag) => !tag.startsWith(project + '-'))) {
    throw new Error('Only distinct private project image tags may be reserved');
  }
  if (resourceCount(projectResources(project, run))) throw new Error('Generated Compose project is not empty before launch');
  for (const tag of plannedTags) if (imageWitness(tag, run)) throw new Error(`Planned image tag already exists: ${tag}`);
  const record = { version: VERSION, kind: 'e2e', state: 'reserved', token, project, owner, startedAt,
    plannedTags, absentAtReservation: true, launchPending: false, images: [], file };
  if (home) markPending(home);
  writeAtomic(file, record);
  if (home) refreshMarker(home);
  return record;
}

/** Persist the spawned command's birth identity before it can outlive the wrapper. */
export function recordE2EChild(record, pid) {
  if (record?.kind !== 'e2e' || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('E2E child PID is unreadable');
  const identity = readProcessIdentity(pid);
  if (!identity) throw new Error('E2E child birth identity is unreadable');
  record.child = { pid, pgid: pid, identity, startedAt: new Date().toISOString() };
  if (record.file) writeAtomic(record.file, record);
  return record.child;
}

function defaultChildAlive(child) {
  if (!child) return false;
  if (child.pgid !== undefined) {
    if (!Number.isSafeInteger(child.pgid) || child.pgid <= 1) return true;
    // The gate and every non-detached descendant share this isolated group.
    // A reused group ID may delay cleanup, but can never authorize deletion.
    try { process.kill(-child.pgid, 0); return true; }
    catch (error) { if (error?.code === 'EPERM') return true; if (error?.code !== 'ESRCH') return true; }
  }
  const identity = readProcessIdentity(child.pid);
  if (identity) return !child.identity || identity === child.identity;
  try { process.kill(child.pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function inspectContainersForImage(image, project, run) {
  const ids = dockerResult(['container', 'ls', '-aq', '--no-trunc'], run).split('\n').filter(Boolean);
  for (const id of ids) {
    const raw = dockerResult(['container', 'inspect', id], run);
    const container = JSON.parse(raw)[0];
    if (container?.Image !== image.id) continue;
    if (container.Config?.Labels?.['com.docker.compose.project'] !== project || container.State?.Running === true) {
      throw new Error(`Image ${image.tag} is referenced by a foreign or live container`);
    }
  }
}

/** Reconcile only post-reservation project witnesses and exact built tags; partial retries stay idempotent. */
export function reconcileGeneratedE2E(record, { run = dockerRun, ownerAlive = () => false, childAlive = defaultChildAlive,
  lockHeld = () => false,
  allowCurrentOwner = false, home } = {}) {
  if (record?.version !== VERSION || record.kind !== 'e2e' || !/^[a-f0-9]{32}$/i.test(record.token ?? '')
    || record.project !== `vibe-e2e-${record.token}` || record.absentAtReservation !== true
    || !Number.isFinite(Date.parse(record.startedAt ?? '')) || !record.owner?.identity
    || !Array.isArray(record.plannedTags) || typeof record.launchPending !== 'boolean') {
    throw new Error('Legacy E2E reservation has no exact ownership proof');
  }
  if (record.state === 'complete') return { removed: [] };
  if (!allowCurrentOwner && (ownerAlive(record.owner) || lockHeld(record.owner))) throw new Error('Live E2E owner or lock retains resources');
  if (record.launchPending && !record.child) {
    // No release file could have been written before the birth witness. A
    // stranded gate times out without starting the command.
    if (!record.file || existsSync(path.join(path.dirname(record.file), `e2e-gate-${record.token}.ready`))) {
      throw new Error('E2E launch handshake is unproved');
    }
  }
  if (childAlive(record.child)) throw new Error('Live E2E command tree retains resources');
  const current = projectResources(record.project, run);
  projectHasRunningContainers(current, run);
  for (const kind of ['containers', 'volumes', 'networks']) {
    for (const witness of current[kind]) {
      if (Date.parse(witness.created) <= Date.parse(record.startedAt)) throw new Error('Docker resource predates the reserved project');
    }
  }
  if (record.resources) {
    for (const kind of ['containers', 'volumes', 'networks']) {
      const saved = new Map((record.resources[kind] ?? []).map((value) => [value.id, value]));
      for (const witness of current[kind]) {
        const previous = saved.get(witness.id);
        if (!previous || previous.created !== witness.created || previous.project !== witness.project) {
          throw new Error('Docker project gained an unrecorded or changed witness');
        }
      }
    }
  }
  const images = [];
  if (record.builder?.builtTagsFile) recordBuiltTags(record);
  if (record.builder && record.state !== 'cleaning') {
    for (const tag of record.requiredBuiltTags ?? []) {
      if (!imageWitness(tag, run)) throw new Error('Built service tag is missing from the local image store');
    }
  }
  const isPrivateTag = (tag) => typeof tag === 'string' && tag.startsWith(record.project + '-')
    && /^[a-z0-9][a-z0-9_-]*$/.test(tag.slice(record.project.length + 1));
  for (const tag of record.plannedTags) {
    const currentImage = imageWitness(tag, run);
    if (!currentImage) continue;
    // Compose up can implicitly build a reserved project-private service tag.
    // The full random project and pre-launch absence are the capability;
    // successful explicit build waves still add stronger ID/Created witnesses.
    if (!isPrivateTag(tag)) throw new Error('Image tag is outside the reserved private project');
    if (Date.parse(currentImage.created) <= Date.parse(record.startedAt)) throw new Error('Image tag predates the reservation');
    const previous = record.images?.find((image) => image.tag === tag);
    if (previous && (previous.id !== currentImage.id || previous.created !== currentImage.created)) {
      throw new Error('Image tag changed ID or creation witness');
    }
    const built = record.observedImages?.find((image) => image.tag === tag);
    if (built && (built.id !== currentImage.id || built.created !== currentImage.created)) {
      throw new Error('Built image tag changed its wave witness');
    }
    for (const other of currentImage.tags) {
      const owned = record.plannedTags.find((candidate) => sameImageTag(candidate, other));
      if (!owned || !isPrivateTag(owned)) throw new Error('Image is retagged or shared');
      const peer = imageWitness(owned, run);
      if (!peer || peer.id !== currentImage.id || peer.created !== currentImage.created) {
        throw new Error('Owned image pair has differing witnesses');
      }
      const peerBuilt = record.observedImages?.find((image) => image.tag === owned);
      if (peerBuilt && (peerBuilt.id !== peer.id || peerBuilt.created !== peer.created)) {
        throw new Error('Owned image pair changed its wave witness');
      }
    }
    inspectContainersForImage(currentImage, record.project, run);
    images.push(currentImage);
  }
  if (record.builder) verifiedBuilder(record, run);
  if (record.cache) verifyOwnedCache(record);
  if (record.runState) verifyOwnedRunState(record);
  // Freeze the complete discovery before deleting anything. The existing
  // removal primitive re-lists the project and refuses additions after freeze.
  record.resources ??= current;
  record.images = images;
  record.state = 'cleaning';
  if (record.file) writeAtomic(record.file, record);
  const removed = removeOwnedDockerResources(record.resources, { run }).removed;
  record.cleanupStage = 'resources';
  if (record.file) writeAtomic(record.file, record);
  for (const image of images) {
    const still = imageWitness(image.tag, run);
    if (!still) continue;
    if (still.id !== image.id || still.created !== image.created) throw new Error('Image tag changed during cleanup');
    inspectContainersForImage(still, record.project, run);
    dockerResult(['image', 'rm', image.tag], run);
    if (imageWitness(image.tag, run)) throw new Error('Owned image tag remains after cleanup');
    removed.push({ kind: 'image-tag', id: image.tag });
  }
  record.cleanupStage = 'tags';
  if (record.file) writeAtomic(record.file, record);
  removeRunOwnedBuilder(record, run);
  record.cleanupStage = 'builder';
  if (record.file) writeAtomic(record.file, record);
  removeOwnedCache(record);
  record.cleanupStage = 'cache';
  if (record.file) writeAtomic(record.file, record);
  removeOwnedRunState(record);
  record.cleanupStage = 'run-state';
  if (record.file) writeAtomic(record.file, record);
  if (record.file) rmSync(path.join(path.dirname(record.file), `e2e-gate-${record.token}.ready`), { force: true });
  record.state = 'complete';
  if (record.file) writeAtomic(record.file, record);
  if (home) refreshMarker(home);
  return { removed };
}

function inspectBuilderPart(kind, name, run) {
  const result = run([kind, 'inspect', name]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = String(result.stderr ?? '').trim();
    const absent = kind === 'container' ? 'Error response from daemon: No such container: ' + name
      : 'Error response from daemon: get ' + name + ': no such volume';
    if (result.status === 1 && message === absent) return null;
    throw new Error('Builder ' + kind + ' inspect failed: ' + message);
  }
  const value = JSON.parse(String(result.stdout ?? ''))[0];
  const id = kind === 'container' ? value?.Id : value?.Name;
  const created = kind === 'container' ? value?.Created : value?.CreatedAt;
  if ((kind === 'container' && !/^[a-f0-9]{64}$/i.test(id ?? '')) || kind === 'volume' && id !== name
    || !Number.isFinite(Date.parse(created ?? ''))) throw new Error('Builder part has no exact identity witness');
  return { name, id, created };
}

function verifiedBuilder(record, run) {
  const builder = record.builder;
  if (!builder?.name || builder.name !== 'vibe-build-' + record.token || builder.absentAtReservation !== true) {
    throw new Error('Builder has no run-owned reservation');
  }
  const container = inspectBuilderPart('container', builder.containerName, run);
  const volume = inspectBuilderPart('volume', builder.volumeName, run);
  if (!container && !volume) return null;
  if (!container || !volume || Date.parse(container.created) <= Date.parse(record.startedAt)
    || Date.parse(volume.created) <= Date.parse(record.startedAt)) throw new Error('Builder identity changed or predates run');
  if (builder.container && (builder.container.id !== container.id || builder.container.created !== container.created)
    || builder.volume && (builder.volume.id !== volume.id || builder.volume.created !== volume.created)) {
    throw new Error('Builder identity witness changed');
  }
  return { container, volume };
}

/** Create one activity-scoped builder and Turbo root without selecting Docker's global builder. */
export function prepareRunOwnedBuild(record, { run = dockerRun, home, buildIntent = true } = {}) {
  if (!buildIntent || record?.kind !== 'e2e' || !record.absentAtReservation
    || record.project !== 'vibe-e2e-' + record.token || !/^[a-f0-9]{32}$/i.test(record.token ?? '')
    || record.state !== 'reserved' || record.builder) throw new Error('Generated E2E build intent and an unused reservation are required');
  const version = dockerResult(['buildx', 'version'], run);
  const match = /v(\d+)\.(\d+)(?:\.|\b)/.exec(version);
  if (!match || Number(match[1]) === 0 && Number(match[2]) < 14) throw new Error('Buildx 0.14 or newer is required for default-load');
  if (!dockerResult(['compose', 'build', '--help'], run).includes('--builder')) throw new Error('Compose selected-builder support is required');
  const name = 'vibe-build-' + record.token;
  const containerName = 'buildx_buildkit_' + name + '0';
  const volumeName = containerName + '_state';
  if (inspectBuilderPart('container', containerName, run) || inspectBuilderPart('volume', volumeName, run)) {
    throw new Error('Per-run builder name or state already exists');
  }
  const root = path.join(home ? cleanupDir(home) : path.dirname(record.file), 'run-state', record.token);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(root);
  record.runState = { path: root, dev: rootStat.dev, ino: rootStat.ino };
  const config = path.join(root, 'buildkitd.toml');
  writeFileSync(config, 'debug = false\n[worker.oci]\ngc = true\nmax-parallelism = 1\n', { mode: 0o600, flag: 'wx' });
  const cachePath = path.join(root, 'turbo-cache');
  mkdirSync(cachePath, { mode: 0o700 });
  const cacheStat = lstatSync(cachePath);
  record.builder = { name, containerName, volumeName, absentAtReservation: true };
  record.cache = { path: cachePath, dev: cacheStat.dev, ino: cacheStat.ino };
  record.requiredBuiltTags ??= [];
  if (record.file) writeAtomic(record.file, record);
  const created = dockerResult(['buildx', 'create', '--driver', 'docker-container', '--driver-opt',
    'default-load=true', '--buildkitd-config', config, '--name', name, '--bootstrap'], run);
  if (created !== name) throw new Error('Buildx returned a different builder name');
  const parts = verifiedBuilder(record, run);
  if (!parts) throw new Error('Builder did not create its exact container and state volume');
  record.builder = { ...record.builder, ...parts };
  if (record.file) writeAtomic(record.file, record);
  return { builder: record.builder, cache: record.cache };
}

/** Existing Docker/Turbo child contracts, scoped to this one run only. */
export function ownedBuildEnvironment(record, env = process.env) {
  if (!record?.builder?.container || !record?.cache?.path) throw new Error('Owned build environment needs exact builder and cache witnesses');
  return { ...env, BUILDX_BUILDER: record.builder.name, TURBO_CACHE_DIR: record.cache.path,
    ...(record.builder.shimDir ? { PATH: record.builder.shimDir + path.delimiter + (env.PATH ?? '') } : {}) };
}

/** A child-only Docker adapter pins every Compose build wave with --builder. */
export function installOwnedBuildShim(record, dockerBinary) {
  if (!record?.builder?.container || !path.isAbsolute(dockerBinary)) throw new Error('Build shim needs an exact builder and Docker executable');
  const shimDir = path.join(path.dirname(record.cache.path), 'bin');
  mkdirSync(shimDir, { mode: 0o700 });
  const shim = path.join(shimDir, 'docker');
  const builtTagsFile = path.join(record.runState.path, 'built-tags.jsonl');
  const overlayFile = path.join(record.runState.path, 'owned-images.json');
  writeFileSync(overlayFile, JSON.stringify({ services: {} }), { mode: 0o600, flag: 'wx' });
  const source = '#!' + process.execPath + '\n' + `
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const docker=${JSON.stringify(dockerBinary)};
const overlayFile=${JSON.stringify(overlayFile)};
const observations=${JSON.stringify(builtTagsFile)};
const builder=${JSON.stringify(record.builder.name)};
const project=${JSON.stringify(record.project)};
const allowed=new Set(${JSON.stringify(record.plannedTags)});
const args=process.argv.slice(2);
const commands=new Set(['build','up','down','config','ps','images','logs','exec','run','stop','start','rm','pull']);
const index=args[0]==='compose'?args.findIndex((word,i)=>i>0&&commands.has(word)):-1;
let selected=[];
if(index>=0&&args[index]==='build'){
 const prefix=args.slice(0,index);
 const config=spawnSync(docker,[...prefix,'--profile','*','config','--format','json'],{encoding:'utf8',env:process.env});
 if(config.error||config.status!==0)process.exit(127);
 const services=JSON.parse(config.stdout).services;
 selected=args.slice(index+1).filter(name=>Object.hasOwn(services,name));
 if(!selected.length)process.exit(127);
 const overlay=JSON.parse(fs.readFileSync(overlayFile,'utf8'));
 for(const name of selected){
  if(!services[name].build)process.exit(127);
  const tag=project+'-'+name;
  if(!allowed.has(tag))process.exit(127);
  overlay.services[name]={image:tag};
  fs.appendFileSync(observations,JSON.stringify({phase:'planned',service:name,tag})+'\\n');
 }
 const tmp=overlayFile+'.'+process.pid;
 fs.writeFileSync(tmp,JSON.stringify(overlay),{mode:0o600,flag:'wx'});
 fs.renameSync(tmp,overlayFile);
}
if(index>=0)args.splice(index,0,'-f',overlayFile);
if(index>=0&&args[index+2]==='build')args.splice(index+3,0,'--builder',builder);
const result=spawnSync(docker,args,{stdio:'inherit',env:process.env});
if(result.error){process.stderr.write(result.error.message+'\\n');process.exit(127)}
if(selected.length){
 for(const name of selected){
  const tag=project+'-'+name;
  const inspected=spawnSync(docker,['image','inspect',tag],{encoding:'utf8',env:process.env});
  if(inspected.status!==0){
   if(result.status===0){fs.appendFileSync(observations,JSON.stringify({phase:'missing',service:name,tag})+'\\n');process.exit(127)}
   continue;
  }
  const image=JSON.parse(inspected.stdout)[0];
  if(!/^sha256:[a-f0-9]{64}$/i.test(image?.Id||'')||!Number.isFinite(Date.parse(image?.Created||'')))process.exit(127);
  fs.appendFileSync(observations,JSON.stringify({phase:'observed',service:name,tag,id:image.Id,created:image.Created,success:result.status===0})+'\\n');
 }
}
process.exit(result.status??1);
`;
  writeFileSync(shim, source, { mode: 0o700, flag: 'wx' });
  record.builder.shimDir = shimDir;
  record.builder.builtTagsFile = builtTagsFile;
  record.builder.overlayFile = overlayFile;
  const shimStat = lstatSync(shim);
  record.runState.shim = { dev: shimStat.dev, ino: shimStat.ino };
  if (record.file) writeAtomic(record.file, record);
  return shimDir;
}

/** Persist each selected wave's exact image witness, including partial failures. */
export function recordBuiltTags(record) {
  const file = record?.builder?.builtTagsFile;
  const rows = file && existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const observed = rows.map((row) => JSON.parse(row));
  if (observed.some((row) => !record.plannedTags.includes(row.tag) ||
    row.tag !== record.project + '-' + row.service || !['planned', 'observed', 'missing'].includes(row.phase))) {
    throw new Error('Built image tag was not reserved before launch');
  }
  const potential = new Set(observed.filter((row) => row.phase === 'planned').map((row) => row.tag));
  const witnessed = new Map();
  for (const row of observed.filter((value) => value.phase === 'observed')) {
    if (!potential.has(row.tag) || !/^sha256:[a-f0-9]{64}$/i.test(row.id ?? '')
      || !Number.isFinite(Date.parse(row.created ?? ''))) throw new Error('Build wave image witness is invalid');
    const earlier = witnessed.get(row.tag);
    if (earlier && (earlier.id !== row.id || earlier.created !== row.created)) {
      throw new Error('Build wave image tag changed identity between observations');
    }
    witnessed.set(row.tag, row);
  }
  record.potentialBuiltTags = [...potential];
  record.observedImages = [...witnessed.values()];
  record.builtTags = record.observedImages.filter((image) => image.success).map((image) => image.tag);
  record.requiredBuiltTags = [...new Set([...record.builtTags,
    ...observed.filter((row) => row.phase === 'missing').map((row) => row.tag)])];
  if (record.file) writeAtomic(record.file, record);
  return record.builtTags;
}

function verifyOwnedCache(record) {
  const saved = record.cache;
  if (!saved) return false;
  let current;
  try { current = lstatSync(saved.path); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== saved.dev || current.ino !== saved.ino
    || realpathSync(saved.path) !== saved.path
    || !saved.path.endsWith(path.join('run-state', record.token, 'turbo-cache'))) {
    throw new Error('Owned local cache root changed identity or became a symlink');
  }
  return true;
}

function removeOwnedCache(record) {
  if (!record.cache) return;
  if (!verifyOwnedCache(record)) { record.cache = null; return; }
  const saved = record.cache;
  rmSync(saved.path, { recursive: true });
  record.cache = null;
}

function verifyOwnedRunState(record) {
  const saved = record.runState;
  let current;
  try { current = lstatSync(saved.path); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== saved.dev || current.ino !== saved.ino
    || realpathSync(saved.path) !== saved.path || !saved.path.endsWith(path.join('run-state', record.token))) {
    throw new Error('Run-owned builder state root changed identity');
  }
  if (saved.shim) {
    let shim;
    try { shim = lstatSync(path.join(saved.path, 'bin', 'docker')); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (shim && (!shim.isFile() || shim.isSymbolicLink() || shim.dev !== saved.shim.dev || shim.ino !== saved.shim.ino)) {
      throw new Error('Run-owned Docker shim changed identity');
    }
  }
  return true;
}

function removeOwnedRunState(record) {
  if (!record.runState) return;
  if (!verifyOwnedRunState(record)) { record.runState = null; return; }
  const root = record.runState.path;
  const allowed = new Set(['buildkitd.toml', 'bin', 'built-tags.jsonl', 'owned-images.json']);
  if (readdirSync(root).some((name) => !allowed.has(name))) throw new Error('Run-owned state contains unknown files');
  if (existsSync(path.join(root, 'bin'))) {
    if (readdirSync(path.join(root, 'bin')).some((name) => name !== 'docker')) throw new Error('Run-owned shim directory contains unknown files');
    rmSync(path.join(root, 'bin', 'docker'), { force: true });
    rmdirSync(path.join(root, 'bin'));
  }
  rmSync(path.join(root, 'buildkitd.toml'), { force: true });
  rmSync(path.join(root, 'built-tags.jsonl'), { force: true });
  rmSync(path.join(root, 'owned-images.json'), { force: true });
  rmdirSync(root);
  record.runState = null;
}

function removeRunOwnedBuilder(record, run) {
  if (!record.builder) return;
  const parts = verifiedBuilder(record, run);
  if (parts) {
    dockerResult(['buildx', 'rm', record.builder.name], run);
    if (verifiedBuilder(record, run)) throw new Error('Owned builder remains after removal');
  }
  record.builder = null;
}

const MIN_FREE_BYTES = 64_000_000_000n;

function systemRun(binary, args) {
  return spawnSync(binary, args, { encoding: 'utf8', timeout: 30_000 });
}

function sameInode(left, right) {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

function output(binary, args, run) {
  const result = run(binary, args);
  if (result.error || result.status !== 0) throw new Error(binary + ' probe is unreadable: '
    + String(result.stderr ?? result.error ?? '').trim());
  return String(result.stdout ?? '').trim();
}

/** Only direct containerized E2E builds consume the disk admission budget. */
export function isContainerizedBuild(command, args = []) {
  const words = [command, ...args];
  const runner = words.some((word) => /(?:^|\/)run-containerized\.sh$/.test(word));
  if (runner) return !args.includes('--no-build');
  return path.basename(command ?? '') === 'dagger' && args[0] === 'call' && args[1] === 'e-2-e';
}

/** Measure the Docker backing filesystem in integer 1024-byte df blocks. */
export function measureDockerDisk({ home = os.homedir(), run = systemRun, exists = existsSync,
  sameFile = sameInode, docker = process.env.VIBE_E2E_DOCKER || 'docker' } = {}) {
  const root = output(docker, ['info', '--format', '{{.DockerRootDir}}'], run);
  if (!root) throw new Error('Docker root probe is unreadable');
  const endpoint = output(docker, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], run);
  if (!endpoint.startsWith('unix://')) throw new Error('Docker context is nonlocal: ' + endpoint);
  const socketPath = endpoint.slice('unix://'.length);
  let backing;
  const desktopSocket = path.join(home, '.docker', 'run', 'docker.sock');
  if (sameFile(socketPath, desktopSocket)) {
    const socket = path.join(home, 'Library', 'Containers', 'com.docker.docker', 'Data', 'backend.sock');
    const settings = JSON.parse(output('curl', ['-s', '--unix-socket', socket, 'http://localhost/app/settings'], run));
    backing = settings?.vm?.resources?.dataFolder;
    if (typeof backing !== 'string' || !exists(backing)) throw new Error('Docker Desktop data folder is unreadable');
  } else if (socketPath === '/var/run/docker.sock' && exists(root)) {
    backing = root;
  } else {
    throw new Error('Docker context has no verified local backing path: ' + endpoint);
  }
  let diskTable;
  try { diskTable = output('df', ['-Pk', backing], run); }
  catch (error) { throw new Error('Docker free-space probe is unreadable under ' + backing + ': ' + error.message); }
  const lines = diskTable.split(/\r?\n/);
  const available = lines[1]?.trim().split(/\s+/)[3];
  if (!/^[0-9]+$/.test(available ?? '')) {
    throw new Error('Docker free-space probe is unreadable under ' + backing + '; requires 64,000,000,000 bytes');
  }
  const free = BigInt(available) * 1024n;
  if (free > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Docker free-space probe exceeds exact integer range');
  return { path: backing, freeBytes: Number(free), thresholdBytes: Number(MIN_FREE_BYTES) };
}

/** Warn and refuse a verified build below the repo's 64 GB decimal standard. */
export function requireDockerDisk(options = {}) {
  let measured;
  try { measured = measureDockerDisk(options); }
  catch (error) { throw new Error('Docker disk admission unavailable: '
    + String(error instanceof Error ? error.message : error) + '; requires 64,000,000,000 bytes'); }
  if (BigInt(measured.freeBytes) < MIN_FREE_BYTES) {
    throw new Error('Docker build refused: ' + measured.freeBytes + ' bytes free under ' + measured.path
      + '; requires 64,000,000,000 bytes');
  }
  return measured;
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
