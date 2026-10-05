#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppServerClient,
  initializeClient,
  managedDaemon,
  readThreadState,
  sendInput,
} from '../../gh-monitor-pr/scripts/native-app-server-client.mjs';

export const SESSION_SCHEMA = 'APP_SERVER_ORCHESTRATOR_SESSION v1';
export const EVENT_SCHEMA = 'APP_SERVER_ORCHESTRATOR_EVENT v1';
export const EVENT_PREFIX = `${EVENT_SCHEMA} `;
export const DEFAULT_WORKER_MODEL = 'gpt-6-sol';
export const LEGACY_WORKER_MODEL = 'gpt-5.5';
export const BOUNDED_EXPLORATION_MODELS = Object.freeze(['gpt-6-luna']);

const STARTABLE_STATES = new Set(['READY', 'AWAITING_FIRST_TURN', 'IDLE', 'FAILED', 'INTERRUPTED', 'DISCONNECTED']);
const RAW_SECRET_KEY = /(?:^|_)(?:api_?key|authorization|cookie|credential|password|passwd|private_?key|secret|token)(?:$|_)/i;
const RAW_SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:sk|gh[oprsu])_[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const THREAD_START_RECOVERY_LIMIT = 2;
const THREAD_START_RECOVERY_TIMEOUT_MS = 5_000;

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function now() {
  return new Date().toISOString();
}

function canonicalDirectory(pathValue, label = 'cwd') {
  const path = realpathSync(resolve(pathValue));
  if (!statSync(path).isDirectory()) fail(`${label} must be a directory`);
  return path;
}

function writeJsonPrivate(pathValue, value) {
  const path = resolve(pathValue);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function appendEvent(pathValue, event) {
  const path = resolve(pathValue);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readEventJournal(pathValue) {
  const path = resolve(pathValue);
  if (!existsSync(path)) return [];
  const events = [];
  const byId = new Map();
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').filter(Boolean).entries()) {
    let event;
    try { event = JSON.parse(line); } catch { fail(`Invalid event journal JSON at line ${index + 1}`); }
    if (!event?.eventId) fail(`Event journal entry ${index + 1} is missing eventId`);
    assertNoRawSecrets(event);
    const prior = byId.get(event.eventId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) {
      fail(`Event journal contains conflicting eventId ${event.eventId}`);
    }
    if (!prior) {
      events.push(event);
      byId.set(event.eventId, event);
    }
  }
  return events;
}

function persistSession(path, session) {
  session.updatedAt = now();
  assertNoRawSecrets(session);
  writeJsonPrivate(path, session);
}

/** Reconcile the state outbox and JSONL event journal without dropping either side. */
export function reconcileEventJournal(path, session) {
  session.events ||= [];
  const journal = readEventJournal(session.eventsFile);
  const outbox = new Map();
  for (const entry of session.events) {
    if (!entry?.event?.eventId || !entry.delivery?.status) fail('Malformed session event outbox entry');
    if (outbox.has(entry.event.eventId)) fail(`Duplicate outbox eventId ${entry.event.eventId}`);
    outbox.set(entry.event.eventId, entry);
  }
  for (const event of journal) {
    const entry = outbox.get(event.eventId);
    if (entry && JSON.stringify(entry.event) !== JSON.stringify(event)) {
      fail(`Outbox conflicts with journal eventId ${event.eventId}`);
    }
    if (!entry) {
      const recovered = {
        event,
        journaled: true,
        delivery: session.parent
          ? { status: 'pending', recoveredFromJournal: true, updatedAt: now() }
          : { status: 'not_configured', recoveredFromJournal: true, updatedAt: now() },
      };
      session.events.push(recovered);
      outbox.set(event.eventId, recovered);
    }
  }
  const journalIds = new Set(journal.map((event) => event.eventId));
  for (const entry of session.events) {
    if (!entry?.event?.eventId) fail('Session outbox contains an event without eventId');
    assertNoRawSecrets(entry.event);
    if (!journalIds.has(entry.event.eventId)) {
      appendEvent(session.eventsFile, entry.event);
      journalIds.add(entry.event.eventId);
    }
    entry.journaled = true;
  }
  return { journalEvents: journalIds.size, outboxEvents: session.events.length };
}

/** Audit outbox/journal crash gaps without mutating either durable artifact. */
export function auditEventJournal(session) {
  if (!Array.isArray(session.events)) fail('Session event outbox must be an array');
  const journal = readEventJournal(session.eventsFile);
  const journalById = new Map(journal.map((event) => [event.eventId, event]));
  const outboxById = new Map();
  for (const entry of session.events) {
    if (!entry?.event?.eventId || !entry.delivery?.status) fail('Malformed session event outbox entry');
    if (outboxById.has(entry.event.eventId)) fail(`Duplicate outbox eventId ${entry.event.eventId}`);
    const journalEvent = journalById.get(entry.event.eventId);
    if (journalEvent && JSON.stringify(journalEvent) !== JSON.stringify(entry.event)) {
      fail(`Outbox conflicts with journal eventId ${entry.event.eventId}`);
    }
    outboxById.set(entry.event.eventId, entry.event);
  }
  return {
    journalOnly: journal.filter((event) => !outboxById.has(event.eventId)).map((event) => event.eventId),
    outboxOnly: session.events.filter((entry) => !journalById.has(entry.event.eventId)).map((entry) => entry.event.eventId),
  };
}

/** Reject structured events containing raw credential fields or recognizable raw credential values. */
export function assertNoRawSecrets(value, path = '$') {
  if (typeof value === 'string') {
    if (RAW_SECRET_VALUE.test(value)) fail(`Raw secret-like value is forbidden at ${path}`);
    return;
  }
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawSecrets(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const namesDigest = /(?:hash|digest|sha256)$/i.test(key);
    if (RAW_SECRET_KEY.test(key) && !namesDigest) fail(`Raw secret field is forbidden at ${path}.${key}`);
    assertNoRawSecrets(item, `${path}.${key}`);
  }
}

function loadSession(pathValue) {
  const path = resolve(pathValue);
  const session = JSON.parse(readFileSync(path, 'utf8'));
  if (session.schema !== SESSION_SCHEMA) fail('Unexpected App Server orchestrator session schema');
  return { path, session };
}

function validateSessionBinding(session) {
  const cwd = canonicalDirectory(session.cwd);
  if (cwd !== session.cwd) fail('Session cwd binding no longer resolves to the same directory');
  if (session.parent && canonicalDirectory(session.parent.cwd, 'parent cwd') !== session.parent.cwd) {
    fail('Session parent cwd binding no longer resolves to the same directory');
  }
}

function threadOptions(session) {
  return Object.fromEntries(Object.entries({
    approvalPolicy: session.options.approvalPolicy,
    sandbox: session.options.sandbox,
    serviceName: session.options.serviceName,
    model: session.options.model,
  }).filter(([, value]) => value !== null && value !== undefined));
}

function turnOptions(session) {
  return Object.fromEntries(Object.entries({
    approvalPolicy: session.options.approvalPolicy,
    sandboxPolicy: session.options.sandbox === 'danger-full-access'
      ? { type: 'dangerFullAccess' }
      : (session.options.sandbox === 'read-only' ? { type: 'readOnly' } : undefined),
    model: session.options.model,
    effort: session.options.effort,
  }).filter(([, value]) => value !== null && value !== undefined));
}

function validateModelOption(value, label = 'model') {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    fail(`${label} must be a compact model identifier`);
  }
  return value;
}

function validateNewSessionModel(value) {
  const model = validateModelOption(value ?? DEFAULT_WORKER_MODEL);
  if (model === LEGACY_WORKER_MODEL) {
    fail(`New worker sessions cannot use legacy model ${LEGACY_WORKER_MODEL}; use ${DEFAULT_WORKER_MODEL}`);
  }
  return model;
}

function validateEffortOption(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value)) {
    fail('effort must be a compact reasoning effort identifier');
  }
  return value;
}

