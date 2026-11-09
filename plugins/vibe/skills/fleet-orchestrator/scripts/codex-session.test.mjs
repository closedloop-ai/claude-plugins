import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  assertVibeSession, lastMessages, loadState, nextState, ORCHESTRATOR_PROVENANCE, parseCli, requireResumeSession, run, saveState,
} from './codex-session.mjs';
import { FLEET_SECTION_NAME, WORKER_THREAD_SOURCE } from '../../codex-fleet-monitor/scripts/thread-sidebar.mjs';
import { LoadBasis, loadedSkillEvidence } from '../../vibe/scripts/loaded-skill.mjs';
import * as sessions from './codex-session.mjs';
import { writeRemoteCodexStub } from './fleet-test-support.mjs';
import { readProcessIdentity } from '../../../shared/process-identity.mjs';
import * as ownership from '../../vibe/scripts/owned-state.mjs';

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

test('fleet writer requires a matching active vibe session record in its worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-session-record-'));
  execFileSync('git', ['init', '-q', '-b', 'vibe/example', dir]);
  const gitDir = execFileSync('git', ['-C', dir, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  const record = join(gitDir, 'vibe-session.json');
  assert.throws(() => assertVibeSession(dir), /no vibe session record/);
  const valid = { status: 'active', branch: 'vibe/example', slug: 'example', summary: 'Example', operator: { id: 'operator' },
    baseCommit: 'a'.repeat(40), createdAt: '2026-10-30T12:00:00Z' };
  writeFileSync(record, JSON.stringify({ ...valid, branch: 'vibe/other' }));
  assert.throws(() => assertVibeSession(dir), /does not match/);
  writeFileSync(record, JSON.stringify({ ...valid, status: 'stopped' }));
  assert.throws(() => assertVibeSession(dir), /no active vibe session/);
  writeFileSync(record, JSON.stringify({ status: 'active', branch: 'vibe/example' }));
  assert.throws(() => assertVibeSession(dir), /no active vibe session/, 'a hand-written stub is not a session');
  writeFileSync(record, JSON.stringify(valid));
  assert.equal(assertVibeSession(dir).branch, 'vibe/example');
  assert.equal(requireResumeSession(null, dir), null, 'the first $vibe turn creates its own record');
  assert.equal(requireResumeSession({ cwd: dir }, dir).branch, 'vibe/example');
});

test('the fleet CLI refuses a sessionless saved thread before connecting to App Server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-session-cli-'));
  execFileSync('git', ['init', '-q', '-b', 'vibe/example', dir]);
  const prompt = join(dir, 'prompt.md');
  writeFileSync(prompt, '$vibe build this request\n');
  saveState(join(dir, 'state'), 'writer', { threadId: 'thread-1', cwd: dir, turns: [] });
  const result = spawnSync(process.execPath, [new URL('./codex-session.mjs', import.meta.url).pathname,
    'turn', join(dir, 'state'), 'writer', '--prompt-file', prompt], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no vibe session record/);
});

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
  const saved = JSON.parse(readFileSync(join(dir, 'w1.json'), 'utf8'));
  assert.equal(saved.loadedSkill.actorId, 'T1');
  assert.equal(saved.loadedSkill.skill, 'vibe');
  // PR #371 review: spawn-time evidence is the installed definition, never claimed as an observed read.
  assert.deepEqual([saved.loadedSkill.runtime, saved.loadedSkill.basis], ['codex', 'installed-at-spawn']);
  delete saved.loadedSkill;
  assert.deepEqual(saved, {
    threadId: 'T1', cwd: '/wt', model: 'm', effort: 'high', turns: [{ turnId: 'U1', kind: 'turn', promptFile }], ticket: 'ISS-1',
  });
});

test('AC-3: turn on a saved session resumes its thread with the saved options', async () => {
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

/** A real file-backed actor and installed release, with no daemon or signal-sending child. */
function reloadFixture(t) {
  const { dir, promptFile } = workDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'vibe/original', dir]);
  writeFileSync(join(dir, '.git/vibe-session.json'), JSON.stringify({ status: 'active', branch: 'vibe/original', slug: 'original', summary: 'Original',
    operator: { id: 'operator' }, baseCommit: 'a'.repeat(40), createdAt: '2026-11-05T12:00:00Z' }));
  const pluginRoot = join(dir, 'plugin');
  mkdirSync(join(pluginRoot, '.codex-plugin'), { recursive: true });
  mkdirSync(join(pluginRoot, 'skills/vibe'), { recursive: true });
  writeFileSync(join(pluginRoot, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'vibe', version: '1.1.48' }));
  writeFileSync(join(pluginRoot, 'skills/vibe/SKILL.md'), Array.from({ length: 205 }, (_, n) => `skill line ${n + 1}`).join('\n'));
  const loadedSkill = { ...loadedSkillEvidence('T1', 'codex', pluginRoot, 'vibe', LoadBasis.InstalledAtSpawn), version: '1.1.38' };
  const saved = { threadId: 'T1', cwd: dir, model: 'm', effort: 'high', turns: [], loadedSkill,
    custom: { retained: true }, ticket: 'fixture-ticket' };
  saveState(dir, 'w1', saved);
  const options = (command) => ({ ...parseCli([command, dir, 'w1', '--prompt-file', promptFile]), pluginRoot });
  const idle = () => reloadServer({ dir, pluginRoot, lockDirs }).client;
  const lockDirs = { slotRoot: join(dir, 'slots'), e2eLockDir: join(dir, 'e2e') };
  return { dir, promptFile, pluginRoot, saved, options, idle, lockDirs };
}

/** Strict App Server fixture: input receipt and actor acknowledgement are separate observable events. */
function reloadServer(f) {
  let turnId = 'U1'; let status = 'completed'; let count = 1; let failure;
  const items = new Map(); const sent = [];
  const receive = (params) => {
    assert.equal(params.threadId, 'T1');
    if (failure === 'before') { failure = null; throw new Error('delivery rejected'); }
    sent.push(params.input[0].text);
    items.set(turnId, [...(items.get(turnId) ?? []), { type: 'userMessage', content: params.input }]);
    if (failure === 'after') { failure = null; throw new Error('response lost'); }
  };
  const client = stubClient({
    'thread/read': () => ({ thread: { id: 'T1', status: { type: status === 'inProgress' ? 'active' : 'idle' }, turns: [{ id: turnId, status }] } }),
    'thread/turns/list': () => ({ data: [{ id: turnId, status }] }),
    'thread/items/list': params => {
      assert.equal(params.threadId, 'T1');
      return { data: (items.get(params.turnId) ?? []).map(item => ({ item })) };
    },
    'thread/resume': {},
    'thread/archive': {}, 'thread/unarchive': {},
    'turn/start': params => { turnId = `U${++count}`; status = 'inProgress'; receive(params); return { turn: { id: turnId } }; },
    'turn/steer': params => { assert.equal(params.expectedTurnId, turnId); receive(params); return { turnId }; },
    'turn/interrupt': () => { status = 'interrupted'; return {}; },
  });
  return { client, sent: () => sent, turn: () => turnId,
    finish: () => { status = 'completed'; },
    ack: (turn = turnId, nonce = loadState(f.dir, 'w1').reload.delivery.nonce) => {
      items.set(turn, [...(items.get(turn) ?? []), { type: 'agentMessage', text: `VIBE_SKILL_RELOAD_ACK v1 ${nonce}` }]);
    },
    reply: (text, turn = turnId) => { items.set(turn, [...(items.get(turn) ?? []), { type: 'agentMessage', text }]); },
    failBefore: () => { failure = 'before'; }, failAfter: () => { failure = 'after'; },
    pump: (retry = false) => sessions.deliverReload({ stateDir: f.dir, name: 'w1', pluginRoot: f.pluginRoot, retry }, { client, ...f.lockDirs }),
  };
}

