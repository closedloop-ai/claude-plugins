#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { recordDisplayActivation } from './display-event.mjs';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditEventJournal,
  inspectThread as inspectAppServerThread,
  rebindParent as rebindGenericParent,
  statusSession as statusGenericSession,
} from './native-app-server-orchestrator.mjs';
import { rebindParent as rebindLegacyAppServerParent } from './app-server-worker-session.mjs';

export const REGISTRY_SCHEMA = 'CL_SWEEP_ROOT_REGISTRY v1';
export const SCOPE_SCHEMA = 'CL_SWEEP_ROOT_SCOPE v1';
export const MONITOR_REGISTRY_SCHEMA = 'CL_SWEEP_MONITOR_REGISTRY v1';
export const ROOT_TRANSFER_SCHEMA = 'CL_SWEEP_ROOT_TRANSFER v1';
export const ROOT_AUTHORITY_SCHEMA = 'CL_SWEEP_ROOT_AUTHORITY v1';

const ROOT_LEASE_KEY = '@sweep-root';
const TERMINAL_EVENTS = new Set(['TERMINAL', 'ABANDONED']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const ownershipScript = resolve(scriptDirectory, 'ownership-lease.mjs');
const fallbackWorkerScript = resolve(scriptDirectory, 'cli-worker-session.mjs');
const monitorScript = resolve(scriptDirectory, '../../gh-monitor-pr/scripts/monitor-pr.mjs');

function fail(message) {
  throw new Error(message);
}

function now() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashRecord(record) {
  return sha256(JSON.stringify(record));
}

function canonicalKey(value, label) {
  const result = String(value || '').normalize('NFKC').trim().toLowerCase();
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) {
    fail(`${label} must be a nonempty stable identifier`);
  }
  return result;
}

function canonicalDirectory(pathValue, label) {
  if (!pathValue) fail(`${label} is required`);
  const path = realpathSync(resolve(pathValue));
  if (!statSync(path).isDirectory()) fail(`${label} must be a directory`);
  return path;
}

/** Normalize a ClosedLoop project UUID or a full ClosedLoop project URL. */
export function normalizeProjectReference(value) {
  const input = String(value || '').trim();
  let projectId = null;
  if (UUID.test(input)) {
    projectId = input;
  } else {
    let url;
    try { url = new URL(input); } catch { fail('Project must be a ClosedLoop project UUID or URL'); }
    if (url.protocol !== 'https:' || !/(^|\.)closedloop(?:-stage)?\.ai$/i.test(url.hostname)) {
      fail('Project URL must be an HTTPS ClosedLoop URL');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const projectIndex = parts.findIndex((part) => part.toLowerCase() === 'projects');
    const candidate = projectIndex >= 0 ? parts[projectIndex + 1] : null;
    if (!candidate || !UUID.test(candidate)) fail('ClosedLoop project URL is missing a project UUID');
    projectId = candidate;
  }
  projectId = projectId.toLowerCase();
  return { projectId, projectKey: `closedloop-project:${projectId}` };
}

function repositoryBinding(pathValue) {
  const path = canonicalDirectory(pathValue, 'repo path');
  const git = (args) => execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  let topLevel;
  let commonDir;
  try {
    topLevel = realpathSync(git(['rev-parse', '--show-toplevel']));
    commonDir = realpathSync(resolve(topLevel, git(['rev-parse', '--git-common-dir'])));
  } catch {
    fail('repo path must belong to a Git repository');
  }
  return { repoTopLevel: topLevel, repoCommonDir: commonDir };
}

function stateBase(options, create = false) {
  const path = resolve(options.stateBase || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'cl-sweep-state'));
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) return path;
  const canonical = realpathSync(path);
  if ((statSync(canonical).mode & 0o077) !== 0) fail(`Sweep state directory must be mode 0700: ${canonical}`);
  return canonical;
}

function registryPath(base) {
  return resolve(base, 'registry.jsonl');
}

function readRegistry(base) {
  const path = registryPath(base);
  if (!existsSync(path)) return [];
  const records = [];
  let previousHash = null;
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').filter(Boolean).entries()) {
    const record = JSON.parse(line);
    const { hash, ...unsigned } = record;
    if (
      record.schema !== REGISTRY_SCHEMA ||
      record.sequence !== index + 1 ||
      record.previousHash !== previousHash ||
      hashRecord(unsigned) !== hash
    ) {
      fail(`Invalid append-only sweep registry at line ${index + 1}`);
    }
    records.push(record);
    previousHash = hash;
  }
  return records;
}

/** Append one hash-chained registry transition. Callers must hold the registry lock. */
export function appendRegistryRecord(base, records, data) {
  for (const key of ['schema', 'sequence', 'previousHash', 'hash']) {
    if (Object.hasOwn(data, key)) fail(`Registry transition cannot set reserved field ${key}`);
  }
  const previousHash = records.at(-1)?.hash ?? null;
  const unsigned = {
    schema: REGISTRY_SCHEMA,
    sequence: records.length + 1,
    ...data,
    previousHash,
  };
  const record = { ...unsigned, hash: hashRecord(unsigned) };
  const path = registryPath(base);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  records.push(record);
  return record;
}

async function withRegistryLock(base, callback) {
  const lock = resolve(base, 'registry.lock');
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) fail(`Could not acquire sweep registry lock: ${lock}`);
      // Yield so the in-process lock holder can finish awaited ownership probes.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  try { return await callback(); } finally { rmdirSync(lock); }
}

function currentRoots(records) {
  const roots = new Map();
  for (const record of records) roots.set(record.sweepId, record);
  return [...roots.values()];
}

function unindexedLegacyRoots(base, records) {
  if (!existsSync(base)) return [];
  const indexed = new Set(currentRoots(records).map((root) => root.rootPath));
  const candidates = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || ['sweeps', 'registry.lock'].includes(entry.name)) continue;
    const path = realpathSync(resolve(base, entry.name));
    if (indexed.has(path)) continue;
    if (existsSync(resolve(path, 'ownership.jsonl')) || existsSync(resolve(path, 'sessions'))) {
      candidates.push(path);
    }
  }
  return candidates;
}

function isUnfinished(record) {
  return !TERMINAL_EVENTS.has(record.event);
}