function assertThreadBinding(thread, session) {
  if (thread?.id !== session.threadId) fail('App Server returned a different worker thread');
  if (!thread.cwd || canonicalDirectory(thread.cwd) !== session.cwd) {
    fail('App Server worker thread cwd does not match the session cwd');
  }
}

/** Create a durable cwd-bound session without starting a daemon thread. */
export function initializeSession(options) {
  const stateFile = resolve(options.stateFile);
  if (existsSync(stateFile)) fail('Session state file already exists');
  const cwd = canonicalDirectory(options.cwd);
  if (Boolean(options.parentThreadId) !== Boolean(options.parentCwd)) {
    fail('parentThreadId and parentCwd must be provided together');
  }
  if (options.transport && !['proxy', 'direct', 'desktop'].includes(options.transport)) {
    fail('transport must be proxy, direct, or desktop');
  }
  const createdAt = now();
  const session = {
    schema: SESSION_SCHEMA,
    sessionId: options.sessionId || randomUUID(),
    cwd,
    parent: options.parentThreadId ? {
      threadId: options.parentThreadId,
      cwd: canonicalDirectory(options.parentCwd, 'parent cwd'),
      generation: options.parentGeneration ?? 1,
    } : null,
    transport: options.transport || 'proxy',
    codex: options.codex || 'codex',
    options: {
      approvalPolicy: options.approvalPolicy || null,
      sandbox: options.sandbox || null,
      serviceName: options.serviceName || null,
      model: validateNewSessionModel(options.model),
      effort: validateEffortOption(options.effort),
    },
    eventsFile: resolve(options.eventsFile || `${stateFile}.events.jsonl`),
    threadId: null,
    threadMaterialized: false,
    activeTurnId: null,
    state: 'READY',
    events: [],
    createdAt,
    updatedAt: createdAt,
  };
  if (session.parent && (!Number.isSafeInteger(session.parent.generation) || session.parent.generation < 1)) {
    fail('parentGeneration must be a positive integer');
  }
  assertNoRawSecrets(session);
  writeJsonPrivate(stateFile, session);
  return session;
}

/** Inspect an existing exact thread/cwd binding without creating or resuming it. */
export async function inspectThread(options, dependencies = {}) {
  const cwd = canonicalDirectory(options.cwd);
  if (!options.threadId) fail('threadId is required');
  const session = {
    transport: options.transport || 'proxy',
    codex: options.codex || 'codex',
  };
  const connection = await connectedClient(session, options, dependencies);
  try {
    const live = await readThreadState(connection.client, options.threadId);
    if (!live.cwd || canonicalDirectory(live.cwd) !== cwd) {
      fail('Live thread cwd does not match the expected cwd');
    }
    return { threadId: options.threadId, cwd, ...live };
  } finally {
    if (connection.owned) connection.client.close();
  }
}

/**
 * Prove that one stored turn is absent and its exact-bound thread is idle.
 * This is read-only; domain adapters own any durable recovery mutation.
 */
export async function verifyIdleAbsentTurn(options, dependencies = {}) {
  const cwd = canonicalDirectory(options.cwd);
  if (!options.threadId) fail('threadId is required');
  if (!options.turnId) fail('turnId is required');
  const session = {
    transport: options.transport || 'proxy',
    codex: options.codex || 'codex',
  };
  const connection = await connectedClient(session, options, dependencies);
  try {
    const read = await connection.client.request('thread/read', {
      threadId: options.threadId,
      includeTurns: true,
    });
    if (read?.thread?.id !== options.threadId) fail('App Server returned a different thread');
    if (!read.thread.cwd || canonicalDirectory(read.thread.cwd) !== cwd) {
      fail('Live thread cwd does not match the expected cwd');
    }
    const turns = read.thread.turns || [];
    if (turns.some((turn) => turn.id === options.turnId)) {
      fail(`Turn ${options.turnId} remains present in worker history`);
    }
    const historyActive = turns.find((turn) => turn.status === 'inProgress');
    if (historyActive) {
      fail(`Worker history contains a different active turn ${historyActive.id}`);
    }
    const live = await readThreadState(connection.client, options.threadId);
    if (!live.cwd || canonicalDirectory(live.cwd) !== cwd) {
      fail('Live thread cwd does not match the expected cwd');
    }
    if (live.status !== 'idle' || live.activeTurnId) {
      fail(`Cannot fence absent turn while thread is ${live.status || 'unknown'} with active turn ${live.activeTurnId || 'none'}`);
    }
    return {
      threadId: options.threadId,
      turnId: options.turnId,
      cwd,
      status: live.status,
      activeTurnId: live.activeTurnId,
      historyAbsent: true,
      historyTurnCount: turns.length,
    };
  } finally {
    if (connection.owned) connection.client.close();
  }
}

/**
 * Move an idle worker session's parent callback binding to one exact new root.
 * Pending outbox entries are preserved and will be delivered to the new parent.
 */
export async function rebindParent(options, dependencies = {}) {
  const { path, session } = loadSession(options.stateFile);
  validateSessionBinding(session);
  reconcileEventJournal(path, session);
  if (!session.parent) fail('Session has no parent thread binding');
  const expectedGeneration = Number(options.expectedParentGeneration);
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
    fail('expectedParentGeneration must be a positive integer');
  }
  const currentGeneration = session.parent.generation || 1;
  const expectedCwd = canonicalDirectory(options.expectedParentCwd, 'expected parent cwd');
  if (
    session.parent.threadId !== options.expectedParentThreadId ||
    session.parent.cwd !== expectedCwd ||
    currentGeneration !== expectedGeneration
  ) {
    fail('Session parent binding does not match the expected generation');
  }
  if (session.activeTurnId || ['RUNNING', 'DISCONNECTED'].includes(session.state)) {
    fail('Cannot rebind a session with an active or disconnected turn');
  }
  if (session.events.some((entry) => entry?.delivery?.status === 'delivering')) {
    fail('Cannot rebind a session with an ambiguous in-flight callback delivery');
  }
  if (session.threadId) {
    const live = await inspectThread({
      threadId: session.threadId,
      cwd: session.cwd,
      socket: options.socket,
      codex: options.codex || session.codex,
      transport: options.transport || session.transport,
    }, dependencies);
    if (live.status === 'active' || live.activeTurnId) {
      fail(`Cannot rebind active worker turn ${live.activeTurnId || 'unknown'}`);
    }
  }
  const next = {
    threadId: options.parentThreadId,
    cwd: canonicalDirectory(options.parentCwd, 'parent cwd'),
    generation: currentGeneration + 1,
  };
  if (!next.threadId) fail('parentThreadId is required');
  session.parentHistory ||= [];
  session.parentHistory.push({ ...session.parent, generation: currentGeneration, replacedAt: now() });
  session.parent = next;
  for (const entry of session.events) {
    if (entry.delivery.status === 'pending_retry') {
      entry.delivery = { status: 'pending', updatedAt: now() };
    }
  }
  session.updatedAt = now();
  assertNoRawSecrets(session);
  writeJsonPrivate(path, session);
  return {
    sessionId: session.sessionId,
    threadId: session.threadId,
    cwd: session.cwd,
    parent: session.parent,
    previousParent: session.parentHistory.at(-1),
    pendingDeliveries: session.events.filter((entry) => entry.delivery.status === 'pending').length,
  };
}

function connectionOptions(session, options, dependencies) {
  if (dependencies.client) return null;
  if (options.socket) return { socket: realpathSync(options.socket), daemon: null };
  const daemon = (dependencies.managedDaemon || managedDaemon)({ codex: options.codex || session.codex });
  return { socket: daemon.socketPath, daemon };
}

