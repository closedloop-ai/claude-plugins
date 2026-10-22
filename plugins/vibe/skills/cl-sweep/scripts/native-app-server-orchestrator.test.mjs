import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { initializeSession, startTurn } from './native-app-server-orchestrator.mjs';

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