/** Long exact-turn receipt history with a real opaque-cursor continuation boundary. */
function receiptHistory(server, turnId, receipt) {
  const history = [...Array.from({ length: 600 }, (_, index) => ({ type: 'agentMessage', text: `unrelated ${index}` })), receipt];
  const cursors = []; let invalid;
  const client = { request: async (method, params) => {
    if (method !== 'thread/items/list') return server.client.request(method, params);
    assert.equal(params.threadId, 'T1'); assert.equal(params.turnId, turnId); assert.equal(params.limit, 100);
    cursors.push(params.cursor ?? null);
    if (invalid && params.cursor === invalid) throw new Error('invalid receipt cursor');
    const offset = params.cursor ? Number(params.cursor) : 0;
    return { data: history.slice(offset, offset + 100).map(item => ({ item })),
      nextCursor: offset + 100 < history.length ? String(offset + 100) : null };
  } };
  return { client, cursors, invalidate: cursor => { invalid = cursor; } };
}

/** An actual job checkout, separate from the actor/skill fixture so receipts never change its tested source. */
function admissionFixture(t) {
  const f = reloadFixture(t); const worktree = join(f.dir, 'job-worktree'); mkdirSync(worktree);
  const git = args => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'fixture', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'fixture' } }).trim();
  git(['init', '-q', '-b', 'vibe/job']); git(['commit', '-q', '--allow-empty', '-m', 'fixture']);
  const head = git(['rev-parse', 'HEAD']);
  f.saved.cwd = worktree; saveState(f.dir, 'w1', f.saved);
  const docker = join(f.dir, 'no-docker'); writeFileSync(docker, '#!/bin/sh\nexit 1\n'); chmodSync(docker, 0o700);
  return { ...f, worktree, head, docker, marker: join(f.dir, 'job-started') };
}

/** Wait for a filesystem admission barrier, not an assumed scheduling delay. */
async function admissionBarrier(condition) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { if (condition()) return; await delay(10); }
  throw new Error('admission barrier timed out');
}

test('stale running writer accepts only reload steer and stays stale until delivery', async (t) => {
  const f = reloadFixture(t);
  const active = stubClient({ 'thread/read': { thread: { turns: [{ id: 'U1', status: 'inProgress' }] } }, 'turn/steer': { turnId: 'U1' } });
  await assert.rejects(run(active, f.options('steer')), /loaded 1\.1\.38/);
  assert.equal(active.calls.length, 0);
  for (const text of ['VIBE_SKILL_RELOAD v1\ncontinue', 'VIBE_SKILL_RELOAD v1 ']) {
    writeFileSync(f.promptFile, text);
    await assert.rejects(run(active, f.options('steer')), /loaded 1\.1\.38/);
  }
  writeFileSync(f.promptFile, 'VIBE_SKILL_RELOAD v1');
  assert.equal(await run(active, f.options('steer')), 'w1 steer T1 U1');
  const sent = active.calls.find(c => c.method === 'turn/steer').params.input[0].text;
  assert.equal(sent, 'VIBE_SKILL_RELOAD v1');
  assert.deepEqual(active.calls.find(c => c.method === 'turn/steer').params.input,
    [{ type: 'text', text: 'VIBE_SKILL_RELOAD v1', text_elements: [] }]);
  assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.38');
  writeFileSync(f.promptFile, 'continue');
  await assert.rejects(run(active, f.options('steer')), /loaded 1\.1\.38/);
});

test('idle migration requires actor acknowledgements and replays the retained brief through App Server', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  writeFileSync(join(f.dir, 'board.json'), '{"w1":"unchanged"}');
  const sessionBefore = readFileSync(join(f.dir, '.git/vibe-session.json'), 'utf8');
  writeFileSync(f.promptFile, 'Original requested work');
  await run(server.client, f.options('turn'), f.lockDirs);
  assert.equal(server.sent()[0], 'VIBE_SKILL_RELOAD v1');
  assert.equal(server.sent().length, 2, 'the idle next turn starts its first installed page immediately');
  const output = [];
  mkdirSync(join(f.lockDirs.slotRoot, 'heavy-1.lock'), { recursive: true });
  writeFileSync(join(f.lockDirs.slotRoot, 'heavy-1.lock/cwd'), f.dir);
  await assert.rejects(server.pump(), /heavy/);
  assert.equal(server.sent().length, 2);
  rmSync(f.lockDirs.slotRoot, { recursive: true });
  mkdirSync(f.lockDirs.e2eLockDir);
  writeFileSync(join(f.lockDirs.e2eLockDir, 'owner.json'), JSON.stringify({ worktree: f.dir }));
  await assert.rejects(server.pump(), /e2e/);
  rmSync(f.lockDirs.e2eLockDir, { recursive: true });
  await server.pump();
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 0, 'delivery alone cannot advance evidence');
  assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.38');
  assert.doesNotMatch(server.sent().join(''), /Original requested work/);
  server.ack(); await server.pump();
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 160);
  assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.38');
  server.ack(); const result = await server.pump();
  assert.equal(result.complete, true);
  const saved = loadState(f.dir, 'w1');
  assert.equal(saved.loadedSkill.version, '1.1.48');
  assert.equal(saved.loadedSkill.basis, 'reload-acknowledged');
  assert.equal(saved.reload, undefined);
  assert.match(server.sent().at(-1), /^Original requested work\nVIBE_RETAINED_BRIEF v1 /);
  assert.equal(saved.reloadReceipt.turnId, server.turn());
  assert.deepEqual(saved.custom, { retained: true });
  assert.equal(readFileSync(join(f.dir, 'board.json'), 'utf8'), '{"w1":"unchanged"}');
  assert.equal(readFileSync(join(f.dir, '.git/vibe-session.json'), 'utf8'), sessionBefore);
  assert.equal(assertVibeSession(f.dir).branch, 'vibe/original');
});

