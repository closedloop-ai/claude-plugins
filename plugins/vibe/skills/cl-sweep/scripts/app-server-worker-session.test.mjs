import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  watch,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installRegistryFixture } from './core-client-fixture.mjs';

let restoreRegistry;
before(() => { restoreRegistry = installRegistryFixture(); });
after(() => restoreRegistry?.());

import {
  EVENT_PREFIX,
  LEGACY_COMPATIBLE_WORKER_MODEL,
  MAX_RESULT_ARTIFACT_BYTES,
  REQUIRED_WORKER_MODEL,
  RESULT_SCHEMA,
  COMPACT_CALLBACK_REQUIRED_FIELDS,
  describeCompactCallbackRequiredFields,
  createResultArtifact,
  createTurnCollector,
  attachIdleHistoricalThread,
  initializeSession,
  notifyParent,
  parseCallback,
  reconcileSession,
  recoverAbsentTurn,
  rebindParent,
  reconcileAutomaticContinuations,
  reportActivity,
  repairAcceptedCallbackDelivery,
  repairExternalParentWriterDelivery,
  runTurn as runTurnWithActivity,
  statusSession,
  steerSession,
  superviseTurn,
  validateBinding,
  validateCallbackFile,
  verifyResultArtifactReference,
} from './app-server-worker-session.mjs';

const workerScript = fileURLToPath(new URL('./app-server-worker-session.mjs', import.meta.url));
const ownershipScript = fileURLToPath(new URL('./ownership-lease.mjs', import.meta.url));

const runTurn = (args, dependencies) => runTurnWithActivity({
  'activity-phase': 'planning',
  ...args,
}, dependencies);

function createRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'cl-sweep-app-server-'));
  execFileSync('git', ['init', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), 'test\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init']);
  execFileSync('git', ['-C', repo, 'branch', '-m', 'codex/test']);
  return repo;
}

class FakeClient {
  constructor({ worktree, event = null, active = false, existingTurn = null, existingTurns = null, listedTurnId = 'worker-turn', materialized = false }) {
    this.worktree = worktree;
    this.event = event;
    this.active = active;
    this.existingTurn = existingTurn;
    this.existingTurns = existingTurns;
    this.listedTurnId = listedTurnId;
    this.notifications = new Set();
    this.connections = new Set();
    this.requests = [];
    this.materialized = materialized || Boolean(existingTurn) || Boolean(existingTurns);
  }

  async connect() {}
  notify() {}
  close() {}
  onNotification(handler) { this.notifications.add(handler); return () => this.notifications.delete(handler); }
  onConnection(handler) { this.connections.add(handler); return () => this.connections.delete(handler); }
  emit(method, params) { for (const handler of this.notifications) handler(method, params); }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'initialize') return {};
    if (method === 'thread/list') return { data: [], nextCursor: null };
    if (method === 'thread/start') {
      return { thread: { id: 'worker-thread', cwd: this.worktree, status: { type: 'idle' } } };
    }
    if (method === 'thread/resume') {
      if (params.threadId === 'parent-thread') return { thread: { id: 'parent-thread', cwd: this.worktree } };
      return { thread: { id: 'worker-thread', cwd: this.worktree, status: { type: this.active ? 'active' : 'idle' } } };
    }
    if (method === 'thread/read') {
      if (params.threadId === 'parent-thread') {
        return { thread: { id: 'parent-thread', cwd: this.worktree, status: { type: 'idle' } } };
      }
      if (params.includeTurns && !this.materialized) {
        throw new Error('thread is not materialized yet; includeTurns is unavailable before first user message (-32600)');
      }
      return {
        thread: {
          id: 'worker-thread',
          cwd: this.worktree,
          status: { type: this.active ? 'active' : 'idle' },
          turns: this.existingTurns || (this.existingTurn ? [this.existingTurn] : []),
        },
      };
    }
    if (method === 'thread/turns/list') {
      return { data: [{ id: this.listedTurnId, status: 'inProgress' }] };
    }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    if (method === 'turn/start' && params.threadId === 'parent-thread') {
      return { turn: { id: 'parent-turn', status: 'inProgress' } };
    }
    if (method === 'turn/start') {
      this.materialized = true;
      if (this.event) {
        const message = `done\nCL_SWEEP_EVENT v1 ${JSON.stringify(this.event)}`;
        this.emit('item/completed', {
          threadId: 'worker-thread', turnId: 'worker-turn',
          item: { type: 'agentMessage', phase: 'final_answer', text: message },
        });
        this.emit('turn/completed', {
          threadId: 'worker-thread',
          turn: { id: 'worker-turn', status: 'completed', error: null },
        });
      }
      return { turn: { id: 'worker-turn', status: 'inProgress' } };
    }
    throw new Error(`Unexpected request: ${method}`);
  }
}

function initializeFixture(overrides = {}) {
  const worktree = createRepo();
  const directory = mkdtempSync(join(tmpdir(), 'cl-sweep-app-server-state-'));
  const sessionFile = join(directory, 'session.json');
  const promptFile = join(directory, 'prompt.md');
  const eventsFile = join(directory, 'events.jsonl');
  const values = {
    'session-file': sessionFile,
    worktree,
    ticket: 'ISS-1',
    'parent-thread-id': 'parent-thread',
    'parent-cwd': worktree,
    'owner-id': 'worker-1',
    generation: '3',
    'lease-id': 'lease-1',
    'lease-token-hash': 'a'.repeat(64),
    'protocol-schema-sha256': 'c'.repeat(64),
    ...overrides,
  };
  const session = initializeSession(values);
  writeFileSync(promptFile, 'Continue work and callback.\n');
  return { worktree, directory, sessionFile, promptFile, eventsFile, session };
}

function initializeFeatureFixture() {
  const worktree = createRepo();
  const directory = mkdtempSync(join(tmpdir(), 'cl-sweep-feature-session-'));
  const sessionFile = join(directory, 'session.json');
  const ledger = join(directory, 'ownership.jsonl');
  const secretDirectory = join(directory, 'secrets');
  mkdirSync(secretDirectory, { mode: 0o700 });
  const acquire = (ticket) => JSON.parse(execFileSync(process.execPath, [
    ownershipScript, 'acquire', '--ledger', ledger, '--ticket', ticket,
    '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'feature-worker',
    '--secret-output', join(secretDirectory, `${ticket}.json`), '--ttl-seconds', '600',
  ], { encoding: 'utf8' }));
  const anchor = acquire('ISS-1');
  const member = acquire('ISS-2');
  const manifest = join(directory, 'feature-ownership.json');
  writeFileSync(manifest, `${JSON.stringify({
    schema: 'CL_SWEEP_FEATURE_OWNERSHIP v1',
    feature_id: 'feature-1',
    anchor_ticket: 'ISS-1',
    owner_id: 'feature-worker',
    owner_surface: 'cli',
    worktree: realpathSync(worktree),
    members: [anchor, member].map((record) => ({
      ticket: record.ticket,
      generation: record.generation,
      lease_id: record.leaseId,
      lease_token_hash: record.leaseTokenHash,
    })),
  }, null, 2)}\n`, { mode: 0o600 });
  const session = initializeSession({
    'session-file': sessionFile,
    worktree,
    ticket: 'ISS-1',
    'parent-thread-id': 'parent-thread',
    'parent-cwd': worktree,
    'owner-id': 'feature-worker',
    generation: String(anchor.generation),
    'lease-id': anchor.leaseId,
    'lease-token-hash': anchor.leaseTokenHash,
    'protocol-schema-sha256': 'c'.repeat(64),
    'feature-manifest': realpathSync(manifest),
    'ownership-ledger': realpathSync(ledger),
  });
  return {
    worktree, directory, sessionFile, ledger, secretDirectory, manifest, session, anchor, member,
  };
}

function baseEvent(fixture, overrides = {}) {
  return {
    event_id: randomUUID(),
    parent_thread_id: 'parent-thread',
    root_generation: 1,
    ticket: 'ISS-1',
    worker_id: 'worker-1',
    owner_surface: 'cli',
    owner_generation: 3,
    lease_id: 'lease-1',
    lease_token_hash: 'a'.repeat(64),
    kind: 'EXECUTION_CHECKPOINT',
    phase: 'implementation',
    status: 'WAITING',
    parent_action: 'continue',
    worktree: fixture.worktree,
    payload: {},
    ...overrides,
  };
}

function artifactEnvelope(event, result = { evidence: 'full result evidence' }, overrides = {}) {
  return {
    schema: RESULT_SCHEMA,
    event_id: event.event_id,
    parent_thread_id: event.parent_thread_id,
    root_generation: event.root_generation ?? 1,
    ticket: event.ticket,
    worker_id: event.worker_id,
    owner_surface: event.owner_surface,
    owner_generation: event.owner_generation,
    lease_id: event.lease_id,
    lease_token_hash: event.lease_token_hash,
    worktree: event.worktree,
    kind: event.kind,
    phase: event.phase,
    status: event.status,
    result,
    ...overrides,
  };
}

function publishArtifact(fixture, event, result, overrides = {}) {
  const candidate = join(fixture.directory, `candidate-${event.event_id}.json`);
  writeFileSync(candidate, `${JSON.stringify(artifactEnvelope(event, result, overrides))}\n`, { mode: 0o600 });
  return createResultArtifact({
    'session-file': fixture.sessionFile,
    'artifact-file': candidate,
  }).result;
}

