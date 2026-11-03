import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { endSession, initializeSession, startThread, startTurn } from './native-app-server-orchestrator.mjs';
import { FLEET_SECTION_NAME, WORKER_THREAD_SOURCE } from '../../codex-fleet-monitor/scripts/thread-sidebar.mjs';

class FakeClient {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }

  async request(method, params, timeoutMs) {
    this.calls.push({ method, params, timeoutMs });
    return this.handler(method, params, this.calls);
  }

  async connect() {}
  notify() {}
  close() {}
  onNotification() { return () => {}; }
  onConnection() { return () => {}; }
}

const initialized = { initializeClient: async () => {} };
/** The live thread read the core skill would make, answered from the fake thread instead. */
const liveRead = (root, status) => ({ readThreadState: async () => ({ cwd: root, status, activeTurnId: null }) });

function staleRunningSession(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'native-orchestrator-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateFile = resolve(root, 'state', 'worker.json');
  const session = initializeSession({ stateFile, cwd: root, effort: 'medium' });
  Object.assign(session, { threadId: 'thread-1', threadMaterialized: true, state: 'RUNNING', activeTurnId: null });
  writeFileSync(stateFile, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  return { root, stateFile };
}

function thread(root, status, turns) {
  return (method, params) => {
    if (method === 'thread/resume') return { thread: { id: 'thread-1', cwd: root, status: { type: status } } };
    if (method === 'thread/read') return { thread: { id: 'thread-1', cwd: root, status: { type: status }, turns: params.includeTurns ? turns : undefined } };
    if (method === 'turn/start') return { turn: { id: 'turn-2' } };
    throw new Error(`Unexpected method ${method}`);
  };
}

test('turn-start on a RUNNING record whose thread is idle with no active turn reconciles and starts the turn', async (t) => {
  const { root, stateFile } = staleRunningSession(t);
  const client = new FakeClient(thread(root, 'idle', [{ id: 'turn-1', status: 'completed', items: [] }]));
  const started = await startTurn({ stateFile, prompt: 'next' }, { client, ...initialized, ...liveRead(root, 'idle') });
  assert.equal(started.turnId, 'turn-2');
  assert.ok(client.calls.some((call) => call.method === 'turn/start'));
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(saved.state, 'RUNNING');
  assert.equal(saved.activeTurnId, 'turn-2');
});

test('turn-start still refuses a RUNNING record whose thread really has a turn in progress', async (t) => {
  const { root, stateFile } = staleRunningSession(t);
  const client = new FakeClient(thread(root, 'active', [{ id: 'turn-1', status: 'inProgress', items: [] }]));
  await assert.rejects(startTurn({ stateFile, prompt: 'next' }, { client, ...initialized, ...liveRead(root, 'active') }), /cannot start a turn from RUNNING/);
  assert.ok(!client.calls.some((call) => call.method === 'turn/start'), 'no second turn is started');
});

function freshSession(t, extra = {}) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'native-orchestrator-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateFile = resolve(root, 'state', 'worker.json');
  initializeSession({ stateFile, cwd: root, effort: 'medium', ...extra });
  return { root, stateFile };
}

/** A daemon with no "Fleet workers" section yet; `sidebar: false` models one without naming or sections. */
function starting(root, { sidebar = true } = {}) {
  return (method) => {
    if (method === 'thread/list') return { data: [] };
    if (method === 'thread/start') return { thread: { id: 'thread-1', cwd: root } };
    if (!sidebar) throw new Error(`unknown variant \`${method}\``);
    if (method === 'thread/name/set' || method === 'thread/section/move') return {};
    if (method === 'threadSection/list') return { data: [], nextCursor: null };
    if (method === 'threadSection/create') return { section: { id: 'section-1', name: FLEET_SECTION_NAME } };
    throw new Error(`Unexpected method ${method}`);
  };
}

// ISS-13279: an unnamed worker thread is a sidebar chat titled by its prompt in the person's Codex app.
test('thread-start names a new thread and moves it into Fleet workers right after thread/start', async (t) => {
  const { root, stateFile } = freshSession(t, { threadName: 'cl-sweep · ISS-7' });
  const client = new FakeClient(starting(root));
  const started = await startThread({ stateFile }, { client, ...initialized });
  assert.equal(started.threadId, 'thread-1');
  assert.deepEqual(client.calls.map((call) => call.method), [
    'thread/list', 'thread/start', 'thread/name/set', 'threadSection/list', 'threadSection/create', 'thread/section/move',
  ]);
  assert.equal(client.calls[1].params.threadSource, WORKER_THREAD_SOURCE);
  assert.deepEqual(client.calls[2].params, { threadId: 'thread-1', name: 'cl-sweep · ISS-7' });
  assert.deepEqual(client.calls[5].params, { threadId: 'thread-1', sectionId: 'section-1' });
});