async function connectedClient(session, options = {}, dependencies = {}) {
  if (dependencies.client) {
    await (dependencies.initializeClient || initializeClient)(dependencies.client);
    return { client: dependencies.client, owned: false, daemon: null };
  }
  const connection = connectionOptions(session, options, dependencies);
  const client = new AppServerClient({
    transport: options.transport || session.transport,
    codex: options.codex || session.codex,
    socket: connection.socket,
  });
  await initializeClient(client);
  return { client, owned: true, daemon: connection.daemon };
}

async function listExactThreadRecoveryFrontier(client, cwd) {
  const result = await client.request('thread/list', {
    cwd,
    cursor: null,
    limit: THREAD_START_RECOVERY_LIMIT,
    sortDirection: 'desc',
    sortKey: 'created_at',
    useStateDbOnly: true,
  }, THREAD_START_RECOVERY_TIMEOUT_MS);
  const data = result?.data || [];
  if (!Array.isArray(data) || data.length > THREAD_START_RECOVERY_LIMIT) {
    fail('App Server returned an invalid thread/start recovery frontier');
  }
  for (const thread of data) {
    if (!thread?.id || !thread.cwd || canonicalDirectory(thread.cwd) !== cwd) {
      fail('App Server returned a thread outside the exact thread/start recovery binding');
    }
  }
  return data;
}

function recordOperation(session, operation, persist) {
  session.pendingOperation = operation;
  persist();
}

function commitOperation(session, result, persist) {
  const operation = session.pendingOperation;
  session.operationHistory ||= [];
  session.operationHistory.push({ ...operation, status: 'committed', result, committedAt: now() });
  if (session.operationHistory.length > 100) session.operationHistory.splice(0, session.operationHistory.length - 100);
  delete session.pendingOperation;
  persist();
}

async function recoverThreadStart(client, session, persist) {
  const operation = session.pendingOperation;
  if (operation.threadId) {
    session.threadId = operation.threadId;
    session.threadMaterialized = false;
    return { mode: 'awaiting_first_turn', thread: { id: session.threadId, cwd: session.cwd }, materialized: false };
  }
  const before = new Set(operation.baselineThreadIds || []);
  const candidates = (await listExactThreadRecoveryFrontier(client, session.cwd))
    .filter((thread) => !before.has(thread.id));
  if (candidates.length !== 1) {
    fail(`Pending thread/start has ${candidates.length} exact recoverable results; refusing to retry an ambiguous remote operation`);
  }
  session.threadId = candidates[0].id;
  session.threadMaterialized = false;
  assertThreadBinding(candidates[0], session);
  operation.threadId = session.threadId;
  operation.phase = 'thread_created';
  operation.recoveredThreadId = true;
  persist();
  return { mode: 'awaiting_first_turn', thread: candidates[0], materialized: false };
}

/** Start or resume one exact thread with a durable pre-dispatch recovery record. */
export async function ensureDurableThread(client, session, persist, dependencies = {}) {
  if (session.pendingOperation) {
    if (session.pendingOperation.kind !== 'thread_start') {
      fail(`Session has unresolved ${session.pendingOperation.kind} operation`);
    }
    return recoverThreadStart(client, session, persist);
  }
  if (!session.threadId) {
    const baseline = await listExactThreadRecoveryFrontier(client, session.cwd);
    recordOperation(session, {
      operationId: randomUUID(),
      kind: 'thread_start',
      status: 'dispatching',
      cwd: session.cwd,
      baselineThreadIds: baseline.map((thread) => thread.id),
      preparedAt: now(),
    }, persist);
    const result = await client.request('thread/start', {
      cwd: session.cwd,
      ...threadOptions(session),
    });
    const threadId = result?.thread?.id;
    if (!threadId) fail('App Server did not return a worker thread id');
    await dependencies.afterRemoteThreadStart?.(result);
    session.threadId = threadId;
    session.threadMaterialized = false;
    assertThreadBinding(result.thread, session);
    session.pendingOperation.threadId = threadId;
    session.pendingOperation.phase = 'thread_created';
    persist();
    return { mode: 'awaiting_first_turn', thread: result.thread, materialized: false };
  }
  if (session.threadMaterialized !== true) {
    return { mode: 'awaiting_first_turn', thread: { id: session.threadId, cwd: session.cwd }, materialized: false };
  }
  const result = await client.request('thread/resume', {
    threadId: session.threadId,
    cwd: session.cwd,
    ...threadOptions(session),
  });
  assertThreadBinding(result?.thread, session);
  return { mode: 'resume', thread: result.thread };
}

async function ensureThread(client, session, persist = () => {}, dependencies = {}) {
  return ensureDurableThread(client, session, persist, dependencies);
}

/** Start or exactly resume the session's cwd-bound thread. */
export async function startThread(options, dependencies = {}) {
  const { path, session } = loadSession(options.stateFile);
  validateSessionBinding(session);
  const connection = await connectedClient(session, options, dependencies);
  try {
    const result = await ensureThread(connection.client, session, () => persistSession(path, session), dependencies);
    session.state = result.materialized === false
      ? 'AWAITING_FIRST_TURN'
      : (result.thread.status?.type === 'active' ? 'RUNNING' : 'IDLE');
    session.updatedAt = now();
    writeJsonPrivate(path, session);
    return {
      sessionId: session.sessionId,
      threadId: session.threadId,
      cwd: session.cwd,
      parent: session.parent ? { ...session.parent, generation: session.parent.generation || 1 } : null,
      mode: result.mode,
      state: session.state,
    };
  } finally {
    if (connection.owned) connection.client.close();
  }
}

function textInput(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) fail('Prompt must not be empty');
  return [{ type: 'text', text: prompt }];
}

async function recoverTurnStart(client, session, persist) {
  const operation = session.pendingOperation;
  const read = await client.request('thread/read', { threadId: session.threadId, includeTurns: true });
  assertThreadBinding(read?.thread, session);
  const before = new Set(operation.baselineTurnIds || []);
  const candidates = (read.thread.turns || []).filter((turn) => !before.has(turn.id));
  if (candidates.length !== 1) {
    fail(`Pending turn/start has ${candidates.length} exact recoverable results; refusing to retry an ambiguous remote operation`);
  }
  session.activeTurnId = candidates[0].id;
  commitOperation(session, { turnId: candidates[0].id, recovered: true }, persist);
  return { turnId: candidates[0].id, recovered: true, turn: candidates[0] };
}

function isThreadNotFoundTurnStartRejection(error) {
  const message = error?.message || '';
  return /\bthread not found\b/i.test(message)
    && (error?.code === -32600 || /\(-32600\)/.test(message));
}

async function verifyUnacceptedTurnStart(client, session) {
  const operation = session.pendingOperation;
  if (!operation || operation.kind !== 'turn_start') {
    fail('Session does not have an unresolved turn_start operation');
  }
  const read = await client.request('thread/read', {
    threadId: session.threadId,
    includeTurns: true,
  });
  assertThreadBinding(read?.thread, session);
  const before = new Set(operation.baselineTurnIds || []);
  const turns = read.thread.turns || [];
  const candidates = turns.filter((turn) => !before.has(turn.id));
  if (candidates.length !== 0) {
    fail(`Pending turn/start has ${candidates.length} recoverable result(s); run reconcile instead`);
  }
  const historyActive = turns.find((turn) => turn.status === 'inProgress');
  if (historyActive) fail(`Worker history contains active turn ${historyActive.id}`);
  const live = await readThreadState(client, session.threadId);
  if (live.cwd && canonicalDirectory(live.cwd) !== session.cwd) fail('Live worker cwd does not match session cwd');
  if (!['idle', 'notLoaded'].includes(live.status) || live.activeTurnId) {
    fail(`Cannot clear unaccepted turn/start while thread is ${live.status || 'unknown'} with active turn ${live.activeTurnId || 'none'}`);
  }
  return {
    baselineTurnCount: before.size,
    verifiedHistoryTurnCount: turns.length,
  };
}

