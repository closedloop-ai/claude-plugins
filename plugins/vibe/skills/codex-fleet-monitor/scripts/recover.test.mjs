import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { answerThreadRead } from './test-support.mjs';
import {
  acquireLock, DEFAULT_CONTINUE_PROMPT, lockHolder, readConfig, recoverPass, reportLine,
} from './recover.mjs';
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { isolatedVibeEnvironment, makeHome } from '../../vibe/scripts/test-fixtures.mjs';

const { connectDirect, decodeFrames } = await vibeCore("lib/codex-fleet-monitor/scripts/liveness.mjs");

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const SYSTEM_ERROR = 'The App Server thread is in a system-error state';
const OVERLOADED = { message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded', additionalDetails: null };
const MINUTE = 60_000;
const READS = new Set(['initialize', 'thread/read', 'thread/turns/list', 'thread/items/list']);

async function stopChild(child, step, graceMs = 30_000, processGroup = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  if (processGroup && child.pid > 1) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM');
  const deadline = () => new Promise((resolve) => { const timer = setTimeout(() => resolve(false), graceMs); timer.unref(); });
  const graceful = await Promise.race([closed.then(() => true), deadline()]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    if (processGroup && child.pid > 1) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL');
  }
  const ended = await Promise.race([closed.then(() => true), deadline()]);
  if (!ended) throw new Error(`${step} did not exit after SIGKILL`);
}

async function waitForReadyLine(child, text, step, timeoutMs = 60_000) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const done = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.stdout?.removeListener('data', onData);
      if (error) {
        let cleanup = '';
        try { await stopChild(child, step, Math.min(500, timeoutMs)); }
        catch (failure) { cleanup = `; cleanup: ${failure.message}`; }
        reject(new Error(`${error}; stdout=${stdout.trim()}; stderr=${stderr.trim()}${cleanup}`));
      }
      else resolve({ stdout, stderr });
    };
    const onError = (error) => void done(`${step} failed to start: ${error.message}`);
    const onExit = (code, signal) => void done(`${step} exited before its ready line (code ${code}, signal ${signal})`);
    const onData = () => { if (stdout.includes(text)) void done(null); };
    child.on('error', onError);
    child.on('exit', onExit);
    child.stdout?.on('data', onData);
    timer = setTimeout(() => void done(`${step} never printed its ready line within ${timeoutMs}ms`), timeoutMs);
  });
}

function runStep(step, command, args, { timeoutMs = 25_000, ...options } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(new Error(`${step} did not exit: ${error.message}; stdout=${stdout}; stderr=${stderr}`));
      else resolve({ status: error?.code ?? 0, stdout, stderr });
    });
  });
}

function serverFrame(text) {
  const body = Buffer.from(text);
  const header = body.length < 126
    ? Buffer.from([0x81, body.length])
    : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([header, body]);
}

/**
 * A stateful fake App Server. A thread in systemError refuses resume and turn/start, as the real one did;
 * restart() is the daemon restart: every thread reloads as notLoaded and an active turn is interrupted.
 */
function fakeAppServer(threads) {
  const calls = [];
  let turnCount = 0;
  let restarts = 0;
  const answer = (method, params) => {
    const thread = threads[params?.threadId];
    if (method === 'initialize') return {};
    if (!thread) throw new Error('no such thread');
    const read = answerThreadRead(threads, method, params);
    if (read) return read;
    if (thread.status.type === 'systemError') throw new Error(SYSTEM_ERROR);
    if (method === 'thread/resume') {
      if (thread.status.type === 'notLoaded') thread.status = { type: 'idle' };
      return { thread: { id: params.threadId } };
    }
    if (method === 'turn/start') {
      if (thread.status.type !== 'idle') throw new Error(`thread is ${thread.status.type}`);
      turnCount += 1;
      const turn = { id: `new-${turnCount}`, status: 'inProgress', items: [], error: null };
      thread.turns.push(turn);
      thread.status = { type: 'active', activeFlags: [] };
      return { turn: { id: turn.id } };
    }
    throw new Error(`unexpected ${method}`);
  };
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
        if (message.id === undefined) continue;
        calls.push({ method: message.method, params: message.params });
        let reply;
        try {
          reply = { id: message.id, result: answer(message.method, message.params) };
        } catch (error) {
          reply = { id: message.id, error: { code: -32600, message: error.message } };
        }
        socket.write(serverFrame(JSON.stringify(reply)));
      }
    });
    socket.on('error', () => {});
  });
  const restart = () => {
    restarts += 1;
    for (const thread of Object.values(threads)) {
      const last = thread.turns.at(-1);
      if (last?.status === 'inProgress') last.status = 'interrupted';
      thread.status = { type: 'notLoaded' };
    }
  };
  return { server, calls, restart, restarts: () => restarts };
}

