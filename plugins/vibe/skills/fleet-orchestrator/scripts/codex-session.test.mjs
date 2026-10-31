import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  lastMessages, loadState, nextState, ORCHESTRATOR_PROVENANCE, parseCli, run, saveState,
} from './codex-session.mjs';
import { FLEET_SECTION_NAME, WORKER_THREAD_SOURCE } from '../../codex-fleet-monitor/scripts/thread-sidebar.mjs';

// A writer recorded its parent orchestrator's capacity stop as a human ruling (2026-10-26); every turn and steer
// this client sends says who it is from.
const SENT = `$vibe resume the session for the ticket.\n\n${ORCHESTRATOR_PROVENANCE}`;

/** Records each request and answers from `replies[method]` (a value or a function of params). */
function stubClient(replies) {
  const calls = [];
  return {
    calls,
    request: async (method, params) => {
      calls.push({ method, params });
      const reply = replies[method];
      if (reply === undefined) throw new Error(`unexpected ${method}`);
      return typeof reply === 'function' ? reply(params) : reply;
    },
  };
}

/** An App Server with no "Fleet workers" section yet. */
const SIDEBAR = {
  'thread/name/set': {},
  'threadSection/list': { data: [{ id: 'S-pinned', name: 'Pinned' }], nextCursor: null },
  'threadSection/create': { section: { id: 'S-new', name: FLEET_SECTION_NAME } },
  'thread/section/move': {},
};

function workDir() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-session-'));
  const promptFile = join(dir, 'prompt.md');
  writeFileSync(promptFile, '$vibe resume the session for the ticket.\n');
  return { dir, promptFile };
}

test('parseCli reads each command and its options', () => {
  assert.deepEqual(parseCli(['turn', 'state', 'w1', '--prompt-file', 'p.md', '--cwd', 'wt', '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high', '--sandbox', 'workspace-write']), {
    command: 'turn', stateDir: 'state', name: 'w1', promptFile: 'p.md', cwd: resolve('wt'), ticket: 'ISS-1',
    reason: undefined, model: 'm', effort: 'high', sandbox: 'workspace-write', count: 1,
  });
  assert.equal(parseCli(['end', 'state', 'w1', '--reason', 'merged']).reason, 'merged');
  assert.equal(parseCli(['steer', 'state', 'w1', '--prompt-file', 'p.md']).command, 'steer');
  assert.equal(parseCli(['last', 'state', 'w1', '--count', '3']).count, 3);
  assert.equal(parseCli(['last', 'state', 'w1']).count, 1);
});

test('parseCli rejects bad commands, names and option combinations', () => {
  const rejects = (argv, pattern) => assert.throws(() => parseCli(argv), pattern);
  rejects(['start', 'state', 'w1'], /command must be one of/);
  rejects(['turn', 'state'], /expected <stateDir> <name>/);
  rejects(['last', 'state', 'w1', 'extra'], /expected <stateDir> <name>/);
  rejects(['last', 'state', '../w1'], /name must be/);
  rejects(['turn', 'state', 'w1'], /turn needs --prompt-file/);
  rejects(['steer', 'state', 'w1'], /steer needs --prompt-file/);
  rejects(['steer', 'state', 'w1', '--prompt-file', 'p', '--cwd', 'x'], /--cwd applies to turn only/);
  rejects(['last', 'state', 'w1', '--effort', 'high'], /--effort applies to turn only/);
  rejects(['turn', 'state', 'w1', '--prompt-file', 'p', '--count', '2'], /--count applies to last only/);
  rejects(['turn', 'state', 'w1', '--prompt-file', 'p', '--effort', 'very high'], /effort must be/);
  rejects(['turn', 'state', 'w1', '--prompt-file', 'p', '--sandbox', 'open'], /sandbox must be one of/);
  rejects(['last', 'state', 'w1', '--count', '0'], /count must be a positive integer/);
  rejects(['last', 'state', 'w1', '--count', '1.5'], /count must be a positive integer/);
  rejects(['last', 'state', 'w1', '--bogus'], /Unknown option/);
  rejects(['steer', 'state', 'w1', '--prompt-file', 'p', '--ticket', 'ISS-1'], /--ticket applies to turn only/);
  rejects(['end', 'state', 'w1'], /end needs --reason stopped\|merged/);
  rejects(['end', 'state', 'w1', '--reason', 'done'], /end needs --reason/);
  rejects(['end', 'state', 'w1', '--reason', 'merged', '--prompt-file', 'p'], /--prompt-file applies to turn and steer only/);
  rejects(['turn', 'state', 'w1', '--prompt-file', 'p', '--reason', 'merged'], /--reason applies to end only/);
});

