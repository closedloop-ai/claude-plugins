import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./slot-lock.sh', import.meta.url));
const TIMEOUT = { timeout: 20_000 };

function lockRoot() {
  return mkdtempSync(join(tmpdir(), 'slot-lock-'));
}

function env(root) {
  return { ...process.env, SLOT_LOCK_DIR: root, SLOT_LOCK_POLL_SECONDS: '0.1' };
}

function runSync(root, args, input) {
  return spawnSync('bash', [SCRIPT, ...args], { env: env(root), encoding: 'utf8', input });
}

/** Spawns the script and resolves `waitFor(stream, text)` once that text appears on the stream. */
function start(root, args) {
  const child = spawn('bash', [SCRIPT, ...args], { env: env(root) });
  const seen = { stdout: '', stderr: '' };
  const waiters = [];
  for (const stream of ['stdout', 'stderr']) {
    child[stream].on('data', (chunk) => {
      seen[stream] += chunk;
      for (const w of waiters) if (seen[w.stream].includes(w.text)) w.resolve();
    });
  }
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const waitFor = (stream, text) => new Promise((resolve) => {
    if (seen[stream].includes(text)) resolve();
    else waiters.push({ stream, text, resolve });
  });
  return { child, exited, waitFor, seen };
}

/** A lock held by a live process: this test runner. */
function holdSlot(root, name, n, owner = 'holder') {
  const dir = join(root, `${name}-${n}.lock`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'pid'), `${process.pid}\n`);
  writeFileSync(join(dir, 'owner'), `${owner}\n`);
  return dir;
}

function deadPid() {
  return spawnSync('true').pid;
}

test('runs the command with its stdin, returns its exit status and frees the slot', TIMEOUT, () => {
  const root = lockRoot();
  const ok = runSync(root, ['e2e', 'w1', 'sh', '-c', 'cat; ls "$1"', '_', join(root, 'e2e-1.lock')], 'piped\n');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'piped\nowner\npid\n');
  assert.equal(existsSync(join(root, 'e2e-1.lock')), false);
  assert.equal(runSync(root, ['e2e', 'w1', 'sh', '-c', 'exit 7']).status, 7);
  assert.equal(existsSync(join(root, 'e2e-1.lock')), false);
});

test('records the owner label while the command runs', TIMEOUT, () => {
  const root = lockRoot();
  const result = runSync(root, ['heavy', 'pr-42 typecheck', 'cat', join(root, 'heavy-1.lock', 'owner')]);
  assert.match(result.stdout, /^pr-42 typecheck pid \d+ since \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n$/);
});

test('reclaims a slot whose holder pid is dead', TIMEOUT, () => {
  const root = lockRoot();
  const stale = holdSlot(root, 'e2e', 1);
  writeFileSync(join(stale, 'pid'), `${deadPid()}\n`);
  const result = runSync(root, ['e2e', 'w2', 'true']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(existsSync(stale), false);
});

test('takes a free slot of N without waiting and reports holders with --status', TIMEOUT, () => {
  const root = lockRoot();
  holdSlot(root, 'heavy', 1, 'w1 vitest');
  const result = runSync(root, ['--slots', '2', 'heavy', 'w2', 'ls', root]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /heavy-2\.lock/);
  assert.equal(runSync(root, ['--status', 'heavy']).stdout, 'w1 vitest\n');
});

test('waits while every slot is held by a live process, then runs once one frees', TIMEOUT, async () => {
  const root = lockRoot();
  const held = holdSlot(root, 'e2e', 1, 'w1 e2e');
  const run = start(root, ['e2e', 'w2', 'echo', 'ran']);
  await run.waitFor('stderr', 'slot-lock: e2e busy (w1 e2e); waiting');
  assert.equal(run.seen.stdout, '');
  spawnSync('rm', ['-rf', held]);
  assert.deepEqual(await run.exited, { code: 0, signal: null });
  assert.equal(run.seen.stdout, 'ran\n');
});

test('SIGTERM stops the command and frees the slot', TIMEOUT, async () => {
  const root = lockRoot();
  const marker = join(root, 'child-pid');
  const run = start(root, ['e2e', 'w1', 'sh', '-c', `echo $$ > ${marker}; echo started; exec sleep 30`]);
  await run.waitFor('stdout', 'started');
  run.child.kill('SIGTERM');
  assert.deepEqual(await run.exited, { code: 143, signal: null });
  assert.equal(existsSync(join(root, 'e2e-1.lock')), false);
  const childPid = Number(readFileSync(marker, 'utf8'));
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
});

test('rejects bad arguments with usage and exit 2', TIMEOUT, () => {
  const root = lockRoot();
  for (const args of [[], ['e2e', 'w1'], ['--slots', '0', 'e2e', 'w1', 'true'], ['--slots', 'x', 'e2e', 'w1', 'true'], ['../e2e', 'w1', 'true'], ['--status']]) {
    const result = runSync(root, args);
    assert.equal(result.status, 2, `args ${JSON.stringify(args)}`);
    assert.match(result.stderr, /Usage: slot-lock\.sh/);
  }
});