async function harness(threads, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-recover-'));
  const fake = fakeAppServer(threads);
  const sock = join(dir, 's.sock');
  await new Promise((resolve) => fake.server.listen(sock, resolve));
  const connect = async () => {
    const client = connectDirect(sock);
    await client.initialize();
    return client;
  };
  const config = readConfig(env);
  const pass = (now) => recoverPass({ stateDir: dir, specs: Object.keys(threads).map((id) => `${id.toLowerCase()}=${id}`), config, connect, restart: fake.restart, now, host: 'hostA' });
  return { dir, fake, pass, close: () => fake.server.close() };
}

const failedTurn = (id, error = OVERLOADED) => ({ id, status: 'failed', items: [1, 2], error });
const turnStarts = (calls) => calls.filter((call) => call.method === 'turn/start');

test('a transient failure waits out the backoff, then resumes with the continue prompt', async () => {
  const threads = { T1: { status: { type: 'idle' }, turns: [failedTurn('t-1')] } };
  const h = await harness(threads);
  try {
    const first = await h.pass(0);
    assert.equal(first.length, 1);
    assert.match(first[0], /^EVENT recovery t1 transient-failure turn=t-1 code=serverOverloaded retry=1\/3 in=120s: Selected model is at capacity/);
    assert.deepEqual(await h.pass(2 * MINUTE - 1), []);
    assert.equal(turnStarts(h.fake.calls).length, 0);
    assert.deepEqual(await h.pass(2 * MINUTE), ['EVENT recovery t1 resumed attempt=1/3 turn=new-1']);
    const [start] = turnStarts(h.fake.calls);
    assert.equal(start.params.threadId, 'T1');
    assert.equal(start.params.approvalPolicy, 'never');
    assert.equal(start.params.input[0].text, DEFAULT_CONTINUE_PROMPT);
    assert.match(DEFAULT_CONTINUE_PROMPT, /git status and HEAD/);
    assert.match(DEFAULT_CONTINUE_PROMPT, /Do not redo steps that are already finished/);
    assert.deepEqual(await h.pass(3 * MINUTE), [], 'a running resumed turn is left alone');
    threads.T1.turns.at(-1).status = 'completed';
    assert.deepEqual(await h.pass(4 * MINUTE), ['EVENT recovery t1 recovered after 1 retry']);
    assert.match(reportLine(h.dir, 'local'), /^recovery local 3 recovery t1 recovered after 1 retry$/);
  } finally {
    h.close();
  }
});

