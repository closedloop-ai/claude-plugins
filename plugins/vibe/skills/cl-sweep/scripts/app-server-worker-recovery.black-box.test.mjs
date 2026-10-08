import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test, { before, after } from 'node:test';
import { decodeWebSocketFrames } from './core-client-process.mjs';
import { registryFixtureCode, installRegistryFixture } from './core-client-fixture.mjs';

let restoreRegistry;
before(() => { restoreRegistry = installRegistryFixture(); });
after(() => restoreRegistry?.());

const execFileAsync = promisify(execFile);
const workerCli = resolve(import.meta.dirname, 'app-server-worker-session.mjs');
const ownershipCli = resolve(import.meta.dirname, 'ownership-lease.mjs');

function serverFrame(value) {
  const payload = Buffer.from(value);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function startFakeAppServer(socketPath, cwd) {
  const state = {
    threadId: 'worker-thread',
    status: 'idle',
    activeTurnId: null,
    turnStartCount: 0,
    created: false,
    materialized: false,
  };
  const thread = (includeTurns = false) => ({
    id: state.threadId,
    cwd,
    status: { type: state.status },
    canAcceptDirectInput: true,
    activeFlags: [],
    ...(includeTurns ? {
      turns: state.activeTurnId ? [{ id: state.activeTurnId, status: 'inProgress', items: [] }] : [],
    } : {}),
  });
  const resultFor = (message) => {
    const { method, params } = message;
    if (method === 'initialize') return {};
    if (method === 'thread/list') {
      return { data: state.created ? [thread()] : [], nextCursor: null };
    }
    if (method === 'thread/start' || method === 'thread/resume') {
      assert.equal(params.cwd, cwd);
      assert.equal(params.model, 'gpt-6-sol');
      if (method === 'thread/resume') assert.equal(params.threadId, state.threadId);
      if (method === 'thread/start') state.created = true;
      return { thread: thread() };
    }
    if (method === 'thread/read') {
      assert.equal(params.threadId, state.threadId);
      if (params.includeTurns && !state.materialized) {
        throw new Error('thread is not materialized yet; includeTurns is unavailable before first user message (-32600)');
      }
      return { thread: thread(Boolean(params.includeTurns)) };
    }
    if (method === 'thread/turns/list') {
      return { data: state.activeTurnId ? [{ id: state.activeTurnId, status: 'inProgress' }] : [] };
    }
    if (method === 'turn/start') {
      assert.equal(params.threadId, state.threadId);
      assert.equal(params.cwd, cwd);
      assert.equal(params.model, 'gpt-6-sol');
      assert.equal(params.effort, 'xhigh');
      state.turnStartCount += 1;
      state.materialized = true;
      // Reproduce the defect: App Server accepts a turn id but subsequently
      // reports an idle thread with no matching turn in durable history.
      return { turn: { id: 'stale-turn' } };
    }
    throw new Error(`Unexpected fake App Server method ${method}`);
  };
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    const read = () => {
      if (!handshaken) {
        const boundary = buffer.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const request = buffer.subarray(0, boundary).toString('utf8');
        buffer = buffer.subarray(boundary + 4);
        const key = /^Sec-WebSocket-Key:\s*(.+)\s*$/im.exec(request)?.[1];
        assert.ok(key);
        const accept = createHash('sha1')
          .update(`${key.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        handshaken = true;
      }
      const decoded = decodeWebSocketFrames(buffer);
      buffer = decoded.remainder;
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x8) {
          socket.end();
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        const message = JSON.parse(frame.payload.toString('utf8'));
        if (!Object.hasOwn(message, 'id')) continue;
        try {
          socket.write(serverFrame(JSON.stringify({ id: message.id, result: resultFor(message) })));
        } catch (error) {
          socket.write(serverFrame(JSON.stringify({ id: message.id, error: { code: -32603, message: error.message } })));
        }
      }
    };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      read();
    });
  });
  return { server, state };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('black box: writes, validates, reuses, and mutation-fences a compact local result artifact', async () => {
  const root = realpathSync(mkdtempSync(resolve('/tmp', 'cl-sweep-result-artifact-')));
  const repo = resolve(root, 'repo');
  const control = resolve(root, 'control');
  const sessionFile = resolve(control, 'session.json');
  const candidateFile = resolve(control, 'candidate-result.json');
  const callbackFile = resolve(control, 'callback.json');
  mkdirSync(repo);
  mkdirSync(control, { mode: 0o700 });
  execFileSync('git', ['init', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  writeFileSync(resolve(repo, 'README.md'), 'test\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init']);
  execFileSync('git', ['-C', repo, 'branch', '-m', 'codex/result-artifact-test']);
  const eventId = '11111111-1111-4111-8111-111111111111';
  const envelope = {
    schema: 'CL_SWEEP_RESULT v1',
    event_id: eventId,
    parent_thread_id: 'parent-1',
    root_generation: 1,
    ticket: 'ISS-1',
    worker_id: 'worker-1',
    owner_surface: 'cli',
    owner_generation: 1,
    lease_id: 'lease-1',
    lease_token_hash: 'a'.repeat(64),
    worktree: realpathSync(repo),
    kind: 'ANALYSIS_COMPLETE',
    phase: 'analysis',
    status: 'GO',
    result: { decision: 'GO', evidence: 'full analysis evidence '.repeat(1_000) },
  };
  try {
    execFileSync(process.execPath, [
      workerCli, 'init', '--session-file', sessionFile, '--worktree', repo,
      '--ticket', 'ISS-1', '--parent-thread-id', 'parent-1', '--parent-cwd', repo,
      '--root-generation', '1', '--owner-id', 'worker-1', '--generation', '1',
      '--lease-id', 'lease-1', '--lease-token-hash', 'a'.repeat(64),
      '--protocol-schema-sha256', 'c'.repeat(64),
    ]);
    writeFileSync(candidateFile, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    const first = JSON.parse(execFileSync(process.execPath, [
      workerCli, 'write-result-artifact', '--session-file', sessionFile,
      '--artifact-file', candidateFile,
    ], { encoding: 'utf8' }));
    assert.equal(first.created, true);
    assert.equal(first.result.transport, 'local_artifact');
    assert.equal(statSync(first.result.path).mode & 0o777, 0o600);

    const second = JSON.parse(execFileSync(process.execPath, [
      workerCli, 'write-result-artifact', '--session-file', sessionFile,
      '--artifact-file', candidateFile,
    ], { encoding: 'utf8' }));
    assert.equal(second.created, false);
    assert.deepEqual(second.result, first.result);

    const callback = {
      event_id: eventId,
      parent_thread_id: 'parent-1',
      root_generation: 1,
      ticket: 'ISS-1',
      worker_id: 'worker-1',
      owner_surface: 'cli',
      owner_generation: 1,
      lease_id: 'lease-1',
      lease_token_hash: 'a'.repeat(64),
      kind: 'ANALYSIS_COMPLETE',
      phase: 'analysis',
      status: 'GO',
      parent_action: 'execute',
      worktree: realpathSync(repo),
      payload: {
        summary: { decision: 'GO' },
        routing: { next: 'execute' },
        result: first.result,
      },
    };
    writeFileSync(callbackFile, `${JSON.stringify(callback)}\n`, { mode: 0o600 });
    const valid = JSON.parse(execFileSync(process.execPath, [
      workerCli, 'validate-callback', '--session-file', sessionFile,
      '--callback-file', callbackFile,
    ], { encoding: 'utf8' }));
    assert.equal(valid.eventId, eventId);

    writeFileSync(first.result.path, '{}\n', { mode: 0o600 });
    await assert.rejects(execFileAsync(process.execPath, [
      workerCli, 'validate-callback', '--session-file', sessionFile,
      '--callback-file', callbackFile,
    ]), (error) => /size mismatch/.test(error.stderr));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('black box: fences an absent stale turn and detached waiter without recreating the worker', async () => {
  const root = realpathSync(mkdtempSync(resolve('/tmp', 'cl-sweep-recover-')));
  const socketPath = resolve(root, 'daemon.sock');
  const repo = resolve(root, 'repo');
  const control = resolve(root, 'control');
  const sessionFile = resolve(control, 'session.json');
  const eventsFile = resolve(control, 'events.jsonl');
  const promptFile = resolve(control, 'prompt.md');
  const runnerFile = resolve(control, 'runner.json');
  const runnerLog = resolve(control, 'runner.log');
  const ledger = resolve(control, 'ownership.jsonl');
  const leaseSecret = resolve(control, 'lease.secret.json');
  const fakeCodex = resolve(root, 'codex-fixture.mjs');
  mkdirSync(repo);
  execFileSync('git', ['init', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  writeFileSync(resolve(repo, 'README.md'), 'test\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init']);
  execFileSync('git', ['-C', repo, 'branch', '-m', 'codex/recovery-test']);
  mkdirSync(control, { mode: 0o700 });
  const { server, state } = startFakeAppServer(socketPath, realpathSync(repo));
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolvePromise);
  });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { createConnection } from 'node:net';
const socketPath = ${JSON.stringify(socketPath)};
${registryFixtureCode()}
const args = process.argv.slice(2);
if (args[0] === 'app-server' && args[1] === 'proxy') {
  const socket = createConnection(socketPath);
  socket.on('connect', () => process.stdin.pipe(socket));
  socket.pipe(process.stdout);
  socket.on('error', (error) => { process.stderr.write(error.message); process.exitCode = 1; });
} else {
  process.stderr.write('unexpected fake codex command');
  process.exitCode = 2;
}
}
`);
  chmodSync(fakeCodex, 0o700);
  writeFileSync(promptFile, 'Continue after approved planning support.\n');
  let runnerPid = null;
  try {
    const lease = JSON.parse(execFileSync(process.execPath, [
      ownershipCli, 'acquire', '--ledger', ledger, '--ticket', 'ISS-1',
      '--secret-output', leaseSecret, '--owner-surface', 'cli',
      '--owner-role', 'ticket_worker', '--owner-id', 'worker-1', '--ttl-seconds', '300',
    ], { encoding: 'utf8' }));
    execFileSync(process.execPath, [
      workerCli, 'init', '--session-file', sessionFile, '--worktree', repo,
      '--ticket', 'ISS-1', '--parent-thread-id', 'parent-1', '--parent-cwd', repo,
      '--root-generation', '1', '--owner-id', 'worker-1', '--generation', '1',
      '--lease-id', lease.leaseId, '--lease-token-hash', lease.leaseTokenHash,
      '--protocol-schema-sha256', 'c'.repeat(64),
    ]);
    const launched = JSON.parse(execFileSync(process.execPath, [
      workerCli, 'launch', '--session-file', sessionFile, '--events-file', eventsFile,
      '--prompt-file', promptFile, '--runner-file', runnerFile, '--log-file', runnerLog,
      '--activity-phase', 'planning',
      '--socket', socketPath, '--codex', fakeCodex,
    ], { encoding: 'utf8' }));
    runnerPid = launched.pid;
    await waitFor(() => {
      const session = JSON.parse(readFileSync(sessionFile, 'utf8'));
      return session.activeTurnId === 'stale-turn' && session.state === 'RUNNING';
    }, 'stale durable turn');
    assert.equal(alive(runnerPid), true);
    assert.equal(state.turnStartCount, 1);

    const guards = [
      '--session-file', sessionFile,
      '--ownership-ledger', ledger,
      '--expected-ticket', 'ISS-1',
      '--expected-thread-id', 'worker-thread',
      '--expected-turn-id', 'stale-turn',
      '--expected-worktree', repo,
      '--expected-branch', 'codex/recovery-test',
      '--expected-owner-id', 'worker-1',
      '--expected-generation', '1',
      '--expected-lease-id', lease.leaseId,
      '--expected-parent-thread-id', 'parent-1',
      '--expected-root-generation', '1',
      '--expected-state', 'RUNNING',
      '--runner-file', runnerFile,
      '--socket', socketPath,
      '--codex', fakeCodex,
    ];
    state.status = 'active';
    state.activeTurnId = 'different-live-turn';
    await assert.rejects(execFileAsync(process.execPath, [
      workerCli, 'recover-absent-turn', ...guards,
    ]), (error) => /different active turn/.test(error.stderr));
    assert.equal(alive(runnerPid), true);
    assert.equal(JSON.parse(readFileSync(sessionFile, 'utf8')).activeTurnId, 'stale-turn');

    state.status = 'idle';
    state.activeTurnId = null;
    const recovered = JSON.parse((await execFileAsync(process.execPath, [
      workerCli, 'recover-absent-turn', ...guards,
    ])).stdout);
    assert.equal(recovered.action, 'stale_turn_fenced');
    assert.equal(recovered.continuable, true);
    await waitFor(() => !alive(runnerPid), 'runner fence');
    const session = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.equal(session.activeTurnId, null);
    assert.equal(session.state, 'INTERRUPTED');
    assert.equal(session.appServerThreadId, 'worker-thread');
    assert.equal(session.worktree, realpathSync(repo));
    assert.equal(session.ownerId, 'worker-1');
    assert.equal(session.generation, 1);
    assert.equal(session.leaseId, lease.leaseId);
    assert.equal(session.lastStaleTurnRecovery.turnId, 'stale-turn');
    assert.equal(JSON.parse(readFileSync(runnerFile, 'utf8')).status, 'FENCED_ABSENT_TURN');
    assert.equal(state.turnStartCount, 1);
  } finally {
    if (runnerPid && alive(runnerPid)) process.kill(runnerPid, 'SIGTERM');
    await new Promise((resolvePromise) => server.close(resolvePromise));
    rmSync(root, { recursive: true, force: true });
  }
});