function compactEvent(fixture, overrides = {}, result = { evidence: 'full result evidence' }) {
  const event = baseEvent(fixture, overrides);
  const reference = publishArtifact(fixture, event, result);
  return {
    ...event,
    payload: {
      summary: { checkpoint: event.phase },
      routing: { next: event.parent_action },
      ...event.payload,
      result: reference,
    },
  };
}

function manuallyWriteArtifact(fixture, event, artifact) {
  const path = join(fixture.session.resultRoot, `${event.event_id}.json`);
  const contents = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    schema: RESULT_SCHEMA,
    transport: 'local_artifact',
    path,
    sha256: createHash('sha256').update(contents).digest('hex'),
    bytes: contents.length,
  };
}

test('new ticket sessions default to gpt-6-sol and capture a synchronous callback', async () => {
  const fixture = initializeFixture();
  const event = {
    event_id: randomUUID(),
    parent_thread_id: 'parent-thread',
    ticket: 'ISS-1',
    worker_id: 'worker-1',
    owner_surface: 'cli',
    owner_generation: 3,
    lease_id: 'lease-1',
    lease_token_hash: 'a'.repeat(64),
    kind: 'EXECUTION_CHECKPOINT',
    phase: 'implementation',
    status: 'WAITING',
    parent_action: 'monitor',
    worktree: fixture.worktree,
    payload: {},
  };
  const client = new FakeClient({ worktree: fixture.worktree, event });
  const result = await runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client });
  assert.equal(result.threadId, 'worker-thread');
  assert.equal(result.event.event_id, event.event_id);
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(stored.state, 'WAITING');
  assert.equal(stored.appServerThreadId, 'worker-thread');
  assert.equal(REQUIRED_WORKER_MODEL, 'gpt-6-sol');
  assert.equal(stored.requestedModel, REQUIRED_WORKER_MODEL);
  assert.equal(stored.requestedReasoningEffort, 'xhigh');
  assert.equal(stored.modelBinding.field, 'model');
  assert.match(readFileSync(fixture.eventsFile, 'utf8'), new RegExp(event.event_id));
  const threadStart = client.requests.find(({ method }) => method === 'thread/start');
  assert.equal(threadStart.params.model, REQUIRED_WORKER_MODEL);
  const start = client.requests.find(({ method, params }) => method === 'turn/start' && params.threadId === 'worker-thread');
  assert.equal(start.params.model, REQUIRED_WORKER_MODEL);
  assert.equal(start.params.effort, 'xhigh');
  assert.equal(start.params.cwd, realpathSync(fixture.worktree));
  assert.deepEqual(start.params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.match(start.params.input[0].text, /validate-callback --session-file/);
  assert.match(start.params.input[0].text, /"root_generation":1/);
  assert.match(start.params.input[0].text, /parent_action at or below 512 characters/);
  // The worker sees every rule the validators enforce, so a first attempt can pass.
  const prompt = start.params.input[0].text;
  assert.match(prompt, /with or without the leading `CL_SWEEP_EVENT v1 ` prefix \(the validator accepts both\)/);
  assert.match(prompt, /regular file you own with mode 0600/);
  assert.ok(prompt.includes(describeCompactCallbackRequiredFields()), 'prompt lists the required inline callback fields');
  assert.match(prompt, /TERMINAL: payload\.summary\.outcome, payload\.summary\.requirements_contract, payload\.summary\.review_learning_memory/);
});

test('the rendered required-field list covers every enforced event kind', () => {
  const rendered = describeCompactCallbackRequiredFields();
  for (const [kind, fields] of Object.entries(COMPACT_CALLBACK_REQUIRED_FIELDS)) {
    for (const [container, field] of fields) {
      assert.ok(rendered.includes(`payload.${container}.${field}`), `${kind} ${container}.${field}`);
    }
    assert.ok(rendered.includes(`${kind}: `), kind);
  }
});

test('new ticket sessions reject every legacy model without fallback', () => {
  for (const model of [LEGACY_COMPATIBLE_WORKER_MODEL, 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-custom']) {
    assert.throws(
      () => initializeFixture({ 'requested-model': model }),
      /--requested-model must be gpt-6-sol; no fallback model is allowed/,
    );
  }
});

test('resumes an existing WAITING session with the bound callback preflight', async () => {
  const fixture = initializeFixture();
  const makeEvent = () => ({
    event_id: randomUUID(),
    parent_thread_id: 'parent-thread',
    ticket: 'ISS-1',
    worker_id: 'worker-1',
    owner_surface: 'cli',
    owner_generation: 3,
    lease_id: 'lease-1',
    lease_token_hash: 'a'.repeat(64),
    kind: 'EXECUTION_CHECKPOINT',
    phase: 'implementation',
    status: 'WAITING',
    parent_action: 'continue',
    worktree: fixture.worktree,
    payload: {},
  });
  await runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client: new FakeClient({ worktree: fixture.worktree, event: makeEvent() }) });
  assert.equal(JSON.parse(readFileSync(fixture.sessionFile, 'utf8')).state, 'WAITING');

  const resumedClient = new FakeClient({
    worktree: fixture.worktree,
    event: makeEvent(),
    materialized: true,
  });
  const resumed = await runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client: resumedClient });
  assert.equal(resumed.event.status, 'WAITING');
  const start = resumedClient.requests.find(({ method, params }) => (
    method === 'turn/start' && params.threadId === 'worker-thread'
  ));
  const resume = resumedClient.requests.find(({ method, params }) => (
    method === 'thread/resume' && params.threadId === 'worker-thread'
  ));
  assert.equal(resume.params.model, REQUIRED_WORKER_MODEL);
  assert.equal(start.params.model, REQUIRED_WORKER_MODEL);
  assert.equal(start.params.effort, 'xhigh');
  assert.match(start.params.input[0].text, /"parent_thread_id":"parent-thread"/);
  assert.match(start.params.input[0].text, /validate-callback --session-file/);
});

test('legacy persisted sessions block new turns without rewriting their model binding', async () => {
  for (const model of [LEGACY_COMPATIBLE_WORKER_MODEL, 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-custom']) {
  const fixture = initializeFixture();
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.requestedModel = model;
  stored.modelBinding.requestedModel = model;
  stored.appServerThreadId = 'worker-thread';
  stored.appServerThreadMaterialized = true;
  stored.activeTurnId = null;
  stored.state = 'WAITING';
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });

  const client = new FakeClient({ worktree: fixture.worktree, materialized: true });
  const status = await statusSession({ 'session-file': fixture.sessionFile }, { client });
  assert.deepEqual(status.modelReplacement, {
    targetModel: REQUIRED_WORKER_MODEL,
    requiredBeforeNextTurn: true,
    idleCandidate: true,
  });
  await assert.rejects(runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client }), /requires idle-boundary replacement with a new gpt-6-sol session/);
  assert.equal(client.requests.some(({ method, params }) => method === 'turn/start' && params.threadId === 'worker-thread'), false);
  assert.equal(JSON.parse(readFileSync(fixture.sessionFile, 'utf8')).requestedModel, model);
  }
});

test('fails closed before a worker turn when model proof is missing or incompatible', async () => {
  const fixture = initializeFixture();
  const unproven = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  delete unproven.modelBinding;
  writeFileSync(fixture.sessionFile, `${JSON.stringify(unproven, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client: new FakeClient({ worktree: fixture.worktree }) }), /missing proven App Server model binding field/);

  const incompatible = { ...unproven, requestedModel: 'gpt-5.6', modelBinding: { field: 'model', requestedModel: 'gpt-5.6', protocolSchemaSha256: 'c'.repeat(64) } };
  writeFileSync(fixture.sessionFile, `${JSON.stringify(incompatible, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client: new FakeClient({ worktree: fixture.worktree }) }), /requestedModel must be gpt-6-sol or a persisted legacy gpt-5\.5\/gpt-5\.6-\* binding/);
});

test('status validates the persisted gpt-6-sol model binding without starting a turn', async () => {
  const fixture = initializeFixture();
  const status = await statusSession({ 'session-file': fixture.sessionFile }, { client: new FakeClient({ worktree: fixture.worktree }) });
  assert.equal(status.requestedModel, REQUIRED_WORKER_MODEL);
  assert.equal(status.requestedReasoningEffort, 'xhigh');
  assert.deepEqual(status.modelBinding, { valid: true, error: null });

  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.modelBinding.protocolSchemaSha256 = null;
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  const invalid = await statusSession({ 'session-file': fixture.sessionFile }, { client: new FakeClient({ worktree: fixture.worktree }) });
  assert.equal(invalid.modelBinding.valid, false);
  assert.match(invalid.modelBinding.error, /lacks protocolSchemaSha256 proof/);
});

test('server-side model reroutes fail the worker turn and remain visible in status', async () => {
  const fixture = initializeFixture();
  const event = baseEvent(fixture);
  const client = new FakeClient({ worktree: fixture.worktree });
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'turn/start' && params.threadId === 'worker-thread') {
      const result = await request(method, params);
      client.emit('model/rerouted', {
        threadId: 'worker-thread',
        turnId: 'worker-turn',
        fromModel: REQUIRED_WORKER_MODEL,
        toModel: 'gpt-6-luna',
        reason: 'test',
      });
      const message = `done\nCL_SWEEP_EVENT v1 ${JSON.stringify(event)}`;
      client.emit('item/completed', {
        threadId: 'worker-thread', turnId: 'worker-turn',
        item: { type: 'agentMessage', phase: 'final_answer', text: message },
      });
      client.emit('turn/completed', {
        threadId: 'worker-thread',
        turn: { id: 'worker-turn', status: 'completed', error: null },
      });
      return result;
    }
    return request(method, params);
  };

  await assert.rejects(runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client }), /rerouted turn worker-turn from requested model gpt-6-sol to gpt-6-luna/);
  const status = await statusSession({ 'session-file': fixture.sessionFile }, { client: new FakeClient({ worktree: fixture.worktree }) });
  assert.equal(status.modelBinding.valid, false);
  assert.match(status.modelBinding.error, /incompatible model reroute to gpt-6-luna/);
});

