import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  lastMessages, loadState, nextState, parseCli, run, saveState,
} from './codex-session.mjs';

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

function workDir() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-session-'));
  const promptFile = join(dir, 'prompt.md');
  writeFileSync(promptFile, '$vibe resume the session for the ticket.\n');
  return { dir, promptFile };
}

test('parseCli reads each command and its options', () => {
  assert.deepEqual(parseCli(['turn', 'state', 'w1', '--prompt-file', 'p.md', '--cwd', 'wt', '--model', 'm', '--effort', 'high', '--sandbox', 'workspace-write']), {
    command: 'turn', stateDir: 'state', name: 'w1', promptFile: 'p.md', cwd: resolve('wt'),
    model: 'm', effort: 'high', sandbox: 'workspace-write', count: 1,
  });
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
  assert.throws(() => nextState(null, { cwd: '/wt' }), /a new session needs --effort/);
  assert.throws(() => nextState(null, { cwd: '/wt', effort: 'high' }), /a new session needs --model/);
  assert.deepEqual(nextState(null, { cwd: '/wt', model: 'm1', effort: 'high' }), {
    threadId: undefined, cwd: '/wt', model: 'm1', effort: 'high', sandbox: undefined, turns: [],
  });
  const saved = { threadId: 'T1', cwd: '/wt', model: 'm1', effort: 'medium', sandbox: 'workspace-write', turns: [{ turnId: 'u1' }] };
  assert.deepEqual(nextState(saved, { cwd: '/wt' }), saved);
  assert.equal(nextState(saved, { model: 'm2' }).model, 'm2');
  assert.throws(() => nextState(saved, { cwd: '/other' }), /bound to \/wt/);
});

test('turn on a new session starts a thread in the cwd, starts the turn and saves the state', async () => {
  const { dir, promptFile } = workDir();
  const client = stubClient({ 'thread/start': { thread: { id: 'T1' } }, 'turn/start': { turn: { id: 'U1' } } });
  const line = await run(client, parseCli(['turn', dir, 'w1', '--prompt-file', promptFile, '--cwd', '/wt', '--model', 'm', '--effort', 'high']));
  assert.equal(line, 'w1 turn T1 U1');
  assert.deepEqual(client.calls, [
    { method: 'thread/start', params: { cwd: '/wt', model: 'm', approvalPolicy: 'never' } },
    {
      method: 'turn/start',
      params: {
        threadId: 'T1', input: [{ type: 'text', text: '$vibe resume the session for the ticket.\n', text_elements: [] }],
        cwd: '/wt', model: 'm', effort: 'high', approvalPolicy: 'never',
      },
    },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'w1.json'), 'utf8')), {
    threadId: 'T1', cwd: '/wt', model: 'm', effort: 'high', turns: [{ turnId: 'U1', kind: 'turn', promptFile }],
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
  const client = stubClient({ 'thread/start': { thread: { id: 'T1' } }, 'turn/start': {} });
  await assert.rejects(run(client, parseCli(['turn', dir, 'w1', '--prompt-file', promptFile, '--cwd', '/wt', '--model', 'm', '--effort', 'high'])), /no turn id/);
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
    threadId: 'T1', expectedTurnId: 'U2', input: [{ type: 'text', text: '$vibe resume the session for the ticket.\n', text_elements: [] }],
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
  await assert.rejects(run(client, parseCli(['turn', dir, 'w1', '--prompt-file', plain, '--cwd', '/wt', '--model', 'm', '--effort', 'high'])), /must start with \$vibe/);
  assert.deepEqual(client.calls, []);
  saveState(dir, 'w1', { threadId: 'T1', cwd: '/wt', effort: 'high', turns: [] });
  assert.equal(await run(client, parseCli(['turn', dir, 'w1', '--prompt-file', plain])), 'w1 turn T1 U1');
});
