import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureOwnedDockerResources, removeOwnedDockerResources } from '../../vibe/scripts/owned-docker.mjs';
import { defaultLockDir, sameWorktreeEntry } from '../../vibe/scripts/e2e-lock.mjs';
import { readSessionRecord } from '../../vibe/scripts/session-record.mjs';
import { acquireLedgerLock, helperEntries, isAlive, pendingRecordedProcess, read, readIdentity, write } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Capture the exact live vibe or fleet writer lease that authorizes a scratch stack. */
export function captureScratchLease(orchDir, owner, worktree) {
  let session;
  try { session = readSessionRecord(worktree); } catch { /* Fleet state is checked below. */ }
  if (session?.createdAt && session.status === 'active') return { kind: 'vibe', createdAt: session.createdAt };
  const file = path.join(process.env.LOCAL_STATE_DIR || path.join(orchDir, 'sessions'), owner + '.json');
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { /* Missing proof refuses registration. */ }
  if (state?.cwd === path.resolve(worktree) && state.threadId && !state.ended) {
    return { kind: 'fleet', stateDir: path.dirname(file), name: owner, threadId: state.threadId };
  }
  throw new Error('scratch start requires a live recorded vibe or fleet writer lease');
}

/** Whether the scratch stack's recorded writer lease has reached its terminal handoff. */
export function scratchLeaseTerminal(helper) {
  const lease = helper.writerLease;
  if (lease?.kind === 'vibe') {
    try {
      const current = readSessionRecord(helper.worktree);
      return current?.createdAt === lease.createdAt && current.status === 'handed-off';
    } catch { return false; }
  }
  if (lease?.kind === 'fleet') {
    try {
      const current = JSON.parse(readFileSync(path.join(lease.stateDir, lease.name + '.json'), 'utf8'));
      return current.cwd === helper.worktree && current.threadId === lease.threadId
        && Boolean(current.ended && current.archivedAt);
    } catch { return false; }
  }
  return false;
}

/** Reconcile expired, creation-labelled scratch stacks without touching active leases. */
export function reconcileExpiredScratchHelpers(ledger, now, { capture = captureOwnedDockerResources,
  cleanup = removeOwnedDockerResources, alive = isAlive, identityOf = readIdentity,
  leaseTerminal = scratchLeaseTerminal, explicit = false,
  lockHeld = (worktree) => Boolean(sameWorktreeEntry(defaultLockDir(), worktree)) } = {}) {
  const findings = [];
  let changed = false;
  for (const [name, helper] of helperEntries(ledger)) {
    if (helper.kind !== "scratch" || helper.stoppedAt
      || !explicit && now < Date.parse(helper.expiresAt ?? "")) continue;
    const label = `${name} owner ${helper.owner ?? "unknown"} ticket ${helper.ticket ?? "unknown"}`;
    try {
      if (!helper.owner || !helper.ticket || !helper.worktree || !helper.project || !helper.ownerToken
        || !helper.writerLease || !Number.isFinite(Date.parse(helper.startedAt)) || !Number.isFinite(Date.parse(helper.expiresAt))) {
        throw new Error("scratch ownership or TTL is incomplete");
      }
      if (!explicit && !leaseTerminal(helper)) throw new Error('scratch writer lease remains active');
      if ((helper.pids ?? []).some((pid) => pendingRecordedProcess({ pid, identity: helper.identities?.[pid] }, alive, identityOf))
        || lockHeld(helper.worktree)) throw new Error("scratch process or lock remains active");
      const current = capture({ project: helper.project });
      for (const kind of ["containers", "volumes", "networks"]) {
        const saved = new Map((helper.dockerResources?.[kind] ?? []).map((witness) => [witness.id, witness]));
        for (const witness of current[kind]) {
          if (witness.project !== helper.project || witness.ownerToken !== helper.ownerToken
            || Date.parse(witness.created) <= Date.parse(helper.startedAt)) throw new Error("scratch resource lacks exact owner and creation proof");
          if (helper.dockerResources) {
            const previous = saved.get(witness.id);
            if (!previous || previous.created !== witness.created || previous.ownerToken !== witness.ownerToken) {
              throw new Error("scratch resource changed or was not recorded");
            }
          }
        }
      }
      const target = helper.dockerResources ?? current;
      cleanup(target);
      helper.dockerResources = target;
      helper.stoppedAt = new Date(now).toISOString();
      helper.cleanupError = undefined;
      changed = true;
    } catch (error) {
      helper.cleanupError = error instanceof Error ? error.message : String(error);
      findings.push(`LEFTOVER ${label}: ${helper.cleanupError}`);
      changed = true;
    }
  }
  return { findings, changed };
}


