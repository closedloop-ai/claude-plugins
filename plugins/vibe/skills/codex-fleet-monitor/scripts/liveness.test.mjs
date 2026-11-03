import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assistantTail, classifyTurnError, connectDirect, decodeFrames, encodeFrame, Failure, modelDrift, needsReply, parseSession, readSessions, readThreadState, summarize,
} from './liveness.mjs';
import { answerThreadRead } from './test-support.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function serverFrame(text, opcode = 0x1) {
  const body = Buffer.from(text);
  const header = body.length < 126
    ? Buffer.from([0x80 | opcode, body.length])
    : Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([header, body]);
}

/** Fake App Server: WebSocket upgrade, then JSON-RPC answers from `threads`. */
function fakeServer(threads, options = {}) {
  const calls = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(buffer.subarray(0, end).toString())[1];
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        const accept = createHash('sha1').update(key + GUID).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      }
      const { frames, remainder } = decodeFrames(buffer);
      buffer = remainder;
      for (const frame of frames) {
        if (frame.opcode !== 0x1) continue;
        const message = JSON.parse(frame.payload.toString());
        calls.push(message);
        if (message.id === undefined) continue;
        let reply;
        try {
          const result = message.method === 'initialize' ? {} : answerThreadRead(threads, message.method, message.params, options);
          reply = { id: message.id, result };
        } catch (error) {
          reply = { id: message.id, error: { code: -32600, message: error.message } };
        }
        socket.write(serverFrame(JSON.stringify(reply)));
      }
    });
  });
  return { server, calls };
}

test('frames round trip through the masked encoder', () => {
  const payload = 'x'.repeat(300);
  const { frames, remainder } = decodeFrames(encodeFrame(payload));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString(), payload);
  assert.equal(remainder.length, 0);
});

test('summarize classifies limit, transient, system-error, error and running turns', () => {
  const turn = (extra, status) => ({ status, turns: [{ status: 'failed', items: [1, 2], ...extra }] });
  const overloaded = { message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded' };
  assert.equal(summarize('a', turn({ error: { message: 'You hit your usage limit' } })), 'a failed 2 LIMIT');
  assert.equal(summarize('a', turn({ error: overloaded })), 'a failed 2 TRANSIENT');
  assert.equal(summarize('a', turn({ error: overloaded }, { type: 'systemError' })), 'a failed 2 SYSTEM-ERROR');
  assert.equal(summarize('a', turn({ error: { message: 'boom' } })), 'a failed 2 ERROR');
  assert.equal(summarize('a', turn({})), 'a failed 2 -');
  assert.equal(summarize('a', { turns: [] }), 'a none 0 -');
});

test('an idle writer prints its final message lines and flags a question or permission request', () => {
  const message = { id: 'i-1', type: 'agentMessage', text: 'done\nWaiting for permission?' };
  assert.equal(assistantTail(message), 'done / Waiting for permission?');
  assert.equal(needsReply(assistantTail(message)), true);
  assert.equal(summarize('w1', {}, { status: 'completed', items: [message] }, 'i-1', message),
    'w1 completed i-1 - NEEDS-REPLY "done / Waiting for permission?"');
});

test('classifyTurnError keeps usage limits apart from transient provider failures', () => {
  const table = [
    [{ message: 'Selected model is at capacity', codexErrorInfo: 'serverOverloaded' }, Failure.Transient],
    [{ message: 'slow down', codexErrorInfo: 'rateLimitExceeded' }, Failure.Transient],
    [{ message: 'x', codexErrorInfo: 'internalServerError' }, Failure.Transient],
    [{ message: 'x', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }, Failure.Transient],
    [{ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }, Failure.Transient],
    [{ message: 'x', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }, Failure.Transient],
    [{ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }, Failure.Error],
    [{ message: 'You have hit your usage limit', codexErrorInfo: 'usageLimitExceeded' }, Failure.Limit],
    [{ message: 'context too long', codexErrorInfo: 'contextWindowExceeded' }, Failure.Error],
    [{ message: 'Selected model is at capacity', codexErrorInfo: null }, Failure.Transient],
    [{ message: 'stream error: status 502', codexErrorInfo: 'other' }, Failure.Transient],
    [{ message: 'rate limit reached' }, Failure.Transient],
    [{ message: 'You hit your usage limit; rate limits reset at 5pm' }, Failure.Limit],
    [{ message: 'quota exceeded' }, Failure.Limit],
    [{ message: 'token limit' }, Failure.Limit],
    [{ message: 'boom' }, Failure.Error],
    ['server overloaded', Failure.Transient],
  ];
  for (const [error, flag] of table) assert.equal(classifyTurnError(error), flag, JSON.stringify(error));
});

test('parseSession accepts label=threadId and a state file name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-'));
  writeFileSync(join(dir, 'w1.json'), JSON.stringify({ threadId: 'T-file' }));
  assert.deepEqual(parseSession('lbl=T-direct', dir), { label: 'lbl', threadId: 'T-direct' });
  assert.deepEqual(parseSession('w1', dir), { label: 'w1', threadId: 'T-file' });
});