/** App Server answers as a live daemon does: a not-loaded turn summary, then newest-first item pages for that turn. */
function realShapedReload(server) {
  return { request: async (method, params) => {
    const result = await server.client.request(method, params);
    if (method === 'thread/turns/list') return { ...result, data: result.data.map(turn => ({ ...turn, items: [], itemsView: 'notLoaded' })), nextCursor: null, backwardsCursor: null };
    if (method !== 'thread/items/list') return result;
    assert.equal(params.sortDirection, 'desc');
    return { data: [...result.data].reverse().map(row => ({ turnId: params.turnId, item: row.item, startedAtMs: null, completedAtMs: null })), nextCursor: null, backwardsCursor: null };
  } };
}

// 2026-11-06: a stale writer's real ACK item ended with "\n\n" and strict equality never advanced its page.
test('a page acknowledged with trailing whitespace advances every page and replays the brief; other text never does', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f); const client = realShapedReload(server);
  const pump = (retry = false) => sessions.deliverReload({ stateDir: f.dir, name: 'w1', pluginRoot: f.pluginRoot, retry }, { client, ...f.lockDirs });
  writeFileSync(f.promptFile, 'retained brief after reload');
  await run(server.client, f.options('turn'), f.lockDirs);
  const first = loadState(f.dir, 'w1').reload.delivery.nonce;
  server.reply(`VIBE_SKILL_RELOAD_ACK v1 ${first} and more`);
  server.reply(`VIBE_SKILL_RELOAD_ACK v1 ${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}\n\n`);
  server.reply(`Done VIBE_SKILL_RELOAD_ACK v1 ${first}`);
  server.finish();
  assert.equal((await pump()).waitingFor, 'actor acknowledgement');
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 0, 'extra words or another nonce never acknowledge a page');
  server.reply(`VIBE_SKILL_RELOAD_ACK v1 ${first}\n\n`); server.finish();
  const second = await pump();
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 160);
  assert.notEqual(second.turnId, 'U2', 'the next page starts a turn on the completed one');
  server.reply(`\nVIBE_SKILL_RELOAD_ACK v1 ${loadState(f.dir, 'w1').reload.delivery.nonce}\n\n`); server.finish();
  assert.equal((await pump()).complete, true);
  const saved = loadState(f.dir, 'w1');
  assert.equal(saved.reload, undefined);
  assert.equal(saved.loadedSkill.version, '1.1.48');
  assert.equal(saved.loadedSkill.basis, 'reload-acknowledged');
  assert.match(server.sent().at(-1), /^retained brief after reload\nVIBE_RETAINED_BRIEF v1 /);
});

test('retry after a lost page reply keeps the nonce and binds a whitespace-padded ACK without resending', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f); const client = realShapedReload(server);
  const pump = (retry = false) => sessions.deliverReload({ stateDir: f.dir, name: 'w1', pluginRoot: f.pluginRoot, retry }, { client, ...f.lockDirs });
  await run(server.client, f.options('turn'), f.lockDirs); await pump(); server.ack(); server.finish();
  server.failAfter(); await assert.rejects(pump(), /response lost/);
  const lost = loadState(f.dir, 'w1').reload.delivery;
  assert.equal(lost.sent, undefined);
  server.reply(`VIBE_SKILL_RELOAD_ACK v1 ${lost.nonce}\n\n`); server.finish();
  const before = server.sent().length;
  await pump(true);
  assert.equal(server.sent().length, before + 1, 'retry sends only the retained brief, never the acknowledged page again');
  assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.48');
  assert.equal(loadState(f.dir, 'w1').reload, undefined);
});

test('page delivery rejection preserves stale evidence and retries the same nonce', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  writeFileSync(f.promptFile, 'VIBE_SKILL_RELOAD v1');
  await run(server.client, f.options('turn'), f.lockDirs);
  server.failBefore();
  await assert.rejects(server.pump(), /delivery rejected/);
  const before = loadState(f.dir, 'w1');
  assert.equal(before.loadedSkill.version, '1.1.38');
  assert.equal(before.reload.cursor, 0);
  await server.pump();
  assert.equal(loadState(f.dir, 'w1').reload.delivery.nonce, before.reload.delivery.nonce);
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 0);
});

test('interrupt confirms stop, records reason and resumes the same thread', async () => {
  const { dir, promptFile } = workDir();
  saveState(dir, 'w1', { threadId: 'T1', cwd: '/wt', turns: [], custom: 'kept' });
  let stopped = false;
  const client = stubClient({
    'thread/read': { thread: { id: 'T1', status: { type: 'active' } } },
    'thread/turns/list': () => ({ data: [{ id: 'U1', status: stopped ? 'interrupted' : 'inProgress' }] }),
    'turn/interrupt': params => {
      assert.deepEqual(params, { threadId: 'T1', turnId: 'U1' });
      assert.equal(loadState(dir, 'w1').interrupt.reason, 'reload cannot wait: priority lock yield');
      stopped = true; return {};
    },
  });
  assert.equal(await run(client, parseCli(['interrupt', dir, 'w1', '--reason', 'reload cannot wait: priority lock yield'])), 'w1 interrupted T1 U1');
  assert.ok(loadState(dir, 'w1').interrupt.completedAt);
  assert.equal(loadState(dir, 'w1').ended, undefined);
  await run(stubClient({ 'thread/resume': {}, 'turn/start': { turn: { id: 'U2' } } }), parseCli(['turn', dir, 'w1', '--prompt-file', promptFile]));
  assert.equal(loadState(dir, 'w1').custom, 'kept');
  assert.equal(loadState(dir, 'w1').interrupt.reason, 'reload cannot wait: priority lock yield');
});

test('interrupt rejects blank reason and preserves failed request evidence', async () => {
  for (const args of [[], ['--reason', ''], ['--reason', '  '], ['--reason']]) {
    assert.throws(() => parseCli(['interrupt', 'state', 'w1', ...args]), /reason|argument/);
  }
  const { dir } = workDir();
  saveState(dir, 'w1', { threadId: 'T1', cwd: '/wt', turns: [] });
  await assert.rejects(run(endClient('inProgress', { 'turn/interrupt': () => { throw new Error('RPC failed'); } }),
    parseCli(['interrupt', dir, 'w1', '--reason', 'reload cannot wait'])), /RPC failed/);
  assert.equal(loadState(dir, 'w1').interrupt.reason, 'reload cannot wait');
  assert.equal(loadState(dir, 'w1').interrupt.completedAt, undefined);
});

test('a stale running turn and a wrong actor cannot start idle migration', async (t) => {
  const f = reloadFixture(t);
  await assert.rejects(run(endClient('inProgress'), f.options('turn')), /running writer needs a mechanical reload steer/);
  assert.deepEqual(loadState(f.dir, 'w1'), f.saved);
  saveState(f.dir, 'w1', { ...f.saved, loadedSkill: { ...f.saved.loadedSkill, actorId: 'another-thread' } });
  writeFileSync(f.promptFile, 'VIBE_SKILL_RELOAD v1');
  const client = stubClient({});
  await assert.rejects(run(client, f.options('steer')), /no recorded loaded skill evidence/);
  assert.equal(client.calls.length, 0);
});