test('state files round trip, are absent until saved, and must name a thread and cwd', () => {
  const { dir } = workDir();
  const stateDir = join(dir, 'sessions');
  assert.equal(loadState(stateDir, 'w1'), null);
  const state = { threadId: 'T1', cwd: '/wt', effort: 'high', turns: [] };
  saveState(stateDir, 'w1', state);
  assert.deepEqual(loadState(stateDir, 'w1'), state);
  assert.deepEqual(readdirSync(stateDir), ['w1.json']);
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ cwd: '/wt' }));
  assert.throws(() => loadState(dir, 'bad'), /has no threadId and cwd/);
});

test('nextState binds a session to its first cwd and keeps model and effort between turns', () => {
  assert.throws(() => nextState(null, { effort: 'high' }), /a new session needs --cwd/);
  assert.throws(() => nextState(null, { cwd: '/wt', ticket: 'ISS-1' }), /a new session needs --effort/);
  assert.throws(() => nextState(null, { cwd: '/wt', ticket: 'ISS-1', effort: 'high' }), /a new session needs --model/);
  assert.deepEqual(nextState(null, { cwd: '/wt', ticket: 'ISS-1', model: 'm1', effort: 'high' }), {
    threadId: undefined, cwd: '/wt', model: 'm1', effort: 'high', sandbox: undefined, turns: [], ticket: 'ISS-1',
  });
  assert.throws(() => nextState({ threadId: 'T1', cwd: '/wt', ticket: 'ISS-1', turns: [] }, { ticket: 'ISS-2' }), /session is for ISS-1/);
  // A single-use run, or an older caller, has no ticket; the session still starts.
  assert.deepEqual(nextState(null, { cwd: '/wt', model: 'm1', effort: 'high' }), {
    threadId: undefined, cwd: '/wt', model: 'm1', effort: 'high', sandbox: undefined, turns: [],
  });
  const saved = { threadId: 'T1', cwd: '/wt', model: 'm1', effort: 'medium', sandbox: 'workspace-write', turns: [{ turnId: 'u1' }] };
  assert.deepEqual(nextState(saved, { cwd: '/wt' }), saved);
  assert.equal(nextState(saved, { model: 'm2' }).model, 'm2');
  assert.throws(() => nextState(saved, { cwd: '/other' }), /bound to \/wt/);
});

test('turn on a new session starts a thread, names it, moves it into Fleet workers, starts the turn and saves the state', async () => {
  const { dir, promptFile } = workDir();
  const client = stubClient({ ...SIDEBAR, 'thread/start': { thread: { id: 'T1' } }, 'turn/start': { turn: { id: 'U1' } } });
  const line = await run(client, parseCli(['turn', dir, 'w1', '--prompt-file', promptFile, '--cwd', '/wt', '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']));
  assert.equal(line, 'w1 turn T1 U1');
  assert.deepEqual(client.calls, [
    { method: 'thread/start', params: { cwd: '/wt', model: 'm', approvalPolicy: 'never', threadSource: WORKER_THREAD_SOURCE } },
    { method: 'thread/name/set', params: { threadId: 'T1', name: 'w1 · ISS-1' } },
    { method: 'threadSection/list', params: {} },
    { method: 'threadSection/create', params: { name: FLEET_SECTION_NAME } },
    { method: 'thread/section/move', params: { threadId: 'T1', sectionId: 'S-new' } },
    {
      method: 'turn/start',
      params: {
        threadId: 'T1', input: [{ type: 'text', text: SENT, text_elements: [] }],
        cwd: '/wt', model: 'm', effort: 'high', approvalPolicy: 'never',
      },
    },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'w1.json'), 'utf8')), {
    threadId: 'T1', cwd: '/wt', model: 'm', effort: 'high', turns: [{ turnId: 'U1', kind: 'turn', promptFile }], ticket: 'ISS-1',
  });
});