function clearUnacceptedTurnStart(session, proof, persist) {
  session.activeTurnId = null;
  session.state = 'IDLE';
  commitOperation(session, {
    unacceptedTurnStartFenceCleared: true,
    baselineTurnCount: proof.baselineTurnCount,
    verifiedHistoryTurnCount: proof.verifiedHistoryTurnCount,
  }, persist);
}

// A JSON-RPC thread-not-found rejection is clearable only after the exact
// history and live idle checks prove App Server did not accept the turn.
async function clearRejectedTurnStartIfProven(client, session, error, persist) {
  if (!isThreadNotFoundTurnStartRejection(error)) throw error;
  const proof = await verifyUnacceptedTurnStart(client, session);
  clearUnacceptedTurnStart(session, proof, persist);
  throw error;
}

export async function recoverUnacceptedTurnStart(options, dependencies = {}) {
  const { path, session } = loadSession(options.stateFile);
  validateSessionBinding(session);
  if (session.pendingOperation?.kind !== 'turn_start') {
    fail('Session does not have an unresolved turn_start operation');
  }
  if (!session.threadId) fail('Worker thread has not started');
  const connection = await connectedClient(session, options, dependencies);
  try {
    const proof = await verifyUnacceptedTurnStart(connection.client, session);
    clearUnacceptedTurnStart(session, proof, () => persistSession(path, session));
    return {
      action: 'cleared_unaccepted_turn_start',
      sessionId: session.sessionId,
      threadId: session.threadId,
      cwd: session.cwd,
      baselineTurnCount: proof.baselineTurnCount,
      verifiedHistoryTurnCount: proof.verifiedHistoryTurnCount,
    };
  } finally {
    if (connection.owned) connection.client.close();
  }
}

function isUnmaterializedThreadError(error) {
  return /not materialized yet|no rollout found for thread id/i.test(error?.message || '');
}

function isTurnHistoryUnavailableError(error) {
  return /list_turns is not supported yet|thread\/turns\/list.*not supported/i.test(error?.message || '');
}

async function establishFirstTurn(client, session, prompt, persist, dependencies) {
  const operation = session.pendingOperation;
  if (!operation || operation.kind !== 'thread_start' || !session.threadId) {
    fail('First turn requires the durable thread/start operation');
  }
  if (operation.promptSha256 && operation.promptSha256 !== sha256(prompt)) {
    fail('Pending first-turn prompt does not match the requested prompt');
  }
  operation.promptSha256 = sha256(prompt);
  operation.phase = 'dispatching_first_turn';
  persist();

  try {
    const read = await client.request('thread/read', { threadId: session.threadId, includeTurns: true });
    assertThreadBinding(read?.thread, session);
    const turns = read.thread.turns || [];
    const status = read.thread.status?.type || null;
    if (turns.length === 0 && ['idle', 'notLoaded'].includes(status)) {
      // The first user message can be absent even after thread creation succeeded.
    } else if (turns.length !== 1) {
      fail(`Pending first turn has ${turns.length} exact recoverable results; refusing an ambiguous retry`);
    } else {
      session.activeTurnId = turns[0].id;
      session.threadMaterialized = true;
      commitOperation(session, { threadId: session.threadId, turnId: turns[0].id, recovered: true }, persist);
      return { turnId: turns[0].id, recovered: true, turn: turns[0] };
    }
  } catch (error) {
    if (isTurnHistoryUnavailableError(error)) {
      const live = await readThreadState(client, session.threadId);
      if (live.cwd && canonicalDirectory(live.cwd) !== session.cwd) fail('Live worker cwd does not match session cwd');
      if (live.status === 'active' || live.activeTurnId) {
        fail('Cannot recover first turn because the worker thread is already active');
      }
      if (!['idle', 'notLoaded'].includes(live.status)) {
        fail(`Cannot recover first turn from live thread status ${live.status || 'missing'}`);
      }
    } else if (!isUnmaterializedThreadError(error)) {
      throw error;
    }
  }

  const result = await client.request('turn/start', {
    threadId: session.threadId,
    input: textInput(prompt),
    cwd: session.cwd,
    ...turnOptions(session),
  });
  const turnId = result?.turn?.id;
  if (!turnId) fail('App Server did not return a worker turn id');
  await dependencies.afterRemoteTurnStart?.(result);
  session.activeTurnId = turnId;
  session.threadMaterialized = true;
  commitOperation(session, { threadId: session.threadId, turnId, recovered: false }, persist);
  return { turnId, recovered: false, turn: result.turn };
}

function hasDurableCompletedTurnEvidence(session, operation) {
  if (operation.phase !== 'dispatching_first_turn' || operation.threadId !== session.threadId) return false;
  if (session.threadMaterialized !== true || session.activeTurnId) return false;
  return Boolean(
    session.events?.length
    || session.lastEventId
    || session.operationHistory?.some((item) => item?.result?.turnId),
  );
}

/** Start one exact idle turn with a durable pre-dispatch recovery record. */
export async function startDurableTurn(client, session, prompt, persist, lifecycle = {}, dependencies = {}) {
  if (session.pendingOperation) {
    if (session.pendingOperation.kind === 'thread_start') {
      if (hasDurableCompletedTurnEvidence(session, session.pendingOperation)) {
        commitOperation(session, {
          threadId: session.threadId,
          staleFirstTurnFenceCleared: true,
        }, persist);
      } else {
        await recoverThreadStart(client, session, persist);
        return establishFirstTurn(client, session, prompt, persist, dependencies);
      }
    }
    if (session.pendingOperation && session.pendingOperation.kind !== 'turn_start') {
      fail(`Session has unresolved ${session.pendingOperation.kind} operation`);
    }
    if (session.pendingOperation && session.pendingOperation.promptSha256 !== sha256(prompt)) {
      fail('Pending turn/start prompt does not match the requested prompt');
    }
    if (session.pendingOperation) return recoverTurnStart(client, session, persist);
  }
  const isFreshThread = lifecycle.freshThread ?? !session.threadId;
  if (!lifecycle.threadEnsured) await ensureThread(client, session, persist, dependencies);
  if (session.threadMaterialized !== true) {
    if (!session.pendingOperation) {
      session.threadMaterialized = false;
      recordOperation(session, {
        operationId: randomUUID(),
        kind: 'thread_start',
        status: 'dispatching',
        phase: 'thread_created',
        threadId: session.threadId,
        cwd: session.cwd,
        baselineThreadIds: [],
        recoveredLegacyBinding: true,
        preparedAt: now(),
      }, persist);
    }
    return establishFirstTurn(client, session, prompt, persist, dependencies);
  }
  if (!isFreshThread) {
    const live = await readThreadState(client, session.threadId);
    if (live.cwd && canonicalDirectory(live.cwd) !== session.cwd) fail('Live worker cwd does not match session cwd');
    if (live.status === 'active') fail(`Worker already has active turn ${live.activeTurnId}`);
  }
  const read = await client.request('thread/read', { threadId: session.threadId, includeTurns: true });
  assertThreadBinding(read?.thread, session);
  recordOperation(session, {
    operationId: randomUUID(),
    kind: 'turn_start',
    status: 'dispatching',
    threadId: session.threadId,
    cwd: session.cwd,
    promptSha256: sha256(prompt),
    baselineTurnIds: (read.thread.turns || []).map((turn) => turn.id),
    preparedAt: now(),
  }, persist);
  let result;
  try {
    result = await client.request('turn/start', {
      threadId: session.threadId,
      input: textInput(prompt),
      cwd: session.cwd,
      ...turnOptions(session),
    });
  } catch (error) {
    await clearRejectedTurnStartIfProven(client, session, error, persist);
  }
  const turnId = result?.turn?.id;
  if (!turnId) fail('App Server did not return a worker turn id');
  await dependencies.afterRemoteTurnStart?.(result);
  session.activeTurnId = turnId;
  commitOperation(session, { turnId, recovered: false }, persist);
  return { turnId, recovered: false, turn: result.turn };
}