test('exact page envelope excludes provenance and wrong-turn acknowledgements do not advance evidence', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  await run(server.client, f.options('turn'), f.lockDirs); await server.pump();
  const state = loadState(f.dir, 'w1'); const page = state.reload.delivery;
  const expected = 'VIBE_SKILL_RELOAD v1\n' + JSON.stringify({ kind: 'page', threadId: 'T1', nonce: page.nonce,
    definition: 'skills/vibe/SKILL.md', definitionSha256: state.reload.target.definitionSha256,
    start: 1, end: 160, total: 205, content: Array.from({ length: 160 }, (_, n) => 'skill line ' + (n + 1)).join('\n'),
    instruction: 'Read this installed skill page and its required references. Run no other work until all pages are acknowledged.',
    acknowledge: 'VIBE_SKILL_RELOAD_ACK v1 ' + page.nonce });
  assert.deepEqual(server.client.calls.findLast(c => c.method === 'turn/steer').params.input,
    [{ type: 'text', text: expected, text_elements: [] }]);
  server.ack('wrong-turn');
  const callsBefore = server.sent().length;
  await server.pump();
  assert.equal(server.sent().length, callsBefore);
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 0);
  server.ack(undefined, 'wrong nonce'); await server.pump();
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 0);
  server.ack(); await server.pump();
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 160);
});

test('a changed installation refuses the old cursor then a new reload retains the original brief', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  writeFileSync(f.promptFile, 'retained work');
  await run(server.client, f.options('turn'), f.lockDirs); await server.pump();
  writeFileSync(join(f.pluginRoot, 'skills/vibe/SKILL.md'), '# replacement skill\n');
  await assert.rejects(server.pump(), /target changed/);
  assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.38');
  writeFileSync(f.promptFile, 'VIBE_SKILL_RELOAD v1');
  await run(server.client, f.options('steer'), f.lockDirs);
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 0);
  assert.equal(loadState(f.dir, 'w1').reload.pendingPrompt, 'retained work');
  assert.equal(ownership.reloadFenceStatus(f.dir, { ...f.lockDirs, identityOf: () => null }).held, true,
    'definition migration preserves the durable reload identity between CLI pumps');
  await server.pump(); server.ack(); await server.pump();
  assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.48');
});

test('reload dispatch failure keeps queued recovery and refuses ordinary work on retry', async (t) => {
  const f = reloadFixture(t);
  writeFileSync(f.promptFile, 'VIBE_SKILL_RELOAD v1');
  const client = stubClient({ 'thread/read': { thread: { turns: [{ id: 'U1', status: 'inProgress' }] } },
    'turn/steer': () => { throw new Error('delivery rejected'); } });
  await assert.rejects(run(client, f.options('steer')), /delivery rejected/);
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 0);
  assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.38');
  writeFileSync(f.promptFile, 'continue');
  await assert.rejects(run(client, f.options('steer')), /loaded 1\.1\.38/);
});

test('unconfirmed interrupt is bounded and never claims a completed stop', async () => {
  const { dir } = workDir();
  saveState(dir, 'w1', { threadId: 'T1', cwd: '/wt', turns: [] });
  const client = endClient('inProgress', { 'turn/interrupt': {} });
  await assert.rejects(run(client, parseCli(['interrupt', dir, 'w1', '--reason', 'reload cannot wait']),
    { attempts: 2, wait: async () => {} }), /stop is unconfirmed/);
  assert.equal(client.calls.filter(c => c.method === 'thread/turns/list').length, 3);
  assert.equal(loadState(dir, 'w1').interrupt.completedAt, undefined);
});

test('safe-point ownership handles foreign, subdirectory and incomplete records conservatively', (t) => {
  const f = reloadFixture(t);
  mkdirSync(join(f.lockDirs.slotRoot, 'heavy-1.lock'), { recursive: true });
  assert.deepEqual(sessions.reloadBlockers(f.saved, f.lockDirs), ['heavy slot heavy-1.lock']);
  writeFileSync(join(f.lockDirs.slotRoot, 'heavy-1.lock/cwd'), join(f.dir, 'nested'));
  assert.deepEqual(sessions.reloadBlockers(f.saved, f.lockDirs), ['heavy slot heavy-1.lock']);
  writeFileSync(join(f.lockDirs.slotRoot, 'heavy-1.lock/cwd'), '/other/worktree');
  assert.deepEqual(sessions.reloadBlockers(f.saved, f.lockDirs), []);
  mkdirSync(f.lockDirs.e2eLockDir);
  assert.deepEqual(sessions.reloadBlockers(f.saved, f.lockDirs), ['e2e lock']);
  writeFileSync(join(f.lockDirs.e2eLockDir, 'owner.json'), JSON.stringify({ worktree: '/other/worktree' }));
  assert.deepEqual(sessions.reloadBlockers(f.saved, f.lockDirs), []);
});

test('direct CLI refuses a caller old root against the verified host installation', (t) => {
  const f = reloadFixture(t);
  const bin = join(f.dir, 'bin'); mkdirSync(bin);
  writeRemoteCodexStub(bin, f.pluginRoot);
  const oldRoot = join(f.dir, 'old-root');
  mkdirSync(join(oldRoot, '.codex-plugin'), { recursive: true }); mkdirSync(join(oldRoot, 'skills/vibe'), { recursive: true });
  writeFileSync(join(oldRoot, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'vibe', version: '1.1.38' }));
  writeFileSync(join(oldRoot, 'skills/vibe/SKILL.md'), '# old vibe');
  const saved = { ...f.saved, loadedSkill: loadedSkillEvidence('T1', 'codex', oldRoot, 'vibe', LoadBasis.InstalledAtSpawn) };
  saveState(f.dir, 'w1', saved);
  const result = spawnSync(process.execPath, [new URL('./codex-session.mjs', import.meta.url).pathname,
    'steer', f.dir, 'w1', '--prompt-file', f.promptFile, '--plugin-root', oldRoot], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /verified installed root/);
  assert.deepEqual(loadState(f.dir, 'w1'), saved);
  assert.equal(sessions.verifiedPluginRoot(f.pluginRoot, { list: () => ({ installed: [{ name: 'vibe', installed: true, enabled: true, source: { path: f.pluginRoot } }] }) }),
    saved.loadedSkill.pluginRoot.replace(/old-root$/, 'plugin'), 'the legitimate internal binding remains accepted');
});

test('recovery stdout cannot advance another actor load or consume its retained brief', async (t) => {
  const f = reloadFixture(t);
  await run(f.idle(), f.options('turn'), f.lockDirs);
  const before = loadState(f.dir, 'w1');
  await assert.rejects(Promise.resolve().then(() => sessions.deliverReload({ stateDir: f.dir, name: 'w1', pluginRoot: f.pluginRoot },
    { ...f.lockDirs, emit: () => {} })), /App Server/);
  assert.deepEqual(loadState(f.dir, 'w1'), before);
});

