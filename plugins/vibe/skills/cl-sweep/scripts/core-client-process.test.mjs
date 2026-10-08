import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import {
  AppServerClient, decodeWebSocketFrames, initializeClient, managedDaemon,
  readThreadState, sendInput,
} from './core-client-process.mjs';
import { fixtureSkillPath, installRegistryFixture, registryFixtureCode } from './core-client-fixture.mjs';
import { DISCOVERY_STAGE_TIMEOUT_MS, DISCOVERY_TOTAL_TIMEOUT_MS, resolveCoreSkill } from './resolve-core-skill.mjs';

function executable(root, name, body) {
  const path = join(root, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}`);
  chmodSync(path, 0o700);
  return path;
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

test('public core client preserves actual connection, RPC, events, state, delivery, timeout, and disposal', async t => {
  const restore = installRegistryFixture();
  t.after(restore);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'core-process-contract-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, 'daemon.sock');
  const observed = [];
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let opened = false;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!opened) {
        const boundary = buffer.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const key = /Sec-WebSocket-Key:\s*([^\r\n]+)/i.exec(buffer.subarray(0, boundary).toString('utf8'))?.[1];
        const accept = createHash('sha1').update(`${key.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(boundary + 4);
        opened = true;
      }
      const decoded = decodeWebSocketFrames(buffer);
      buffer = decoded.remainder;
      for (const item of decoded.frames) {
        if (item.opcode === 8) { socket.end(); continue; }
        if (item.opcode !== 1) continue;
        const message = JSON.parse(item.payload.toString('utf8'));
        observed.push(message);
        if (!Object.hasOwn(message, 'id') || message.method === 'pending') continue;
        if (message.method === 'fail') {
          socket.write(frame({ id: message.id, error: { code: -32600, message: 'fixture rejection' } }));
          continue;
        }
        let result = {};
        if (message.method === 'thread/read' || message.method === 'thread/resume') {
          result = { thread: { id: 'thread-1', cwd: root, status: { type: 'idle' } } };
        }
        if (message.method === 'turn/start') result = { turn: { id: 'turn-1' } };
        socket.write(frame({ id: message.id, result }));
        if (message.method === 'event') socket.write(frame({ method: 'item/completed', params: { marker: 'notification-1' } }));
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(accept => server.close(accept));
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(socketPath, accept); });
  const codex = executable(root, 'codex', `import {createConnection} from 'node:net';\n${registryFixtureCode()}
const args=process.argv.slice(2);
if(args[0]==='app-server'&&args[1]==='daemon') process.stdout.write(JSON.stringify({status:'running',socketPath:${JSON.stringify(socketPath)}}));
else if(args[0]==='app-server'&&args[1]==='proxy'){const socket=createConnection(${JSON.stringify(socketPath)});socket.on('connect',()=>process.stdin.pipe(socket));socket.pipe(process.stdout);socket.on('error',()=>process.exit(1));}
else process.exitCode=2;\n}\n`);
  assert.equal(managedDaemon({ codex }).socketPath, socketPath);
  const client = new AppServerClient({ codex, socket: socketPath });
  t.after(() => client.close());
  await initializeClient(client, { name: 'consumer', title: 'Consumer', version: '1.0.0' });
  const notification = new Promise(accept => client.onNotification((method, params) => accept({ method, params })));
  await client.request('event', {});
  assert.deepEqual(await notification, { method: 'item/completed', params: { marker: 'notification-1' } });
  assert.deepEqual(await readThreadState(client, 'thread-1'), {
    status: 'idle', activeTurnId: null, cwd: root, canAcceptDirectInput: true, activeFlags: [],
  });
  assert.deepEqual(await sendInput(client, { threadId: 'thread-1', cwd: root, waitSeconds: 1 }, [{ type: 'text', text: 'private input' }]),
    { status: 'accepted', mode: 'start', turnId: 'turn-1' });
  await assert.rejects(client.request('fail', {}), error => error.code === -32600 && /fixture rejection/.test(error.message));
  await assert.rejects(client.request('pending', {}, 20), /pending timed out/);
  assert.ok(observed.some(message => message.method === 'initialize' && message.params.clientInfo.name === 'consumer'));
  assert.ok(observed.some(message => message.method === 'turn/start' && message.params.input[0].text === 'private input'));
  const connectionClosed = new Promise(accept => client.onConnection((state, error) => accept({ state, message: error.message })));
  const pending = client.request('pending', {}, 5000);
  const pendingRejected = assert.rejects(pending, /connection closed/);
  for (const socket of sockets) socket.end();
  assert.deepEqual(await connectionClosed, { state: 'close', message: 'The managed App Server connection closed' });
  await pendingRejected;
  const closed = once(client.child, 'close');
  await client.operation('close');
  await closed;
  client.close();
  assert.equal(client.pending.size, 0);
  await assert.rejects(client.request('event', {}), /closed/);
});