test('callback preflight reports the exact schema field that violates the current binding', () => {
  const fixture = initializeFixture();
  const callbackFile = join(fixture.directory, 'candidate.json');
  const event = {
    event_id: randomUUID(),
    parent_thread_id: 'parent-thread',
    root_generation: 1,
    ticket: 'ISS-1',
    worker_id: 'worker-1',
    owner_surface: 'cli',
    owner_generation: 3,
    lease_id: 'lease-1',
    lease_token_hash: 'a'.repeat(64),
    kind: 'EXECUTION_CHECKPOINT',
    phase: 'implementation',
    status: 'WAITING',
    parent_action: 'continue',
    worktree: fixture.worktree,
    payload: {},
  };
  writeFileSync(callbackFile, `${JSON.stringify(event)}\n`);
  assert.equal(validateCallbackFile({
    'session-file': fixture.sessionFile,
    'callback-file': callbackFile,
  }).valid, true);
  writeFileSync(callbackFile, `${EVENT_PREFIX}${JSON.stringify(event)}\n`);
  assert.equal(validateCallbackFile({
    'session-file': fixture.sessionFile,
    'callback-file': callbackFile,
  }).valid, true, 'the prefixed final line is accepted too');
  writeFileSync(callbackFile, `${JSON.stringify(event)}\n`);
  const blackBox = JSON.parse(execFileSync(process.execPath, [
    workerScript,
    'validate-callback',
    '--session-file', fixture.sessionFile,
    '--callback-file', callbackFile,
  ], { encoding: 'utf8' }));
  assert.equal(blackBox.valid, true);
  assert.equal(blackBox.rootGeneration, 1);

  writeFileSync(callbackFile, `${JSON.stringify({ ...event, root_generation: 2 })}\n`);
  assert.throws(() => validateCallbackFile({
    'session-file': fixture.sessionFile,
    'callback-file': callbackFile,
  }), /root_generation does not match the current parent generation/);

  writeFileSync(callbackFile, `${JSON.stringify({
    ...event,
    event_id: randomUUID(),
    parent_action: 'x'.repeat(513),
  })}\n`);
  assert.throws(() => validateCallbackFile({
    'session-file': fixture.sessionFile,
    'callback-file': callbackFile,
  }), /parent_action exceeds 512 characters \(observed 513\)/);
});

test('accepts compact artifacts for analysis, PR handoff, terminal, support, and waiting routes', () => {
  const fixture = initializeFixture();
  const cases = [
    {
      kind: 'ANALYSIS_COMPLETE', phase: 'analysis', status: 'GO',
      payload: { summary: { decision: 'GO' }, routing: { next: 'execute' } },
    },
    {
      kind: 'PR_MONITORING_HANDOFF', phase: 'pr', status: 'WAITING',
      payload: {
        summary: { pr_url: 'https://github.test/pull/1', head_sha: 'b'.repeat(40), ui_work: 'NO' },
        routing: { merge_disposition: 'direct_protected_queue' },
      },
    },
    {
      kind: 'TERMINAL', phase: 'terminal', status: 'MERGED',
      payload: {
        summary: {
          outcome: 'MERGED', requirements_contract: 'PRD-1 v1 R1',
          review_learning_memory: 'not_applicable',
        },
        routing: { next: 'reconcile' },
      },
    },
    {
      kind: 'SUPPORT_REQUEST', phase: 'support', status: 'WAITING',
      payload: {
        summary: { request_id: 'support-1', support_type: 'planning_review' },
        routing: { next: 'launch_support' },
      },
    },
    {
      kind: 'SUPPORT_RESULT', phase: 'support', status: 'READY',
      payload: {
        summary: { request_id: 'support-1', outcome: 'PASS' },
        routing: { next: 'resume_worker' },
      },
    },
    {
      kind: 'WAITING_HUMAN', phase: 'approval', status: 'WAITING',
      payload: {
        summary: { wait_kind: 'UI_PLAN_APPROVAL' },
        routing: { recheck_when: 'matching plan is approved' },
      },
    },
  ];
  for (const sample of cases) {
    const event = compactEvent(fixture, sample, { evidence: `${sample.kind} full evidence`.repeat(100) });
    const parsed = parseCallback(`${EVENT_PREFIX}${JSON.stringify(event)}`, fixture.session);
    assert.equal(parsed.kind, sample.kind);
    assert.equal(parsed.payload.result.transport, 'local_artifact');
    assert.equal(statSync(parsed.payload.result.path).mode & 0o777, 0o600);
  }
});

test('preserves legacy inline result objects even when their evidence includes a path', () => {
  const fixture = initializeFixture();
  const event = baseEvent(fixture, {
    payload: {
      result: { path: '/reported/source/path', sha256: 'informational-not-a-reference' },
      evidence: 'legacy inline payload',
    },
  });
  const parsed = parseCallback(`${EVENT_PREFIX}${JSON.stringify(event)}`, fixture.session);
  assert.equal(parsed.payload.result.path, '/reported/source/path');
});

test('compact artifact preflight rejects path, digest, mode, UID, schema, binding, symlink, size, secret, stale generation, and dangling evidence', () => {
  const fixture = initializeFixture();
  const parse = (event) => parseCallback(`${EVENT_PREFIX}${JSON.stringify(event)}`, fixture.session);

  const outside = compactEvent(fixture);
  assert.throws(() => parse({
    ...outside,
    payload: { ...outside.payload, result: { ...outside.payload.result, path: join(fixture.directory, 'outside.json') } },
  }), /outside the session-authorized canonical event path/);

  const badHash = compactEvent(fixture);
  assert.throws(() => parse({
    ...badHash,
    payload: { ...badHash.payload, result: { ...badHash.payload.result, sha256: '0'.repeat(64) } },
  }), /sha256 mismatch/);

  const badMode = compactEvent(fixture);
  chmodSync(badMode.payload.result.path, 0o644);
  assert.throws(() => parse(badMode), /mode 0600/);

  const wrongUid = compactEvent(fixture);
  assert.throws(() => verifyResultArtifactReference(wrongUid, fixture.session, {
    getuid: () => process.getuid() + 1,
  }), /owned by the current UID/);

  const badReferenceSchema = compactEvent(fixture);
  assert.throws(() => parse({
    ...badReferenceSchema,
    payload: {
      ...badReferenceSchema.payload,
      result: { ...badReferenceSchema.payload.result, schema: 'CL_SWEEP_RESULT v2' },
    },
  }), /reference schema must be CL_SWEEP_RESULT v1/);

  const badBinding = baseEvent(fixture);
  const badBindingReference = manuallyWriteArtifact(
    fixture,
    badBinding,
    artifactEnvelope(badBinding, { evidence: 'bound wrong' }, { ticket: 'ISS-OTHER' }),
  );
  badBinding.payload = {
    summary: { checkpoint: 'implementation' }, routing: { next: 'continue' },
    result: badBindingReference,
  };
  assert.throws(() => parse(badBinding), /artifact ticket does not match/);

  const symlinkEvent = baseEvent(fixture);
  const symlinkArtifact = artifactEnvelope(symlinkEvent);
  const symlinkContents = Buffer.from(`${JSON.stringify(symlinkArtifact, null, 2)}\n`);
  const symlinkTarget = join(fixture.directory, 'symlink-target.json');
  writeFileSync(symlinkTarget, symlinkContents, { mode: 0o600 });
  const symlinkPath = join(fixture.session.resultRoot, `${symlinkEvent.event_id}.json`);
  symlinkSync(symlinkTarget, symlinkPath);
  symlinkEvent.payload = {
    summary: { checkpoint: 'implementation' }, routing: { next: 'continue' },
    result: {
      schema: RESULT_SCHEMA, transport: 'local_artifact', path: symlinkPath,
      sha256: createHash('sha256').update(symlinkContents).digest('hex'), bytes: symlinkContents.length,
    },
  };
  assert.throws(() => parse(symlinkEvent), /must not be a symlink/);

  const tooLarge = baseEvent(fixture);
  tooLarge.payload = {
    summary: { checkpoint: 'implementation' }, routing: { next: 'continue' },
    result: {
      schema: RESULT_SCHEMA, transport: 'local_artifact',
      path: join(fixture.session.resultRoot, `${tooLarge.event_id}.json`),
      sha256: '1'.repeat(64), bytes: MAX_RESULT_ARTIFACT_BYTES + 1,
    },
  };
  assert.throws(() => parse(tooLarge), /bytes must be between/);

  const secretEvent = baseEvent(fixture);
  const secretCandidate = join(fixture.directory, 'secret-candidate.json');
  writeFileSync(
    secretCandidate,
    JSON.stringify(artifactEnvelope(secretEvent, { api_token: 'forbidden' })),
    { mode: 0o600 },
  );
  assert.throws(() => createResultArtifact({
    'session-file': fixture.sessionFile,
    'artifact-file': secretCandidate,
  }), /Raw secret field is forbidden/);

  const staleArtifactEvent = baseEvent(fixture);
  const staleReference = manuallyWriteArtifact(
    fixture,
    staleArtifactEvent,
    artifactEnvelope(staleArtifactEvent, { evidence: 'stale' }, { owner_generation: 2 }),
  );
  staleArtifactEvent.payload = {
    summary: { checkpoint: 'implementation' }, routing: { next: 'continue' }, result: staleReference,
  };
  assert.throws(() => parse(staleArtifactEvent), /artifact owner_generation does not match/);

  const staleCallback = baseEvent(fixture, { owner_generation: 2 });
  assert.throws(() => parse(staleCallback), /Callback owner_generation does not match/);

  const dangling = baseEvent(fixture);
  dangling.payload = {
    summary: { checkpoint: 'implementation' }, routing: { next: 'continue' },
    result: {
      schema: RESULT_SCHEMA, transport: 'local_artifact',
      path: join(fixture.session.resultRoot, `${dangling.event_id}.json`),
      sha256: '2'.repeat(64), bytes: 1,
    },
  };
  assert.throws(() => parse(dangling), /Result artifact is unavailable/);

  const oversizedCandidate = join(fixture.directory, 'oversized-candidate.json');
  writeFileSync(oversizedCandidate, Buffer.alloc(MAX_RESULT_ARTIFACT_BYTES + 1, 0x20), { mode: 0o600 });
  assert.throws(() => createResultArtifact({
    'session-file': fixture.sessionFile,
    'artifact-file': oversizedCandidate,
  }), /candidate must be between/);

  const arrayCandidate = join(fixture.directory, 'array-candidate.json');
  writeFileSync(arrayCandidate, '[]\n', { mode: 0o600 });
  assert.throws(() => createResultArtifact({
    'session-file': fixture.sessionFile,
    'artifact-file': arrayCandidate,
  }), /plain JSON object/);

  const missingRouting = compactEvent(fixture);
  assert.throws(() => parse({
    ...missingRouting,
    payload: { summary: missingRouting.payload.summary, result: missingRouting.payload.result },
  }), /payload.routing must be a nonempty plain JSON object/);
});