function scratchProgramFile(orchDir, home = os.homedir()) {
  const digest = createHash('sha256').update(path.resolve(orchDir)).digest('hex');
  return path.join(home, '.codex', 'vibe', 'cleanup', 'scratch-programs', digest + '.json');
}

/** Register a fleet directory for bounded crash-recovery sweeps outside its worktree. */
export function registerScratchProgram(orchDir, home = os.homedir()) {
  const file = scratchProgramFile(orchDir, home);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const marker = path.join(home, '.codex', 'vibe', 'cleanup', 'pending');
  writeFileSync(marker, JSON.stringify({ pending: true }), { mode: 0o600 });
  const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify({ orchDir: path.resolve(orchDir) }), { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
}

/** One bounded scratch pass under the helper ledger lock; TTL never replaces terminal writer proof. */
export async function sweepScratchHelpers(orchDir, { now = Date.now(), deadline = Date.now() + 30_000,
  clock = Date.now, maxRecords = 20, home = os.homedir(), ...checks } = {}) {
  if (clock() >= deadline || maxRecords <= 0) return { removed: [], leftover: [], visited: 0 };
  const initial = read(orchDir);
  const due = helperEntries(initial).filter(([, helper]) => helper.kind === 'scratch' && !helper.stoppedAt
    && now >= Date.parse(helper.expiresAt ?? '')).map(([name]) => name);
  const allScratch = helperEntries(initial).filter(([, helper]) => helper.kind === 'scratch');
  if (!due.length) {
    if (allScratch.length && allScratch.every(([, helper]) => helper.stoppedAt)) rmSync(scratchProgramFile(orchDir, home), { force: true });
    return { removed: [], leftover: [], visited: 0 };
  }
  let release;
  try { release = await acquireLedgerLock(orchDir, { waitMs: Math.min(1_000, Math.max(1, deadline - clock())), clock }); }
  catch { return { removed: [], leftover: ['LEFTOVER scratch helper ledger is busy'], visited: 0 }; }
  try {
    const ledger = read(orchDir);
    const names = helperEntries(ledger).filter(([, helper]) => helper.kind === 'scratch' && !helper.stoppedAt
      && now >= Date.parse(helper.expiresAt ?? '')).map(([name]) => name).sort();
    const cursorFile = path.join(orchDir, 'scratch.cursor');
    let offset = 0;
    try { offset = Number(JSON.parse(readFileSync(cursorFile, 'utf8')).next) || 0; } catch { /* First pass. */ }
    let visited = 0;
    let changed = false;
    const removed = [];
    const leftover = [];
    for (let index = 0; index < Math.min(maxRecords, names.length); index += 1) {
      if (clock() >= deadline) break;
      const name = names[(offset + index) % names.length];
      visited += 1;
      const wasStopped = Boolean(ledger[name].stoppedAt);
      const result = reconcileExpiredScratchHelpers({ [name]: ledger[name] }, now, checks);
      changed ||= result.changed;
      leftover.push(...result.findings);
      if (!wasStopped && ledger[name].stoppedAt) removed.push(name);
    }
    if (names.length) {
      const temp = cursorFile + '.' + process.pid + '.' + randomUUID() + '.tmp';
      writeFileSync(temp, JSON.stringify({ next: (offset + visited) % names.length }), { mode: 0o600, flag: 'wx' });
      renameSync(temp, cursorFile);
    }
    if (changed) write(orchDir, ledger);
    const remainingScratch = helperEntries(ledger).filter(([, helper]) => helper.kind === 'scratch');
    if (remainingScratch.length && remainingScratch.every(([, helper]) => helper.stoppedAt)) rmSync(scratchProgramFile(orchDir, home), { force: true });
    return { removed, leftover, visited };
  } finally { release(); }
}


function command(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`Scratch command failed: ${bin} ${args.slice(0, 3).join(' ')}: ${String(result.stderr ?? result.error ?? '').trim()}`);
  return String(result.stdout ?? '').trim();
}