test('overloaded, then stuck in systemError: retries, then with the switch on restarts and resumes the interrupted sessions', async () => {
  const threads = {
    T1: { status: { type: 'systemError' }, turns: [failedTurn('t-1')] },
    T2: { status: { type: 'active', activeFlags: [] }, turns: [{ id: 't-2', status: 'inProgress', items: [1], error: null }] },
    T3: { status: { type: 'idle' }, turns: [{ id: 't-3', status: 'completed', items: [1], error: null }] },
  };
  const h = await harness(threads, { AUTO_RESTART_DAEMON: '1' });
  try {
    await h.pass(0);
    const tries = [];
    for (const at of [2, 7, 17]) tries.push(...await h.pass(at * MINUTE));
    assert.deepEqual(tries.slice(0, 2), [
      `EVENT recovery t1 resume-failed attempt=1/3: ${SYSTEM_ERROR}`,
      `EVENT recovery t1 resume-failed attempt=2/3: ${SYSTEM_ERROR}`,
    ]);
    assert.equal(tries[2], `EVENT recovery t1 resume-failed attempt=3/3: ${SYSTEM_ERROR}`);
    assert.match(tries[3], /^EVENT recovery !!! RESTARTING the Codex App Server daemon on hostA: sessions=t1 are stuck in systemError/);
    assert.equal(h.fake.restarts(), 1);
    assert.deepEqual(tries.slice(7), [
      'EVENT recovery t1 resumed-after-restart turn=new-1',
      'EVENT recovery t2 resumed-after-restart turn=new-2',
      'EVENT recovery t3 left-idle-after-restart',
    ]);
    assert.deepEqual(turnStarts(h.fake.calls).map((call) => call.params.threadId), ['T1', 'T2']);
    assert.ok(turnStarts(h.fake.calls).every((call) => call.params.input[0].text === DEFAULT_CONTINUE_PROMPT));

    // The resumed turn fails the same way inside the cooldown: no second restart, one alert.
    threads.T1.turns.at(-1).status = 'failed';
    threads.T1.turns.at(-1).error = OVERLOADED;
    threads.T1.status = { type: 'systemError' };
    const later = [];
    for (const at of [18, 20, 25, 35, 36]) later.push(...await h.pass(at * MINUTE));
    assert.equal(h.fake.restarts(), 1);
    assert.equal(later.filter((line) => /restart-cooldown sessions=t1/.test(line)).length, 1);
  } finally {
    h.close();
  }
});

test('a restart resumes only the sessions whose turn was active or failed, and leaves an idle one idle', async () => {
  const threads = {
    T1: { status: { type: 'systemError' }, turns: [failedTurn('t-1')] },
    T2: { status: { type: 'active', activeFlags: [] }, turns: [{ id: 't-2', status: 'inProgress', items: [1], error: null }] },
    T3: { status: { type: 'idle' }, turns: [{ id: 't-3', status: 'completed', items: [1], error: null }] },
    T4: { status: { type: 'idle' }, turns: [failedTurn('t-4', { message: 'boom', codexErrorInfo: 'sandboxError' })] },
  };
  const h = await harness(threads, { AUTO_RESTART_DAEMON: '1', RECOVERY_BACKOFF_SECONDS: '0' });
  try {
    const events = await h.pass(0);
    assert.equal(h.fake.restarts(), 1);
    assert.deepEqual(events.filter((line) => /before-restart/.test(line)), [
      'EVENT recovery t1 before-restart thread=systemError turn=failed',
      'EVENT recovery t2 before-restart thread=active turn=inProgress',
      'EVENT recovery t3 before-restart thread=idle turn=completed',
      'EVENT recovery t4 before-restart thread=idle turn=failed',
    ]);
    assert.deepEqual(turnStarts(h.fake.calls).map((call) => call.params.threadId), ['T1', 'T2', 'T4']);
    assert.ok(events.includes('EVENT recovery t3 left-idle-after-restart'));
    assert.ok(!events.some((line) => /t3 resumed/.test(line)));
    assert.equal(threads.T3.turns.length, 1, 'the idle session got no continue prompt');
    assert.equal(threads.T2.turns[0].status, 'interrupted');
  } finally {
    h.close();
  }
});

test('with the switch off, a thread stuck in systemError raises one alert and the daemon is not restarted', async () => {
  const threads = { T1: { status: { type: 'systemError' }, turns: [failedTurn('t-1')] } };
  const h = await harness(threads, { RECOVERY_BACKOFF_SECONDS: '0 0' });
  try {
    await h.pass(0);
    const events = await h.pass(1);
    assert.match(events.at(-1), /^EVENT recovery ALERT hostA daemon-restart-needed sessions=t1: .*AUTO_RESTART_DAEMON is off/);
    assert.deepEqual(await h.pass(2), [], 'the alert is not repeated');
    assert.equal(h.fake.restarts(), 0);
    assert.equal(turnStarts(h.fake.calls).length, 0);
  } finally {
    h.close();
  }
});