test('artifact envelope equality covers every callback ownership and routing binding', () => {
  const fixture = initializeFixture();
  const cases = [
    ['event_id', randomUUID(), /event_id does not match the callback/],
    ['parent_thread_id', 'parent-other', /parent_thread_id does not match the callback/],
    ['root_generation', 2, /root_generation does not match the callback/],
    ['ticket', 'ISS-OTHER', /ticket does not match the worker session/],
    ['worker_id', 'worker-other', /worker_id does not match the worker session/],
    ['owner_surface', 'desktop', /owner_surface must be cli/],
    ['owner_generation', 4, /owner_generation does not match the ticket generation/],
    ['lease_id', 'lease-other', /lease_id does not match the ticket lease/],
    ['lease_token_hash', 'b'.repeat(64), /lease_token_hash does not match the ticket lease/],
    ['worktree', fixture.directory, /worktree does not match the worker session/],
    ['kind', 'TERMINAL', /kind does not match the callback/],
    ['phase', 'other', /phase does not match the callback/],
    ['status', 'READY', /status does not match the callback/],
  ];
  for (const [field, value, expected] of cases) {
    const event = baseEvent(fixture);
    const reference = manuallyWriteArtifact(
      fixture,
      event,
      artifactEnvelope(event, { evidence: field }, { [field]: value }),
    );
    event.payload = {
      summary: { checkpoint: 'implementation' }, routing: { next: 'continue' }, result: reference,
    };
    assert.throws(
      () => parseCallback(`${EVENT_PREFIX}${JSON.stringify(event)}`, fixture.session),
      expected,
      field,
    );
  }
});

test('artifact callbacks persist verified metadata, deliver compactly, and reject later mutation', async () => {
  const fixture = initializeFixture();
  const event = compactEvent(fixture, {
    kind: 'ANALYSIS_COMPLETE', phase: 'analysis', status: 'GO',
    payload: { summary: { decision: 'GO' }, routing: { next: 'execute' } },
  }, { evidence: 'detailed analysis '.repeat(2_000) });
  const client = new FakeClient({ worktree: fixture.worktree, event });
  const result = await runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client });
  assert.equal(result.parentDelivery.status, 'delivered');
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(stored.resultArtifacts[event.event_id].sha256, event.payload.result.sha256);
  assert.equal(stored.events[0].resultArtifact.bindingSha256.length, 64);
  const parentStart = client.requests.find(({ method, params }) => (
    method === 'turn/start' && params.threadId === 'parent-thread'
  ));
  assert.match(parentStart.params.input[0].text, /"transport":"local_artifact"/);
  assert.doesNotMatch(parentStart.params.input[0].text, /detailed analysis detailed analysis/);

  writeFileSync(event.payload.result.path, `${readFileSync(event.payload.result.path, 'utf8')} `, { mode: 0o600 });
  assert.throws(() => verifyResultArtifactReference(event, stored), /size mismatch/);
});

test('root adoption preserves verified artifacts and fails closed if evidence changes', async () => {
  const fixture = initializeFixture();
  const event = compactEvent(fixture);
  await runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client: new FakeClient({ worktree: fixture.worktree, event }) });
  const crashWindow = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  delete crashWindow.resultArtifacts;
  delete crashWindow.events[0].resultArtifact;
  writeFileSync(fixture.sessionFile, `${JSON.stringify(crashWindow, null, 2)}\n`, { mode: 0o600 });
  const rebound = await rebindParent({
    'session-file': fixture.sessionFile,
    'expected-parent-thread-id': 'parent-thread',
    'expected-parent-cwd': fixture.worktree,
    'expected-root-generation': '1',
    'parent-thread-id': 'parent-thread-2',
    'parent-cwd': fixture.worktree,
  }, { inspectThread: async () => ({ status: 'idle', activeTurnId: null }) });
  assert.equal(rebound.parentGeneration, 2);
  const adopted = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(adopted.resultArtifacts[event.event_id].sha256, event.payload.result.sha256);

  writeFileSync(event.payload.result.path, '{}\n', { mode: 0o600 });
  await assert.rejects(rebindParent({
    'session-file': fixture.sessionFile,
    'expected-parent-thread-id': 'parent-thread-2',
    'expected-parent-cwd': fixture.worktree,
    'expected-root-generation': '2',
    'parent-thread-id': 'parent-thread-3',
    'parent-cwd': fixture.worktree,
  }, { inspectThread: async () => ({ status: 'idle', activeTurnId: null }) }), /size mismatch/);
  assert.equal(JSON.parse(readFileSync(fixture.sessionFile, 'utf8')).parentGeneration, 2);
});