function rootSummary(record) {
  return {
    sweepId: record.sweepId,
    event: record.event,
    projectId: record.projectId,
    projectKey: record.projectKey,
    repoKey: record.repoKey,
    userKey: record.userKey,
    repoTopLevel: record.repoTopLevel,
    repoCommonDir: record.repoCommonDir,
    rootCwd: record.rootCwd,
    rootPath: record.rootPath,
    ownerSurface: record.ownerSurface,
    ownerThreadId: record.ownerThreadId,
    ownerGeneration: record.ownerGeneration,
    rootLeaseGeneration: record.rootLeaseGeneration,
    terminal: !isUnfinished(record),
    transfer: record.transfer || null,
    updatedAt: record.at,
  };
}

function rootIdentityFields(root) {
  return {
    sweepId: root.sweepId,
    projectId: root.projectId,
    projectKey: root.projectKey,
    repoKey: root.repoKey,
    userKey: root.userKey,
    repoTopLevel: root.repoTopLevel,
    repoCommonDir: root.repoCommonDir,
    rootCwd: root.rootCwd,
    rootPath: root.rootPath,
    ownerSurface: root.ownerSurface,
    ownerThreadId: root.ownerThreadId,
    ownerGeneration: root.ownerGeneration,
    rootLeaseId: root.rootLeaseId,
    rootLeaseTokenHash: root.rootLeaseTokenHash,
    rootLeaseGeneration: root.rootLeaseGeneration,
  };
}

function invocationContext(options) {
  const project = normalizeProjectReference(options.project);
  const repoKey = canonicalKey(options.repo, 'repo');
  const userKey = canonicalKey(options.user, 'user');
  const rootCwd = canonicalDirectory(options.rootCwd, 'root cwd');
  const repo = repositoryBinding(options.repoPath);
  const ownerSurface = options.ownerSurface || 'cli';
  if (!['desktop', 'cli'].includes(ownerSurface)) fail('owner surface must be desktop or cli');
  if (!options.rootThreadId) fail('root thread id is required');
  return {
    ...project,
    repoKey,
    userKey,
    rootCwd,
    ...repo,
    ownerSurface,
    rootThreadId: options.rootThreadId,
  };
}

function rootSecret(rootPath, generation) {
  return resolve(rootPath, 'private', 'root', String(generation), 'lease.secret.json');
}

function authorityPath(rootPath) {
  return resolve(rootPath, 'authority.json');
}

function authorityScopeHash(root) {
  return sha256(JSON.stringify({
    sweepId: root.sweepId,
    projectId: root.projectId,
    repoKey: root.repoKey,
    userKey: root.userKey,
    repoCommonDir: root.repoCommonDir,
    rootCwd: root.rootCwd,
  }));
}

function writeRootAuthority(root, values) {
  const authority = {
    schema: ROOT_AUTHORITY_SCHEMA,
    sweepId: root.sweepId,
    scopeHash: authorityScopeHash(root),
    state: values.state,
    ownerThreadId: values.ownerThreadId,
    ownerSurface: values.ownerSurface,
    generation: values.generation,
    transferId: values.transferId || null,
    updatedAt: now(),
  };
  writeJsonPrivate(authorityPath(root.rootPath), authority);
  return authority;
}

function currentRootLease(root) {
  const status = runOwnership([
    'status', '--ledger', resolve(root.rootPath, 'ownership.jsonl'), '--ticket', ROOT_LEASE_KEY,
  ]);
  const lease = status.record;
  if (!status.active || !lease || lease.ownerId !== root.ownerThreadId
    || lease.ownerSurface !== root.ownerSurface || lease.generation !== root.ownerGeneration
    || lease.ownerRole !== 'root' || lease.expiresAt !== null) {
    fail('Sweep root lease does not match the current durable authority');
  }
  return lease;
}

function assertRootOwnerRecord(root, options) {
  if (!root || !isUnfinished(root) || ['CREATION_PREPARED', 'TRANSFER_PREPARED'].includes(root.event)) {
    fail('Sweep root is not in an ACTIVE ownership state');
  }
  const generation = Number(options.rootGeneration);
  if (root.ownerThreadId !== options.rootThreadId || root.ownerGeneration !== generation) {
    fail('Sweep root owner generation does not match');
  }
  const path = authorityPath(root.rootPath);
  if (!existsSync(path)) fail('Sweep root authority fence is missing');
  const authority = JSON.parse(readFileSync(path, 'utf8'));
  if (authority.schema !== ROOT_AUTHORITY_SCHEMA || authority.state !== 'ACTIVE'
    || authority.sweepId !== root.sweepId || authority.scopeHash !== authorityScopeHash(root)
    || authority.ownerThreadId !== root.ownerThreadId || authority.ownerSurface !== root.ownerSurface
    || authority.generation !== root.ownerGeneration) {
    fail('Sweep root authority fence does not match the current registry generation');
  }
  const lease = currentRootLease(root);
  return { root: rootSummary(root), authority, lease };
}

/** Verify the exact current root/generation before any root-owned mutation. */
export async function assertRootOwner(options) {
  const base = stateBase(options, false);
  if (!existsSync(base)) fail('Sweep state base does not exist');
  return withRegistryLock(base, async () => {
    const root = currentRoots(readRegistry(base)).find((item) => item.sweepId === options.sweepId);
    return assertRootOwnerRecord(root, options);
  });
}