const item = (id, text = 'finished') => ({ id, type: 'agentMessage', text });

test('reads threads over a fake server and reports READFAIL for failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-'));
  writeFileSync(join(dir, 'w1.json'), JSON.stringify({ threadId: 'T1' }));
  const { server, calls } = fakeServer({
    T1: { status: { type: 'active' }, turns: [{ id: 't-0', status: 'completed', items: [item('i-0')] }, { id: 't-1', status: 'inProgress', items: [item('i-1'), item('i-2'), item('i-3')] }] },
    T2: { status: { type: 'idle' }, turns: [{ id: 't-2', status: 'failed', items: [item('i-4')], error: { message: 'usage limit reached' } }] },
  });
  const sock = join(dir, 's.sock');
  await new Promise((resolve) => server.listen(sock, resolve));
  const client = connectDirect(sock);
  try {
    await client.initialize();
    const lines = await readSessions(client, dir, ['w1', 'two=T2', 'gone=T9', 'nofile']);
    assert.deepEqual(lines, [
      'w1 inProgress i-3 -',
      'two failed i-4 LIMIT',
      'gone unreadable 0 READFAIL',
      'nofile unreadable 0 READFAIL',
    ]);
    const read = calls.find((c) => c.method === 'thread/read');
    assert.deepEqual(read.params, { threadId: 'T1', includeTurns: false });
    assert.ok(calls.some((c) => c.method === 'initialized'));
  } finally {
    client.close();
    server.close();
  }
});

test('a read never loads a thread history: status, the newest turn without items, and its newest item id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-'));
  const history = Array.from({ length: 50 }, (_, n) => ({ id: `t-${n}`, status: 'completed', items: Array.from({ length: 40 }, (__, k) => item(`i-${n}-${k}`)) }));
  const { server, calls } = fakeServer({ T1: { status: { type: 'active' }, turns: [...history, { id: 't-last', status: 'inProgress', items: [item('i-a'), item('i-b')] }] } });
  const sock = join(dir, 's.sock');
  await new Promise((resolve) => server.listen(sock, resolve));
  const client = connectDirect(sock);
  try {
    await client.initialize();
    assert.deepEqual(await readSessions(client, dir, ['w1=T1']), ['w1 inProgress i-b -']);
    const reads = calls.filter((c) => c.id !== undefined && c.method !== 'initialize');
    assert.ok(reads.every((c) => c.params.includeTurns !== true), 'no thread/read asks for the history');
    assert.deepEqual(reads.find((c) => c.method === 'thread/turns/list').params, { threadId: 'T1', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    assert.deepEqual(reads.find((c) => c.method === 'thread/items/list').params, { threadId: 'T1', turnId: 't-last', limit: 20, sortDirection: 'desc' });
  } finally {
    client.close();
    server.close();
  }
});

test('an App Server without thread/turns/list gets the full read and the item count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-'));
  const { server } = fakeServer({ T1: { status: { type: 'idle' }, turns: [{ id: 't-1', status: 'completed', items: [item('i-1'), item('i-2')] }] } }, { legacy: true });
  const sock = join(dir, 's.sock');
  await new Promise((resolve) => server.listen(sock, resolve));
  const client = connectDirect(sock);
  try {
    await client.initialize();
    const state = await readThreadState(client, 'T1', { progress: true });
    assert.equal(state.turn.id, 't-1');
    assert.equal(summarize('w1', state.thread, state.turn, state.progress, state.lastItem), 'w1 completed 2 - LAST "finished"');
  } finally {
    client.close();
    server.close();
  }
});