test('reconcile recovers the same compact artifact callback after client interruption', async () => {
  const fixture = initializeFixture();
  const event = compactEvent(fixture, {
    kind: 'TERMINAL', phase: 'terminal', status: 'MERGED',
    payload: {
      summary: {
        outcome: 'MERGED', requirements_contract: 'PRD-1 v1 R1',
        review_learning_memory: 'not_applicable',
      },
      routing: { next: 'reconcile' },
    },
  });
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.appServerThreadId = 'worker-thread';
  stored.activeTurnId = 'completed-turn';
  stored.state = 'INTERRUPTED';
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`);
  const message = `done\n${EVENT_PREFIX}${JSON.stringify(event)}`;
  const client = new FakeClient({
    worktree: fixture.worktree,
    existingTurn: {
      id: 'completed-turn', status: 'completed',
      items: [{ type: 'agentMessage', phase: 'final_answer', text: message }],
    },
  });
  const recovered = await reconcileSession({
    'session-file': fixture.sessionFile,
    'events-file': fixture.eventsFile,
  }, { client });
  assert.equal(recovered.action, 'callback_recovered');
  assert.equal(recovered.event.payload.result.sha256, event.payload.result.sha256);
  const durable = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(durable.state, 'TERMINAL');
  assert.equal(durable.resultArtifacts[event.event_id].bytes, event.payload.result.bytes);
});

test('representative compact callback is deterministically more than 75 percent smaller', () => {
  const fixture = initializeFixture();
  const event = baseEvent(fixture, {
    kind: 'ANALYSIS_COMPLETE', phase: 'analysis', status: 'GO',
  });
  const fullResult = {
    decision: 'GO',
    evidence: 'bounded code, PRD, dependency, validation, and routing evidence. '.repeat(600),
  };
  const reference = publishArtifact(fixture, event, fullResult);
  const inline = {
    ...event,
    payload: {
      summary: { decision: 'GO' }, routing: { next: 'execute' }, result: fullResult,
    },
  };
  const compact = {
    ...event,
    payload: {
      summary: { decision: 'GO' }, routing: { next: 'execute' }, result: reference,
    },
  };
  const inlineBytes = Buffer.byteLength(JSON.stringify(inline));
  const compactBytes = Buffer.byteLength(JSON.stringify(compact));
  const reduction = 1 - (compactBytes / inlineBytes);
  assert.ok(reduction > 0.75, `expected >75% event-byte reduction, observed ${(reduction * 100).toFixed(1)}%`);
  assert.equal(parseCallback(`${EVENT_PREFIX}${JSON.stringify(compact)}`, fixture.session).status, 'GO');
});

test('persists the generic callback attempt fence before parent acceptance and refuses replay', async () => {
  const fixture = initializeFixture();
  const event = compactEvent(fixture);
  const client = new FakeClient({ worktree: fixture.worktree, event });
  const request = client.request.bind(client);
  let parentStarts = 0;
  client.request = async (method, params) => {
    if (method === 'turn/start' && params.threadId === 'parent-thread') {
      parentStarts += 1;
      const fenced = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
      assert.equal(fenced.events[0].delivery.status, 'delivering');
      await request(method, params);
      throw new Error('simulated crash after parent acceptance');
    }
    return request(method, params);
  };
  const result = await runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client });
  assert.equal(result.parentDelivery.status, 'delivering');
  const durable = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(durable.events[0].delivery.outcome, 'ambiguous');
  await assert.rejects(notifyParent({ 'session-file': fixture.sessionFile }, { client }), /ambiguous accepted outcome/);
  assert.equal(parentStarts, 1);
});

test('known external parent writer leaves callback pending retry without ambiguous fence', async () => {
  const fixture = initializeFixture();
  const event = compactEvent(fixture);
  const client = new FakeClient({ worktree: fixture.worktree, event });
  const request = client.request.bind(client);
  let parentStarts = 0;
  client.request = async (method, params) => {
    if (method === 'thread/read' && params.threadId === 'parent-thread') {
      return {
        thread: {
          id: 'parent-thread',
          cwd: fixture.worktree,
          status: { type: 'notLoaded' },
        },
      };
    }
    if (method === 'thread/resume' && params.threadId === 'parent-thread') {
      throw new Error('thread already has an active writer');
    }
    if (method === 'turn/start' && params.threadId === 'parent-thread') {
      parentStarts += 1;
    }
    return request(method, params);
  };
  const result = await runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client });
  assert.equal(result.parentDelivery.status, 'pending_retry');
  assert.equal(result.parentDelivery.failure, 'The target thread has an active writer outside this managed App Server daemon');
  const durable = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(durable.events[0].delivery.status, 'pending_retry');
  assert.equal(durable.events[0].delivery.outcome, undefined);
  assert.equal(parentStarts, 0);
});

test('repairs known external parent writer delivery so root adoption can rebind', async () => {
  const fixture = initializeFixture();
  const event = compactEvent(fixture);
  const delivery = {
    status: 'delivering',
    attemptId: 'attempt-known-parent-writer',
    parent: {
      threadId: 'parent-thread',
      cwd: fixture.worktree,
      generation: 1,
    },
    failure: 'The target thread has an active writer outside this managed App Server daemon',
    outcome: 'ambiguous',
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
  const session = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  session.events = [{ event, delivery }];
  session.acceptedEventIds = [event.event_id];
  session.lastEvent = event;
  session.parentDelivery = { ...delivery, eventId: event.event_id };
  writeFileSync(fixture.sessionFile, JSON.stringify(session, null, 2));

  const repaired = repairExternalParentWriterDelivery({
    'session-file': fixture.sessionFile,
  });
  assert.equal(repaired.repaired, 1);
  assert.equal(repaired.parentDelivery.status, 'pending_retry');
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(stored.events[0].delivery.status, 'pending_retry');
  assert.equal(stored.events[0].delivery.repairedFrom.attemptId, 'attempt-known-parent-writer');

  const rebound = await rebindParent({
    'session-file': fixture.sessionFile,
    'expected-root-generation': '1',
    'expected-parent-thread-id': 'parent-thread',
    'expected-parent-cwd': fixture.worktree,
    'parent-thread-id': 'parent-2',
    'parent-cwd': fixture.worktree,
  });
  assert.equal(rebound.parentGeneration, 2);
});

test('turn collector rejects promptly when the daemon connection closes', async () => {
  const client = new FakeClient({ worktree: createRepo() });
  const collector = createTurnCollector(client, 'worker-thread', 60_000);
  const waiting = collector.wait('turn-1');
  for (const handler of client.connections) handler('close', new Error('daemon restarted'));
  await assert.rejects(waiting, /daemon restarted/);
  collector.close();
});

test('status and steer use the exact stored App Server thread and active turn', async () => {
  const fixture = initializeFixture();
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.appServerThreadId = 'worker-thread';
  stored.state = 'RUNNING';
  stored.activeTurnId = 'worker-turn';
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`);
  const client = new FakeClient({ worktree: fixture.worktree, active: true });
  const status = await statusSession({ 'session-file': fixture.sessionFile }, { client });
  assert.equal(status.activeProcess, true);
  assert.equal(status.activeTurnId, 'worker-turn');
  const result = await steerSession({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
  }, { client });
  assert.equal(result.mode, 'steer');
  const steer = client.requests.find(({ method }) => method === 'turn/steer');
  assert.equal(steer.params.threadId, 'worker-thread');
  assert.equal(steer.params.expectedTurnId, 'worker-turn');
});

test('report activity adopts one direct user successor after an interrupted managed turn', async () => {
  const fixture = initializeFixture();
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.appServerThreadId = 'worker-thread';
  stored.state = 'FAILED';
  stored.activeTurnId = 'interrupted-turn';
  stored.lastFailure = 'Turn interrupted-turn ended interrupted';
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  const client = new FakeClient({
    worktree: fixture.worktree,
    active: true,
    listedTurnId: 'direct-turn',
    existingTurns: [
      { id: 'interrupted-turn', status: 'interrupted', items: [] },
      { id: 'direct-turn', status: 'inProgress', items: [{ type: 'userMessage', text: 'Continue.' }] },
    ],
  });

  const result = await reportActivity({
    'session-file': fixture.sessionFile,
    'activity-phase': 'planning',
  }, { client, recordSessionDisplayEvent: () => true });

  assert.equal(result.currentActivity.turnId, 'direct-turn');
  assert.equal(result.currentActivity.recorded, true);
  const adopted = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(adopted.state, 'RUNNING');
  assert.equal(adopted.activeTurnId, 'direct-turn');
  assert.equal(adopted.lastFailure, undefined);
  assert.equal(adopted.lastDirectTurnAdoption.previousTurnId, 'interrupted-turn');
  assert.equal(adopted.lastDirectTurnAdoption.previousTurnStatus, 'interrupted');
  assert.equal(adopted.lastDirectTurnAdoption.reason, 'direct_user_successor');
});

test('report activity adopts one automatic continuation after an accepted callback', async () => {
  const fixture = initializeFixture();
  const callbackMessage = 'done\nCL_SWEEP_EVENT v1 {"event_id":"accepted-event"}';
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.appServerThreadId = 'worker-thread';
  stored.state = 'WAITING';
  stored.activeTurnId = null;
  stored.lastEvent = { event_id: 'accepted-event' };
  stored.lastMessageSha256 = createHash('sha256').update(callbackMessage).digest('hex');
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  const client = new FakeClient({
    worktree: fixture.worktree,
    active: true,
    listedTurnId: 'continuation-turn',
    existingTurns: [
      {
        id: 'callback-turn',
        status: 'completed',
        items: [{ type: 'agentMessage', phase: 'final_answer', text: callbackMessage }],
      },
      { id: 'continuation-turn', status: 'inProgress', items: [{ type: 'reasoning' }] },
    ],
  });

  const result = await reportActivity({
    'session-file': fixture.sessionFile,
    'activity-phase': 'reviewing',
    'review-kind': 'code',
  }, { client, recordSessionDisplayEvent: () => true });

  assert.equal(result.currentActivity.turnId, 'continuation-turn');
  assert.equal(result.currentActivity.reviewKind, 'code');
  const adopted = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(adopted.state, 'RUNNING');
  assert.equal(adopted.activeTurnId, 'continuation-turn');
  assert.equal(adopted.lastAutomaticContinuationAdoption.previousTurnId, 'callback-turn');
  assert.equal(adopted.lastAutomaticContinuationAdoption.previousEventId, 'accepted-event');
  assert.equal(adopted.lastAutomaticContinuationAdoption.reason, 'persistent_goal_continuation');
});

test('report activity replays completed continuation callbacks before adopting the live turn', async () => {
  const fixture = initializeFixture();
  const anchorMessage = 'done\nCL_SWEEP_EVENT v1 {"event_id":"anchor-event"}';
  const replayedEvent = baseEvent(fixture, { kind: 'BLOCKED', status: 'DEPENDENCY_BLOCKED' });
  const replayedMessage = `done\nCL_SWEEP_EVENT v1 ${JSON.stringify(replayedEvent)}`;
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.appServerThreadId = 'worker-thread';
  stored.state = 'WAITING';
  stored.activeTurnId = null;
  stored.eventsFile = fixture.eventsFile;
  stored.lastEvent = { event_id: 'anchor-event' };
  stored.lastMessageSha256 = createHash('sha256').update(anchorMessage).digest('hex');
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  const client = new FakeClient({
    worktree: fixture.worktree,
    active: true,
    listedTurnId: 'live-continuation',
    existingTurns: [
      {
        id: 'anchor-turn',
        status: 'completed',
        items: [{ type: 'agentMessage', phase: 'final_answer', text: anchorMessage }],
      },
      {
        id: 'completed-continuation',
        status: 'completed',
        items: [{ type: 'agentMessage', phase: 'final_answer', text: replayedMessage }],
      },
      { id: 'live-continuation', status: 'inProgress', items: [{ type: 'reasoning' }] },
    ],
  });

  await reportActivity({
    'session-file': fixture.sessionFile,
    'activity-phase': 'reviewing',
    'review-kind': 'code',
  }, { client, recordSessionDisplayEvent: () => true });

  const adopted = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(adopted.activeTurnId, 'live-continuation');
  assert.equal(adopted.lastEvent.event_id, replayedEvent.event_id);
  assert.equal(adopted.lastMessageSha256, createHash('sha256').update(replayedMessage).digest('hex'));
  assert.deepEqual(adopted.lastAutomaticContinuationAdoption.replayedEventIds, [replayedEvent.event_id]);
  assert.equal(adopted.acceptedEventIds.includes(replayedEvent.event_id), true);
});