async function startIdleTurn(client, session, prompt, persist = () => {}, lifecycle = {}, dependencies = {}) {
  return startDurableTurn(client, session, prompt, persist, lifecycle, dependencies);
}

/** Start one idle worker turn and return immediately. */
export async function startTurn(options, dependencies = {}) {
  const { path, session } = loadSession(options.stateFile);
  validateSessionBinding(session);
  if (!STARTABLE_STATES.has(session.state)) fail(`Session cannot start a turn from ${session.state}`);
  const connection = await connectedClient(session, options, dependencies);
  try {
    const started = await startIdleTurn(
      connection.client,
      session,
      options.prompt,
      () => persistSession(path, session),
      {},
      dependencies,
    );
    const turnId = started.turnId;
    session.activeTurnId = turnId;
    session.state = 'RUNNING';
    delete session.lastFailure;
    session.updatedAt = now();
    writeJsonPrivate(path, session);
    return { sessionId: session.sessionId, threadId: session.threadId, turnId, mode: started.recovered ? 'recovered' : 'start' };
  } finally {
    if (connection.owned) connection.client.close();
  }
}

/** Steer the exact live active turn; never starts a new turn. */
export async function steerSession(options, dependencies = {}) {
  const { session } = loadSession(options.stateFile);
  validateSessionBinding(session);
  if (!session.threadId) fail('Worker thread has not started');
  const connection = await connectedClient(session, options, dependencies);
  try {
    const live = await readThreadState(connection.client, session.threadId);
    if (live.status !== 'active' || !live.activeTurnId) fail('Worker has no active turn to steer');
    if (!live.canAcceptDirectInput) fail('Worker active turn cannot accept direct input');
    const result = await connection.client.request('turn/steer', {
      threadId: session.threadId,
      expectedTurnId: live.activeTurnId,
      input: textInput(options.prompt),
    });
    if (result?.turnId !== live.activeTurnId) fail('App Server steered a different worker turn');
    return { sessionId: session.sessionId, threadId: session.threadId, turnId: result.turnId, mode: 'steer' };
  } finally {
    if (connection.owned) connection.client.close();
  }
}

/** Steer when active and direct-input capable, or start a new turn when idle. */
export async function sendSessionInput(options, dependencies = {}) {
  const { path, session } = loadSession(options.stateFile);
  validateSessionBinding(session);
  const connection = await connectedClient(session, options, dependencies);
  try {
    if (!session.threadId) {
      await ensureThread(connection.client, session, () => persistSession(path, session), dependencies);
    }
    if (session.pendingOperation && session.pendingOperation.kind !== 'thread_start') {
      fail(`Session has unresolved ${session.pendingOperation.kind} operation; reconcile before sending input`);
    }
    const liveBefore = await readThreadState(connection.client, session.threadId);
    if (liveBefore.status !== 'active') {
      const started = await startIdleTurn(
        connection.client,
        session,
        options.prompt,
        () => persistSession(path, session),
        // A live read is not a durable resume; materialized notLoaded threads
        // must pass through ensureDurableThread before turn/start.
        { threadEnsured: false, freshThread: false },
        dependencies,
      );
      session.state = 'RUNNING';
      delete session.lastFailure;
      persistSession(path, session);
      return {
        sessionId: session.sessionId,
        threadId: session.threadId,
        status: 'accepted',
        mode: started.recovered ? 'recovered' : 'start',
        turnId: started.turnId,
      };
    }
    recordOperation(session, {
      operationId: randomUUID(),
      kind: 'turn_steer',
      status: 'dispatching',
      threadId: session.threadId,
      turnId: liveBefore.activeTurnId,
      promptSha256: sha256(options.prompt),
      preparedAt: now(),
    }, () => persistSession(path, session));
    const result = await connection.client.request('turn/steer', {
      threadId: session.threadId,
      expectedTurnId: liveBefore.activeTurnId,
      input: textInput(options.prompt),
    });
    await dependencies.afterRemoteTurnSteer?.(result);
    if (result.turnId !== liveBefore.activeTurnId) {
      fail('Durable active delivery changed turn identity');
    }
    session.activeTurnId = result.turnId;
    session.state = 'RUNNING';
    delete session.lastFailure;
    commitOperation(session, { turnId: result.turnId, mode: 'steer' }, () => persistSession(path, session));
    return { sessionId: session.sessionId, threadId: session.threadId, status: 'accepted', mode: 'steer', turnId: result.turnId };
  } finally {
    if (connection.owned) connection.client.close();
  }
}

/** Parse the domain-neutral callback line from a completed worker's final response. */
export function parseGenericCallback(message, context) {
  if (typeof message !== 'string' || Buffer.byteLength(message, 'utf8') > 256 * 1024) {
    fail('Worker final response is missing or too large');
  }
  const lines = message.split('\n').map((item) => item.trim()).filter(Boolean);
  const eventLines = lines.filter((line) => line.startsWith(EVENT_PREFIX));
  const line = lines.at(-1);
  if (eventLines.length !== 1 || line !== eventLines[0]) {
    fail(`Worker final response must contain exactly one final ${EVENT_SCHEMA} line`);
  }
  const callback = JSON.parse(line.slice(EVENT_PREFIX.length));
  if (!callback || Object.getPrototypeOf(callback) !== Object.prototype) fail('Callback must be a plain JSON object');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callback.event_id || '')) {
    fail('Callback event_id must be a UUID');
  }
  if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(callback.kind || '')) fail('Callback kind is invalid');
  if (!/^[a-z][a-z0-9_.-]{0,31}$/i.test(callback.status || '')) fail('Callback status is invalid');
  if (typeof callback.terminal !== 'boolean') fail('Callback terminal must be boolean');
  if (!callback.payload || typeof callback.payload !== 'object' || Array.isArray(callback.payload)
    || Object.getPrototypeOf(callback.payload) !== Object.prototype
    || Buffer.byteLength(JSON.stringify(callback.payload), 'utf8') > 64 * 1024) {
    fail('Callback payload must be an object');
  }
  assertNoRawSecrets(callback);
  return {
    schema: EVENT_SCHEMA,
    eventId: callback.event_id,
    sessionId: context.session.sessionId,
    workerThreadId: context.session.threadId,
    turnId: context.turnId,
    cwd: context.session.cwd,
    kind: callback.kind,
    status: callback.status,
    terminal: callback.terminal,
    payload: callback.payload,
    occurredAt: now(),
  };
}

/** Format one event for delivery to a parent thread. Domain adapters may replace this hook. */
export function formatGenericDelivery(event) {
  return `Worker event from session ${event.sessionId}\n\n${EVENT_PREFIX}${JSON.stringify(event)}`;
}

/**
 * Add one event to an arbitrary durable outbox before any remote delivery can begin.
 * Callers provide persistence so domain adapters can retain their own state schema.
 */
export function enqueueDurableDelivery(state, event, options) {
  const eventId = options.eventId(event);
  const outbox = options.outbox(state);
  const existing = outbox.find((entry) => options.eventId(entry.event) === eventId);
  if (existing) {
    if (JSON.stringify(existing.event) !== JSON.stringify(event)) {
      fail(`Outbox eventId ${eventId} conflicts with different content`);
    }
    return { duplicate: true, entry: existing };
  }
  const entry = {
    event,
    delivery: options.parent
      ? { status: 'pending', updatedAt: now() }
      : { status: 'not_configured', updatedAt: now() },
  };
  outbox.push(entry);
  options.persist();
  return { duplicate: false, entry };
}