test('a usage limit or an ordinary error is left for a human', async () => {
  const threads = {
    T1: { status: { type: 'idle' }, turns: [failedTurn('t-1', { message: 'You hit your usage limit', codexErrorInfo: 'usageLimitExceeded' })] },
    T2: { status: { type: 'idle' }, turns: [failedTurn('t-2', { message: 'boom', codexErrorInfo: 'sandboxError' })] },
  };
  const h = await harness(threads, { RECOVERY_BACKOFF_SECONDS: '0' });
  try {
    assert.deepEqual(await h.pass(0), []);
    assert.equal(h.fake.calls.filter((call) => !READS.has(call.method)).length, 0);
  } finally {
    h.close();
  }
});

test('retries that keep failing outside systemError give up once, naming a human', async () => {
  const threads = { T1: { status: { type: 'idle' }, turns: [failedTurn('t-1')] } };
  const h = await harness(threads, { RECOVERY_BACKOFF_SECONDS: '0' });
  try {
    assert.deepEqual((await h.pass(0)).slice(1), ['EVENT recovery t1 resumed attempt=1/1 turn=new-1']);
    Object.assign(threads.T1.turns.at(-1), { status: 'failed', error: OVERLOADED });
    threads.T1.status = { type: 'idle' };
    assert.deepEqual(await h.pass(1), ['EVENT recovery t1 gave-up after 1 retry; needs a human']);
    assert.deepEqual(await h.pass(2), []);
  } finally {
    h.close();
  }
});

test('a resume keeps the cwd, model, effort and sandbox a state file records', async () => {
  const threads = { T1: { status: { type: 'idle' }, turns: [failedTurn('t-1')] } };
  const h = await harness(threads, { RECOVERY_BACKOFF_SECONDS: '0' });
  try {
    writeFileSync(join(h.dir, 'w1.json'), JSON.stringify({ threadId: 'T1', cwd: '/wt', model: 'm1', effort: 'high', sandbox: 'workspace-write', turns: [] }));
    const config = readConfig({ RECOVERY_BACKOFF_SECONDS: '0' });
    const connect = async () => {
      const client = connectDirect(join(h.dir, 's.sock'));
      await client.initialize();
      return client;
    };
    await recoverPass({ stateDir: h.dir, specs: ['w1'], config, connect, restart: h.fake.restart, now: 0 });
    const resume = h.fake.calls.find((call) => call.method === 'thread/resume');
    assert.deepEqual(resume.params, { threadId: 'T1', cwd: '/wt', model: 'm1', sandbox: 'workspace-write', approvalPolicy: 'never' });
    const [start] = turnStarts(h.fake.calls);
    assert.deepEqual({ ...start.params, input: undefined }, { threadId: 'T1', input: undefined, cwd: '/wt', model: 'm1', effort: 'high', approvalPolicy: 'never' });
  } finally {
    h.close();
  }
});

test('a session fleet-orchestrator ended is never read or resumed (its thread is archived)', async () => {
  const threads = { T1: { status: { type: 'idle' }, turns: [failedTurn('t-1')] } };
  const h = await harness(threads, { RECOVERY_BACKOFF_SECONDS: '0' });
  try {
    writeFileSync(join(h.dir, 'w1.json'), JSON.stringify({ threadId: 'T1', cwd: '/wt', turns: [], ended: { reason: 'merged', at: 't' }, archivedAt: 't' }));
    const config = readConfig({ RECOVERY_BACKOFF_SECONDS: '0' });
    const connect = async () => {
      const client = connectDirect(join(h.dir, 's.sock'));
      await client.initialize();
      return client;
    };
    assert.deepEqual(await recoverPass({ stateDir: h.dir, specs: ['w1'], config, connect, restart: h.fake.restart, now: 0 }), []);
    assert.equal(h.fake.calls.some((call) => call.method === 'thread/resume' || call.method === 'thread/read'), false);
    writeFileSync(join(h.dir, 'w1.json'), JSON.stringify({ threadId: 'T1', cwd: '/wt', turns: [] }));
    await recoverPass({ stateDir: h.dir, specs: ['w1'], config, connect, restart: h.fake.restart, now: 0 });
    assert.equal(turnStarts(h.fake.calls).length, 1, 'the same session before it ended is resumed');
  } finally {
    h.close();
  }
});