test('full App Server reload input is the exact closed envelope without provenance', async (t) => {
  const f = reloadFixture(t);
  writeFileSync(f.promptFile, 'VIBE_SKILL_RELOAD v1');
  const client = f.idle();
  await run(client, f.options('turn'));
  assert.deepEqual(client.calls.find(call => call.method === 'turn/start').params.input,
    [{ type: 'text', text: 'VIBE_SKILL_RELOAD v1', text_elements: [] }]);
});

test('old ownerless control lock is reclaimed instead of permanently stranding the writer', async (t) => {
  const f = reloadFixture(t);
  const lock = join(f.dir, 'w1.json.control'); mkdirSync(lock);
  utimesSync(lock, new Date(0), new Date(0));
  await run(stubClient({ 'thread/read': { thread: { turns: [] } } }), parseCli(['last', f.dir, 'w1']));
  assert.deepEqual(loadState(f.dir, 'w1'), f.saved);
});

test('initial ownership-write failure cleans the lock and a reused PID is reclaimed without signaling', async (t) => {
  const f = reloadFixture(t); const options = parseCli(['last', f.dir, 'w1']);
  const client = stubClient({ 'thread/read': { thread: { turns: [] } } });
  await assert.rejects(Promise.resolve().then(() => run(client, options, { control: {
    identityOf: () => 'self', writeOwner: () => { throw new Error('ownership write failed'); },
  } })), /ownership write failed/);
  assert.equal(readdirSync(f.dir).includes('w1.json.control'), false);
  const lock = join(f.dir, 'w1.json.control'); mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 987654, identity: 'prior birth', token: 'prior' }));
  const observed = [];
  await run(client, options, { control: { identityOf: pid => { observed.push(pid); return pid === process.pid ? 'self' : 'new birth'; } } });
  assert.deepEqual(observed, [process.pid, 987654]);
  assert.equal(readdirSync(f.dir).includes('w1.json.control'), false);
});

test('a live exact process witness and a fresh ownerless creation remain protected', async (t) => {
  const f = reloadFixture(t); const options = parseCli(['last', f.dir, 'w1']);
  const lock = join(f.dir, 'w1.json.control'); mkdirSync(lock);
  await assert.rejects(Promise.resolve().then(() => run(stubClient({}), options)), /session control busy/);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 987654, identity: 'live birth', token: 'live' }));
  await assert.rejects(Promise.resolve().then(() => run(stubClient({}), options, { control: {
    identityOf: pid => pid === process.pid ? 'self' : 'live birth',
  } })), /session control busy/);
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'))).token, 'live');
});

test('retained work survives rejected delivery and a lost successful reply reconciles without duplicate replay', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  writeFileSync(f.promptFile, 'durable requested work');
  await run(server.client, f.options('turn'), f.lockDirs); await server.pump();
  server.ack(); await server.pump(); server.ack();
  server.failBefore(); await assert.rejects(server.pump(), /delivery rejected/);
  assert.equal(loadState(f.dir, 'w1').reload.pendingPrompt, 'durable requested work');
  assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.48');
  const nonce = loadState(f.dir, 'w1').reload.delivery.nonce;
  server.failAfter(); await assert.rejects(server.pump(), /response lost/);
  assert.equal(loadState(f.dir, 'w1').reload.delivery.nonce, nonce);
  const before = server.sent().length;
  assert.equal((await server.pump()).complete, true);
  assert.equal(server.sent().length, before, 'receipt reconciliation never replays already delivered work');
  assert.equal(loadState(f.dir, 'w1').reload, undefined);
});

test('lost page-start reply binds the observed turn; only its actor acknowledgement advances the page', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  await run(server.client, f.options('turn'), f.lockDirs); await server.pump(); server.ack(); server.finish();
  server.failAfter(); await assert.rejects(server.pump(), /response lost/);
  const before = server.sent().length;
  await server.pump();
  assert.equal(server.sent().length, before);
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 160);
  server.ack(); server.finish(); await server.pump();
  assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.48');
});

test('explicit page retry keeps one nonce and wrong App Server actor never changes evidence', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  await run(server.client, f.options('turn'), f.lockDirs); await server.pump();
  const before = loadState(f.dir, 'w1');
  const wrong = { request: async (method, params) => method === 'thread/read'
    ? { thread: { id: 'T-other', status: { type: 'active' } } } : server.client.request(method, params) };
  await assert.rejects(sessions.deliverReload({ stateDir: f.dir, name: 'w1', pluginRoot: f.pluginRoot }, { client: wrong, ...f.lockDirs }), /actor is unverified/);
  assert.deepEqual(loadState(f.dir, 'w1'), before);
  const sent = server.sent().length;
  await server.pump(true);
  assert.equal(server.sent().length, sent + 1);
  assert.equal(loadState(f.dir, 'w1').reload.delivery.nonce, before.reload.delivery.nonce);
  assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.38');
});

test('shared process-identity reads retain the raw witness and bound ps without signaling', () => {
  const calls = [];
  assert.equal(readProcessIdentity(987654, { env: {}, run: (...args) => {
    calls.push(args); return { status: 0, stdout: 'Mon Nov  2 12:00:00 2026 node worker\n' };
  } }), 'Mon Nov  2 12:00:00 2026 node worker');
  assert.deepEqual(calls, [['ps', ['-o', 'lstart=,command=', '-p', '987654'], { encoding: 'utf8', env: { LC_ALL: 'C' }, timeout: 5000 }]]);
  assert.equal(readProcessIdentity(987654, { run: () => ({ status: 1, stdout: '' }) }), null);
});

test('cursor moves only after the exact acknowledgement on its recorded actor turn', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  await run(server.client, f.options('turn'), f.lockDirs);
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 0);
  server.ack('wrong-turn');
  await server.pump();
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 0, 'another turn cannot acknowledge this page');
  server.ack(); await server.pump();
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 160);
});

test('direct reload CLI with no actor connection cannot promote evidence or consume work', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  writeFileSync(f.promptFile, 'keep this work durable');
  await run(server.client, f.options('turn'), f.lockDirs);
  const before = loadState(f.dir, 'w1');
  const bin = join(f.dir, 'bin'); mkdirSync(bin); writeRemoteCodexStub(bin, f.pluginRoot);
  const result = spawnSync(process.execPath, [new URL('./codex-session.mjs', import.meta.url).pathname,
    'reload', f.dir, 'w1', '--plugin-root', f.pluginRoot], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /App Server connection closed/);
  assert.doesNotMatch(result.stdout, /skill line|keep this work durable/);
  assert.deepEqual(loadState(f.dir, 'w1'), before);
});

