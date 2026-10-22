import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assistantTail, classifyTurnError, connectDirect, decodeFrames, encodeFrame, Failure, needsReply, parseSession, readSessions, readThreadState, summarize,
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