test('a request times out while the connection never opens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-'));
  const sockets = [];
  const silent = createServer((socket) => sockets.push(socket));
  const sock = join(dir, 's.sock');
  await new Promise((resolve) => silent.listen(sock, resolve));
  const client = connectDirect(sock);
  try {
    await assert.rejects(client.request('thread/read', { threadId: 'T1' }, 200), /thread\/read timed out/);
  } finally {
    client.close();
    for (const socket of sockets) socket.destroy();
    silent.close();
  }
});

const LIVENESS = fileURLToPath(new URL('./liveness.mjs', import.meta.url));
const CLASSIFY = fileURLToPath(new URL('./classify.sh', import.meta.url));

async function withFakeServer(threads, body) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-'));
  const { server, calls } = fakeServer(threads);
  const sock = join(dir, 's.sock');
  await new Promise((resolve) => server.listen(sock, resolve));
  try {
    return await body({ dir, sock, calls });
  } finally {
    server.close();
  }
}

test('a finished writer whose thread the App Server unloaded (notLoaded) still reads IDLE with its final message', async () => {
  const done = item('i-9', 'Pushed the fix.\nPR is mergeable; waiting for the merge.');
  const turns = [{ id: 't-1', status: 'completed', items: [item('i-8'), done] }];
  await withFakeServer({ LOADED: { status: { type: 'idle' }, turns }, UNLOADED: { status: { type: 'notLoaded' }, turns } }, async ({ dir, sock }) => {
    const client = connectDirect(sock);
    try {
      await client.initialize();
      const [loaded, unloaded] = await readSessions(client, dir, ['w=LOADED', 'w=UNLOADED']);
      assert.equal(unloaded, 'w completed i-9 - LAST "Pushed the fix. / PR is mergeable; waiting for the merge."');
      assert.equal(unloaded, loaded, 'unloading a finished thread is neither an event nor a lost message');
      const classified = spawnSync('zsh', [CLASSIFY, join(dir, 'history.txt'), '720'], { input: `remote ${unloaded}\n`, encoding: 'utf8' });
      assert.equal(classified.stdout, 'session remote w IDLE LAST "Pushed the fix. / PR is mergeable; waiting for the merge."\n');
    } finally {
      client.close();
    }
  });
});

test('NEEDS-REPLY catches a question or permission request anywhere in the final lines, not only at the end', () => {
  const asks = [
    '1. Should the depth limit apply within one project only? / 2. May I use the plain-push fallback here? Publication was refused. / The PR has not been opened yet.',
    'Draft PR open. Repairing the five stale tests is pending authorization.',
    'Everything else is done; approval needed before I merge main.',
    'Which option do you want?',
  ];
  for (const text of asks) assert.equal(needsReply(text), true, text);
  const reports = [
    'Auto-merge armed. / QA is document review; no UI applies.',
    'Opened https://example.test/pull/7?tab=checks and all checks passed.',
    'Approved stories were left unchanged.',
  ];
  for (const text of reports) assert.equal(needsReply(text), false, text);
});