test('receipt scans stop on current actor evidence and checkpoint older history across bounded pumps', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  await run(server.client, f.options('turn'), f.lockDirs);
  const before = loadState(f.dir, 'w1'); let scans = 0;
  const missing = { request: async (method, params) => method === 'thread/items/list'
    ? (scans++, { data: [], nextCursor: `page-${scans}` }) : server.client.request(method, params) };
  const result = await sessions.deliverReload({ stateDir: f.dir, name: 'w1', pluginRoot: f.pluginRoot }, { client: missing, ...f.lockDirs });
  assert.equal(result.waitingFor, 'receipt scan');
  assert.equal(scans, 5);
  assert.deepEqual(loadState(f.dir, 'w1').reload.delivery.scan, { turnId: server.turn(), cursor: 'page-5' });
  assert.equal(loadState(f.dir, 'w1').reload.cursor, before.reload.cursor);
  assert.deepEqual(loadState(f.dir, 'w1').loadedSkill, before.loadedSkill);
  server.ack(); scans = 0;
  const current = { request: async (method, params) => {
    const result = await server.client.request(method, params);
    return method === 'thread/items/list' ? (scans++, { ...result, nextCursor: 'older-history' }) : result;
  } };
  await sessions.deliverReload({ stateDir: f.dir, name: 'w1', pluginRoot: f.pluginRoot }, { client: current, ...f.lockDirs });
  assert.equal(scans, 1, 'a valid current ACK never walks old proof-run history');
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 160);
});

test('a live canonical writer waiter behind a foreign holder blocks reload until its E2E run releases', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  mkdirSync(f.lockDirs.e2eLockDir);
  writeFileSync(join(f.lockDirs.e2eLockDir, 'owner.json'), JSON.stringify({ worktree: '/foreign/worktree', name: 'foreign' }));
  const waiters = `${f.lockDirs.e2eLockDir}.waiters`; mkdirSync(waiters);
  const waiter = { pid: process.pid, identity: readProcessIdentity(process.pid), token: 'waiting',
    worktree: realpathSync(f.dir), name: 'w1' };
  writeFileSync(join(waiters, 'waiting.json'), JSON.stringify(waiter));
  await run(server.client, f.options('turn'), f.lockDirs);
  assert.deepEqual(server.sent(), ['VIBE_SKILL_RELOAD v1'], 'waiting E2E run prevents even the automatic first page');
  await assert.rejects(server.pump(), /e2e waiter/);
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 0);
  writeFileSync(join(f.lockDirs.e2eLockDir, 'owner.json'), JSON.stringify(waiter));
  rmSync(join(waiters, 'waiting.json'));
  await assert.rejects(server.pump(), /e2e lock/);
  rmSync(f.lockDirs.e2eLockDir, { recursive: true });
  await server.pump();
  assert.equal(server.sent().length, 2, 'page delivery starts only after the owned run releases');
});

test('exact actor ACK beyond 500 newer items completes across bounded resumable pumps without replay duplication', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  writeFileSync(f.promptFile, 'retained original work');
  await run(server.client, f.options('turn'), f.lockDirs);
  const pending = loadState(f.dir, 'w1').reload.delivery;
  const history = receiptHistory(server, pending.turnId, { type: 'agentMessage', text: `VIBE_SKILL_RELOAD_ACK v1 ${pending.nonce}` });
  const pump = () => sessions.deliverReload({ stateDir: f.dir, name: 'w1', pluginRoot: f.pluginRoot }, { client: history.client, ...f.lockDirs });
  const sentBefore = server.sent().length;
  assert.equal((await pump()).waitingFor, 'receipt scan');
  assert.equal(history.cursors.length, 5);
  assert.deepEqual(loadState(f.dir, 'w1').reload.delivery.scan, { turnId: pending.turnId, cursor: '500' });
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 0);
  assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.38');
  assert.equal(server.sent().length, sentBefore);
  const requestsBefore = history.cursors.length;
  await pump();
  assert.ok(history.cursors.length - requestsBefore <= 5);
  assert.ok(history.cursors.slice(requestsBefore).includes('500'));
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 160);
  server.ack(); await server.pump();
  assert.equal(loadState(f.dir, 'w1').reload, undefined);
  assert.equal(server.sent().filter(text => text.startsWith('retained original work\n')).length, 1);
});

test('invalid receipt cursor remains retryable with identical nonce/text and no evidence advancement', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  await run(server.client, f.options('turn'), f.lockDirs);
  const pending = loadState(f.dir, 'w1').reload.delivery;
  const history = receiptHistory(server, pending.turnId, { type: 'agentMessage', text: 'not an acknowledgement' });
  const pump = retry => sessions.deliverReload({ stateDir: f.dir, name: 'w1', pluginRoot: f.pluginRoot, retry },
    { client: history.client, ...f.lockDirs });
  await pump(false); history.invalidate('500');
  const before = loadState(f.dir, 'w1');
  await assert.rejects(pump(false), /invalid receipt cursor/);
  assert.deepEqual(loadState(f.dir, 'w1'), before);
  const sentBefore = server.sent().length;
  await pump(true);
  const retried = loadState(f.dir, 'w1');
  assert.equal(retried.reload.delivery.scan, undefined);
  assert.equal(retried.reload.delivery.nonce, pending.nonce);
  assert.equal(retried.reload.delivery.text, pending.text);
  assert.equal(retried.reload.cursor, 0);
  assert.equal(retried.loadedSkill.version, '1.1.38');
  assert.equal(server.sent().length, sentBefore + 1);
  assert.equal(server.sent().at(-1), pending.text);
  server.ack(); await server.pump();
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 160);
});

test('waiter ownership handles same-name, foreign, reused and unreadable records conservatively', (t) => {
  const f = reloadFixture(t); const waiters = `${f.lockDirs.e2eLockDir}.waiters`; mkdirSync(waiters);
  const file = join(waiters, 'waiter.json');
  const gate = identityOf => sessions.reloadBlockers({ ...f.saved, name: 'w1' }, { ...f.lockDirs, identityOf });
  writeFileSync(file, JSON.stringify({ name: 'w1', worktree: '/another/worktree', pid: 987654, identity: 'birth' }));
  assert.deepEqual(gate(() => 'birth'), ['e2e waiter'], 'same name is relevant even with a different worktree spelling');
  assert.deepEqual(gate(() => 'reused birth'), [], 'another process holding that PID is not this waiter');
  assert.deepEqual(gate(() => null), ['e2e waiter'], 'unreadable relevant identity cannot establish safe release');
  writeFileSync(file, JSON.stringify({ name: 'foreign', worktree: '/foreign/worktree', pid: 987654, identity: 'birth' }));
  assert.deepEqual(gate(() => { throw new Error('foreign identity must not be probed'); }), []);
  writeFileSync(file, JSON.stringify({ worktree: f.dir, pid: 1 }));
  assert.deepEqual(gate(() => { throw new Error('invalid PID must not be probed'); }), ['e2e waiter']);
  writeFileSync(file, 'incomplete JSON');
  assert.deepEqual(gate(() => 'birth'), ['e2e waiter']);
  rmSync(file); mkdirSync(file);
  assert.deepEqual(gate(() => 'birth'), ['e2e waiter'], 'non-file ownership is not silently discarded');
  rmSync(file, { recursive: true });
  const staging = `${file}.00000000-0000-0000-0000-000000000000.tmp`;
  writeFileSync(staging, 'incomplete atomic write');
  assert.deepEqual(gate(() => 'birth'), [], 'only canonical waiter records participate before final job admission');
  writeFileSync(file, 'incomplete canonical waiter');
  assert.deepEqual(gate(() => 'birth'), ['e2e waiter'], 'an incomplete canonical ownership record still blocks');
});

