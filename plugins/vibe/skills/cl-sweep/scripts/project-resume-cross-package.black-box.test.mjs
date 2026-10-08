import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { decodeWebSocketFrames } from '../../gh-monitor-pr/scripts/native-app-server-client.mjs';

const execFileAsync = promisify(execFile);
const rootCli = resolve(import.meta.dirname, 'sweep-root-state.mjs');
const workerCli = resolve(import.meta.dirname, 'app-server-worker-session.mjs');
const monitorCli = resolve(import.meta.dirname, '../../gh-monitor-pr/scripts/monitor-pr.mjs');
const projectId = '019d54c6-d099-74a5-87d0-0a0d4cbdc599';

async function waitFor(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function spawnPublicCli(args, env) {
  const child = spawn(process.execPath, args, {
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
  return { child, exited };
}

async function killPublicCli(processHandle) {
  assert.equal(processHandle.child.exitCode, null, 'public CLI must still be alive before forced termination');
  process.kill(-processHandle.child.pid, 'SIGKILL');
  const exit = await processHandle.exited;
  assert.equal(exit.code, null);
  assert.equal(exit.signal, 'SIGKILL');
}

function serverFrame(value) {
  const payload = Buffer.from(value);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function startFixtureServer(socketPath, workerCwd, parentCwd) {
  const state = { workerCreated: false, workerMaterialized: false, parentAcceptances: 0 };
  const thread = (id, cwd, includeTurns = false) => ({
    id, cwd, status: { type: 'idle' }, canAcceptDirectInput: true, activeFlags: [],
    ...(includeTurns ? { turns: [] } : {}),
  });
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    const send = (value) => socket.write(serverFrame(JSON.stringify(value)));
    const handle = (message) => {
      const { id, method, params } = message;
      if (!Object.hasOwn(message, 'id')) return;
      if (method === 'initialize') return send({ id, result: {} });
      if (method === 'thread/list') {
        return send({ id, result: { data: state.workerCreated ? [thread('worker-thread', workerCwd)] : [], nextCursor: null } });
      }
      if (method === 'thread/start') {
        assert.equal(params.model, 'gpt-6-sol');
        state.workerCreated = true;
        return send({ id, result: { thread: thread('worker-thread', workerCwd) } });
      }
      if (method === 'thread/read') {
        if (params.threadId === 'worker-thread' && params.includeTurns && !state.workerMaterialized) {
          return send({ id, error: { code: -32600, message: 'thread is not materialized yet; no rollout found for thread id' } });
        }
        const cwd = params.threadId === 'worker-thread' ? workerCwd : parentCwd;
        return send({ id, result: { thread: thread(params.threadId, cwd, Boolean(params.includeTurns)) } });
      }
      if (method === 'thread/resume') {
        if (params.threadId === 'worker-thread') assert.equal(params.model, 'gpt-6-sol');
        const cwd = params.threadId === 'worker-thread' ? workerCwd : parentCwd;
        return send({ id, result: { thread: thread(params.threadId, cwd) } });
      }
      if (method === 'turn/start' && params.threadId === 'worker-thread') {
        assert.equal(params.model, 'gpt-6-sol');
        assert.equal(params.effort, 'xhigh');
        state.workerMaterialized = true;
        send({ id, result: { turn: { id: 'worker-turn', status: 'inProgress' } } });
        const event = {
          event_id: randomUUID(), parent_thread_id: 'root-2', root_generation: 2,
          ticket: 'ISS-1', worker_id: 'worker-1', owner_surface: 'cli', owner_generation: 1,
          lease_id: 'lease-1', lease_token_hash: 'a'.repeat(64), kind: 'EXECUTION_CHECKPOINT',
          phase: 'implementation', status: 'WAITING', parent_action: 'continue', worktree: workerCwd, payload: {},
        };
        setTimeout(() => {
          send({ method: 'item/completed', params: {
            threadId: 'worker-thread', turnId: 'worker-turn',
            item: { type: 'agentMessage', phase: 'final_answer', text: `done\nCL_SWEEP_EVENT v1 ${JSON.stringify(event)}` },
          } });
          send({ method: 'turn/completed', params: {
            threadId: 'worker-thread', turn: { id: 'worker-turn', status: 'completed', error: null },
          } });
        }, 10);
        return;
      }
      if (method === 'turn/start' && params.threadId === 'root-2') {
        state.parentAcceptances += 1;
        // Model remote acceptance while withholding the response so the caller
        // remains alive until the test kills it after observing the durable fence.
        return;
      }
      send({ id, error: { code: -32603, message: `Unexpected fixture method ${method}` } });
    };
    const read = () => {
      if (!handshaken) {
        const boundary = buffer.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const request = buffer.subarray(0, boundary).toString('utf8');
        buffer = buffer.subarray(boundary + 4);
        const key = /^Sec-WebSocket-Key:\s*(.+)\s*$/im.exec(request)?.[1];
        const accept = createHash('sha1').update(`${key.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        handshaken = true;
      }
      const decoded = decodeWebSocketFrames(buffer);
      buffer = decoded.remainder;
      for (const frame of decoded.frames) {
        if (frame.opcode === 1) handle(JSON.parse(frame.payload.toString('utf8')));
      }
    };
    socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); read(); });
  });
  return { server, state };
}

test('public processes serialize adoption and fence worker and monitor callback replay across restart', async () => {
  const root = realpathSync(mkdtempSync(resolve('/tmp', 'project-resume-public-')));
  const repo = resolve(root, 'repo');
  const rootCwd = resolve(root, 'root-cwd');
  const stateBase = resolve(root, 'state');
  const socketPath = resolve(root, 'app-server.sock');
  const fakeCodex = resolve(root, 'codex');
  mkdirSync(rootCwd);
  execFileSync('git', ['init', repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  writeFileSync(resolve(repo, 'README.md'), 'test\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'branch', '-m', 'codex/test']);
  const { server, state } = startFixtureServer(socketPath, realpathSync(repo), realpathSync(rootCwd));
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(socketPath, resolvePromise); });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { createConnection } from 'node:net';
const socketPath = ${JSON.stringify(socketPath)};
const args = process.argv.slice(2);
if (args[0] === '--version') process.stdout.write('codex-fixture 1.0.0\\n');
else if (args[0] === 'app-server' && args[1] === 'daemon') process.stdout.write(JSON.stringify({ status: 'running', socketPath }) + '\\n');
else if (args[0] === 'app-server' && args[1] === 'proxy') {
  const socket = createConnection(socketPath);
  socket.on('connect', () => process.stdin.pipe(socket));
  socket.pipe(process.stdout);
} else process.exitCode = 2;
`);
  chmodSync(fakeCodex, 0o700);
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}` };
  const rootArgs = (threadId) => [rootCli, 'open', '--state-base', stateBase, '--project', projectId,
    '--repo', 'openai/symphony-alpha', '--repo-path', repo, '--user', 'user-1',
    '--root-thread-id', threadId, '--root-cwd', rootCwd, '--owner-surface', 'cli'];
  try {
    const created = JSON.parse((await execFileAsync(process.execPath, rootArgs('root-1'), { env })).stdout);
    assert.equal(created.action, 'created');
    const adopted = await Promise.all([
      execFileAsync(process.execPath, rootArgs('root-2'), { env }),
      execFileAsync(process.execPath, rootArgs('root-2'), { env }),
    ]);
    const adoptionResults = adopted.map((item) => JSON.parse(item.stdout));
    assert.deepEqual(adoptionResults.map((item) => item.action).sort(), ['adopted', 'resumed']);
    const adoptedRoot = adoptionResults.find((item) => item.action === 'adopted').root;

    const control = resolve(adoptedRoot.rootPath, 'sessions', 'ISS-1', '1');
    mkdirSync(control, { recursive: true });
    const sessionFile = resolve(control, 'session.json');
    const eventsFile = resolve(control, 'events.jsonl');
    const promptFile = resolve(control, 'prompt.md');
    writeFileSync(promptFile, 'Run one public worker turn.\n');
    execFileSync(process.execPath, [workerCli, 'init', '--session-file', sessionFile, '--worktree', repo,
      '--ticket', 'ISS-1', '--parent-thread-id', 'root-2', '--parent-cwd', rootCwd,
      '--root-generation', '2', '--owner-id', 'worker-1', '--generation', '1',
      '--lease-id', 'lease-1', '--lease-token-hash', 'a'.repeat(64),
      '--protocol-schema-sha256', 'c'.repeat(64)], { env });
    const workerProcess = spawnPublicCli([workerCli, 'run', '--session-file', sessionFile,
      '--events-file', eventsFile, '--prompt-file', promptFile, '--activity-phase', 'planning',
      '--socket', socketPath, '--codex', fakeCodex], env);
    await waitFor(() => (
      state.parentAcceptances === 1
      && JSON.parse(readFileSync(sessionFile, 'utf8')).events[0].delivery.status === 'delivering'
    ), 'worker remote acceptance and durable delivery fence');
    await killPublicCli(workerProcess);
    await assert.rejects(execFileAsync(process.execPath, [workerCli, 'notify-parent',
      '--session-file', sessionFile, '--socket', socketPath, '--codex', fakeCodex], { env }), /ambiguous accepted outcome/);
    assert.equal(state.parentAcceptances, 1);

    const monitorFile = resolve(root, 'monitor.json');
    const monitorEvent = { eventId: 'monitor-event-1', kind: 'ci_checks_failed', severity: 'attention', details: {} };
    writeFileSync(monitorFile, `${JSON.stringify({
      version: 4, status: 'running', pr: { url: 'https://github.com/openai/symphony-alpha/pull/1' },
      threadId: 'root-2', ownerSurface: 'cli', ownerGeneration: 2, cwd: realpathSync(rootCwd),
      intervalSeconds: 60, codexExecutable: fakeCodex, appServerSocket: socketPath,
      notificationTransport: 'proxy', pendingEvents: [monitorEvent], deliveredEventIds: [],
      deliveryOutbox: [], stateFile: monitorFile,
    })}\n`);
    await execFileAsync(process.execPath, [rootCli, 'register-monitor', '--state-base', stateBase,
      '--sweep-id', adoptedRoot.sweepId, '--root-thread-id', 'root-2', '--root-generation', '2',
      '--state-file', monitorFile], { env });
    const monitorProcess = spawnPublicCli([monitorCli, 'run', '--state-file', monitorFile], env);
    await waitFor(() => (
      state.parentAcceptances === 2
      && JSON.parse(readFileSync(monitorFile, 'utf8')).deliveryOutbox[0].delivery.status === 'delivering'
    ), 'monitor remote acceptance and durable delivery fence');
    await killPublicCli(monitorProcess);
    await execFileAsync(process.execPath, [monitorCli, 'run', '--state-file', monitorFile], { env });
    assert.equal(state.parentAcceptances, 2);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    rmSync(root, { recursive: true, force: true });
  }
});
