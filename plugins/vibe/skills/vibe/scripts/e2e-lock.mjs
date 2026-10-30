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
// Generated Compose projects start empty. After a run, exact container,
// volume and network witnesses are removed before the lock is released; a
// refusal retains a private pending record. Caller and foreign projects stay.
//
// `run` exits with the command's own code. When the stack stays busy past
// `--wait-seconds` (default 3600) it runs nothing, prints
// {"status":"busy","holder":{...}} and exits 75. `status` prints
// {"status":"free"} or {"status":"held","holder":{...}}.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { escalation, isSandboxRefusal } from "./sandbox-refusal.mjs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { imageProblem, recordImages } from "./image-head.mjs";
import { readProcessIdentity } from "../../../shared/process-identity.mjs";
import { testedSource, sameSource, withStableSource } from "./tested-head.mjs";

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
  return env.COMPOSE_PROJECT_NAME || `${COMPOSE_PREFIX}${token.replace(/-/g, "").slice(0, 8)}`;
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
  return { id: identity, created, project };
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
        || (record.project && current.project !== record.project))) {
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

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
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
  const dockerReady = generatedProject && spawnSync(process.env.VIBE_E2E_DOCKER || "docker", ["version"],
    { encoding: "utf8", timeout: 10_000 }).status === 0;
  const cleanupFile = path.join(path.dirname(lockDir), `e2e-cleanup-${owner.token}.json`);
  if (dockerReady) {
    try {
      const existing = captureOwnedDockerResources({ project: composeProject });
      if (DOCKER_KINDS.some((kind) => existing[kind.key].length > 0)) {
        throw new Error("The generated Compose project already has resources; it is not this run's.");
      }
    } catch (error) {
      release(lockDir, owner);
      throw error;
    }
    writeFileSync(cleanupFile, JSON.stringify({ project: composeProject, owner }), { mode: 0o600 });
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
      return { exitCode: await runCommand(command, args, { ...process.env, COMPOSE_PROJECT_NAME: composeProject }), executed: true };
    }, { head: tested });
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
        const resources = captureOwnedDockerResources({ project: composeProject });
        writeFileSync(cleanupFile, JSON.stringify({ project: composeProject, owner, resources }), { mode: 0o600 });
        removeOwnedDockerResources(resources);
        rmSync(cleanupFile, { force: true });
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      if (isSandboxRefusal(error)) process.stdout.write(`${JSON.stringify(escalation(error, ESCALATION_JUSTIFICATION))}\n`);
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    }
  );
}