function runOwnership(args) {
  return JSON.parse(execFileSync(process.execPath, [ownershipScript, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function completePreparedCreation(base, records, prepared) {
  const { sweepId, rootPath } = prepared;
  mkdirSync(resolve(rootPath, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(resolve(rootPath, 'private', 'root', '1'), { recursive: true, mode: 0o700 });
  const scope = {
    schema: SCOPE_SCHEMA,
    sweepId,
    projectId: prepared.projectId,
    projectKey: prepared.projectKey,
    repoKey: prepared.repoKey,
    userKey: prepared.userKey,
    repoTopLevel: prepared.repoTopLevel,
    repoCommonDir: prepared.repoCommonDir,
    rootCwd: prepared.rootCwd,
    createdAt: prepared.at,
  };
  const scopeFile = resolve(rootPath, 'scope.json');
  if (existsSync(scopeFile)) {
    const existing = JSON.parse(readFileSync(scopeFile, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(scope)) fail('Prepared root scope does not match its durable creation intent');
  } else {
    writeJsonPrivate(scopeFile, scope);
  }
  const ledger = resolve(rootPath, 'ownership.jsonl');
  let lease = runOwnership(['status', '--ledger', ledger, '--ticket', ROOT_LEASE_KEY]);
  if (!lease.record) {
    lease = runOwnership([
      'acquire', '--ledger', ledger,
      '--ticket', ROOT_LEASE_KEY,
      '--owner-surface', prepared.ownerSurface,
      '--owner-role', 'root',
      '--owner-id', prepared.ownerThreadId,
      '--ttl-seconds', 'persistent',
      '--secret-output', rootSecret(rootPath, 1),
      '--reason', 'sweep_created',
    ]);
  } else {
    lease = lease.record;
    if (!existsSync(rootSecret(rootPath, 1)) || lease.generation !== 1 || lease.ownerRole !== 'root'
      || lease.ownerId !== prepared.ownerThreadId || lease.ownerSurface !== prepared.ownerSurface
      || lease.expiresAt !== null) {
      fail('Prepared root lease does not match its durable creation intent');
    }
  }
  const record = appendRegistryRecord(base, records, {
    event: 'CREATED',
    ...rootIdentityFields(prepared),
    ownerGeneration: 1,
    rootLeaseId: lease.leaseId,
    rootLeaseTokenHash: lease.leaseTokenHash,
    rootLeaseGeneration: lease.generation,
    at: now(),
  });
  writeRootAuthority(record, {
    state: 'ACTIVE', ownerThreadId: record.ownerThreadId,
    ownerSurface: record.ownerSurface, generation: record.ownerGeneration,
  });
  return { action: 'created', root: rootSummary(record) };
}

function createRoot(base, records, context) {
  const sweepId = randomUUID();
  const rootPath = resolve(base, 'sweeps', sweepId);
  const prepared = appendRegistryRecord(base, records, {
    event: 'CREATION_PREPARED',
    sweepId,
    projectId: context.projectId,
    projectKey: context.projectKey,
    repoKey: context.repoKey,
    userKey: context.userKey,
    repoTopLevel: context.repoTopLevel,
    repoCommonDir: context.repoCommonDir,
    rootCwd: context.rootCwd,
    rootPath,
    ownerSurface: context.ownerSurface,
    ownerThreadId: context.rootThreadId,
    ownerGeneration: 1,
    rootLeaseId: null,
    rootLeaseTokenHash: null,
    rootLeaseGeneration: 0,
    operationId: randomUUID(),
    at: now(),
  });
  return completePreparedCreation(base, records, prepared);
}

/** Index one legacy thread-keyed root so future project-only recovery can find it. */
export async function migrateLegacySweep(options) {
  const base = stateBase(options, true);
  const context = invocationContext(options);
  const rootPath = canonicalDirectory(options.legacyRoot, 'legacy root');
  return withRegistryLock(base, async () => {
    const records = readRegistry(base);
    const conflicts = currentRoots(records).filter((root) => (
      isUnfinished(root) &&
      root.projectId === context.projectId &&
      root.repoKey === context.repoKey &&
      root.userKey === context.userKey
    ));
    if (conflicts.length) fail('Cannot migrate: an unfinished project-scoped sweep root already exists');
    if (currentRoots(records).some((root) => root.rootPath === rootPath)) {
      fail('Legacy root is already indexed');
    }
    const scopePath = resolve(rootPath, 'scope.json');
    if (existsSync(scopePath)) fail('Legacy root already has scope metadata but is absent from the registry');
    mkdirSync(resolve(rootPath, 'private', 'root', '1'), { recursive: true, mode: 0o700 });
    const sweepId = randomUUID();
    const createdAt = now();
    const scope = {
      schema: SCOPE_SCHEMA,
      sweepId,
      projectId: context.projectId,
      projectKey: context.projectKey,
      repoKey: context.repoKey,
      userKey: context.userKey,
      repoTopLevel: context.repoTopLevel,
      repoCommonDir: context.repoCommonDir,
      rootCwd: context.rootCwd,
      createdAt,
      migratedFromThreadKeyedState: true,
    };
    writeJsonPrivate(scopePath, scope);
    const lease = runOwnership([
      'acquire', '--ledger', resolve(rootPath, 'ownership.jsonl'),
      '--ticket', ROOT_LEASE_KEY,
      '--owner-surface', context.ownerSurface,
      '--owner-role', 'root',
      '--owner-id', context.rootThreadId,
      '--ttl-seconds', 'persistent',
      '--secret-output', rootSecret(rootPath, 1),
      '--reason', 'legacy_root_indexed',
    ]);
    const record = appendRegistryRecord(base, records, {
      event: 'MIGRATED',
      sweepId,
      projectId: context.projectId,
      projectKey: context.projectKey,
      repoKey: context.repoKey,
      userKey: context.userKey,
      repoTopLevel: context.repoTopLevel,
      repoCommonDir: context.repoCommonDir,
      rootCwd: context.rootCwd,
      rootPath,
      ownerSurface: context.ownerSurface,
      ownerThreadId: context.rootThreadId,
      ownerGeneration: 1,
      rootLeaseId: lease.leaseId,
      rootLeaseTokenHash: lease.leaseTokenHash,
      rootLeaseGeneration: lease.generation,
      at: createdAt,
    });
    writeRootAuthority(record, {
      state: 'ACTIVE', ownerThreadId: record.ownerThreadId,
      ownerSurface: record.ownerSurface, generation: record.ownerGeneration,
    });
    return { action: 'migrated', root: rootSummary(record) };
  });
}

function writeJsonPrivate(pathValue, value) {
  const path = resolve(pathValue);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function walkJson(directory) {
  if (!existsSync(directory)) return [];
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...walkJson(path));
    else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(path);
  }
  return paths;
}

function discoverWorkers(root) {
  const workers = [];
  for (const stateFile of walkJson(resolve(root.rootPath, 'sessions'))) {
    if (!stateFile.endsWith('/session.json')) continue;
    let state;
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); }
    catch (error) { fail(`Malformed worker session manifest ${stateFile}: ${error.message}`); }
    if (state.schema === 'APP_SERVER_ORCHESTRATOR_SESSION v1' && state.sessionId && state.cwd) {
      workers.push({ kind: 'generic_app_server', stateFile, state });
    } else if (state.schema === 'CL_SWEEP_APP_SERVER_WORKER_SESSION v1' && state.worktree && state.ownerId) {
      workers.push({ kind: 'legacy_app_server', stateFile, state });
    } else if (state.schema === 'CL_SWEEP_CLI_WORKER_SESSION v1' && state.worktree && state.ownerId) {
      workers.push({ kind: 'codex_exec', stateFile, state });
    } else {
      fail(`Invalid or unsupported worker session manifest: ${stateFile}`);
    }
  }
  for (const replacement of workers) {
    const replacedIdentity = replacement.state.replacementOf;
    if (!replacedIdentity) continue;
    const prior = workers.find((candidate) => (
      `${candidate.state.ownerId}:${candidate.state.generation}` === replacedIdentity
      && candidate.state.ticket === replacement.state.ticket
      && candidate.state.worktree === replacement.state.worktree
    ));
    if (prior) prior.supersededBy = replacement.stateFile;
  }
  return workers;
}

function workerFeatureOwnership(worker) {
  const scope = worker.state.featureOwnership;
  if (!scope) return null;
  if (!scope.manifestSha256 || !scope.featureId || !scope.anchorTicket
    || !Array.isArray(scope.members) || scope.members.length < 2) {
    fail(`Malformed feature ownership binding: ${worker.stateFile}`);
  }
  return {
    featureId: scope.featureId,
    manifestSha256: scope.manifestSha256,
    anchorTicket: scope.anchorTicket,
    members: scope.members.map((member) => ({
      ticket: member.ticket,
      generation: member.generation,
      leaseId: member.lease_id,
      leaseTokenHash: member.lease_token_hash,
    })),
  };
}

function workerIsSettledOrSuperseded(worker) {
  if (['TERMINAL', 'REPLACED'].includes(worker.state.state)) return true;
  return Boolean(worker.supersededBy
    && !worker.state.activeTurnId
    && ['READY', 'WAITING', 'FAILED', 'INTERRUPTED'].includes(worker.state.state));
}

function workerDeliveryState(worker) {
  if (worker.kind === 'generic_app_server') {
    if (!Array.isArray(worker.state.events)) fail(`Invalid generic callback outbox: ${worker.stateFile}`);
    for (const entry of worker.state.events) {
      if (!entry?.event?.eventId || !entry.delivery?.status) {
        fail(`Malformed generic callback outbox entry: ${worker.stateFile}`);
      }
    }
    const audit = auditEventJournal(worker.state);
    const statuses = worker.state.events.map((entry) => entry.delivery.status);
    return {
      ambiguous: statuses.includes('delivering'),
      pending: statuses.filter((status) => !['delivered', 'not_configured'].includes(status)).length
        + audit.journalOnly.length + audit.outboxOnly.length,
    };
  }
  if (worker.kind === 'app_server' && Array.isArray(worker.state.events)) {
    const statuses = worker.state.events.map((entry) => entry?.delivery?.status);
    if (statuses.some((status) => !status)) {
      fail(`Malformed worker callback outbox entry: ${worker.stateFile}`);
    }
    return {
      ambiguous: statuses.includes('delivering'),
      pending: statuses.filter((status) => !['delivered', 'not_configured'].includes(status)).length,
    };
  }
  const status = worker.state.parentDelivery?.status;
  return {
    ambiguous: status === 'delivering',
    pending: status && !['delivered', 'not_configured'].includes(status) ? 1 : 0,
  };
}

function workerParent(worker) {
  if (worker.kind === 'generic_app_server') {
    return {
      threadId: worker.state.parent?.threadId,
      cwd: worker.state.parent?.cwd,
      generation: worker.state.parent?.generation ?? 1,
    };
  }
  return {
    threadId: worker.state.parentThreadId,
    cwd: worker.state.parentCwd,
    generation: worker.state.parentGeneration ?? 1,
  };
}

async function inspectWorkerDefault(worker) {
  if (worker.kind === 'generic_app_server') {
    const status = await statusGenericSession({ stateFile: worker.stateFile });
    return { active: status.threadStatus === 'active' || Boolean(status.activeTurnId), status };
  }
  if (worker.kind === 'legacy_app_server') {
    if (worker.state.activeTurnId || ['RUNNING', 'DISCONNECTED'].includes(worker.state.state)) {
      return { active: true, status: worker.state.state };
    }
    if (!worker.state.appServerThreadId) return { active: false, status: worker.state.state };
    const status = await inspectAppServerThread({
      threadId: worker.state.appServerThreadId,
      cwd: worker.state.worktree,
    });
    return { active: status.status === 'active' || Boolean(status.activeTurnId), status };
  }
  const status = JSON.parse(execFileSync(process.execPath, [
    fallbackWorkerScript, 'status', '--session-file', worker.stateFile,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  return { active: status.state === 'RUNNING' || status.activeProcess, status };
}

async function rebindWorkerDefault(worker, transfer) {
  const common = {
    expectedParentThreadId: transfer.from.threadId,
    expectedParentCwd: transfer.from.cwd,
    expectedParentGeneration: transfer.from.generation,
    parentThreadId: transfer.to.threadId,
    parentCwd: transfer.to.cwd,
  };
  if (worker.kind === 'generic_app_server') {
    return rebindGenericParent({ stateFile: worker.stateFile, ...common });
  }
  if (worker.kind === 'legacy_app_server') {
    return rebindLegacyAppServerParent({
      'session-file': worker.stateFile,
      'expected-parent-thread-id': common.expectedParentThreadId,
      'expected-parent-cwd': common.expectedParentCwd,
      'expected-root-generation': String(common.expectedParentGeneration),
      'parent-thread-id': common.parentThreadId,
      'parent-cwd': common.parentCwd,
    });
  }
  return JSON.parse(execFileSync(process.execPath, [
    fallbackWorkerScript, 'rebind-parent',
    '--session-file', worker.stateFile,
    '--expected-parent-thread-id', common.expectedParentThreadId,
    '--expected-parent-cwd', common.expectedParentCwd,
    '--expected-root-generation', String(common.expectedParentGeneration),
    '--parent-thread-id', common.parentThreadId,
    '--parent-cwd', common.parentCwd,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

function monitorRegistryPath(rootPath) {
  return resolve(rootPath, 'monitors.json');
}

function readMonitorRegistry(rootPath) {
  const path = monitorRegistryPath(rootPath);
  if (!existsSync(path)) return { schema: MONITOR_REGISTRY_SCHEMA, monitors: [] };
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  if (registry.schema !== MONITOR_REGISTRY_SCHEMA || !Array.isArray(registry.monitors)) {
    fail('Invalid sweep monitor registry');
  }
  return registry;
}

function writeMonitorRegistry(rootPath, monitors) {
  writeJsonPrivate(monitorRegistryPath(rootPath), {
    schema: MONITOR_REGISTRY_SCHEMA,
    monitors,
    updatedAt: now(),
  });
}

function stopMonitorDefault(entry) {
  execFileSync(process.execPath, [
    monitorScript, 'stop', '--state-file', entry.stateFile, '--wait-seconds', '15',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const verified = JSON.parse(execFileSync(process.execPath, [
    monitorScript, 'verify-stopped', '--state-file', entry.stateFile,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (!verified.verifiedStopped) fail(`Monitor did not stop: ${entry.stateFile}`);
  return verified;
}

function startMonitorDefault(entry, transfer, receiptFile) {
  return JSON.parse(execFileSync(process.execPath, [
    monitorScript, 'start', entry.prUrl,
    '--thread-id', transfer.to.threadId,
    '--cwd', transfer.to.cwd,
    '--interval', String(entry.intervalSeconds),
    '--owner-surface', transfer.to.surface,
    '--owner-generation', String(transfer.to.generation),
    '--previous-state-file', entry.stateFile,
    '--root-transfer-file', receiptFile,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

function transferRootLease(root, transfer, options) {
  const command = transfer.from.surface === 'desktop' && transfer.to.surface === 'cli' ? 'transfer' : 'replace';
  const args = [
    command,
    '--ledger', resolve(root.rootPath, 'ownership.jsonl'),
    '--ticket', ROOT_LEASE_KEY,
    '--secret-file', rootSecret(root.rootPath, transfer.from.generation),
    '--secret-output', rootSecret(root.rootPath, transfer.to.generation),
    '--owner-surface', transfer.to.surface,
    '--owner-role', 'root',
    '--owner-id', transfer.to.threadId,
    '--ttl-seconds', 'persistent',
    '--reason', 'sweep_root_adoption',
  ];
  if (command === 'transfer') {
    if (!options.desktopFenceFile) fail('Desktop-to-CLI root adoption requires a verified desktop fence file');
    args.push('--desktop-fence-file', options.desktopFenceFile);
  }
  return runOwnership(args);
}

function exactBinding(root, context) {
  return root.rootCwd === context.rootCwd && root.repoCommonDir === context.repoCommonDir;
}

function readTransferReceipt(pathValue) {
  const receipt = JSON.parse(readFileSync(pathValue, 'utf8'));
  if (receipt.schema !== ROOT_TRANSFER_SCHEMA || receipt.status !== 'PREPARED' || !receipt.transferId) {
    fail('Invalid prepared root-transfer receipt');
  }
  receipt.phases ||= {};
  return receipt;
}

function updateTransferReceipt(pathValue, update) {
  const receipt = readTransferReceipt(pathValue);
  const next = update(receipt) || receipt;
  writeJsonPrivate(pathValue, next);
  return next;
}

async function completePreparedTransfer(base, records, root, context, options, dependencies) {
  const receiptFile = root.transfer?.receiptFile;
  if (!receiptFile) fail('Prepared root transfer is missing its receipt');
  let receipt = readTransferReceipt(receiptFile);
  const transfer = { transferId: receipt.transferId, from: receipt.from, to: receipt.to };
  if (transfer.to.threadId !== context.rootThreadId || transfer.to.cwd !== context.rootCwd
    || transfer.to.surface !== context.ownerSurface || transfer.to.generation !== root.ownerGeneration + 1) {
    fail('Ownership conflict: incomplete root transfer belongs to a different target root');
  }
  writeRootAuthority(root, {
    state: 'TRANSFERRING', ownerThreadId: transfer.from.threadId,
    ownerSurface: transfer.from.surface, generation: transfer.from.generation,
    transferId: transfer.transferId,
  });
  const inspectRoot = dependencies.inspectRoot || inspectAppServerThread;
  const verifyPriorIdle = async (label) => {
    let prior;
    try { prior = await inspectRoot({ threadId: transfer.from.threadId, cwd: transfer.from.cwd }); }
    catch (error) { fail(`Cannot ${label} prior root activity: ${error.message}`); }
    if (prior.status !== 'idle' || prior.activeTurnId) {
      fail(`Active-owner conflict: prior root ${transfer.from.threadId} is ${prior.status || 'unknown'}`);
    }
    return prior;
  };
  await verifyPriorIdle('verify');

  const monitorRegistry = receipt.monitorRegistry || readMonitorRegistry(root.rootPath);
  const stopMonitor = dependencies.stopMonitor || stopMonitorDefault;
  if (!receipt.phases.monitorsStopped) {
    for (const monitor of monitorRegistry.monitors) await stopMonitor(monitor, transfer);
    receipt = updateTransferReceipt(receiptFile, (current) => {
      current.phases.monitorsStopped = { at: now() };
      return current;
    });
  }
  await verifyPriorIdle('re-verify');

  const workers = discoverWorkers(root);
  const rebindWorker = dependencies.rebindWorker || rebindWorkerDefault;
  const workerTransfers = receipt.workerTransfers || [];
  if (!receipt.phases.workersRebound) {
    for (const worker of workers) {
      if (workerIsSettledOrSuperseded(worker)) {
        const delivery = workerDeliveryState(worker);
        if (delivery.pending || delivery.ambiguous) {
          fail(`Cannot skip inactive worker with unsettled callbacks during transfer: ${worker.stateFile}`);
        }
        if (!workerTransfers.some((item) => item.stateFile === worker.stateFile)) {
          workerTransfers.push({
            stateFile: worker.stateFile,
            ticket: worker.state.ticket || null,
            featureOwnership: workerFeatureOwnership(worker),
            ticketLeaseGenerationBefore: worker.state.generation ?? null,
            ticketLeaseGenerationAfter: worker.state.generation ?? null,
            callbackGeneration: workerParent(worker).generation,
            inactiveSkipped: true,
            supersededBy: worker.supersededBy || null,
          });
        }
        continue;
      }
      const parent = workerParent(worker);
      let result;
      if (parent.threadId === transfer.to.threadId && parent.cwd === transfer.to.cwd
        && parent.generation === transfer.to.generation) {
        result = { ticketOwnerGeneration: worker.state.generation ?? null, alreadyRebound: true };
      } else {
        if (parent.threadId !== transfer.from.threadId || parent.cwd !== transfer.from.cwd
          || parent.generation !== transfer.from.generation) {
          fail(`Worker callback binding conflict during transfer recovery: ${worker.stateFile}`);
        }
        result = await rebindWorker(worker, transfer);
      }
      if (!workerTransfers.some((item) => item.stateFile === worker.stateFile)) {
        workerTransfers.push({
          stateFile: worker.stateFile,
          ticket: worker.state.ticket || null,
          featureOwnership: workerFeatureOwnership(worker),
          ticketLeaseGenerationBefore: worker.state.generation ?? null,
          ticketLeaseGenerationAfter: result.ticketOwnerGeneration ?? worker.state.generation ?? null,
          callbackGeneration: transfer.to.generation,
        });
      }
    }
    receipt = updateTransferReceipt(receiptFile, (current) => {
      current.workerTransfers = workerTransfers;
      current.phases.workersRebound = { at: now() };
      return current;
    });
  }

  let lease = receipt.rootLease || null;
  if (!receipt.phases.rootLeaseRotated) {
    const currentLease = runOwnership([
      'status', '--ledger', resolve(root.rootPath, 'ownership.jsonl'), '--ticket', ROOT_LEASE_KEY,
    ]);
    if (currentLease.record?.generation === transfer.to.generation
      && currentLease.record.ownerId === transfer.to.threadId
      && currentLease.record.ownerSurface === transfer.to.surface) {
      lease = currentLease.record;
    } else {
      lease = await (dependencies.transferRootLease || transferRootLease)(root, transfer, options);
    }
    if (lease.generation !== transfer.to.generation) fail('Root lease generation did not match the prepared transfer');
    receipt = updateTransferReceipt(receiptFile, (current) => {
      current.rootLease = lease;
      current.phases.rootLeaseRotated = { at: now() };
      return current;
    });
  }

  const startMonitor = dependencies.startMonitor || startMonitorDefault;
  const monitorTransfers = receipt.monitorTransfers || [];
  if (!receipt.phases.monitorsStarted) {
    for (const monitor of monitorRegistry.monitors) {
      if (monitorTransfers.some((item) => item.prUrl === monitor.prUrl)) continue;
      const started = await startMonitor(monitor, transfer, receiptFile);
      monitorTransfers.push({
        prUrl: monitor.prUrl,
        previousStateFile: monitor.stateFile,
        stateFile: started.stateFile,
        ownerGeneration: transfer.to.generation,
        intervalSeconds: started.intervalSeconds || monitor.intervalSeconds,
        registrationDelta: started.registrationDelta || null,
      });
      receipt = updateTransferReceipt(receiptFile, (current) => {
        current.monitorTransfers = monitorTransfers;
        return current;
      });
    }
    const nextMonitors = monitorTransfers.map((monitor) => ({
      prUrl: monitor.prUrl,
      stateFile: monitor.stateFile,
      threadId: context.rootThreadId,
      cwd: context.rootCwd,
      ownerSurface: context.ownerSurface,
      ownerGeneration: transfer.to.generation,
      intervalSeconds: monitor.intervalSeconds,
    }));
    writeMonitorRegistry(root.rootPath, nextMonitors);
    receipt = updateTransferReceipt(receiptFile, (current) => {
      current.phases.monitorsStarted = { at: now() };
      return current;
    });
  }

  const committed = appendRegistryRecord(base, records, {
    event: 'TRANSFERRED',
    ...rootIdentityFields(root),
    ownerSurface: context.ownerSurface,
    ownerThreadId: context.rootThreadId,
    ownerGeneration: transfer.to.generation,
    rootLeaseId: lease.leaseId,
    rootLeaseTokenHash: lease.leaseTokenHash,
    rootLeaseGeneration: lease.generation,
    transfer: { ...transfer, receiptFile },
    at: now(),
  });
  writeRootAuthority(committed, {
    state: 'ACTIVE', ownerThreadId: committed.ownerThreadId,
    ownerSurface: committed.ownerSurface, generation: committed.ownerGeneration,
  });
  updateTransferReceipt(receiptFile, (current) => ({ ...current, status: 'COMMITTED', committedAt: now() }));
  return {
    action: 'adopted',
    root: rootSummary(committed),
    workerTransfers,
    monitorTransfers,
    reconciliationRequired: monitorTransfers.some((item) => item.registrationDelta?.detected),
  };
}

/** Resolve, create, resume, or fail-closed adopt one project-scoped sweep root. */
export async function openSweep(options, dependencies = {}) {
  const base = stateBase(options, true);
  const context = invocationContext(options);
  return withRegistryLock(base, async () => {
    const records = readRegistry(base);
    const scopeRoots = currentRoots(records).filter((root) => (
      isUnfinished(root) &&
      root.projectId === context.projectId &&
      root.repoKey === context.repoKey &&
      root.userKey === context.userKey
    ));
    if (scopeRoots.length > 1) {
      fail(`Ownership conflict: multiple unfinished sweep roots claim ${context.projectId} for ${context.repoKey}/${context.userKey}`);
    }
    if (scopeRoots.length === 0) {
      const legacyRoots = unindexedLegacyRoots(base, records);
      if (legacyRoots.length) {
        fail(`Unindexed legacy sweep roots require migration before create: ${legacyRoots.join(', ')}`);
      }
      return createRoot(base, records, context);
    }
    const root = scopeRoots[0];
    if (root.event === 'CREATION_PREPARED') {
      if (!exactBinding(root, context) || root.ownerThreadId !== context.rootThreadId
        || root.ownerSurface !== context.ownerSurface) {
        fail(`Ownership conflict: sweep ${root.sweepId} has an incomplete root creation owned by another exact root`);
      }
      return completePreparedCreation(base, records, root);
    }
    if (root.event === 'TRANSFER_PREPARED') {
      return completePreparedTransfer(base, records, root, context, options, dependencies);
    }
    if (!exactBinding(root, context)) {
      fail('Ownership conflict: project/repo/user scope exists with a different exact cwd or repository binding');
    }
    if (root.ownerThreadId === context.rootThreadId) {
      if (root.ownerSurface !== context.ownerSurface) fail('Existing root thread has a different execution surface');
      currentRootLease(root);
      writeRootAuthority(root, {
        state: 'ACTIVE', ownerThreadId: root.ownerThreadId,
        ownerSurface: root.ownerSurface, generation: root.ownerGeneration,
      });
      recordDisplayActivation(base, {
        sweepId: root.sweepId, projectId: root.projectId,
        ownerThreadId: root.ownerThreadId, ownerGeneration: root.ownerGeneration,
        kind: 'resumed', afterRegistrySequence: records.at(-1).sequence,
      });
      return { action: 'resumed', root: rootSummary(root) };
    }

    const inspectRoot = dependencies.inspectRoot || inspectAppServerThread;
    let prior;
    try {
      prior = await inspectRoot({ threadId: root.ownerThreadId, cwd: root.rootCwd });
    } catch (error) {
      fail(`Cannot verify prior root activity: ${error.message}`);
    }
    if (prior.status !== 'idle' || prior.activeTurnId) {
      fail(`Active-owner conflict: prior root ${root.ownerThreadId} is ${prior.status || 'unknown'}`);
    }

    const workers = discoverWorkers(root);
    const inspectWorker = dependencies.inspectWorker || inspectWorkerDefault;
    for (const worker of workers) {
      const delivery = workerDeliveryState(worker);
      if (delivery.ambiguous) {
        fail(`Ambiguous in-flight worker callback delivery blocks adoption: ${worker.stateFile}`);
      }
      const parent = workerParent(worker);
      if (
        parent.threadId !== root.ownerThreadId ||
        parent.cwd !== root.rootCwd ||
        parent.generation !== root.ownerGeneration
      ) {
        fail(`Worker callback binding conflict: ${worker.stateFile}`);
      }
      const status = await inspectWorker(worker);
      if (status.active) fail(`Active-owner conflict: worker is still active: ${worker.stateFile}`);
    }

    const monitorRegistry = readMonitorRegistry(root.rootPath);
    for (const monitor of monitorRegistry.monitors) {
      if (
        monitor.threadId !== root.ownerThreadId ||
        monitor.ownerGeneration !== root.ownerGeneration ||
        monitor.cwd !== root.rootCwd
      ) {
        fail(`Monitor ownership conflict: ${monitor.stateFile}`);
      }
    }

    const transfer = {
      transferId: randomUUID(),
      from: {
        threadId: root.ownerThreadId,
        cwd: root.rootCwd,
        surface: root.ownerSurface,
        generation: root.ownerGeneration,
      },
      to: {
        threadId: context.rootThreadId,
        cwd: context.rootCwd,
        surface: context.ownerSurface,
        generation: root.ownerGeneration + 1,
      },
    };
    const receipt = {
      schema: ROOT_TRANSFER_SCHEMA,
      status: 'PREPARED',
      sweepId: root.sweepId,
      projectId: root.projectId,
      repoKey: root.repoKey,
      userKey: root.userKey,
      repoCommonDir: root.repoCommonDir,
      ...transfer,
      monitorRegistry,
      phases: {},
      preparedAt: now(),
    };
    const receiptFile = resolve(root.rootPath, 'transfers', `${transfer.to.generation}-${transfer.transferId}.json`);
    writeJsonPrivate(receiptFile, receipt);
    appendRegistryRecord(base, records, {
      event: 'TRANSFER_PREPARED',
      ...rootIdentityFields(root),
      transfer: { ...transfer, receiptFile },
      at: now(),
    });
    writeRootAuthority(root, {
      state: 'TRANSFERRING', ownerThreadId: transfer.from.threadId,
      ownerSurface: transfer.from.surface, generation: transfer.from.generation,
      transferId: transfer.transferId,
    });

    const prepared = currentRoots(readRegistry(base)).find((item) => item.sweepId === root.sweepId);
    return completePreparedTransfer(base, records, prepared, context, options, dependencies);
  });
}

/** Return project-keyed recovery data without touching ownership. */
export function statusSweep(options) {
  const base = stateBase(options, false);
  const project = normalizeProjectReference(options.project);
  const records = existsSync(base) ? readRegistry(base) : [];
  let roots = currentRoots(records).filter((root) => root.projectId === project.projectId);
  if (options.repo) roots = roots.filter((root) => root.repoKey === canonicalKey(options.repo, 'repo'));
  if (options.user) roots = roots.filter((root) => root.userKey === canonicalKey(options.user, 'user'));
  const unfinished = roots.filter(isUnfinished).map(rootSummary);
  const terminalHistory = roots.filter((root) => !isUnfinished(root)).map(rootSummary);
  const conflicts = [];
  const claims = new Map();
  for (const root of unfinished) {
    const key = `${root.projectId}\0${root.repoKey}\0${root.userKey}`;
    const items = claims.get(key) || [];
    items.push(root.sweepId);
    claims.set(key, items);
  }
  for (const [scope, sweepIds] of claims) {
    if (sweepIds.length > 1) conflicts.push({ scope, sweepIds });
  }
  return { ...project, unfinished, terminalHistory, conflicts };
}

/** Register one parent-owned monitor so a later root can transfer it exactly. */
export async function registerMonitor(options) {
  const base = stateBase(options, true);
  return withRegistryLock(base, async () => {
    const root = currentRoots(readRegistry(base)).find((item) => item.sweepId === options.sweepId);
    assertRootOwnerRecord(root, options);
    const stateFile = canonicalFile(options.stateFile, 'monitor state file');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    const ownerGeneration = state.ownerGeneration ?? (state.version == null || state.version <= 3 ? 0 : null);
    const ownerSurface = state.ownerSurface ?? (state.version == null || state.version <= 3 ? 'desktop' : null);
    const cwd = canonicalDirectory(state.cwd, 'monitor cwd');
    if (
      state.threadId !== root.ownerThreadId ||
      ownerGeneration !== root.ownerGeneration ||
      ownerSurface !== root.ownerSurface ||
      cwd !== root.rootCwd ||
      !state.pr?.url
    ) {
      fail('Monitor does not match the current sweep-root owner binding');
    }
    const registry = readMonitorRegistry(root.rootPath);
    const entry = {
      prUrl: state.pr.url,
      stateFile,
      threadId: state.threadId,
      cwd,
      ownerSurface,
      ownerGeneration,
      intervalSeconds: state.intervalSeconds,
    };
    registry.monitors = registry.monitors.filter((item) => item.prUrl !== entry.prUrl);
    registry.monitors.push(entry);
    writeMonitorRegistry(root.rootPath, registry.monitors);
    return { sweepId: root.sweepId, monitor: entry };
  });
}

function canonicalFile(pathValue, label) {
  const path = realpathSync(resolve(pathValue));
  if (!statSync(path).isFile()) fail(`${label} must be a file`);
  return path;
}

function verifyMonitorStoppedDefault(entry) {
  const result = JSON.parse(execFileSync(process.execPath, [
    monitorScript, 'verify-stopped', '--state-file', entry.stateFile,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  return result.verifiedStopped;
}

/** Mark one fully reconciled sweep terminal so history does not block a new run. */
export async function finishSweep(options, dependencies = {}) {
  const base = stateBase(options, true);
  return withRegistryLock(base, async () => {
    const records = readRegistry(base);
    const root = currentRoots(records).find((item) => item.sweepId === options.sweepId);
    assertRootOwnerRecord(root, options);
    const ownership = runOwnership([
      'status', '--ledger', resolve(root.rootPath, 'ownership.jsonl'),
    ]);
    const unreleasedTicketLeases = ownership.records.filter((record) => (
      record.ticket !== ROOT_LEASE_KEY && record.event !== 'RELEASE'
    ));
    if (unreleasedTicketLeases.length) {
      const tickets = unreleasedTicketLeases.map((record) => record.ticket).sort().join(', ');
      fail(`Cannot finish with unreleased ticket worker leases: ${tickets}`);
    }
    for (const worker of discoverWorkers(root)) {
      const delivery = workerDeliveryState(worker);
      if (delivery.pending) fail(`Cannot finish with pending worker callbacks: ${worker.stateFile}`);
      if (!workerIsSettledOrSuperseded(worker)) {
        fail(`Cannot finish with nonterminal worker: ${worker.stateFile}`);
      }
    }
    const verifyMonitorStopped = dependencies.verifyMonitorStopped || verifyMonitorStoppedDefault;
    for (const monitor of readMonitorRegistry(root.rootPath).monitors) {
      if (!await verifyMonitorStopped(monitor)) fail(`Cannot finish with a live monitor: ${monitor.stateFile}`);
    }
    const release = runOwnership([
      'release', '--ledger', resolve(root.rootPath, 'ownership.jsonl'),
      '--ticket', ROOT_LEASE_KEY,
      '--secret-file', rootSecret(root.rootPath, root.ownerGeneration),
      '--reason', options.reason || 'sweep_terminal',
    ]);
    const terminal = appendRegistryRecord(base, records, {
      event: 'TERMINAL',
      ...rootIdentityFields(root),
      rootLeaseGeneration: release.generation,
      terminalReason: options.reason || 'sweep_terminal',
      at: now(),
    });
    writeRootAuthority(terminal, {
      state: 'TERMINAL', ownerThreadId: root.ownerThreadId,
      ownerSurface: root.ownerSurface, generation: root.ownerGeneration,
    });
    return { action: 'terminal', root: rootSummary(terminal) };
  });
}

/** Mark an unfinished registry claim abandoned when its root directory is gone. */
export async function abandonMissingRoot(options) {
  const base = stateBase(options, true);
  return withRegistryLock(base, async () => {
    const records = readRegistry(base);
    const root = currentRoots(records).find((item) => item.sweepId === options.sweepId);
    if (!root || !isUnfinished(root) || ['CREATION_PREPARED', 'TRANSFER_PREPARED'].includes(root.event)) {
      fail('Sweep root is not an abandoned ACTIVE registry claim');
    }
    const generation = Number(options.rootGeneration);
    if (root.ownerThreadId !== options.rootThreadId || root.ownerGeneration !== generation) {
      fail('Sweep root owner generation does not match');
    }
    if (existsSync(root.rootPath)) {
      fail('Cannot abandon a registry claim whose root directory exists');
    }
    const abandoned = appendRegistryRecord(base, records, {
      event: 'ABANDONED',
      ...rootIdentityFields(root),
      terminalReason: options.reason || 'missing_root_directory',
      at: now(),
    });
    return { action: 'abandoned', root: rootSummary(abandoned) };
  });
}

function parseArgs(argv) {
  const args = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${token}`);
    args[token.slice(2)] = value;
    index += 1;
  }
  return args;
}

function required(args, key) {
  if (!args[key]) fail(`Missing --${key}`);
  return args[key];
}

function commonOptions(args) {
  return {
    stateBase: args['state-base'],
    project: required(args, 'project'),
    repo: required(args, 'repo'),
    repoPath: required(args, 'repo-path'),
    user: required(args, 'user'),
    rootThreadId: required(args, 'root-thread-id'),
    rootCwd: required(args, 'root-cwd'),
    ownerSurface: args['owner-surface'] || 'cli',
    desktopFenceFile: args['desktop-fence-file'],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.command === 'normalize') result = normalizeProjectReference(required(args, 'project'));
  else if (args.command === 'status') result = statusSweep({
    stateBase: args['state-base'],
    project: required(args, 'project'),
    repo: args.repo,
    user: args.user,
  });
  else if (args.command === 'open') result = await openSweep(commonOptions(args));
  else if (args.command === 'migrate') result = await migrateLegacySweep({
    ...commonOptions(args),
    legacyRoot: required(args, 'legacy-root'),
  });
  else if (args.command === 'register-monitor') result = await registerMonitor({
    stateBase: args['state-base'],
    sweepId: required(args, 'sweep-id'),
    rootThreadId: required(args, 'root-thread-id'),
    rootGeneration: required(args, 'root-generation'),
    stateFile: required(args, 'state-file'),
  });
  else if (args.command === 'finish') result = await finishSweep({
    stateBase: args['state-base'],
    sweepId: required(args, 'sweep-id'),
    rootThreadId: required(args, 'root-thread-id'),
    rootGeneration: required(args, 'root-generation'),
    reason: required(args, 'reason'),
  });
  else if (args.command === 'abandon-missing-root') result = await abandonMissingRoot({
    stateBase: args['state-base'],
    sweepId: required(args, 'sweep-id'),
    rootThreadId: required(args, 'root-thread-id'),
    rootGeneration: required(args, 'root-generation'),
    reason: required(args, 'reason'),
  });
  else if (args.command === 'assert-owner') result = await assertRootOwner({
    stateBase: args['state-base'],
    sweepId: required(args, 'sweep-id'),
    rootThreadId: required(args, 'root-thread-id'),
    rootGeneration: required(args, 'root-generation'),
  });
  else fail('Usage: sweep-root-state.mjs <normalize|status|open|migrate|assert-owner|register-monitor|finish|abandon-missing-root> [options]');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stderr?.toString().trim() || error.message}\n`);
    process.exitCode = 1;
  });
}