test('reconciles completed automatic continuation callbacks after the thread becomes idle', async () => {
  const fixture = initializeFixture();
  const anchorMessage = 'done\nCL_SWEEP_EVENT v1 {"event_id":"anchor-event"}';
  const firstEvent = baseEvent(fixture, { kind: 'BLOCKED', status: 'DEPENDENCY_BLOCKED' });
  const secondEvent = baseEvent(fixture, { kind: 'BLOCKED', status: 'DEPENDENCY_BLOCKED' });
  const firstMessage = `done\nCL_SWEEP_EVENT v1 ${JSON.stringify(firstEvent)}`;
  const secondMessage = `done\nCL_SWEEP_EVENT v1 ${JSON.stringify(secondEvent)}`;
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.appServerThreadId = 'worker-thread';
  stored.state = 'WAITING';
  stored.activeTurnId = null;
  stored.eventsFile = fixture.eventsFile;
  stored.lastEvent = { event_id: 'anchor-event' };
  stored.lastMessageSha256 = createHash('sha256').update(anchorMessage).digest('hex');
  stored.currentActivity = { phase: 'reviewing', reviewKind: 'code' };
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  const client = new FakeClient({
    worktree: fixture.worktree,
    existingTurns: [
      {
        id: 'anchor-turn',
        status: 'completed',
        items: [{ type: 'agentMessage', phase: 'final_answer', text: anchorMessage }],
      },
      {
        id: 'first-continuation',
        status: 'completed',
        items: [{ type: 'agentMessage', phase: 'final_answer', text: firstMessage }],
      },
      {
        id: 'second-continuation',
        status: 'completed',
        items: [{ type: 'agentMessage', phase: 'final_answer', text: secondMessage }],
      },
    ],
  });

  const result = await reconcileAutomaticContinuations({
    'session-file': fixture.sessionFile,
  }, { client });

  assert.equal(result.state, 'WAITING');
  assert.deepEqual(result.events.map(({ event_id: eventId }) => eventId), [firstEvent.event_id, secondEvent.event_id]);
  const reconciled = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(reconciled.lastEvent.event_id, secondEvent.event_id);
  assert.equal(reconciled.currentActivity, undefined);
  assert.deepEqual(reconciled.lastAutomaticContinuationReconciliation.eventIds, [firstEvent.event_id, secondEvent.event_id]);
});

test('repairs an accepted callback misclassified after parent delivery failure', async () => {
  const fixture = initializeFixture();
  const acceptedEvent = baseEvent(fixture, { kind: 'PR_MONITORING_HANDOFF', status: 'WAITING' });
  const message = `done\nCL_SWEEP_EVENT v1 ${JSON.stringify(acceptedEvent)}`;
  const runtimeEvent = baseEvent(fixture, {
    kind: 'CHECKPOINT_READY',
    phase: 'callback_correction',
    status: 'CALLBACK_CORRECTION_REQUIRED',
  });
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.appServerThreadId = 'worker-thread';
  stored.state = 'INTERRUPTED';
  stored.activeTurnId = null;
  stored.acceptedEventIds = [acceptedEvent.event_id, runtimeEvent.event_id];
  stored.events = [
    { event: acceptedEvent, delivery: { status: 'pending', updatedAt: new Date().toISOString() } },
    { event: runtimeEvent, delivery: { status: 'pending', updatedAt: new Date().toISOString() } },
  ];
  stored.lastEvent = runtimeEvent;
  stored.lastRejectedCallback = {
    turnId: 'source-turn',
    messageSha256: createHash('sha256').update(message).digest('hex'),
    failure: 'Server is draining',
  };
  stored.callbackCorrection = {
    sourceTurnId: 'source-turn', attempts: 0, maxAttempts: 1, status: 'required',
  };
  stored.lastFailure = 'Server is draining';
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  const client = new FakeClient({
    worktree: fixture.worktree,
    existingTurns: [{
      id: 'source-turn',
      status: 'completed',
      items: [{ type: 'agentMessage', phase: 'final_answer', text: message }],
    }],
  });

  const result = await repairAcceptedCallbackDelivery({
    'session-file': fixture.sessionFile,
  }, { client });

  assert.equal(result.event.event_id, acceptedEvent.event_id);
  assert.equal(result.state, 'WAITING');
  const repaired = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(repaired.lastEvent.event_id, acceptedEvent.event_id);
  assert.equal(repaired.callbackCorrection, undefined);
  assert.equal(repaired.lastRejectedCallback, undefined);
  assert.equal(repaired.lastFailure, undefined);
  assert.equal(repaired.parentDelivery.status, 'pending_retry');
  assert.equal(repaired.lastAcceptedCallbackDeliveryRepair.runtimeFailureEventId, runtimeEvent.event_id);
});

test('supervises an already-completed legacy turn under its stored model, then requires replacement', async () => {
  for (const model of [LEGACY_COMPATIBLE_WORKER_MODEL, 'gpt-5.6-sol']) {
  const fixture = initializeFixture();
  const event = {
    event_id: randomUUID(),
    parent_thread_id: 'parent-thread',
    ticket: 'ISS-1',
    worker_id: 'worker-1',
    owner_surface: 'cli',
    owner_generation: 3,
    lease_id: 'lease-1',
    lease_token_hash: 'a'.repeat(64),
    kind: 'EXECUTION_CHECKPOINT',
    phase: 'implementation',
    status: 'WAITING',
    parent_action: 'continue',
    worktree: fixture.worktree,
    payload: {},
  };
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.appServerThreadId = 'worker-thread';
  stored.activeTurnId = 'worker-turn';
  stored.state = 'INTERRUPTED';
  stored.requestedModel = model;
  stored.modelBinding.requestedModel = model;
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`);
  const message = `done\nCL_SWEEP_EVENT v1 ${JSON.stringify(event)}`;
  const client = new FakeClient({
    worktree: fixture.worktree,
    existingTurn: {
      id: 'worker-turn',
      status: 'completed',
      items: [{ type: 'agentMessage', phase: 'final_answer', text: message }],
    },
  });
  const result = await superviseTurn({
    'session-file': fixture.sessionFile,
    'events-file': fixture.eventsFile,
  }, { client });
  assert.equal(result.event.event_id, event.event_id);
  const resumed = client.requests.find(({ method, params }) => method === 'thread/resume' && params.threadId === 'worker-thread');
  assert.equal(resumed.params.model, model);
  assert.equal(client.requests.some(({ method, params }) => method === 'turn/start' && params.threadId === 'worker-thread'), false);
  const recovered = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(recovered.state, 'WAITING');
  assert.equal(recovered.requestedModel, model);
  const status = await statusSession({ 'session-file': fixture.sessionFile }, { client });
  assert.equal(status.modelReplacement.idleCandidate, true);
  }
});

test('recovers a malformed completed callback on the same thread and worktree', async () => {
  const fixture = initializeFixture();
  const event = {
    event_id: randomUUID(),
    parent_thread_id: 'parent-thread',
    ticket: 'ISS-1',
    worker_id: 'worker-1',
    owner_surface: 'cli',
    owner_generation: 3,
    lease_id: 'lease-1',
    lease_token_hash: 'a'.repeat(64),
    kind: 'EXECUTION_CHECKPOINT',
    phase: 'implementation',
    status: 'WAITING',
    parent_action: 'continue',
    worktree: fixture.worktree,
    payload: {},
  };
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.appServerThreadId = 'worker-thread';
  stored.activeTurnId = 'malformed-turn';
  stored.state = 'INTERRUPTED';
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`);
  const malformed = `done\nCL_SWEEP_EVENT v1 ${JSON.stringify(event)}}`;
  const interruptedClient = new FakeClient({
    worktree: fixture.worktree,
    existingTurn: {
      id: 'malformed-turn',
      status: 'completed',
      items: [{ type: 'agentMessage', phase: 'final_answer', text: malformed }],
    },
  });

  await assert.rejects(reconcileSession({
    'session-file': fixture.sessionFile,
    'events-file': fixture.eventsFile,
  }, { client: interruptedClient }));
  const fenced = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(fenced.state, 'INTERRUPTED');
  assert.equal(fenced.activeTurnId, null);
  assert.equal(fenced.lastRejectedCallback.turnId, 'malformed-turn');
  assert.equal(fenced.lastEvent.status, 'CALLBACK_CORRECTION_REQUIRED');
  assert.equal(fenced.lastEvent.payload.failure_kind, 'CALLBACK_CORRECTION_REQUIRED');
  assert.equal(fenced.callbackCorrection.parentDelivery.status, 'delivered');
  assert.equal(fenced.acceptedEventIds.length, 1);

  const recoveredEvent = { ...event, event_id: randomUUID() };
  const recoveryClient = new FakeClient({ worktree: fixture.worktree, event: recoveredEvent, materialized: true });
  const recovered = await runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client: recoveryClient });
  assert.equal(recovered.threadId, 'worker-thread');
  const canonicalWorktree = realpathSync(fixture.worktree);
  assert.ok(recoveryClient.requests.some(({ method, params }) => (
    method === 'thread/resume' && params.threadId === 'worker-thread' && params.cwd === canonicalWorktree
  )), JSON.stringify(recoveryClient.requests));
  assert.ok(recoveryClient.requests.some(({ method, params }) => (
    method === 'turn/start' && params.threadId === 'worker-thread' && params.cwd === canonicalWorktree
  )));
  assert.equal(recoveryClient.requests.some(({ method }) => method === 'thread/start'), false);
  const finalSession = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(finalSession.worktree, canonicalWorktree);
  assert.equal(finalSession.generation, 3);
  assert.equal(finalSession.state, 'WAITING');
  assert.equal(finalSession.callbackCorrection.status, 'corrected');
});