/**
 * Deliver one durable outbox entry, persisting the attempt fence before App Server I/O.
 * An unknown result remains `delivering` and is never replayed automatically.
 */
export async function deliverDurableDelivery(client, state, entry, options) {
  const eventId = options.eventId(entry.event);
  if (!options.parent) return entry.delivery;
  if (entry.delivery.status === 'delivered' || entry.delivery.status === 'not_configured') return entry.delivery;
  if (entry.delivery.status === 'delivering') {
    fail(`Delivery ${eventId} has an ambiguous accepted outcome; reconcile the exact parent before retry`);
  }
  entry.delivery = {
    status: 'delivering',
    attemptId: randomUUID(),
    parent: { ...options.parent },
    updatedAt: now(),
  };
  options.persist();
  try {
    const result = await (options.send || sendInput)(client, {
      threadId: options.parent.threadId,
      cwd: options.parent.cwd,
      waitSeconds: options.waitSeconds || 30,
    }, textInput(options.formatDelivery(entry.event, { state })));
    await options.afterRemoteAcceptance?.(result);
    entry.delivery = {
      status: 'delivered',
      mode: result.mode,
      turnId: result.turnId,
      updatedAt: now(),
    };
  } catch (error) {
    entry.delivery = {
      status: 'delivering',
      attemptId: entry.delivery.attemptId,
      parent: entry.delivery.parent,
      failure: error.message,
      outcome: 'ambiguous',
      updatedAt: now(),
    };
  }
  options.persist();
  return entry.delivery;
}

function queueEvent(path, session, event) {
  assertNoRawSecrets(event);
  reconcileEventJournal(path, session);
  const queued = enqueueDurableDelivery(session, event, {
    eventId: (item) => item.eventId,
    outbox: (state) => state.events,
    parent: session.parent,
    persist: () => persistSession(path, session),
  });
  const { entry } = queued;
  if (queued.duplicate) return queued;
  entry.journaled = false;
  session.lastEventId = event.eventId;
  reconcileEventJournal(path, session);
  persistSession(path, session);
  return queued;
}

async function deliverEntry(client, path, session, entry, formatDelivery) {
  return deliverDurableDelivery(client, session, entry, {
    eventId: (event) => event.eventId,
    parent: session.parent ? { ...session.parent, generation: session.parent.generation || 1 } : null,
    formatDelivery: (event) => formatDelivery(event, { session }),
    persist: () => {
      session.updatedAt = now();
      writeJsonPrivate(path, session);
    },
  });
}

async function deliverQueued(client, path, session, formatDelivery) {
  const deliveries = [];
  reconcileEventJournal(path, session);
  persistSession(path, session);
  for (const entry of session.events.filter((candidate) => !['delivered', 'not_configured'].includes(candidate.delivery.status))) {
    deliveries.push({
      eventId: entry.event.eventId,
      delivery: await deliverEntry(client, path, session, entry, formatDelivery),
    });
  }
  return deliveries;
}

function finalMessage(turn) {
  const items = turn?.items || [];
  return items.findLast((item) => item?.type === 'agentMessage' && item.phase === 'final_answer' && item.text)?.text
    || items.findLast((item) => item?.type === 'agentMessage' && item.text)?.text
    || '';
}

/** Collect completion notifications for turns started on one connection. */
export function createTurnCollector(client, threadId, timeoutMs = 24 * 60 * 60 * 1000) {
  const turns = new Map();
  const waiters = new Map();
  const modelReroutes = new Map();
  const settle = (turnId) => {
    const waiter = waiters.get(turnId);
    const turn = turns.get(turnId);
    if (!waiter || !turn?.completed) return;
    clearTimeout(waiter.timer);
    waiters.delete(turnId);
    const reroute = modelReroutes.get(turnId);
    if (waiter.expectedModel && reroute && reroute.toModel !== waiter.expectedModel) {
      const error = new Error(`App Server rerouted turn ${turnId} from requested model ${waiter.expectedModel} to ${reroute.toModel}`);
      error.modelReroute = reroute;
      waiter.reject(error);
    } else if (turn.status !== 'completed') {
      waiter.reject(new Error(turn.error?.message || `Turn ${turnId} ended ${turn.status}`));
    } else {
      waiter.resolve(turn.message || '');
    }
  };
  const removeNotification = client.onNotification((method, params) => {
    if (params?.threadId && params.threadId !== threadId) return;
    if (method === 'model/rerouted' && params?.turnId) {
      modelReroutes.set(params.turnId, {
        fromModel: params.fromModel || null,
        toModel: params.toModel || null,
        reason: params.reason || null,
      });
      settle(params.turnId);
    }
    if (method === 'item/completed' && params?.turnId) {
      const item = params.item;
      if (item?.type === 'agentMessage' && item.text && item.phase === 'final_answer') {
        const turn = turns.get(params.turnId) || {};
        turn.message = item.text;
        turns.set(params.turnId, turn);
      }
    }
    if (method === 'turn/completed' && params?.turn?.id) {
      const turn = turns.get(params.turn.id) || {};
      Object.assign(turn, { completed: true, status: params.turn.status, error: params.turn.error });
      turns.set(params.turn.id, turn);
      settle(params.turn.id);
    }
  });
  const removeConnection = client.onConnection((state, error) => {
    if (!['close', 'error'].includes(state)) return;
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error || new Error('App Server connection closed'));
    }
    waiters.clear();
  });
  return {
    wait(turnId, options = {}) {
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(turnId);
          reject(new Error(`Turn ${turnId} timed out`));
        }, timeoutMs);
        waiters.set(turnId, { resolve: resolvePromise, reject, timer, expectedModel: options.expectedModel || null });
        settle(turnId);
      });
    },
    close() {
      removeNotification();
      removeConnection();
      for (const waiter of waiters.values()) clearTimeout(waiter.timer);
      waiters.clear();
    },
  };
}

async function acceptCompletedTurn(path, session, turnId, message, dependencies) {
  const parseEvent = dependencies.parseEvent || parseGenericCallback;
  const event = parseEvent(message, { session, turnId });
  const queued = queueEvent(path, session, event);
  session.lastMessageSha256 = sha256(message);
  session.activeTurnId = null;
  session.state = event.terminal ? 'TERMINAL' : 'IDLE';
  delete session.lastFailure;
  session.updatedAt = now();
  writeJsonPrivate(path, session);
  return { event, duplicate: queued.duplicate };
}

/** Start an idle turn, await its callback, persist it, and attempt parent delivery. */
export async function runTurn(options, dependencies = {}) {
  const { path, session } = loadSession(options.stateFile);
  validateSessionBinding(session);
  if (!STARTABLE_STATES.has(session.state)) fail(`Session cannot run a turn from ${session.state}`);
  const connection = await connectedClient(session, options, dependencies);
  let collector;
  try {
    const isFreshThread = !session.threadId;
    await ensureThread(connection.client, session, () => persistSession(path, session), dependencies);
    collector = createTurnCollector(connection.client, session.threadId, options.timeoutMs);
    const started = await startIdleTurn(
      connection.client,
      session,
      options.prompt,
      () => persistSession(path, session),
      { threadEnsured: true, freshThread: isFreshThread },
      dependencies,
    );
    const turnId = started.turnId;
    session.state = 'RUNNING';
    delete session.lastFailure;
    session.updatedAt = now();
    writeJsonPrivate(path, session);
    const message = started.recovered && started.turn?.status === 'completed'
      ? finalMessage(started.turn)
      : await collector.wait(turnId, { expectedModel: session.options.model });
    const accepted = await acceptCompletedTurn(path, session, turnId, message, dependencies);
    const deliveries = options.deliver === false
      ? []
      : await deliverQueued(connection.client, path, session, dependencies.formatDelivery || formatGenericDelivery);
    return {
      sessionId: session.sessionId,
      threadId: session.threadId,
      turnId,
      event: accepted.event,
      duplicate: accepted.duplicate,
      deliveries,
    };
  } catch (error) {
    session.state = session.activeTurnId ? 'DISCONNECTED' : 'FAILED';
    session.lastFailure = error.message;
    session.updatedAt = now();
    writeJsonPrivate(path, session);
    throw error;
  } finally {
    collector?.close();
    if (connection.owned) connection.client.close();
  }
}