test('an aged retained-brief delivery receipt reconciles across pumps without resending work', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  writeFileSync(f.promptFile, 'one retained operation');
  await run(server.client, f.options('turn'), f.lockDirs);
  server.ack(); await server.pump(); server.ack();
  server.failAfter(); await assert.rejects(server.pump(), /response lost/);
  const pending = loadState(f.dir, 'w1').reload.delivery;
  assert.equal(pending.kind, 'brief');
  const history = receiptHistory(server, server.turn(), { type: 'userMessage', content: [{ type: 'text', text: pending.text }] });
  const pump = () => sessions.deliverReload({ stateDir: f.dir, name: 'w1', pluginRoot: f.pluginRoot }, { client: history.client, ...f.lockDirs });
  const sent = server.sent().length;
  assert.equal((await pump()).waitingFor, 'receipt scan');
  assert.equal(loadState(f.dir, 'w1').reload.pendingPrompt, 'one retained operation');
  assert.equal((await pump()).complete, true);
  assert.equal(server.sent().length, sent);
  assert.equal(loadState(f.dir, 'w1').reload, undefined);
});

for (const kind of ['e2e', 'heavy']) test(`late ${kind} admission cannot start a job during reload dispatch or acknowledgement`, { timeout: 30_000 }, async (t) => {
  const f = admissionFixture(t); const server = reloadServer(f);
  writeFileSync(f.promptFile, 'VIBE_SKILL_RELOAD v1'); await run(server.client, f.options('turn'), f.lockDirs);
  const markerCode = 'require("node:fs").writeFileSync(process.argv[1], "started")';
  let child; let exited; let launched = false; let stderr = '';
  const client = { request: async (method, params) => {
    if (method === 'thread/read' && !launched) {
      launched = true;
      const command = kind === 'e2e' ? process.execPath : 'bash';
      const args = kind === 'e2e'
        ? [new URL('../../vibe/scripts/e2e-lock.mjs', import.meta.url).pathname, 'run', '--head', f.head, '--wait-seconds', '15',
          '--lock-dir', f.lockDirs.e2eLockDir, '--owner', 'w1', process.execPath, '-e', markerCode, f.marker]
        : [new URL('./slot-lock.sh', import.meta.url).pathname, 'heavy', 'w1', process.execPath, '-e', markerCode, f.marker];
      child = spawn(command, args, { cwd: f.worktree, env: { ...process.env, SLOT_LOCK_DIR: f.lockDirs.slotRoot,
        SLOT_LOCK_POLL_SECONDS: '0.01', VIBE_E2E_DOCKER: f.docker, VIBE_E2E_FOREIGN_COMPOSE: '', COMPOSE_PROJECT_NAME: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr.on('data', data => { stderr += data; }); child.stdout.resume();
      exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
      await admissionBarrier(() => {
        if (existsSync(f.marker)) return true; // pre-fix path: reproduce the actual overlap before dispatch
        const records = kind === 'e2e' ? ownership.readE2eWaiters(f.lockDirs.e2eLockDir)
          : [{ owner: (() => { try { return ownership.regularJson(join(f.lockDirs.slotRoot, 'heavy-1.lock/admission.json')); } catch { return null; } })() }];
        return records.some(({ owner }) => owner?.admission === 'reload-wait');
      });
    }
    if (['turn/steer', 'turn/start'].includes(method)) assert.equal(existsSync(f.marker), false, 'late job must not start before reload/evidence completion');
    return server.client.request(method, params);
  } };
  try {
    await sessions.deliverReload({ stateDir: f.dir, name: 'w1', pluginRoot: f.pluginRoot }, { client, ...f.lockDirs });
    assert.equal(existsSync(f.marker), false);
    assert.ok(loadState(f.dir, 'w1').reload.fence, 'fence remains durable while the actor reads its page');
    server.ack(); await server.pump();
    assert.equal(existsSync(f.marker), false);
    server.ack(); await server.pump();
    assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.48');
  } finally {
    const fence = loadState(f.dir, 'w1')?.reload?.fence;
    if (fence && ownership.releaseReloadFence) ownership.releaseReloadFence(fence);
    if (exited) assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  }
  assert.equal(readFileSync(f.marker, 'utf8'), 'started');
});

test('pre-existing jobs and pre-delivery errors release only the prepared fence', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  writeFileSync(f.promptFile, 'VIBE_SKILL_RELOAD v1'); await run(server.client, f.options('turn'), f.lockDirs);
  mkdirSync(join(f.lockDirs.slotRoot, 'heavy-1.lock'), { recursive: true });
  writeFileSync(join(f.lockDirs.slotRoot, 'heavy-1.lock/cwd'), f.dir);
  await assert.rejects(server.pump(), /release heavy slot/);
  assert.equal(loadState(f.dir, 'w1').reload.fence, undefined);
  assert.equal(ownership.reloadFenceStatus(f.dir, f.lockDirs).held, false);
  rmSync(join(f.lockDirs.slotRoot, 'heavy-1.lock'), { recursive: true });
  const failing = { request: async () => { throw new Error('daemon read failed'); } };
  await assert.rejects(sessions.deliverReload({ stateDir: f.dir, name: 'w1', pluginRoot: f.pluginRoot }, { client: failing, ...f.lockDirs }), /daemon read failed/);
  assert.equal(ownership.reloadFenceStatus(f.dir, f.lockDirs).held, false);
  assert.equal(loadState(f.dir, 'w1').reload.cursor, 0);
  assert.deepEqual(server.sent(), ['VIBE_SKILL_RELOAD v1']);
});

test('uncertain delivery retains a recoverable actor fence through later pumps', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  writeFileSync(f.promptFile, 'VIBE_SKILL_RELOAD v1'); await run(server.client, f.options('turn'), f.lockDirs);
  server.failAfter(); await assert.rejects(server.pump(), /response lost/);
  const fence = loadState(f.dir, 'w1').reload.fence;
  assert.equal(fence.started, true);
  assert.equal(ownership.reloadFenceStatus(f.dir, { ...f.lockDirs, identityOf: () => null }).held, true,
    'a short-lived pump exiting is not authority to release the still-pending actor');
  server.ack(); await server.pump();
  assert.equal(loadState(f.dir, 'w1').reload.fence.token, fence.token);
  server.ack(); await server.pump();
  assert.equal(ownership.reloadFenceStatus(f.dir, f.lockDirs).held, false);
  assert.equal(existsSync(fence.file), false);
});

test('confirmed interruption releases the fence and reload resumes on the same thread', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  await run(server.client, f.options('turn'), f.lockDirs);
  const original = loadState(f.dir, 'w1').reload.fence;
  await run(server.client, parseCli(['interrupt', f.dir, 'w1', '--reason', 'reload cannot wait']), f.lockDirs);
  assert.equal(existsSync(original.file), false);
  assert.equal(loadState(f.dir, 'w1').reload.fence, undefined);
  writeFileSync(f.promptFile, 'VIBE_SKILL_RELOAD v1');
  await run(server.client, f.options('turn'), f.lockDirs);
  await server.pump(true);
  assert.notEqual(loadState(f.dir, 'w1').reload.fence.token, original.token);
  server.ack(); await server.pump(); server.ack(); await server.pump();
  assert.equal(loadState(f.dir, 'w1').threadId, 'T1');
  assert.equal(loadState(f.dir, 'w1').loadedSkill.version, '1.1.48');
  assert.equal(ownership.reloadFenceStatus(f.dir, f.lockDirs).held, false);
});