test('turn on a saved session resumes its thread with the saved options', async () => {
  const { dir, promptFile } = workDir();
  saveState(dir, 'w1', { threadId: 'T1', cwd: '/wt', effort: 'medium', sandbox: 'danger-full-access', turns: [] });
  const client = stubClient({ 'thread/resume': {}, 'turn/start': { turn: { id: 'U2' } } });
  assert.equal(await run(client, parseCli(['turn', dir, 'w1', '--prompt-file', promptFile])), 'w1 turn T1 U2');
  assert.deepEqual(client.calls[0], {
    method: 'thread/resume',
    params: { threadId: 'T1', cwd: '/wt', sandbox: 'danger-full-access', approvalPolicy: 'never' },
  });
  assert.equal(client.calls[1].params.effort, 'medium');
  assert.deepEqual(client.calls[1].params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(loadState(dir, 'w1').turns.length, 1);
});

test('a failed turn/start leaves the state file unchanged', async () => {
  const { dir, promptFile } = workDir();
  const client = stubClient({ ...SIDEBAR, 'thread/start': { thread: { id: 'T1' } }, 'turn/start': {} });
  await assert.rejects(run(client, parseCli(['turn', dir, 'w1', '--prompt-file', promptFile, '--cwd', '/wt', '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'])), /no turn id/);
  assert.equal(loadState(dir, 'w1'), null);
});

test('an empty prompt file is refused before any request', async () => {
  const { dir } = workDir();
  const empty = join(dir, 'empty.md');
  writeFileSync(empty, '  \n');
  const client = stubClient({});
  await assert.rejects(run(client, parseCli(['turn', dir, 'w1', '--prompt-file', empty, '--cwd', '/wt'])), /is empty/);
  assert.deepEqual(client.calls, []);
});

test('steer targets the active turn and refuses when no turn is running', async () => {
  const { dir, promptFile } = workDir();
  saveState(dir, 'w1', { threadId: 'T1', cwd: '/wt', turns: [] });
  const active = stubClient({
    'thread/read': { thread: { turns: [{ id: 'U1', status: 'completed' }, { id: 'U2', status: 'inProgress' }] } },
    'turn/steer': { turnId: 'U2' },
  });
  assert.equal(await run(active, parseCli(['steer', dir, 'w1', '--prompt-file', promptFile])), 'w1 steer T1 U2');
  assert.deepEqual(active.calls[1].params, {
    threadId: 'T1', expectedTurnId: 'U2', input: [{ type: 'text', text: SENT, text_elements: [] }],
  });
  const idle = stubClient({ 'thread/read': { thread: { turns: [{ id: 'U1', status: 'completed' }] } } });
  await assert.rejects(run(idle, parseCli(['steer', dir, 'w1', '--prompt-file', promptFile])), /last turn is completed/);
  await assert.rejects(run(idle, parseCli(['steer', dir, 'none', '--prompt-file', promptFile])), /no session none/);
});

test('last prints the monitor status line and the newest agent messages across turns', async () => {
  const thread = {
    turns: [
      { id: 'U1', status: 'completed', items: [{ type: 'agentMessage', text: 'one' }, { type: 'userMessage' }] },
      { id: 'U2', status: 'failed', error: { message: 'usage limit' }, items: [{ type: 'agentMessage', text: 'two' }, { type: 'agentMessage', text: 'three' }] },
    ],
  };
  assert.equal(lastMessages('w1', thread, 2), 'w1 failed 2 LIMIT\n--- turn U2 failed\ntwo\n--- turn U2 failed\nthree');
  assert.equal(lastMessages('w1', thread, 9).split('\n--- ').length, 4);
  assert.equal(lastMessages('w1', { turns: [] }, 1), 'w1 none 0 -');
  const { dir } = workDir();
  saveState(dir, 'w1', { threadId: 'T1', cwd: '/wt', turns: [] });
  const client = stubClient({ 'thread/read': { thread } });
  assert.equal(await run(client, parseCli(['last', dir, 'w1'])), 'w1 failed 2 LIMIT\n--- turn U2 failed\nthree');
  assert.deepEqual(client.calls[0].params, { threadId: 'T1', includeTurns: true });
});

test('a new session refuses a prompt that does not start with $vibe; a saved one takes any prompt', async () => {
  const { dir } = workDir();
  const plain = join(dir, 'plain.md');
  writeFileSync(plain, 'Fix the failing check.\n');
  const client = stubClient({ 'thread/resume': {}, 'turn/start': { turn: { id: 'U1' } } });
  await assert.rejects(run(client, parseCli(['turn', dir, 'w1', '--prompt-file', plain, '--cwd', '/wt', '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'])), /must start with \$vibe/);
  assert.deepEqual(client.calls, []);
  saveState(dir, 'w1', { threadId: 'T1', cwd: '/wt', effort: 'high', turns: [] });
  assert.equal(await run(client, parseCli(['turn', dir, 'w1', '--prompt-file', plain])), 'w1 turn T1 U1');
});

test('a prompt carrying another writer\'s Done: claims needs a Re-verify: line (takeover claims)', async () => {
  const { dir } = workDir();
  const handover = join(dir, 'resume.md');
  writeFileSync(handover, '$vibe resume the vibe session for ISS-1.\nDone: threads fixed, migration ready\nLeft: QA\n');
  const client = stubClient({ ...SIDEBAR, 'thread/start': { thread: { id: 'T1' } }, 'turn/start': { turn: { id: 'U1' } } });
  await assert.rejects(run(client, parseCli(['turn', dir, 'w1', '--prompt-file', handover, '--cwd', '/wt', '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'])), /no "Re-verify:" line/);
  assert.deepEqual(client.calls, []);
  writeFileSync(handover, '$vibe resume the vibe session for ISS-1.\nDone: threads fixed, migration ready\nRe-verify: each Done claim with a test or a measurement before building on it\nLeft: QA\n');
  assert.equal(await run(client, parseCli(['turn', dir, 'w1', '--prompt-file', handover, '--cwd', '/wt', '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'])), 'w1 turn T1 U1');
});

const NEW_TURN = (dir, promptFile) => parseCli(['turn', dir, 'w1', '--prompt-file', promptFile, '--cwd', '/wt', '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);

test('a new thread joins the existing Fleet workers section, the oldest when there are several', async () => {
  const { dir, promptFile } = workDir();
  const client = stubClient({
    ...SIDEBAR,
    'threadSection/list': (params) => (params.cursor
      ? { data: [{ id: 'S-1', name: FLEET_SECTION_NAME }], nextCursor: null }
      : { data: [{ id: 'S-2', name: FLEET_SECTION_NAME }], nextCursor: 'c2' }),
    'thread/start': { thread: { id: 'T1' } },
    'turn/start': { turn: { id: 'U1' } },
  });
  await run(client, NEW_TURN(dir, promptFile));
  assert.deepEqual(client.calls.filter((call) => call.method.startsWith('threadSection/')).map((call) => call.params), [{}, { cursor: 'c2' }]);
  assert.deepEqual(client.calls.find((call) => call.method === 'thread/section/move').params, { threadId: 'T1', sectionId: 'S-1' });
});

test('an App Server without naming or sections still starts the writer and warns', async () => {
  const { dir, promptFile } = workDir();
  const client = stubClient({ 'thread/start': { thread: { id: 'T1' } }, 'turn/start': { turn: { id: 'U1' } } });
  const warnings = [];
  assert.equal(await run(client, NEW_TURN(dir, promptFile), { warn: (text) => warnings.push(text) }), 'w1 turn T1 U1');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /thread\/name\/set failed/);
  assert.match(warnings[1], /Fleet workers/);
  assert.equal(loadState(dir, 'w1').threadId, 'T1');
});

test('a resumed session is never renamed or moved', async () => {
  const { dir, promptFile } = workDir();
  saveState(dir, 'w1', { threadId: 'T1', cwd: '/wt', effort: 'high', turns: [] });
  const client = stubClient({ ...SIDEBAR, 'thread/resume': {}, 'turn/start': { turn: { id: 'U2' } } });
  await run(client, parseCli(['turn', dir, 'w1', '--prompt-file', promptFile]));
  assert.deepEqual(client.calls.map((call) => call.method), ['thread/resume', 'turn/start']);
});

// The marker goes on the worker's thread/start only. The orchestrator's own thread is never started here, and a
// flagged worker resumes and takes turns like any other thread (verified against App Server 0.163 to 0.165).
test('only a new worker thread carries the hidden marker; resume and turns on a flagged worker are unchanged', async () => {
  const { dir, promptFile } = workDir();
  const client = stubClient({ ...SIDEBAR, 'thread/start': { thread: { id: 'T1' } }, 'thread/resume': {}, 'turn/start': { turn: { id: 'U1' } } });
  await run(client, parseCli(['turn', dir, 'w1', '--prompt-file', promptFile, '--cwd', '/wt', '--model', 'm', '--effort', 'high']));
  await run(client, parseCli(['turn', dir, 'w1', '--prompt-file', promptFile]));
  const flagged = client.calls.filter((call) => call.params?.threadSource !== undefined);
  assert.deepEqual(flagged.map((call) => [call.method, call.params.threadSource]), [['thread/start', WORKER_THREAD_SOURCE]]);
  assert.deepEqual(client.calls.slice(-2).map((call) => call.method), ['thread/resume', 'turn/start']);
  assert.equal(loadState(dir, 'w1').turns.length, 2);
});

/** A thread whose newest turn has `status`, read the way liveness.mjs reads it. */
function endClient(status, extra = {}) {
  return stubClient({
    'thread/read': { thread: { id: 'T1', status: { type: status === 'inProgress' ? 'active' : 'idle' } } },
    'thread/turns/list': { data: [{ id: 'U1', status }] },
    ...extra,
  });
}

test('end refuses a writer with a running turn and records nothing', async () => {
  const { dir } = workDir();
  const saved = { threadId: 'T1', cwd: '/wt', ticket: 'ISS-1', turns: [] };
  saveState(dir, 'w1', saved);
  const client = endClient('inProgress', { 'thread/archive': {} });
  await assert.rejects(run(client, parseCli(['end', dir, 'w1', '--reason', 'merged'])), /live writer is never archived/);
  assert.equal(client.calls.some((call) => call.method === 'thread/archive'), false);
  assert.deepEqual(loadState(dir, 'w1'), saved);
});

test('end records the stop or merge in the state file before it archives the thread', async () => {
  const { dir } = workDir();
  saveState(dir, 'w1', { threadId: 'T1', cwd: '/wt', ticket: 'ISS-1', turns: [] });
  let recordedAtArchive;
  const client = endClient('completed', { 'thread/archive': () => { recordedAtArchive = loadState(dir, 'w1').ended; return {}; } });
  assert.equal(await run(client, parseCli(['end', dir, 'w1', '--reason', 'merged'])), 'w1 ended T1 merged');
  assert.equal(recordedAtArchive?.reason, 'merged');
  assert.deepEqual(client.calls.find((call) => call.method === 'thread/archive').params, { threadId: 'T1' });
  const state = loadState(dir, 'w1');
  assert.equal(state.ended.reason, 'merged');
  assert.ok(state.archivedAt);
  const again = endClient('completed', { 'thread/archive': {} });
  assert.equal(await run(again, parseCli(['end', dir, 'w1', '--reason', 'stopped'])), 'w1 ended T1 merged');
  assert.deepEqual(again.calls, []);
});

test('an archive that fails keeps the recorded end, and end archives on the next run', async () => {
  const { dir } = workDir();
  saveState(dir, 'w1', { threadId: 'T1', cwd: '/wt', ticket: 'ISS-1', turns: [] });
  const failing = endClient('completed', { 'thread/archive': () => { throw new Error('daemon gone'); } });
  await assert.rejects(run(failing, parseCli(['end', dir, 'w1', '--reason', 'stopped'])), /daemon gone/);
  assert.equal(loadState(dir, 'w1').ended.reason, 'stopped');
  assert.equal(loadState(dir, 'w1').archivedAt, undefined);
  const retry = endClient('completed', { 'thread/archive': {} });
  await run(retry, parseCli(['end', dir, 'w1', '--reason', 'stopped']));
  assert.deepEqual(retry.calls.map((call) => call.method), ['thread/archive']);
});

test('an ended session refuses steer, and turn unarchives the thread before resuming it', async () => {
  const { dir, promptFile } = workDir();
  saveState(dir, 'w1', { threadId: 'T1', cwd: '/wt', ticket: 'ISS-1', effort: 'high', turns: [], ended: { reason: 'merged', at: 't' }, archivedAt: 't' });
  await assert.rejects(run(stubClient({}), parseCli(['steer', dir, 'w1', '--prompt-file', promptFile])), /session ended \(merged\)/);
  const client = stubClient({ 'thread/unarchive': {}, 'thread/resume': {}, 'turn/start': { turn: { id: 'U2' } } });
  assert.equal(await run(client, parseCli(['turn', dir, 'w1', '--prompt-file', promptFile])), 'w1 turn T1 U2');
  assert.deepEqual(client.calls.map((call) => call.method), ['thread/unarchive', 'thread/resume', 'turn/start']);
  const state = loadState(dir, 'w1');
  assert.equal(state.ended, undefined);
  assert.equal(state.archivedAt, undefined);
});

test('a new session without --ticket starts and its thread is named by the session name alone', async () => {
  const { dir, promptFile } = workDir();
  const client = stubClient({ ...SIDEBAR, 'thread/start': { thread: { id: 'T1' } }, 'turn/start': { turn: { id: 'U1' } } });
  const line = await run(client, parseCli(['turn', dir, 'w1', '--prompt-file', promptFile, '--cwd', '/wt', '--model', 'm', '--effort', 'high']));
  assert.equal(line, 'w1 turn T1 U1');
  assert.deepEqual(client.calls.find((call) => call.method === 'thread/name/set').params, { threadId: 'T1', name: 'w1' });
  assert.ok(client.calls.some((call) => call.method === 'thread/section/move'));
  assert.equal(loadState(dir, 'w1').ticket, undefined);
});