/** Return persisted and live status, including activeTurnId and canAcceptDirectInput. */
export async function statusSession(options, dependencies = {}) {
  const { session } = loadSession(options.stateFile);
  let bindingValid = true;
  let bindingError = null;
  try { validateSessionBinding(session); } catch (error) { bindingValid = false; bindingError = error.message; }
  if (!session.threadId) {
    return {
      schema: SESSION_SCHEMA,
      sessionId: session.sessionId,
      state: session.state,
      threadId: null,
      threadStatus: 'notStarted',
      authoritativeThreadStatus: 'notStarted',
      threadMaterialized: false,
      activeTurnId: null,
      canAcceptDirectInput: false,
      activeFlags: [],
      cwd: session.cwd,
      requestedModel: session.options.model || null,
      requestedEffort: session.options.effort || null,
      parent: session.parent ? { ...session.parent, generation: session.parent.generation || 1 } : null,
      bindingValid,
      bindingError,
      pendingDeliveries: session.events.filter((entry) => ['pending_retry', 'pending', 'delivering'].includes(entry.delivery.status)).length,
      pendingOperation: session.pendingOperation || null,
      lastFailure: session.lastFailure || null,
    };
  }
  const connection = await connectedClient(session, options, dependencies);
  try {
    const live = await readThreadState(connection.client, session.threadId);
    if (live.cwd && canonicalDirectory(live.cwd) !== session.cwd) fail('Live worker cwd does not match session cwd');
    const materialized = Boolean(session.threadMaterialized === true
      || Boolean(session.activeTurnId || live.activeTurnId || session.events?.length || session.lastEventId)
      || session.operationHistory?.some((operation) => operation.result?.turnId));
    return {
      schema: SESSION_SCHEMA,
      sessionId: session.sessionId,
      state: session.state,
      threadId: session.threadId,
      threadStatus: materialized ? live.status : 'awaitingFirstTurn',
      authoritativeThreadStatus: live.status,
      threadMaterialized: materialized,
      activeTurnId: live.activeTurnId,
      canAcceptDirectInput: live.canAcceptDirectInput,
      activeFlags: live.activeFlags,
      cwd: session.cwd,
      requestedModel: session.options.model || null,
      requestedEffort: session.options.effort || null,
      parent: session.parent ? { ...session.parent, generation: session.parent.generation || 1 } : null,
      bindingValid,
      bindingError,
      pendingDeliveries: session.events.filter((entry) => ['pending_retry', 'pending', 'delivering'].includes(entry.delivery.status)).length,
      pendingOperation: session.pendingOperation || null,
      lastFailure: session.lastFailure || null,
    };
  } finally {
    if (connection.owned) connection.client.close();
  }
}

/** Reconnect after client/daemon loss and recover the exact active turn or its callback. */
export async function reconcileSession(options, dependencies = {}) {
  const { path, session } = loadSession(options.stateFile);
  validateSessionBinding(session);
  if (!session.threadId && session.pendingOperation?.kind !== 'thread_start') fail('Worker thread has not started');
  const connection = await connectedClient(session, options, dependencies);
  try {
    if (session.pendingOperation?.kind === 'thread_start') {
      await ensureThread(connection.client, session, () => persistSession(path, session), dependencies);
      session.state = 'AWAITING_FIRST_TURN';
      persistSession(path, session);
      return {
        action: 'awaiting_first_turn',
        sessionId: session.sessionId,
        threadId: session.threadId,
        threadMaterialized: false,
      };
    }
    if (session.pendingOperation?.kind === 'turn_start') {
      await recoverTurnStart(connection.client, session, () => persistSession(path, session));
    } else if (session.pendingOperation) {
      fail(`Session has ambiguous unresolved ${session.pendingOperation.kind} operation`);
    }
    const read = await connection.client.request('thread/read', {
      threadId: session.threadId,
      includeTurns: true,
    });
    assertThreadBinding(read?.thread, session);
    const turns = read.thread.turns || [];
    let activeTurnId = session.activeTurnId;
    if (!activeTurnId) activeTurnId = turns.find((turn) => turn.status === 'inProgress')?.id || null;
    if (!activeTurnId) {
      session.state = 'IDLE';
      session.updatedAt = now();
      writeJsonPrivate(path, session);
      const deliveries = await deliverQueued(connection.client, path, session, dependencies.formatDelivery || formatGenericDelivery);
      return { action: 'idle', sessionId: session.sessionId, threadId: session.threadId, deliveries };
    }
    const turn = turns.find((candidate) => candidate.id === activeTurnId);
    if (!turn) fail(`Turn ${activeTurnId} is absent from worker history`);
    session.activeTurnId = activeTurnId;
    if (turn.status === 'inProgress') {
      session.state = 'RUNNING';
      delete session.lastFailure;
      session.updatedAt = now();
      writeJsonPrivate(path, session);
      return { action: 'still_running', sessionId: session.sessionId, threadId: session.threadId, turnId: activeTurnId };
    }
    if (turn.status !== 'completed') {
      session.state = turn.status === 'interrupted' ? 'INTERRUPTED' : 'FAILED';
      session.lastFailure = turn.error?.message || `Turn ${activeTurnId} ended ${turn.status}`;
      session.activeTurnId = null;
      session.updatedAt = now();
      writeJsonPrivate(path, session);
      return { action: 'turn_not_completed', status: turn.status, failure: session.lastFailure };
    }
    const accepted = await acceptCompletedTurn(path, session, activeTurnId, finalMessage(turn), dependencies);
    const deliveries = await deliverQueued(connection.client, path, session, dependencies.formatDelivery || formatGenericDelivery);
    return {
      action: accepted.duplicate ? 'already_reconciled' : 'callback_recovered',
      sessionId: session.sessionId,
      threadId: session.threadId,
      turnId: activeTurnId,
      event: accepted.event,
      deliveries,
    };
  } catch (error) {
    if (session.activeTurnId) session.state = 'DISCONNECTED';
    session.lastFailure = error.message;
    session.updatedAt = now();
    writeJsonPrivate(path, session);
    throw error;
  } finally {
    if (connection.owned) connection.client.close();
  }
}

/** Retry all undelivered events against the exact parent thread/cwd binding. */
export async function deliverPendingEvents(options, dependencies = {}) {
  const { path, session } = loadSession(options.stateFile);
  validateSessionBinding(session);
  if (!session.parent) fail('Session has no parent thread binding');
  const connection = await connectedClient(session, options, dependencies);
  try {
    const deliveries = await deliverQueued(connection.client, path, session, dependencies.formatDelivery || formatGenericDelivery);
    if (deliveries.some((entry) => entry.delivery.status !== 'delivered')) {
      fail('One or more parent event deliveries remain pending');
    }
    return { sessionId: session.sessionId, deliveries };
  } finally {
    if (connection.owned) connection.client.close();
  }
}