test('named discovery uses actual installed skill paths for local and Git sources and rejects disabled or wrong owners', async t => {
  const root = mkdtempSync(join(tmpdir(), 'core-resolver-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const source of ['local', 'github']) {
    const codex = executable(root, `codex-${source}`, registryFixtureCode().replace("source:'github'", `source:'${source}'`) + 'process.exitCode=2;\n}\n');
    const result = await resolveCoreSkill({ runtime: 'codex', codex });
    assert.equal(result.skillDirectory, dirname(fixtureSkillPath()));
  }
  const disabled = executable(root, 'codex-disabled', registryFixtureCode().replace('installed:true,enabled:true', 'installed:true,enabled:false') + 'process.exitCode=2;\n}\n');
  await assert.rejects(resolveCoreSkill({ runtime: 'codex', codex: disabled }), /Install and enable/);
  const wrong = executable(root, 'codex-wrong', registryFixtureCode().replace("name:'closedloop-core:gh-monitor-pr',pluginId:'closedloop-core@closedloop-ai'", "name:'gh-monitor-pr',pluginId:'vibe@closedloop-ai'") + 'process.exitCode=2;\n}\n');
  await assert.rejects(resolveCoreSkill({ runtime: 'codex', codex: wrong }), /missing or ambiguous/);
});

test('Claude named discovery honors project precedence, disabled entries, and incompatible core', async t => {
  const root = mkdtempSync(join(tmpdir(), 'core-claude-resolver-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const coreRoot = dirname(dirname(dirname(fixtureSkillPath())));
  const coreAlias = join(root, 'installed-core');
  symlinkSync(coreRoot, coreAlias, 'dir');
  const registry = [
    { id: 'closedloop-core@closedloop-ai', enabled: true, scope: 'user', installPath: '/unavailable/user/core' },
    { id: 'closedloop-core@closedloop-ai', enabled: true, scope: 'project', installPath: coreAlias },
    { id: 'closedloop-core@closedloop-ai', enabled: false, scope: 'local', installPath: '/unavailable/local/core' },
  ];
  const claude = executable(root, 'claude', `process.stdout.write(${JSON.stringify(JSON.stringify(registry))});`);
  assert.equal((await resolveCoreSkill({ runtime: 'claude', claude })).skillDirectory, join(coreAlias, 'skills/gh-monitor-pr'));
  const old = executable(root, 'claude-old', `process.stdout.write(${JSON.stringify(JSON.stringify([{ ...registry[1], installPath: root }]))});`);
  await assert.rejects(resolveCoreSkill({ runtime: 'claude', claude: old }), /API is unavailable/);
});

test('thread-state forwarding preserves three independent RPC budgets and a single shrinking deadline', async t => {
  assert.equal(DISCOVERY_TOTAL_TIMEOUT_MS, DISCOVERY_STAGE_TIMEOUT_MS * 4 + 2000);
  const observed = [];
  const client = Object.assign(Object.create(AppServerClient.prototype), {
    operation: async (...args) => { observed.push(args); return { status: 'active' }; },
  });
  await readThreadState(client, 'thread-1');
  assert.equal(observed[0][2], 181_000);
  await readThreadState(client, 'thread-1', { timeoutMs: 40_000 });
  assert.equal(observed[1][2], 121_000);
  assert.deepEqual(observed[1][1].options, { timeoutMs: 40_000 });
  const previousNow = Date.now;
  t.after(() => { Date.now = previousNow; });
  Date.now = () => 10_000;
  await readThreadState(client, 'thread-1', { timeoutMs: () => 5000 });
  assert.deepEqual(observed[2][1].options, { deadline: 15_000 });
  assert.equal(observed[2][2], 6000);
});