test('readConfig reads the backoff list and refuses a bad one', () => {
  assert.deepEqual(readConfig({}).backoffMs, [120_000, 300_000, 600_000]);
  assert.deepEqual(readConfig({ RECOVERY_BACKOFF_SECONDS: '60,90 120' }).backoffMs, [60_000, 90_000, 120_000]);
  assert.equal(readConfig({}).autoRestart, false);
  assert.equal(readConfig({ AUTO_RESTART_DAEMON: '1' }).autoRestart, true);
  assert.throws(() => readConfig({ RECOVERY_BACKOFF_SECONDS: '2m' }), /RECOVERY_BACKOFF_SECONDS/);
});

test('a lock refuses a second holder while the first lives, and a dead holder is taken over', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fleet-lock-')), 'x.lock');
  const first = acquireLock(path);
  assert.equal(first.acquired, true);
  assert.deepEqual(acquireLock(path, process.pid + 1), { acquired: false, pid: process.pid });
  first.release();
  assert.equal(existsSync(path), false);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  writeFileSync(path, `${dead}\n`);
  assert.equal(lockHolder(path), null);
  assert.equal(acquireLock(path).acquired, true);
  assert.equal(readFileSync(path, 'utf8').trim(), String(process.pid));
});

test('a second supervisor on the host exits while the first holds the lock', { timeout: 150_000 }, async (t) => {
  const fixture = makeHome('fleet-supervise-');
  const dir = fixture.root;
  const env = { ...isolatedVibeEnvironment(fixture.home), FLEET_SUPERVISOR_LOCK: join(dir, 'supervisor.lock'), LOCAL_STATE_DIR: dir, PATH: '' };
  const first = spawn(process.execPath, [join(HERE, 'supervise.mjs'), dir, '3600'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  t.after(async () => {
    try { await stopChild(first, 'first supervisor cleanup', 5000, true); }
    finally { fixture.cleanup(); }
  });
  try {
    await waitForReadyLine(first, 'supervise: pid', 'first supervisor');
    assert.equal(lockHolder(env.FLEET_SUPERVISOR_LOCK), first.pid);
    const second = await runStep('second supervisor', process.execPath, [join(HERE, 'supervise.mjs'), dir, '3600'], { cwd: dir, env });
    assert.equal(second.status, 3);
    assert.match(second.stderr, new RegExp(`another supervisor \\(pid ${first.pid}\\)`));

    // While a supervisor runs, a watcher's own pass steps aside without touching the App Server.
    const watcherPass = await runStep('watcher pass', process.execPath, [join(HERE, 'recover.mjs'), dir, 'w1=T1'], { cwd: dir, env });
    assert.equal(watcherPass.status, 0);
    assert.equal(watcherPass.stdout, '');
  } finally {
    await stopChild(first, 'first supervisor cleanup', 5000, true);
  }
  for (let attempt = 0; attempt < 40 && existsSync(env.FLEET_SUPERVISOR_LOCK); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(existsSync(env.FLEET_SUPERVISOR_LOCK), false,
    `the lock is released on SIGTERM (exit=${first.exitCode}, signal=${first.signalCode}, lock=${existsSync(env.FLEET_SUPERVISOR_LOCK) ? readFileSync(env.FLEET_SUPERVISOR_LOCK, 'utf8').trim() : 'gone'})`);
});

test('ISS-14184 a stalled supervisor ready line fails by step name and is killed', { timeout: 5_000 }, async () => {
  const first = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const started = Date.now();
  await assert.rejects(waitForReadyLine(first, 'supervise: pid', 'first supervisor', 250),
    /first supervisor never printed its ready line within 250ms; stdout=; stderr=/);
  assert.ok(Date.now() - started < 1_000);
  assert.notEqual(first.signalCode, null, 'the stalled supervisor is dead after the deadline');
});

test('AC-020 a stalled supervisor probe reports the bounded subprocess by name', { timeout: 5000 }, async () => {
  await assert.rejects(runStep('watcher pass', process.execPath, ['-e', 'setTimeout(() => process.exit(0), 1000)'], { timeoutMs: 250 }),
    /watcher pass did not exit/);
});

test('a recovery pass reads each thread status and newest turn, never the history', async () => {
  const history = Array.from({ length: 20 }, (_, n) => ({ id: `old-${n}`, status: 'completed', items: [1, 2, 3], error: null }));
  const threads = { T1: { status: { type: 'idle' }, turns: [...history, failedTurn('t-1')] } };
  const h = await harness(threads);
  try {
    const [event] = await h.pass(0);
    assert.match(event, /^EVENT recovery t1 transient-failure turn=t-1 code=serverOverloaded/);
    const reads = h.fake.calls.filter((call) => call.method === 'thread/read');
    assert.ok(reads.length > 0);
    assert.ok(reads.every((call) => call.params.includeTurns !== true), 'no pass asks for the turns');
    assert.ok(h.fake.calls.some((call) => call.method === 'thread/turns/list' && call.params.limit === 1));
  } finally {
    h.close();
  }
});

test('the events log moves to events.log.1 at LOG_MAX_BYTES', async () => {
  const threads = { T1: { status: { type: 'idle' }, turns: [failedTurn('t-1')] } };
  const h = await harness(threads, { RECOVERY_BACKOFF_SECONDS: '0', LOG_MAX_BYTES: '100' });
  try {
    await h.pass(0);
    Object.assign(threads.T1.turns.at(-1), { status: 'failed', error: OVERLOADED });
    threads.T1.status = { type: 'idle' };
    assert.deepEqual(await h.pass(1), ['EVENT recovery t1 gave-up after 1 retry; needs a human']);
    const log = join(h.dir, '.fleet-recovery', 'events.log');
    assert.ok(statSync(log).size <= 100, `events.log is ${statSync(log).size} bytes`);
    assert.match(readFileSync(log, 'utf8'), /^\S+ EVENT recovery t1 gave-up after 1 retry; needs a human\n$/);
    assert.match(readFileSync(`${log}.1`, 'utf8'), /EVENT recovery t1 resumed attempt=1\/1/);
    assert.equal(existsSync(`${log}.2`), false, 'one old file is kept');
    assert.match(reportLine(h.dir, 'local'), /^recovery local 1 recovery t1 gave-up/);
  } finally {
    h.close();
  }
});

test('an idle writer whose question passed its deadline is resumed once on its stated default; a flag question is not (7 quiet hours)', async () => {
  const asked = (text) => ({ id: 'q-1', status: 'completed', error: null, items: [{ id: 'i-1', type: 'agentMessage', text }] });
  const threads = {
    T1: { status: { type: 'idle' }, turns: [asked('Sort the board by rank or by updated time?\nIf no answer by 2026-10-22T06:15:00.000Z: sort by rank')] },
    T2: { status: { type: 'notLoaded' }, turns: [asked('May I add the feature flag key board-v2?\nIf no answer by 2026-10-22T06:15:00.000Z: add it')] },
    T3: { status: { type: 'idle' }, turns: [asked('Pushed abc123; QA ready.')] },
  };
  const h = await harness(threads);
  const at = (iso) => Date.parse(iso);
  try {
    assert.deepEqual(await h.pass(at('2026-10-22T06:14:00Z')), [], 'before the deadline nothing moves');
    const events = await h.pass(at('2026-10-22T06:16:00Z'));
    assert.deepEqual(events, ['EVENT recovery t1 proceeded-on-default turn=new-1 asked=q-1: sort by rank']);
    const [start] = turnStarts(h.fake.calls);
    assert.equal(start.params.threadId, 'T1');
    assert.match(start.params.input[0].text, /Go ahead on your stated default: sort by rank/);
    threads.T1.turns.at(-1).status = 'completed';
    threads.T1.status = { type: 'idle' };
    threads.T1.turns.at(-1).items = threads.T1.turns[0].items;
    threads.T1.turns.at(-1).id = 'q-1';
    assert.deepEqual(await h.pass(at('2026-10-22T07:00:00Z')), [], 'once per asking turn');
    assert.equal(turnStarts(h.fake.calls).length, 1);
  } finally {
    h.close();
  }
});
