import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installRegistryFixture } from './core-client-fixture.mjs';
import { monitorScript } from './core-client-process.mjs';

let restoreRegistry;
before(() => { restoreRegistry = installRegistryFixture(); });
after(() => restoreRegistry?.());

import { initializeSession as initializeLegacyWorker } from './app-server-worker-session.mjs';
import { initializeSession as initializeGenericWorker } from './native-app-server-orchestrator.mjs';
import {
  appendRegistryRecord,
  abandonMissingRoot,
  assertRootOwner,
  finishSweep,
  migrateLegacySweep,
  normalizeProjectReference,
  openSweep,
  registerMonitor,
  statusSweep,
} from './sweep-root-state.mjs';

const PROJECT_ID = '019d54c6-d099-74a5-87d0-0a0d4cbdc599';
const PROJECT_URL = `https://app.closedloop.ai/teams/019c24dc-9445-75ec-8136-c4e6d83147fa/projects/${PROJECT_ID}?tab=features`;
const ownershipScript = fileURLToPath(new URL('./ownership-lease.mjs', import.meta.url));

function run(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cl-sweep-root-state-'));
  const stateBase = join(root, 'state');
  const rootCwd = join(root, 'chat-cwd');
  const otherCwd = join(root, 'other-cwd');
  const repo = join(root, 'repo');
  mkdirSync(rootCwd);
  mkdirSync(otherCwd);
  run('git', ['init', repo]);
  run('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  run('git', ['-C', repo, 'config', 'user.name', 'Test User']);
  writeFileSync(join(repo, 'README.md'), 'test\n');
  run('git', ['-C', repo, 'add', '.']);
  run('git', ['-C', repo, 'commit', '-m', 'init']);
  run('git', ['-C', repo, 'branch', '-m', 'codex/test']);
  return { root, stateBase, rootCwd, otherCwd, repo };
}

function options(item, overrides = {}) {
  return {
    stateBase: item.stateBase,
    project: PROJECT_ID,
    repo: 'openai/symphony-alpha',
    repoPath: item.repo,
    user: 'user-123',
    rootThreadId: 'root-1',
    rootCwd: item.rootCwd,
    ownerSurface: 'cli',
    ...overrides,
  };
}

test('normalizes project IDs and full ClosedLoop URLs to one canonical identity', () => {
  assert.deepEqual(normalizeProjectReference(PROJECT_ID.toUpperCase()), normalizeProjectReference(PROJECT_URL));
  assert.deepEqual(normalizeProjectReference(PROJECT_ID), {
    projectId: PROJECT_ID,
    projectKey: `closedloop-project:${PROJECT_ID}`,
  });
  assert.throws(() => normalizeProjectReference(`https://example.com/projects/${PROJECT_ID}`), /ClosedLoop URL/);
});

test('resumes the same durable root for equivalent project forms', async () => {
  const item = fixture();
  const created = await openSweep(options(item));
  const resumed = await openSweep(options(item, { project: PROJECT_URL }));
  assert.equal(created.action, 'created');
  assert.equal(resumed.action, 'resumed');
  assert.equal(resumed.root.sweepId, created.root.sweepId);
  assert.equal(resumed.root.rootPath, created.root.rootPath);
  assert.equal(resumed.root.ownerGeneration, 1);
});

test('repairs and registers one stopped same-root monitor with a historical generation tag', async () => {
  const item = fixture();
  const legacyRoot = join(item.root, 'legacy-thread-root');
  mkdirSync(legacyRoot, { mode: 0o700 });
  const created = await migrateLegacySweep({
    ...options(item),
    legacyRoot,
  });
  const codexHome = join(item.root, 'codex-home');
  const monitorDirectory = join(codexHome, 'pr-monitors');
  mkdirSync(monitorDirectory, { recursive: true, mode: 0o700 });
  const monitorStateFile = join(
    monitorDirectory,
    'github.com-openai-symphony-alpha-5088-root-1.json',
  );
  const deliveredEvent = {
    eventId: 'delivered-1', kind: 'ready_to_merge', severity: 'success', details: {},
  };
  const ambiguousEvent = {
    eventId: 'ambiguous-1', kind: 'new_inline_comments', severity: 'attention', details: {},
  };
  const original = {
    version: 4,
    status: 'stopped',
    stoppedAt: new Date().toISOString(),
    pid: 2_000_000_000,
    processIdentity: {
      pid: 2_000_000_000,
      startToken: 'historical-stopped-monitor',
      commandSha256: 'b'.repeat(64),
    },
    stateFile: monitorStateFile,
    pr: {
      url: 'https://github.com/openai/symphony-alpha/pull/5088',
      host: 'github.com', owner: 'openai', repo: 'symphony-alpha', number: 5088,
    },
    threadId: 'root-1',
    cwd: realpathSync(item.rootCwd),
    ownerSurface: 'cli',
    ownerGeneration: 2,
    intervalSeconds: 60,
    pendingEvents: [],
    deliveredEventIds: ['delivered-1'],
    reconciledEventIds: ['ambiguous-1'],
    deliveryOutbox: [
      { event: deliveredEvent, delivery: { status: 'delivered', attemptId: 'attempt-1' } },
      {
        event: ambiguousEvent,
        delivery: {
          status: 'delivering', attemptId: 'attempt-2',
          parent: { threadId: 'root-1', cwd: realpathSync(item.rootCwd), generation: 2 },
        },
      },
    ],
    event: ambiguousEvent,
  };
  const originalBytes = `${JSON.stringify(original, null, 2)}\n`;
  const command = [
    monitorScript(),
    'repair-legacy-binding', original.pr.url,
    '--state-file', monitorStateFile,
    '--expected-thread-id', 'root-1',
    '--expected-cwd', item.rootCwd,
    '--expected-prior-owner-surface', 'cli',
    '--expected-prior-owner-generation', '2',
    '--target-owner-surface', 'cli',
    '--target-owner-generation', '1',
    '--root-authority-file', join(created.root.rootPath, 'authority.json'),
    '--root-state-base', item.stateBase,
  ];
  const env = { ...process.env, CODEX_HOME: codexHome };

  const missingExplicitBase = command.slice(0, -2);
  writeFileSync(monitorStateFile, originalBytes, { mode: 0o600 });
  assert.throws(() => execFileSync(process.execPath, missingExplicitBase, {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
  }), /pass --root-state-base/);
  assert.equal(readFileSync(monitorStateFile, 'utf8'), originalBytes);

  const registryFile = join(item.stateBase, 'registry.jsonl');
  chmodSync(registryFile, 0o644);
  assert.throws(() => execFileSync(process.execPath, command, {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
  }), /Sweep root registry must be mode 0600/);
  assert.equal(readFileSync(monitorStateFile, 'utf8'), originalBytes);
  chmodSync(registryFile, 0o600);

  const blocked = {
    ...original,
    pendingEvents: [{
      eventId: 'pending-1', kind: 'ci_checks_failed', severity: 'attention', details: {},
    }],
  };
  const blockedBytes = `${JSON.stringify(blocked, null, 2)}\n`;
  writeFileSync(monitorStateFile, blockedBytes, { mode: 0o600 });
  assert.throws(() => execFileSync(process.execPath, command, {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
  }), /requires no pending events/);
  assert.equal(readFileSync(monitorStateFile, 'utf8'), blockedBytes);

  writeFileSync(monitorStateFile, originalBytes, { mode: 0o600 });

  const first = JSON.parse(execFileSync(process.execPath, command, {
    encoding: 'utf8', env,
  }));
  assert.equal(first.alreadyRepaired, false);
  const repaired = JSON.parse(readFileSync(monitorStateFile, 'utf8'));
  assert.equal(repaired.ownerGeneration, 1);
  assert.equal(repaired.ownerSurface, 'cli');
  assert.deepEqual(repaired.deliveredEventIds, original.deliveredEventIds);
  assert.deepEqual(repaired.pendingEvents, original.pendingEvents);
  assert.equal(repaired.deliveryOutbox[0].delivery.attemptId, 'attempt-1');
  assert.equal(repaired.deliveryOutbox[1].delivery.attemptId, 'attempt-2');
  assert.equal(repaired.deliveryOutbox[1].delivery.parent.generation, 1);
  assert.equal(repaired.legacyOwnerBindingRepair.prior.ownerGeneration, 2);
  assert.equal(repaired.legacyOwnerBindingRepair.target.ownerGeneration, 1);
  assert.ok(repaired.legacyOwnerBindingRepair.rootRegistry.sequence >= 1);

  const audit = JSON.parse(readFileSync(first.auditFile, 'utf8'));
  assert.equal(statSync(first.auditFile).mode & 0o777, 0o400);
  assert.equal(Buffer.from(audit.originalStateBase64, 'base64').toString(), originalBytes);

  const registered = await registerMonitor({
    stateBase: item.stateBase,
    sweepId: created.root.sweepId,
    rootThreadId: 'root-1',
    rootGeneration: 1,
    stateFile: monitorStateFile,
  });
  assert.equal(registered.monitor.ownerGeneration, 1);
  assert.equal(registered.monitor.prUrl, original.pr.url);

  const replay = JSON.parse(execFileSync(process.execPath, command, {
    encoding: 'utf8', env,
  }));
  assert.equal(replay.alreadyRepaired, true);
  assert.equal(replay.receipt.repairId, first.receipt.repairId);
});

test('rolls forward a durable prepared root creation for the exact original owner', async () => {
  const item = fixture();
  mkdirSync(item.stateBase, { mode: 0o700 });
  const sweepId = randomUUID();
  const rootPath = join(item.stateBase, 'sweeps', sweepId);
  appendRegistryRecord(item.stateBase, [], {
    event: 'CREATION_PREPARED', sweepId,
    projectId: PROJECT_ID, projectKey: `closedloop-project:${PROJECT_ID}`,
    repoKey: 'openai/symphony-alpha', userKey: 'user-123',
    repoTopLevel: realpathSync(item.repo), repoCommonDir: realpathSync(join(item.repo, '.git')),
    rootCwd: realpathSync(item.rootCwd), rootPath,
    ownerSurface: 'cli', ownerThreadId: 'root-1', ownerGeneration: 1,
    rootLeaseId: null, rootLeaseTokenHash: null, rootLeaseGeneration: 0,
    operationId: randomUUID(), at: new Date().toISOString(),
  });
  const recovered = await openSweep(options(item));
  assert.equal(recovered.action, 'created');
  assert.equal(recovered.root.sweepId, sweepId);
  assert.equal((await assertRootOwner({
    stateBase: item.stateBase, sweepId, rootThreadId: 'root-1', rootGeneration: 1,
  })).authority.state, 'ACTIVE');
});

test('adopts an idle cross-root sweep and advances callback, root lease, and monitor generations', async () => {
  const item = fixture();
  const created = await openSweep(options(item));
  const sessionFile = join(created.root.rootPath, 'sessions', 'FEA-1', '7', 'session.json');
  initializeLegacyWorker({
    'session-file': sessionFile,
    worktree: item.repo,
    ticket: 'FEA-1',
    'parent-thread-id': 'root-1',
    'parent-cwd': item.rootCwd,
    'root-generation': '1',
    'owner-id': 'ticket-worker-1',
    generation: '7',
    'lease-id': 'ticket-lease-7',
    'lease-token-hash': 'a'.repeat(64),
    'protocol-schema-sha256': 'c'.repeat(64),
  });

  const monitorStateFile = join(item.root, 'old-monitor.json');
  writeFileSync(monitorStateFile, `${JSON.stringify({
    version: 4,
    status: 'running',
    pid: 999999,
    pr: {
      url: 'https://github.com/openai/symphony-alpha/pull/123',
      host: 'github.com', owner: 'openai', repo: 'symphony-alpha', number: 123,
    },
    threadId: 'root-1',
    ownerSurface: 'cli',
    ownerGeneration: 1,
    cwd: item.rootCwd,
    intervalSeconds: 60,
  }, null, 2)}\n`, { mode: 0o600 });
  await registerMonitor({
    stateBase: item.stateBase, sweepId: created.root.sweepId,
    rootThreadId: 'root-1', rootGeneration: 1, stateFile: monitorStateFile,
  });

  let stopped = false;
  let observedReceipt = null;
  const adopted = await openSweep(options(item, { rootThreadId: 'root-2' }), {
    inspectRoot: async () => ({ status: 'idle', activeTurnId: null }),
    inspectWorker: async () => ({ active: false }),
    stopMonitor: async () => { stopped = true; },
    startMonitor: async (entry, transfer, receiptFile) => {
      assert.equal(stopped, true);
      observedReceipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
      assert.equal(statSync(receiptFile).mode & 0o777, 0o600);
      const stateFile = join(item.root, 'new-monitor.json');
      writeFileSync(stateFile, '{}\n', { mode: 0o600 });
      return {
        stateFile,
        intervalSeconds: entry.intervalSeconds,
        ownerGeneration: transfer.to.generation,
        registrationDelta: { detected: true, changes: [{ field: 'headRefOid' }] },
      };
    },
  });

  assert.equal(adopted.action, 'adopted');
  assert.equal(adopted.root.sweepId, created.root.sweepId);
  assert.equal(adopted.root.ownerThreadId, 'root-2');
  assert.equal(adopted.root.ownerGeneration, 2);
  assert.equal(adopted.root.rootLeaseGeneration, 2);
  assert.equal(adopted.workerTransfers[0].ticketLeaseGenerationBefore, 7);
  assert.equal(adopted.workerTransfers[0].ticketLeaseGenerationAfter, 7);
  assert.equal(adopted.workerTransfers[0].callbackGeneration, 2);
  assert.equal(adopted.monitorTransfers[0].ownerGeneration, 2);
  assert.equal(adopted.reconciliationRequired, true);
  assert.equal(observedReceipt.schema, 'CL_SWEEP_ROOT_TRANSFER v1');
  assert.equal(observedReceipt.from.threadId, 'root-1');
  assert.equal(observedReceipt.to.threadId, 'root-2');
  assert.equal(observedReceipt.to.generation, 2);

  const worker = JSON.parse(readFileSync(sessionFile, 'utf8'));
  assert.equal(worker.generation, 7);
  assert.equal(worker.parentThreadId, 'root-2');
  assert.equal(worker.parentGeneration, 2);
  const ownership = readFileSync(join(created.root.rootPath, 'ownership.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.deepEqual(ownership.map((record) => record.generation), [1, 2]);
  assert.deepEqual(ownership.map((record) => record.ownerId), ['root-1', 'root-2']);
});

test('cross-package adoption rebinds a real generic session and preserves its pending outbox', async () => {
  const item = fixture();
  const created = await openSweep(options(item));
  const sessionFile = join(created.root.rootPath, 'sessions', 'ISS-2', '1', 'session.json');
  const session = initializeGenericWorker({
    stateFile: sessionFile,
    cwd: item.repo,
    parentThreadId: 'root-1',
    parentCwd: item.rootCwd,
    parentGeneration: 1,
  });
  session.events.push({
    event: {
      schema: 'APP_SERVER_ORCHESTRATOR_EVENT v1', eventId: randomUUID(),
      sessionId: session.sessionId, workerThreadId: null, turnId: 'turn-1',
      cwd: realpathSync(item.repo), kind: 'checkpoint', status: 'ready', terminal: false,
      payload: {}, occurredAt: new Date().toISOString(),
    },
    journaled: false,
    delivery: { status: 'pending', updatedAt: new Date().toISOString() },
  });
  writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });

  const adopted = await openSweep(options(item, { rootThreadId: 'root-2' }), {
    inspectRoot: async () => ({ status: 'idle', activeTurnId: null }),
  });
  assert.equal(adopted.action, 'adopted');
  const rebound = JSON.parse(readFileSync(sessionFile, 'utf8'));
  assert.deepEqual(rebound.parent, {
    threadId: 'root-2', cwd: realpathSync(item.rootCwd), generation: 2,
  });
  assert.equal(rebound.events.length, 1);
  assert.equal(rebound.events[0].delivery.status, 'pending');
  assert.equal(readFileSync(rebound.eventsFile, 'utf8').trim().split('\n').length, 1);
});

test('fails closed when the prior root is active', async () => {
  const item = fixture();
  await openSweep(options(item));
  await assert.rejects(openSweep(options(item, { rootThreadId: 'root-2' }), {
    inspectRoot: async () => ({ status: 'active', activeTurnId: 'turn-1' }),
  }), /Active-owner conflict/);
  const status = statusSweep({ stateBase: item.stateBase, project: PROJECT_ID });
  assert.equal(status.unfinished.length, 1);
  assert.equal(status.unfinished[0].ownerThreadId, 'root-1');
});

test('malformed worker manifests and ambiguous callback outbox entries block adoption', async () => {
  const item = fixture();
  const created = await openSweep(options(item));
  const malformed = join(created.root.rootPath, 'sessions', 'ISS-1', '1', 'session.json');
  mkdirSync(join(created.root.rootPath, 'sessions', 'ISS-1', '1'), { recursive: true });
  writeFileSync(malformed, '{not-json\n', { mode: 0o600 });
  await assert.rejects(openSweep(options(item, { rootThreadId: 'root-2' }), {
    inspectRoot: async () => ({ status: 'idle', activeTurnId: null }),
  }), /Malformed worker session manifest/);

  const ambiguousEvent = { eventId: randomUUID() };
  const ambiguousEventsFile = `${malformed}.events.jsonl`;
  writeFileSync(ambiguousEventsFile, `${JSON.stringify(ambiguousEvent)}\n`, { mode: 0o600 });
  writeFileSync(malformed, `${JSON.stringify({
    schema: 'APP_SERVER_ORCHESTRATOR_SESSION v1', sessionId: 'worker-1',
    eventsFile: ambiguousEventsFile,
    cwd: realpathSync(item.repo), parent: {
      threadId: 'root-1', cwd: realpathSync(item.rootCwd), generation: 1,
    },
    state: 'IDLE', events: [{
      event: ambiguousEvent,
      delivery: { status: 'delivering', outcome: 'ambiguous' },
    }],
  }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(openSweep(options(item, { rootThreadId: 'root-2' }), {
    inspectRoot: async () => ({ status: 'idle', activeTurnId: null }),
  }), /Ambiguous in-flight worker callback/);
});

test('pending callback outbox entries block terminal completion', async () => {
  const item = fixture();
  const created = await openSweep(options(item));
  const sessionFile = join(created.root.rootPath, 'sessions', 'ISS-1', '1', 'session.json');
  mkdirSync(join(created.root.rootPath, 'sessions', 'ISS-1', '1'), { recursive: true });
  const pendingEvent = { eventId: randomUUID() };
  const pendingEventsFile = `${sessionFile}.events.jsonl`;
  writeFileSync(pendingEventsFile, `${JSON.stringify(pendingEvent)}\n`, { mode: 0o600 });
  writeFileSync(sessionFile, `${JSON.stringify({
    schema: 'APP_SERVER_ORCHESTRATOR_SESSION v1', sessionId: 'worker-1',
    eventsFile: pendingEventsFile,
    cwd: realpathSync(item.repo), parent: {
      threadId: 'root-1', cwd: realpathSync(item.rootCwd), generation: 1,
    },
    state: 'TERMINAL', events: [{
      event: pendingEvent, delivery: { status: 'pending' },
    }],
  }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(finishSweep({
    stateBase: item.stateBase, sweepId: created.root.sweepId,
    rootThreadId: 'root-1', rootGeneration: 1, reason: 'test',
  }), /pending worker callbacks/);
});

test('root adoption preserves a settled terminal feature session after member cleanup', async () => {
  const item = fixture();
  const created = await openSweep(options(item));
  const sessionDirectory = join(created.root.rootPath, 'sessions', 'ISS-1', '1');
  mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  const sessionFile = join(sessionDirectory, 'session.json');
  writeFileSync(sessionFile, `${JSON.stringify({
    schema: 'CL_SWEEP_APP_SERVER_WORKER_SESSION v1',
    ticket: 'ISS-1',
    worktree: realpathSync(item.repo),
    branch: 'codex/test',
    repoCommonDir: realpathSync(join(item.repo, run('git', ['-C', item.repo, 'rev-parse', '--git-common-dir']))),
    ownerId: 'feature-worker',
    generation: 1,
    parentThreadId: 'root-1',
    parentCwd: realpathSync(item.rootCwd),
    parentGeneration: 1,
    appServerThreadId: null,
    activeTurnId: null,
    state: 'TERMINAL',
    events: [],
    featureOwnership: {
      featureId: 'feature-1',
      manifestSha256: 'a'.repeat(64),
      anchorTicket: 'ISS-1',
      members: [
        { ticket: 'ISS-1', generation: 1, lease_id: 'lease-1', lease_token_hash: 'b'.repeat(64) },
        { ticket: 'ISS-2', generation: 1, lease_id: 'lease-2', lease_token_hash: 'c'.repeat(64) },
      ],
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const adopted = await openSweep(options(item, { rootThreadId: 'root-2' }), {
    inspectRoot: async () => ({ status: 'idle', activeTurnId: null }),
    rebindWorker: async () => { throw new Error('terminal worker must not be rebound'); },
  });
  assert.equal(adopted.action, 'adopted');
  const preserved = JSON.parse(readFileSync(sessionFile, 'utf8'));
  assert.equal(preserved.parentThreadId, 'root-1');
  assert.equal(preserved.parentGeneration, 1);
});

test('root adoption skips a feature session durably superseded by its replacement', async () => {
  const item = fixture();
  const created = await openSweep(options(item));
  const writeSession = (ticketGeneration, values) => {
    const directory = join(created.root.rootPath, 'sessions', 'ISS-1', String(ticketGeneration));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, 'session.json'), `${JSON.stringify({
      schema: 'CL_SWEEP_CLI_WORKER_SESSION v1',
      ticket: 'ISS-1',
      worktree: realpathSync(item.repo),
      ownerId: values.ownerId,
      generation: ticketGeneration,
      parentThreadId: 'root-1',
      parentCwd: realpathSync(item.rootCwd),
      parentGeneration: 1,
      state: values.state,
      replacementOf: values.replacementOf || null,
      featureOwnership: {
        featureId: 'feature-1',
        manifestSha256: values.manifestSha256,
        anchorTicket: 'ISS-1',
        members: [
          { ticket: 'ISS-1', generation: ticketGeneration, lease_id: `lease-${ticketGeneration}-1`, lease_token_hash: 'b'.repeat(64) },
          { ticket: 'ISS-2', generation: ticketGeneration, lease_id: `lease-${ticketGeneration}-2`, lease_token_hash: 'c'.repeat(64) },
        ],
      },
    }, null, 2)}\n`, { mode: 0o600 });
  };
  writeSession(1, { ownerId: 'feature-worker-1', state: 'FAILED', manifestSha256: 'a'.repeat(64) });
  writeSession(2, {
    ownerId: 'feature-worker-2', state: 'WAITING', manifestSha256: 'd'.repeat(64),
    replacementOf: 'feature-worker-1:1',
  });
  let rebound = 0;
  const adopted = await openSweep(options(item, { rootThreadId: 'root-2' }), {
    inspectRoot: async () => ({ status: 'idle', activeTurnId: null }),
    inspectWorker: async () => ({ active: false, status: 'idle' }),
    rebindWorker: async (worker) => {
      rebound += 1;
      assert.equal(worker.state.ownerId, 'feature-worker-2');
      return { ticketOwnerGeneration: 2 };
    },
  });
  assert.equal(adopted.action, 'adopted');
  assert.equal(rebound, 1);
});

test('persists an incomplete transfer, rejects another target, and rolls forward for the prepared target', async () => {
  const item = fixture();
  const created = await openSweep(options(item));
  await assert.rejects(openSweep(options(item, { rootThreadId: 'root-2' }), {
    inspectRoot: async () => ({ status: 'idle', activeTurnId: null }),
    transferRootLease: async () => { throw new Error('simulated lease failure'); },
  }), /simulated lease failure/);
  const status = statusSweep({ stateBase: item.stateBase, project: PROJECT_ID });
  assert.equal(status.unfinished.length, 1);
  assert.equal(status.unfinished[0].sweepId, created.root.sweepId);
  assert.equal(status.unfinished[0].event, 'TRANSFER_PREPARED');
  await assert.rejects(openSweep(options(item, { rootThreadId: 'root-3' })), /different target root/);
  const recovered = await openSweep(options(item, { rootThreadId: 'root-2' }), {
    inspectRoot: async () => ({ status: 'idle', activeTurnId: null }),
  });
  assert.equal(recovered.action, 'adopted');
  assert.equal(recovered.root.ownerThreadId, 'root-2');
  assert.equal(recovered.root.ownerGeneration, 2);
  assert.equal(JSON.parse(readFileSync(status.unfinished[0].transfer.receiptFile, 'utf8')).status, 'COMMITTED');
});

test('fences stale root generations during and after an ownership transfer', async () => {
  const item = fixture();
  const created = await openSweep(options(item));
  await assertRootOwner({
    stateBase: item.stateBase, sweepId: created.root.sweepId,
    rootThreadId: 'root-1', rootGeneration: 1,
  });
  const adopted = await openSweep(options(item, { rootThreadId: 'root-2' }), {
    inspectRoot: async () => ({ status: 'idle', activeTurnId: null }),
  });
  await assert.rejects(assertRootOwner({
    stateBase: item.stateBase, sweepId: created.root.sweepId,
    rootThreadId: 'root-1', rootGeneration: 1,
  }), /owner generation/);
  const current = await assertRootOwner({
    stateBase: item.stateBase, sweepId: adopted.root.sweepId,
    rootThreadId: 'root-2', rootGeneration: 2,
  });
  assert.equal(current.authority.state, 'ACTIVE');
  assert.equal(current.lease.expiresAt, null);
});

test('concurrent root opens serialize to one sweep and one current generation', async () => {
  const item = fixture();
  const inspectRoot = async () => ({ status: 'idle', activeTurnId: null });
  const [left, right] = await Promise.all([
    openSweep(options(item, { rootThreadId: 'root-left' }), { inspectRoot }),
    openSweep(options(item, { rootThreadId: 'root-right' }), { inspectRoot }),
  ]);
  assert.equal(left.root.sweepId, right.root.sweepId);
  assert.deepEqual(new Set([left.action, right.action]), new Set(['created', 'adopted']));
  const status = statusSweep({ stateBase: item.stateBase, project: PROJECT_ID });
  assert.equal(status.unfinished.length, 1);
  const current = status.unfinished[0];
  assert.equal(current.ownerGeneration, 2);
  await assertRootOwner({
    stateBase: item.stateBase, sweepId: current.sweepId,
    rootThreadId: current.ownerThreadId, rootGeneration: 2,
  });
});

test('reports duplicate unfinished roots instead of guessing an owner', async () => {
  const item = fixture();
  const created = await openSweep(options(item));
  const records = readFileSync(join(item.stateBase, 'registry.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  appendRegistryRecord(item.stateBase, records, {
    event: 'CREATED',
    sweepId: randomUUID(),
    projectId: created.root.projectId,
    projectKey: created.root.projectKey,
    repoKey: created.root.repoKey,
    userKey: created.root.userKey,
    repoTopLevel: item.repo,
    repoCommonDir: created.root.repoCommonDir,
    rootCwd: created.root.rootCwd,
    rootPath: join(item.stateBase, 'sweeps', 'duplicate'),
    ownerSurface: 'cli',
    ownerThreadId: 'root-duplicate',
    ownerGeneration: 1,
    rootLeaseId: 'duplicate',
    rootLeaseTokenHash: 'b'.repeat(64),
    rootLeaseGeneration: 1,
    at: new Date().toISOString(),
  });
  await assert.rejects(openSweep(options(item, { rootThreadId: 'root-2' })), /multiple unfinished sweep roots/);
  assert.equal(statusSweep({ stateBase: item.stateBase, project: PROJECT_ID }).conflicts.length, 1);
});

test('abandon-missing-root appends terminal history only for absent root directories', async () => {
  const item = fixture();
  const created = await openSweep(options(item));
  await assert.rejects(abandonMissingRoot({
    stateBase: item.stateBase,
    sweepId: created.root.sweepId,
    rootThreadId: 'root-1',
    rootGeneration: 1,
    reason: 'should_refuse_live_root',
  }), /root directory exists/);

  const records = readFileSync(join(item.stateBase, 'registry.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const missingRoot = join(item.stateBase, 'sweeps', 'missing-root');
  mkdirSync(missingRoot, { recursive: true });
  rmdirSync(missingRoot);
  const duplicateId = randomUUID();
  appendRegistryRecord(item.stateBase, records, {
    event: 'CREATED',
    sweepId: duplicateId,
    projectId: created.root.projectId,
    projectKey: created.root.projectKey,
    repoKey: created.root.repoKey,
    userKey: created.root.userKey,
    repoTopLevel: item.repo,
    repoCommonDir: created.root.repoCommonDir,
    rootCwd: created.root.rootCwd,
    rootPath: missingRoot,
    ownerSurface: 'cli',
    ownerThreadId: 'root-duplicate',
    ownerGeneration: 1,
    rootLeaseId: 'duplicate',
    rootLeaseTokenHash: 'b'.repeat(64),
    rootLeaseGeneration: 1,
    at: new Date().toISOString(),
  });
  const abandoned = await abandonMissingRoot({
    stateBase: item.stateBase,
    sweepId: duplicateId,
    rootThreadId: 'root-duplicate',
    rootGeneration: 1,
    reason: 'pruned_missing_state_dir',
  });
  assert.equal(abandoned.action, 'abandoned');
  const status = statusSweep({ stateBase: item.stateBase, project: PROJECT_ID });
  assert.equal(status.unfinished.length, 1);
  assert.equal(status.terminalHistory.length, 1);
  assert.equal(status.terminalHistory[0].sweepId, duplicateId);
});

test('terminal history does not block a new sweep', async () => {
  const item = fixture();
  const first = await openSweep(options(item));
  const terminal = await finishSweep({
    stateBase: item.stateBase,
    sweepId: first.root.sweepId,
    rootThreadId: 'root-1',
    rootGeneration: 1,
    reason: 'validated_complete',
  });
  assert.equal(terminal.action, 'terminal');
  const second = await openSweep(options(item, { rootThreadId: 'root-2' }));
  assert.equal(second.action, 'created');
  assert.notEqual(second.root.sweepId, first.root.sweepId);
  const status = statusSweep({ stateBase: item.stateBase, project: PROJECT_ID });
  assert.equal(status.unfinished.length, 1);
  assert.equal(status.terminalHistory.length, 1);
});

test('root finish refuses an unreleased ticket member lease', async () => {
  const item = fixture();
  const created = await openSweep(options(item));
  const secretDirectory = join(created.root.rootPath, 'private', 'tickets', 'ISS-2');
  mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
  const secret = join(secretDirectory, 'lease.secret.json');
  run(process.execPath, [
    ownershipScript, 'acquire',
    '--ledger', join(created.root.rootPath, 'ownership.jsonl'),
    '--ticket', 'ISS-2',
    '--owner-surface', 'cli',
    '--owner-role', 'ticket_worker',
    '--owner-id', 'feature-worker',
    '--secret-output', secret,
    '--ttl-seconds', '600',
  ]);
  await assert.rejects(finishSweep({
    stateBase: item.stateBase,
    sweepId: created.root.sweepId,
    rootThreadId: 'root-1',
    rootGeneration: 1,
    reason: 'should_fail',
  }), /unreleased ticket worker leases: ISS-2/);
  run(process.execPath, [
    ownershipScript, 'release',
    '--ledger', join(created.root.rootPath, 'ownership.jsonl'),
    '--ticket', 'ISS-2',
    '--secret-file', secret,
    '--reason', 'terminal_cleanup',
  ]);
  const finished = await finishSweep({
    stateBase: item.stateBase,
    sweepId: created.root.sweepId,
    rootThreadId: 'root-1',
    rootGeneration: 1,
    reason: 'validated_complete',
  });
  assert.equal(finished.action, 'terminal');
});

test('requires exact cwd, project, repository, and user bindings', async () => {
  const item = fixture();
  const first = await openSweep(options(item));
  await assert.rejects(openSweep(options(item, {
    rootThreadId: 'root-2',
    rootCwd: item.otherCwd,
  })), /different exact cwd or repository binding/);
  const otherClone = join(item.root, 'repo-clone');
  run('git', ['clone', item.repo, otherClone]);
  await assert.rejects(openSweep(options(item, {
    rootThreadId: 'root-2',
    repoPath: otherClone,
  })), /different exact cwd or repository binding/);

  const otherProject = '019c24dc-b282-7049-951a-f1944dfd89c3';
  const projectRoot = await openSweep(options(item, { project: otherProject, rootThreadId: 'project-root' }));
  const repoRoot = await openSweep(options(item, { repo: 'openai/other-repo', rootThreadId: 'repo-root' }));
  const userRoot = await openSweep(options(item, { user: 'user-456', rootThreadId: 'user-root' }));
  assert.notEqual(projectRoot.root.sweepId, first.root.sweepId);
  assert.notEqual(repoRoot.root.sweepId, first.root.sweepId);
  assert.notEqual(userRoot.root.sweepId, first.root.sweepId);
  assert.equal(statusSweep({ stateBase: item.stateBase, project: PROJECT_ID }).unfinished.length, 3);
  assert.equal(statusSweep({
    stateBase: item.stateBase,
    project: PROJECT_ID,
    repo: 'openai/symphony-alpha',
    user: 'user-123',
  }).unfinished.length, 1);
});

test('indexes a legacy thread-keyed root for project-only recovery', async () => {
  const item = fixture();
  const legacyRoot = join(item.root, 'legacy-root-1');
  mkdirSync(legacyRoot, { mode: 0o700 });
  const migrated = await migrateLegacySweep({
    ...options(item),
    legacyRoot,
  });
  assert.equal(migrated.action, 'migrated');
  assert.equal(migrated.root.rootPath, realpathSync(legacyRoot));
  const status = statusSweep({ stateBase: item.stateBase, project: PROJECT_URL });
  assert.equal(status.unfinished.length, 1);
  assert.equal(status.unfinished[0].sweepId, migrated.root.sweepId);
});

test('fails closed before create when the default state base contains an unindexed legacy root', async () => {
  const item = fixture();
  mkdirSync(item.stateBase, { mode: 0o700 });
  const legacy = join(item.stateBase, 'legacy-thread-id');
  mkdirSync(join(legacy, 'sessions'), { recursive: true, mode: 0o700 });
  await assert.rejects(openSweep(options(item)), /require migration before create/);
});