test('a thread on another model or effort than the configured one is flagged on every state', () => {
  const want = { model: 'fast-model', effort: 'high' };
  assert.equal(modelDrift({ model: 'fast-model', reasoningEffort: 'high' }, want), '');
  assert.equal(modelDrift({ model: 'slow-model', reasoningEffort: 'high' }, want), 'MODEL(slow-model/high!=fast-model/high)');
  assert.equal(modelDrift({ model: 'fast-model', reasoningEffort: 'medium' }, want), 'MODEL(fast-model/medium!=fast-model/high)');
  assert.equal(modelDrift({ model: 'slow-model', reasoningEffort: 'medium' }, {}), '', 'nothing configured, nothing judged');
  assert.equal(modelDrift({}, want), '', 'a value the App Server does not report is not judged');
  const running = { status: 'inProgress', items: [item('i-1')] };
  assert.equal(summarize('w', { model: 'slow-model', reasoningEffort: 'medium' }, running, 'i-1', null, want), 'w inProgress i-1 - MODEL(slow-model/medium!=fast-model/high)');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-'));
  const lines = [
    'local a inProgress i-1 - MODEL(slow-model/medium!=fast-model/high)',
    'local b completed i-2 - MODEL(slow-model/high!=fast-model/high) LAST "done"',
    'local c completed i-3 - LAST "done"',
  ];
  const classified = spawnSync('zsh', [CLASSIFY, join(dir, 'history.txt'), '720'], { input: `${lines.join('\n')}\n`, encoding: 'utf8' });
  assert.deepEqual(classified.stdout.trim().split('\n'), [
    'session local a RUN MODEL(slow-model/medium!=fast-model/high)',
    'session local b IDLE LAST "done" MODEL(slow-model/high!=fast-model/high)',
    'session local c IDLE LAST "done"',
  ]);
});

test('run as a command, it classifies a failed turn and flags model drift from CODEX_MODEL and CODEX_EFFORT', { timeout: 30_000 }, async () => {
  const threads = {
    T1: { status: { type: 'notLoaded' }, model: 'slow-model', reasoningEffort: 'medium', turns: [{ id: 't-1', status: 'completed', items: [item('i-1', 'May I repair the tests?')] }] },
    T2: { status: { type: 'idle' }, model: 'fast-model', reasoningEffort: 'high', turns: [{ id: 't-2', status: 'failed', items: [item('i-2')], error: { message: 'You hit your usage limit', codexErrorInfo: 'usageLimitExceeded' } }] },
  };
  await withFakeServer(threads, async ({ dir, sock }) => {
    // A fake codex: `app-server daemon start` names the fake server's socket, `app-server proxy` pipes stdio to it.
    const codex = join(dir, 'codex');
    writeFileSync(codex, `#!/usr/bin/env node
const net = require('node:net');
const args = process.argv.slice(2).join(' ');
if (args.startsWith('app-server daemon start')) { process.stdout.write(JSON.stringify({ socketPath: ${JSON.stringify(sock)} })); process.exit(0); }
if (args.startsWith('app-server proxy')) { const s = net.connect(process.argv.at(-1)); process.stdin.pipe(s); s.pipe(process.stdout); s.on('close', () => process.exit(0)); }
else process.exit(1);
`);
    chmodSync(codex, 0o755);
    const child = spawn(process.execPath, [LIVENESS, dir, 'one=T1', 'two=T2'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CODEX_MODEL: 'fast-model', CODEX_EFFORT: 'high' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const status = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(status, 0);
    assert.deepEqual(stdout.trim().split('\n'), [
      'one completed i-1 - MODEL(slow-model/medium!=fast-model/high) NEEDS-REPLY "May I repair the tests?"',
      'two failed i-2 LIMIT',
    ]);
  });
});

test('an idle writer whose question waited 15 minutes is QUESTION-UNANSWERED; a report is not (#9118)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ask-'));
  const history = join(dir, 'history.txt');
  const asked = 'w completed i-9 - NEEDS-REPLY "Sort by rank or updated? / If no answer by 2026-10-22T09:04:00Z: rank"';
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(history, `remote:w i-9 ${now - 16 * 60}\nremote:r i-3 ${now - 60 * 60}\n`);
  const run = (line) => spawnSync('zsh', [CLASSIFY, history, '720', '900'], { input: `remote ${line}\n`, encoding: 'utf8' }).stdout;
  assert.equal(run(asked), `session remote w IDLE QUESTION-UNANSWERED(15m+) ${asked.slice('w completed i-9 - '.length)}\n`);
  assert.equal(run('r completed i-3 - LAST "Pushed abc; QA ready."'), 'session remote r IDLE LAST "Pushed abc; QA ready."\n', 'a report waits on nobody');
  writeFileSync(history, `remote:w i-9 ${now - 5 * 60}\n`);
  assert.doesNotMatch(run(asked), /QUESTION-UNANSWERED/, 'a fresh question is not flagged yet');
});