test('thread-start without a thread name, or on a daemon without naming, still starts the thread', async (t) => {
  const plain = freshSession(t);
  const unnamed = new FakeClient(starting(plain.root));
  await startThread({ stateFile: plain.stateFile }, { client: unnamed, ...initialized });
  assert.deepEqual(unnamed.calls.map((call) => call.method), ['thread/list', 'thread/start']);
  const old = freshSession(t, { threadName: 'cl-sweep · ISS-8' });
  const started = await startThread({ stateFile: old.stateFile }, { client: new FakeClient(starting(old.root, { sidebar: false })), ...initialized });
  assert.equal(started.threadId, 'thread-1');
  assert.equal(started.labelWarnings.length, 2);
  assert.throws(() => initializeSession({ stateFile: resolve(old.root, 'other.json'), cwd: old.root, threadName: 'a\nb' }), /one non-empty line/);
});

function idleSession(t, extra = {}) {
  const { root, stateFile } = staleRunningSession(t);
  const session = JSON.parse(readFileSync(stateFile, 'utf8'));
  Object.assign(session, { state: 'IDLE', ...extra });
  writeFileSync(stateFile, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  return { root, stateFile };
}

function ending(root, turnStatus, onArchive = () => ({})) {
  return (method, params) => {
    if (method === 'thread/read') return { thread: { id: 'thread-1', cwd: root, status: { type: turnStatus === 'inProgress' ? 'active' : 'idle' } } };
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-1', status: turnStatus }] };
    if (method === 'thread/archive') return onArchive(params);
    throw new Error(`Unexpected method ${method}`);
  };
}

test('end records the stop or merge before it archives, and refuses a worker whose turn is running', async (t) => {
  const live = idleSession(t);
  const running = new FakeClient(ending(live.root, 'inProgress'));
  await assert.rejects(endSession({ stateFile: live.stateFile, reason: 'merged' }, { client: running, ...initialized }), /never archived/);
  assert.equal(JSON.parse(readFileSync(live.stateFile, 'utf8')).ended, undefined);
  assert.ok(!running.calls.some((call) => call.method === 'thread/archive'));
  const active = idleSession(t, { activeTurnId: 'turn-9' });
  await assert.rejects(endSession({ stateFile: active.stateFile, reason: 'stopped' }, { client: new FakeClient(ending(active.root, 'completed')), ...initialized }), /active or pending turn/);
  const done = idleSession(t);
  let recorded;
  const client = new FakeClient(ending(done.root, 'completed', () => { recorded = JSON.parse(readFileSync(done.stateFile, 'utf8')).ended; return {}; }));
  const result = await endSession({ stateFile: done.stateFile, reason: 'merged' }, { client, ...initialized });
  assert.equal(recorded?.reason, 'merged');
  assert.equal(result.ended.reason, 'merged');
  assert.ok(JSON.parse(readFileSync(done.stateFile, 'utf8')).archivedAt);
  const archives = client.calls.filter((call) => call.method === 'thread/archive').length;
  const again = await endSession({ stateFile: done.stateFile, reason: 'stopped' }, { client, ...initialized });
  assert.equal(again.ended.reason, 'merged', 'the first recorded end stands');
  assert.equal(client.calls.filter((call) => call.method === 'thread/archive').length, archives);
  await assert.rejects(endSession({ stateFile: done.stateFile, reason: 'done' }, { client, ...initialized }), /reason must be one of/);
});

test('a turn on an ended worker unarchives its thread before resuming it', async (t) => {
  const { root, stateFile } = idleSession(t, { ended: { reason: 'merged', at: 't' }, archivedAt: 't' });
  const client = new FakeClient((method, params) => {
    if (method === 'thread/unarchive') return { thread: { id: 'thread-1' } };
    return thread(root, 'idle', [{ id: 'turn-1', status: 'completed', items: [] }])(method, params);
  });
  const started = await startTurn({ stateFile, prompt: 'follow-up' }, { client, ...initialized, ...liveRead(root, 'idle') });
  assert.equal(started.turnId, 'turn-2');
  assert.ok(client.calls.every((call) => call.params?.threadSource === undefined), 'resume and turn never resend the marker');
  const methods = client.calls.map((call) => call.method);
  assert.ok(methods.indexOf('thread/unarchive') >= 0 && methods.indexOf('thread/unarchive') < methods.indexOf('thread/resume'), methods.join());
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(saved.ended, undefined);
  assert.equal(saved.archivedAt, undefined);
});