test('corrects a stale root-generation callback on the same ticket generation', async () => {
  const fixture = initializeFixture();
  const event = {
    event_id: randomUUID(),
    parent_thread_id: 'parent-thread',
    root_generation: 2,
    ticket: 'ISS-1',
    worker_id: 'worker-1',
    owner_surface: 'cli',
    owner_generation: 3,
    lease_id: 'lease-1',
    lease_token_hash: 'a'.repeat(64),
    kind: 'EXECUTION_CHECKPOINT',
    phase: 'implementation',
    status: 'WAITING',
    parent_action: 'continue',
    worktree: fixture.worktree,
    payload: {},
  };
  await assert.rejects(runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client: new FakeClient({ worktree: fixture.worktree, event }) }),
  /root_generation does not match the current parent generation/);
  const rejected = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(rejected.state, 'INTERRUPTED');
  assert.equal(rejected.callbackCorrection.status, 'required');
  assert.equal(rejected.generation, 3);

  const correctedEvent = { ...event, event_id: randomUUID(), root_generation: 1 };
  const result = await runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client: new FakeClient({ worktree: fixture.worktree, event: correctedEvent, materialized: true }) });
  assert.equal(result.event.event_id, correctedEvent.event_id);
  const corrected = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(corrected.state, 'WAITING');
  assert.equal(corrected.callbackCorrection.status, 'corrected');
  assert.equal(corrected.generation, 3);
});

test('correction exhaustion durably notifies the parent that replacement is required', async () => {
  const fixture = initializeFixture();
  const baseEvent = {
    event_id: randomUUID(),
    parent_thread_id: 'parent-thread',
    root_generation: 2,
    ticket: 'ISS-1',
    worker_id: 'worker-1',
    owner_surface: 'cli',
    owner_generation: 3,
    lease_id: 'lease-1',
    lease_token_hash: 'a'.repeat(64),
    kind: 'EXECUTION_CHECKPOINT',
    phase: 'implementation',
    status: 'WAITING',
    parent_action: 'continue',
    worktree: fixture.worktree,
    payload: {},
  };
  await assert.rejects(runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client: new FakeClient({ worktree: fixture.worktree, event: baseEvent }) }),
  /root_generation does not match/);

  const overlong = {
    ...baseEvent,
    event_id: randomUUID(),
    root_generation: 1,
    parent_action: 'x'.repeat(513),
  };
  const correctionClient = new FakeClient({
    worktree: fixture.worktree,
    event: overlong,
    materialized: true,
  });
  await assert.rejects(runTurn({
    'session-file': fixture.sessionFile,
    'prompt-file': fixture.promptFile,
    'events-file': fixture.eventsFile,
  }, { client: correctionClient }), /parent_action exceeds 512 characters \(observed 513\)/);

  const failed = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.callbackCorrection.status, 'exhausted');
  assert.equal(failed.replacementRequired.reason, 'CALLBACK_CORRECTION_EXHAUSTED');
  assert.equal(failed.replacementRequired.parentDelivery.status, 'delivered');
  assert.equal(failed.lastEvent.kind, 'CHECKPOINT_READY');
  assert.equal(failed.lastEvent.status, 'REPLACEMENT_REQUIRED');
  assert.equal(failed.lastEvent.payload.failure_kind, 'CALLBACK_CORRECTION_EXHAUSTED');
  assert.equal(failed.lastEvent.payload.replacement_required, true);
  assert.equal(failed.acceptedEventIds.includes(failed.lastEvent.event_id), true);
  assert.match(readFileSync(fixture.eventsFile, 'utf8'), /CALLBACK_CORRECTION_EXHAUSTED/);
  assert.ok(correctionClient.requests.some(({ method, params }) => (
    method === 'turn/start' && params.threadId === 'parent-thread'
  )));
});

test('fences an absent stored turn without changing worker ownership or identity', async () => {
  const fixture = initializeFixture();
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.appServerThreadId = 'worker-thread';
  stored.activeTurnId = 'missing-turn';
  stored.state = 'RUNNING';
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`);
  let proofCount = 0;
  const result = await recoverAbsentTurn({
    'session-file': fixture.sessionFile,
    'ownership-ledger': join(fixture.directory, 'ownership.jsonl'),
    'expected-ticket': 'ISS-1',
    'expected-thread-id': 'worker-thread',
    'expected-turn-id': 'missing-turn',
    'expected-worktree': fixture.worktree,
    'expected-branch': 'codex/test',
    'expected-owner-id': 'worker-1',
    'expected-generation': '3',
    'expected-lease-id': 'lease-1',
    'expected-parent-thread-id': 'parent-thread',
    'expected-root-generation': '1',
    'expected-state': 'RUNNING',
  }, {
    verifyLease: () => {},
    verifyAbsentTurn: async (options) => {
      proofCount += 1;
      assert.equal(options.threadId, 'worker-thread');
      assert.equal(options.turnId, 'missing-turn');
      assert.equal(options.cwd, realpathSync(fixture.worktree));
      return { status: 'idle', activeTurnId: null, historyAbsent: true };
    },
    fenceRunner: async () => ({ receiptFile: null, pid: null, wasRunning: false, fenced: true }),
  });
  assert.equal(proofCount, 2);
  assert.equal(result.action, 'stale_turn_fenced');
  assert.equal(result.continuable, true);
  const recovered = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(recovered.activeTurnId, null);
  assert.equal(recovered.state, 'INTERRUPTED');
  assert.equal(recovered.appServerThreadId, 'worker-thread');
  assert.equal(recovered.worktree, realpathSync(fixture.worktree));
  assert.equal(recovered.ownerId, 'worker-1');
  assert.equal(recovered.generation, 3);
  assert.equal(recovered.leaseId, 'lease-1');
  assert.equal(recovered.lastStaleTurnRecovery.turnId, 'missing-turn');
  assert.equal(recovered.lastStaleTurnRecovery.historyAbsent, true);
});

test('absent-turn recovery fails closed before mutation when authoritative state is active', async () => {
  const fixture = initializeFixture();
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.appServerThreadId = 'worker-thread';
  stored.activeTurnId = 'missing-turn';
  stored.state = 'RUNNING';
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`);
  await assert.rejects(recoverAbsentTurn({
    'session-file': fixture.sessionFile,
    'ownership-ledger': join(fixture.directory, 'ownership.jsonl'),
    'expected-ticket': 'ISS-1',
    'expected-thread-id': 'worker-thread',
    'expected-turn-id': 'missing-turn',
    'expected-worktree': fixture.worktree,
    'expected-branch': 'codex/test',
    'expected-owner-id': 'worker-1',
    'expected-generation': '3',
    'expected-lease-id': 'lease-1',
    'expected-parent-thread-id': 'parent-thread',
    'expected-root-generation': '1',
    'expected-state': 'RUNNING',
  }, {
    verifyLease: () => {},
    verifyAbsentTurn: async () => { throw new Error('different active turn live-turn'); },
    fenceRunner: async () => { throw new Error('runner must not be fenced'); },
  }), /different active turn/);
  const unchanged = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(unchanged.activeTurnId, 'missing-turn');
  assert.equal(unchanged.state, 'RUNNING');
});

test('supervision adopts the one authoritative live turn after a reconnect id mismatch', async () => {
  const fixture = initializeFixture();
  const stored = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  stored.appServerThreadId = 'worker-thread';
  stored.activeTurnId = 'stale-client-turn';
  stored.state = 'INTERRUPTED';
  stored.lastFailure = 'stale id';
  writeFileSync(fixture.sessionFile, `${JSON.stringify(stored, null, 2)}\n`);
  const client = new FakeClient({
    worktree: fixture.worktree,
    active: true,
    listedTurnId: 'live-server-turn',
    existingTurn: { id: 'live-server-turn', status: 'inProgress', items: [] },
  });
  const adoption = new Promise((accept, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Authoritative turn adoption was not persisted')); }, 5000);
    const watcher = watch(fixture.directory, () => {
      const observed = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
      if (observed.activeTurnId !== 'live-server-turn') return;
      watcher.close();
      clearTimeout(timer);
      accept();
    });
  });
  const supervision = superviseTurn({
    'session-file': fixture.sessionFile,
    'events-file': fixture.eventsFile,
  }, { client });
  await adoption;
  const adopted = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  assert.equal(adopted.activeTurnId, 'live-server-turn');
  assert.equal(adopted.state, 'RUNNING');
  assert.equal(adopted.lastFailure, undefined);
  for (const handler of client.connections) handler('close', new Error('test complete'));
  await assert.rejects(supervision, /test complete/);
});