test('fence recovery is identity checked and exclusive publication never clobbers another owner', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  await run(server.client, f.options('turn'), f.lockDirs);
  const state = loadState(f.dir, 'w1'); const fence = state.reload.fence;
  assert.throws(() => ownership.writeAtomic(fence.file, { token: 'foreign' }, { exclusive: true }), /EEXIST/);
  assert.equal(ownership.regularJson(fence.file).token, fence.token);
  ownership.writeAtomic(join(f.dir, 'w1.json'), {});
  assert.equal(ownership.reloadFenceStatus(f.dir, { ...f.lockDirs, identityOf: () => 'reused process birth' }).held, true,
    'missing actor authority is not proof that an App Server skill read stopped');
  saveState(f.dir, 'w1', state);
  ownership.releaseReloadFence(fence); // simulate a lost physical fence in this fake actor fixture
  await server.pump();
  assert.notEqual(loadState(f.dir, 'w1').reload.fence.token, fence.token, 'republication cannot reuse an old job-wait generation');
  delete state.reload; saveState(f.dir, 'w1', state);
  assert.equal(ownership.reloadFenceStatus(f.dir, { ...f.lockDirs, identityOf: () => 'reused process birth' }).held, false);
  assert.equal(existsSync(fence.file), true, 'job readers never unlink a fence from a stale ownership snapshot');
  state.reload = { id: 'next-reload', fence: { ...fence, reloadId: 'next-reload', started: false } };
  saveState(f.dir, 'w1', state);
  const recovered = ownership.ensureReloadFence(state.reload.fence, { ...f.lockDirs, identityOf: () => 'new process birth' });
  assert.notEqual(recovered.token, fence.token, 'serialized reload recovery publishes a fresh generation');
  ownership.releaseReloadFence(recovered);
  ownership.writeAtomic(fence.file, { kind: 'foreign', token: 'foreign' });
  assert.equal(ownership.reloadFenceStatus(f.dir, f.lockDirs).held, true);
  assert.equal(ownership.releaseReloadFence(fence), false);
  assert.equal(ownership.regularJson(fence.file).token, 'foreign');
});

test('admission waiting is bounded and abortable without releasing the actor fence', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  await run(server.client, f.options('turn'), f.lockDirs);
  const fence = loadState(f.dir, 'w1').reload.fence;
  const owner = { pid: process.pid, identity: readProcessIdentity(process.pid), token: 'job', worktree: realpathSync(f.dir) };
  const recordFile = join(f.dir, 'admission.json');
  const result = await ownership.waitForReloadFence(f.dir, { recordFile, owner, slotRoot: f.lockDirs.slotRoot, deadline: Date.now() });
  assert.equal(result.ready, false);
  assert.equal(ownership.regularJson(recordFile).reloadFence, fence.token);
  const abort = new AbortController();
  const waiting = ownership.waitForReloadFence(f.dir, { recordFile, owner, slotRoot: f.lockDirs.slotRoot, signal: abort.signal });
  abort.abort(); await assert.rejects(waiting, /aborted/i);
  assert.equal(ownership.reloadFenceStatus(f.dir, f.lockDirs).held, true);
  assert.equal(ownership.regularJson(fence.file).token, fence.token);
  await assert.rejects(ownership.waitForReloadFence(f.dir, { recordFile, owner: { ...owner, identity: 'prior birth' },
    slotRoot: f.lockDirs.slotRoot, identityOf: () => 'reused birth' }), /ownership is unverified/);
  const removedDirectory = join(f.dir, 'already-cleaned-slot');
  await assert.rejects(ownership.waitForReloadFence(f.dir, { recordFile: join(removedDirectory, 'admission.json'), owner,
    slotRoot: f.lockDirs.slotRoot, deadline: Date.now() }), /ENOENT/);
  assert.equal(existsSync(removedDirectory), false, 'an interrupted admission cannot recreate a removed slot');
  const previous = { slot: process.env.SLOT_LOCK_DIR, xdg: process.env.XDG_STATE_HOME };
  try {
    process.env.SLOT_LOCK_DIR = ''; process.env.XDG_STATE_HOME = '';
    assert.ok(ownership.machineSlotLockDir().startsWith('/'), 'empty optional keys use the same absolute default as slot-lock.sh');
    process.env.SLOT_LOCK_DIR = 'relative-locks';
    assert.throws(() => ownership.machineSlotLockDir(), /must be absolute/);
  } finally {
    if (previous.slot === undefined) delete process.env.SLOT_LOCK_DIR; else process.env.SLOT_LOCK_DIR = previous.slot;
    if (previous.xdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous.xdg;
  }
});

test('an ended actor cannot reopen a reload behind its released fence', async (t) => {
  const f = reloadFixture(t); const server = reloadServer(f);
  await run(server.client, f.options('turn'), f.lockDirs);
  server.finish();
  await run(server.client, parseCli(['end', f.dir, 'w1', '--reason', 'stopped']), f.lockDirs);
  assert.equal(ownership.reloadFenceStatus(f.dir, f.lockDirs).held, false);
  const sent = server.sent().length;
  await assert.rejects(server.pump(), /session ended; use turn to reopen/);
  assert.equal(server.sent().length, sent);
  writeFileSync(f.promptFile, 'VIBE_SKILL_RELOAD v1');
  await run(server.client, f.options('turn'), f.lockDirs);
  await server.pump(true);
  assert.equal(loadState(f.dir, 'w1').threadId, 'T1');
  assert.equal(ownership.reloadFenceStatus(f.dir, { ...f.lockDirs, identityOf: () => null }).held, true);
});