/** Probe managed daemon transport and the required cwd/turn protocol shapes. */
export async function probe(options = {}, dependencies = {}) {
  const codex = options.codex || 'codex';
  const daemon = options.socket
    ? { status: 'external_socket', socketPath: realpathSync(options.socket) }
    : (dependencies.managedDaemon || managedDaemon)({ codex });
  const directory = mkdtempSync(resolve(tmpdir(), 'native-app-server-orchestrator-schema-'));
  try {
    execFileSync(codex, ['app-server', 'generate-json-schema', '--experimental', '--out', directory], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const schemaPath = resolve(directory, 'ClientRequest.json');
    const schemaData = readFileSync(schemaPath);
    const schema = JSON.parse(schemaData);
    for (const name of ['ThreadStartParams', 'ThreadResumeParams', 'TurnStartParams', 'TurnSteerParams']) {
      if (!schema.definitions?.[name]) fail(`Installed App Server schema lacks ${name}`);
    }
    for (const name of ['ThreadStartParams', 'ThreadResumeParams', 'TurnStartParams']) {
      if (!schema.definitions[name].properties?.cwd) fail(`Installed App Server schema lacks ${name}.cwd`);
    }
    for (const name of ['ThreadStartParams', 'ThreadResumeParams', 'TurnStartParams']) {
      if (!schema.definitions[name].properties?.model) fail(`Installed App Server schema lacks ${name}.model`);
    }
    if (schema.definitions.TurnSteerParams.properties?.model) {
      fail('Installed App Server schema unexpectedly allows TurnSteerParams.model');
    }
    if (!schema.definitions.TurnStartParams.properties?.effort) {
      fail('Installed App Server schema lacks TurnStartParams.effort');
    }
    for (const field of ['threadId', 'expectedTurnId', 'input']) {
      if (!schema.definitions.TurnSteerParams.required?.includes(field)) {
        fail(`Installed App Server schema lacks required TurnSteerParams.${field}`);
      }
    }
    const client = dependencies.client || new AppServerClient({
      transport: options.transport || 'proxy',
      codex,
      socket: daemon.socketPath,
    });
    try {
      await (dependencies.initializeClient || initializeClient)(client);
    } finally {
      if (!dependencies.client) client.close();
    }
    return {
      schema: SESSION_SCHEMA,
      daemon,
      transport: options.transport || 'proxy',
      protocolSchemaSha256: sha256(schemaData),
      cwdBoundStartResume: true,
      cwdBoundTurns: true,
      modelBindingField: 'model',
      modelBoundStartResume: true,
      modelBoundTurns: true,
      turnSteerModelOverride: false,
      effortBindingField: 'effort',
      turnStartEffort: true,
      liveStatus: true,
      liveSteering: true,
      durableReconciliation: true,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--skip-delivery') {
      args.skipDelivery = true;
      continue;
    }
    if (!argument.startsWith('--')) fail(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${argument}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function required(args, key) {
  if (!args[key]) fail(`Missing --${key}`);
  return args[key];
}

function commandOptions(args) {
  return {
    stateFile: args.state,
    socket: args.socket,
    codex: args.codex,
    transport: args.transport,
  };
}

function promptFromArgs(args) {
  return readFileSync(resolve(required(args, 'prompt-file')), 'utf8');
}

function usage() {
  return [
    'Usage: native-app-server-orchestrator.mjs <command> [options]',
    '',
    'Commands:',
    '  daemon       Idempotently start the managed daemon and print its socket metadata',
    '  probe        Verify daemon transport and required App Server protocol shapes',
    '  init         Create durable state: --state PATH --cwd DIR [--parent-thread-id ID --parent-cwd DIR --parent-generation N]',
    '  thread-start Start or exactly resume the cwd-bound thread',
    '  turn-start   Start an idle turn without waiting: --prompt-file PATH',
    '  run          Start an idle turn, wait for its event, persist, and deliver it',
    '  send         Steer an active turn or start an idle turn: --prompt-file PATH',
    '  steer        Steer an active direct-input-capable turn: --prompt-file PATH',
    '  status       Read persisted and live thread/turn status',
    '  thread-status Inspect one existing exact thread/cwd without resuming it',
    '  verify-absent-turn Prove a turn is absent and its exact thread/cwd is idle',
    '  recover-unaccepted-turn-start Clear a turn/start fence after proving no new turn was accepted',
    '  rebind-parent Move an idle session callback binding to a new parent generation',
    '  reconcile    Reconnect and recover an in-progress or completed turn',
    '  deliver      Retry pending event delivery to the parent thread',
    '',
    'Connection options: --codex PATH --socket PATH --transport proxy|direct|desktop',
    'Session policy options (init): --approval-policy VALUE --sandbox VALUE --service-name VALUE --model VALUE --effort VALUE',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || ['help', '--help', '-h'].includes(args.command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  let result;
  if (args.command === 'daemon') result = managedDaemon({ codex: args.codex || 'codex' });
  else if (args.command === 'probe') result = await probe({ codex: args.codex, socket: args.socket, transport: args.transport });
  else if (args.command === 'init') result = initializeSession({
    stateFile: required(args, 'state'),
    cwd: required(args, 'cwd'),
    parentThreadId: args['parent-thread-id'],
    parentCwd: args['parent-cwd'],
    parentGeneration: args['parent-generation'] ? Number(args['parent-generation']) : undefined,
    eventsFile: args['events-file'],
    sessionId: args['session-id'],
    codex: args.codex,
    transport: args.transport,
    approvalPolicy: args['approval-policy'],
    sandbox: args.sandbox,
    serviceName: args['service-name'],
    model: args.model,
    effort: args.effort,
  });
  else if (args.command === 'thread-status') result = await inspectThread({
    threadId: required(args, 'thread-id'),
    cwd: required(args, 'cwd'),
    socket: args.socket,
    codex: args.codex,
    transport: args.transport,
  });
  else if (args.command === 'verify-absent-turn') result = await verifyIdleAbsentTurn({
    threadId: required(args, 'thread-id'),
    turnId: required(args, 'turn-id'),
    cwd: required(args, 'cwd'),
    socket: args.socket,
    codex: args.codex,
    transport: args.transport,
  });
  else {
    const options = { ...commandOptions(args), stateFile: required(args, 'state') };
    if (args.command === 'thread-start') result = await startThread(options);
    else if (args.command === 'turn-start') result = await startTurn({ ...options, prompt: promptFromArgs(args) });
    else if (args.command === 'run') result = await runTurn({
      ...options,
      prompt: promptFromArgs(args),
      timeoutMs: args['timeout-seconds'] ? Number(args['timeout-seconds']) * 1_000 : undefined,
      deliver: !args.skipDelivery,
    });
    else if (args.command === 'send') result = await sendSessionInput({
      ...options,
      prompt: promptFromArgs(args),
      waitSeconds: args['wait-seconds'] ? Number(args['wait-seconds']) : undefined,
    });
    else if (args.command === 'steer') result = await steerSession({ ...options, prompt: promptFromArgs(args) });
    else if (args.command === 'status') result = await statusSession(options);
    else if (args.command === 'recover-unaccepted-turn-start') result = await recoverUnacceptedTurnStart(options);
    else if (args.command === 'rebind-parent') result = await rebindParent({
      ...options,
      expectedParentThreadId: required(args, 'expected-parent-thread-id'),
      expectedParentCwd: required(args, 'expected-parent-cwd'),
      expectedParentGeneration: Number(required(args, 'expected-parent-generation')),
      parentThreadId: required(args, 'parent-thread-id'),
      parentCwd: required(args, 'parent-cwd'),
    });
    else if (args.command === 'reconcile') result = await reconcileSession(options);
    else if (args.command === 'deliver') result = await deliverPendingEvents(options);
    else fail(`Unknown command: ${args.command}\n\n${usage()}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