test('rebinds an idle callback target without changing the ticket lease generation', async () => {
  const fixture = initializeFixture();
  const rebound = await rebindParent({
    'session-file': fixture.sessionFile,
    'expected-parent-thread-id': 'parent-thread',
    'expected-parent-cwd': fixture.worktree,
    'expected-root-generation': '1',
    'parent-thread-id': 'parent-thread-2',
    'parent-cwd': fixture.worktree,
  });
  assert.equal(rebound.ticketOwnerGeneration, 3);
  assert.equal(rebound.parentGeneration, 2);
  const session = JSON.parse(readFileSync(fixture.sessionFile, 'utf8'));
  const callback = {
    event_id: randomUUID(),
    parent_thread_id: 'parent-thread-2',
    root_generation: 2,
    ticket: 'ISS-1',
    worker_id: 'worker-1',
    owner_surface: 'cli',
    owner_generation: 3,
    lease_id: 'lease-1',
    lease_token_hash: 'a'.repeat(64),
    kind: 'EXECUTION_CHECKPOINT',
    phase: 'implementation',
    status: 'WAITING',
    parent_action: 'continue',
    worktree: fixture.worktree,
    payload: {},
  };
  assert.equal(parseCallback(`done\nCL_SWEEP_EVENT v1 ${JSON.stringify(callback)}`, session).root_generation, 2);
  assert.throws(() => parseCallback(`done\nCL_SWEEP_EVENT v1 ${JSON.stringify({
    ...callback,
    event_id: randomUUID(),
    root_generation: 1,
  })}`, session), /does not match/);
});

test('feature ownership fences dispatch and callbacks when any member lease is lost', () => {
  const fixture = initializeFeatureFixture();
  const metadata = {
    manifest_sha256: fixture.session.featureOwnership.manifestSha256,
    feature_id: 'feature-1',
    members: ['ISS-1', 'ISS-2'],
  };
  const callback = {
    event_id: randomUUID(),
    parent_thread_id: 'parent-thread',
    root_generation: 1,
    ticket: 'ISS-1',
    worker_id: 'feature-worker',
    owner_surface: 'cli',
    owner_generation: fixture.anchor.generation,
    lease_id: fixture.anchor.leaseId,
    lease_token_hash: fixture.anchor.leaseTokenHash,
    kind: 'EXECUTION_CHECKPOINT',
    phase: 'implementation',
    status: 'WAITING',
    parent_action: 'continue',
    worktree: fixture.worktree,
    payload: { feature_ownership: metadata },
  };
  assert.equal(parseCallback(`${EVENT_PREFIX}${JSON.stringify(callback)}`, fixture.session).ticket, 'ISS-1');
  assert.throws(() => parseCallback(`${EVENT_PREFIX}${JSON.stringify({
    ...callback, event_id: randomUUID(), payload: {},
  })}`, fixture.session), /feature_ownership/);
  const artifactCandidate = join(fixture.directory, 'feature-artifact.json');
  writeFileSync(artifactCandidate, `${JSON.stringify(artifactEnvelope(
    callback,
    { feature_ownership: metadata, evidence: 'feature result' },
  ))}\n`, { mode: 0o600 });
  assert.equal(createResultArtifact({
    'session-file': fixture.sessionFile,
    'artifact-file': artifactCandidate,
  }).created, true);
  const missingMetadataCandidate = join(fixture.directory, 'feature-artifact-missing.json');
  writeFileSync(missingMetadataCandidate, `${JSON.stringify(artifactEnvelope(
    { ...callback, event_id: randomUUID() },
    { evidence: 'missing feature binding' },
  ))}\n`, { mode: 0o600 });
  assert.throws(() => createResultArtifact({
    'session-file': fixture.sessionFile,
    'artifact-file': missingMetadataCandidate,
  }), /feature_ownership/);

  const competing = spawnSync(process.execPath, [
    ownershipScript, 'acquire', '--ledger', fixture.ledger, '--ticket', 'ISS-2',
    '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'competing-worker',
    '--secret-output', join(fixture.secretDirectory, 'competing.json'), '--ttl-seconds', '600',
  ], { encoding: 'utf8' });
  assert.notEqual(competing.status, 0);
  assert.match(competing.stderr, /already has an active generation/);

  execFileSync(process.execPath, [
    ownershipScript, 'release', '--ledger', fixture.ledger, '--ticket', 'ISS-2',
    '--secret-file', join(fixture.secretDirectory, 'ISS-2.json'), '--reason', 'test_member_loss',
  ]);
  assert.throws(() => validateBinding(fixture.session), /ISS-2.*active current lease/);
  assert.throws(() => parseCallback(`${EVENT_PREFIX}${JSON.stringify({
    ...callback, event_id: randomUUID(),
  })}`, fixture.session), /ISS-2.*active current lease/);
});

test('feature ownership rejects a manifest changed after session initialization', () => {
  const fixture = initializeFeatureFixture();
  const manifest = JSON.parse(readFileSync(fixture.manifest, 'utf8'));
  manifest.feature_id = 'changed-feature';
  writeFileSync(fixture.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  assert.throws(() => validateBinding(fixture.session), /frozen session binding/);
});

test('an original idle thread can be restored only after the outgoing thread is idle', async () => {
  const worktree = createRepo();
  const directory = mkdtempSync(join(tmpdir(), 'cl-sweep-original-thread-'));
  const ledger = join(directory, 'ownership.jsonl');
  const secretDirectory = join(directory, 'secrets');
  mkdirSync(secretDirectory, { mode: 0o700 });
  const lease = (command, generation, ownerId) => {
    const args = [ownershipScript, command, '--ledger', ledger, '--ticket', 'ISS-1'];
    if (generation > 1) args.push('--secret-file', join(secretDirectory, `${generation - 1}.json`));
    args.push('--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', ownerId,
      '--secret-output', join(secretDirectory, `${generation}.json`), '--ttl-seconds', '600');
    return JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  };
  lease('acquire', 1, 'prior-worker');
  const sourceLease = lease('replace', 2, 'original-worker');
  const sourceFile = join(directory, 'source.json');
  initializeSession({ 'session-file': sourceFile, worktree, ticket: 'ISS-1',
    'parent-thread-id': 'parent-thread', 'parent-cwd': worktree,
    'owner-id': 'original-worker', generation: '2', 'lease-id': sourceLease.leaseId,
    'lease-token-hash': sourceLease.leaseTokenHash, 'protocol-schema-sha256': 'c'.repeat(64) });
  const outgoingLease = lease('replace', 3, 'replacement-worker');
  const outgoingFile = join(directory, 'outgoing.json');
  initializeSession({ 'session-file': outgoingFile, worktree, ticket: 'ISS-1',
    'parent-thread-id': 'parent-thread', 'parent-cwd': worktree,
    'owner-id': 'replacement-worker', generation: '3', 'lease-id': outgoingLease.leaseId,
    'lease-token-hash': outgoingLease.leaseTokenHash, 'protocol-schema-sha256': 'c'.repeat(64),
    'replacement-of': 'original-worker:2' });
  for (const [path, threadId] of [[sourceFile, 'source-thread'], [outgoingFile, 'outgoing-thread']]) {
    const session = JSON.parse(readFileSync(path, 'utf8'));
    session.appServerThreadId = threadId;
    session.appServerThreadMaterialized = true;
    session.state = 'WAITING';
    writeFileSync(path, `${JSON.stringify(session)}\n`, { mode: 0o600 });
  }
  const targetLease = lease('replace', 4, 'original-worker');
  const checkpoint = join(directory, 'checkpoint');
  execFileSync(process.execPath, [fileURLToPath(new URL('./checkpoint-worktree.mjs', import.meta.url)),
    'create', '--worktree', worktree, '--output', checkpoint,
    '--owner-surface', 'cli', '--generation', '3']);
  const targetFile = join(directory, 'target.json');
  initializeSession({ 'session-file': targetFile, worktree, ticket: 'ISS-1',
    'parent-thread-id': 'parent-thread', 'parent-cwd': worktree,
    'owner-id': 'original-worker', generation: '4', 'lease-id': targetLease.leaseId,
    'lease-token-hash': targetLease.leaseTokenHash, 'protocol-schema-sha256': 'c'.repeat(64),
    'replacement-of': 'replacement-worker:3', 'cutover-checkpoint': checkpoint });
  const args = { 'session-file': targetFile, 'source-session-file': sourceFile,
    'outgoing-session-file': outgoingFile, 'ownership-ledger': ledger,
    'expected-source-thread-id': 'source-thread', 'expected-outgoing-thread-id': 'outgoing-thread',
    'cutover-checkpoint': checkpoint };
  await assert.rejects(attachIdleHistoricalThread(args, { inspectThread: async ({ threadId }) => ({
    threadId, cwd: realpathSync(worktree), status: threadId === 'outgoing-thread' ? 'active' : 'idle',
    activeTurnId: threadId === 'outgoing-thread' ? 'active-turn' : null,
    canAcceptDirectInput: true,
  }) }), /not idle/);
  assert.equal(JSON.parse(readFileSync(targetFile, 'utf8')).appServerThreadId, null);
  const restored = await attachIdleHistoricalThread(args, { inspectThread: async ({ threadId }) => ({
    threadId, cwd: realpathSync(worktree), status: 'idle', activeTurnId: null,
    canAcceptDirectInput: true,
  }) });
  assert.equal(restored.threadId, 'source-thread');
  assert.equal(JSON.parse(readFileSync(targetFile, 'utf8')).appServerThreadId, 'source-thread');
});