/** Label every service, named volume and network so exact helper witnesses can verify ownership. */
export function scratchOverlay(config, ownerToken, project) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project ?? '')) throw new Error('Scratch overlay needs its exact Compose project.');
  if (!config?.services || Object.keys(config.services).length === 0) throw new Error('Scratch Compose file has no services.');
  const volumes = config.volumes ?? {};
  for (const service of Object.values(config.services)) {
    if (service.build) throw new Error('Scratch wrapper does not own locally built service images.');
    if (service.privileged || service.network_mode || service.pid || service.ipc || service.userns_mode
      || service.uts || service.devices?.length || service.cap_add?.length || service.security_opt?.length
      || service.volumes_from?.length || service.secrets?.length || service.configs?.length) {
      throw new Error('Scratch service requests privileged or host resources.');
    }
    for (const mount of service.volumes ?? []) {
      if (!mount || mount.type !== 'volume' || !mount.source || !Object.hasOwn(volumes, mount.source)) {
        throw new Error('Scratch wrapper requires project-owned named volumes and refuses host binds.');
      }
    }
  }
  const volumeProblem = Object.entries(volumes).some(([key, volume]) => volume.external
    || volume.name && volume.name !== `${project}_${key}` || volume.driver_opts
    || volume.driver && volume.driver !== 'local');
  const networkProblem = Object.entries(config.networks ?? {}).some(([key, network]) => network.external
    || network.name && network.name !== `${project}_${key}` || network.driver_opts
    || network.driver && network.driver !== 'bridge');
  if (volumeProblem || networkProblem) {
    throw new Error('Scratch wrapper cannot claim explicit, shared or host-backed Docker resources.');
  }
  const labels = { 'vibe.owner-token': ownerToken };
  return {
    services: Object.fromEntries(Object.keys(config.services).map((name) => [name, { labels }])),
    volumes: Object.fromEntries(Object.keys(config.volumes ?? {}).map((name) => [name, { labels }])),
    networks: Object.fromEntries(Object.keys(config.networks ?? {}).map((name) => [name, { labels }])),
  };
}

/** Reserve, label, launch and capture one PostgreSQL/perf/seed scratch Compose project. */
export function runScratchStack({ orchDir, name, owner, ticket, worktree, ttlSeconds, composeFile },
  { run = command, docker = process.env.VIBE_E2E_DOCKER || 'docker' } = {}) {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400 || !existsSync(composeFile)) {
    throw new Error('Scratch stack needs an existing Compose file and TTL of 60 to 86400 seconds.');
  }
  const token = randomUUID().replace(/-/g, '');
  const project = `vibe-scratch-${token}`;
  const helper = path.join(HERE, 'helpers.mjs');
  run(process.execPath, [helper, orchDir, 'start', name, '--kind', 'scratch', '--owner', owner, '--ticket', ticket,
    '--worktree', worktree, '--project', project, '--ttl-seconds', String(ttlSeconds)]);
  const ledger = JSON.parse(readFileSync(path.join(orchDir, 'helpers.json'), 'utf8'));
  const ownerToken = ledger[name]?.ownerToken;
  if (!ownerToken || ledger[name]?.project !== project) throw new Error('Scratch owner was not recorded before Docker launch.');
  const config = JSON.parse(run(docker, ['compose', '--project-name', project, '-f', composeFile, 'config', '--format', 'json']));
  const overlay = scratchOverlay(config, ownerToken, project);
  const overlayDir = path.join(orchDir, 'scratch-overlays');
  mkdirSync(overlayDir, { recursive: true, mode: 0o700 });
  const overlayFile = path.join(overlayDir, `${token}.json`);
  const snapshotFile = path.join(overlayDir, `${token}-checked.json`);
  // Compose must read the private bytes that passed isolation, not the caller's mutable path.
  writeFileSync(snapshotFile, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  writeFileSync(overlayFile, JSON.stringify(overlay), { mode: 0o600, flag: 'wx' });
  try {
    run(docker, ['compose', '--project-name', project, '-f', snapshotFile, '-f', overlayFile, 'up', '-d']);
    run(process.execPath, [helper, orchDir, 'resources', name, '--project', project]);
  } finally { rmSync(overlayFile, { force: true }); rmSync(snapshotFile, { force: true }); }
  return { name, project, ownerToken, expiresAt: ledger[name].expiresAt };
}
