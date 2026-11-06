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
  return { ...process.env, SLOT_LOCK_DIR: root, SLOT_LOCK_POLL_SECONDS: '0.1', SLOT_LOCK_HELD_PATH: '', SLOT_LOCK_HELD_PID: '' };
}

function runSync(root, args, input) {
  return spawnSync('bash', [SCRIPT, ...args], { env: env(root), encoding: 'utf8', input });
}

/** Spawns the script and resolves `waitFor(stream, text)` once that text appears on the stream. */
function start(root, args, envOverrides = {}) {
  const child = spawn('bash', [SCRIPT, ...args], { env: { ...env(root), ...envOverrides } });
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
  assert.equal(ok.stdout, 'piped\ncwd\nowner\npid\n');
  assert.equal(existsSync(join(root, 'e2e-1.lock')), false);
  assert.equal(runSync(root, ['e2e', 'w1', 'sh', '-c', 'exit 7']).status, 7);
  assert.equal(existsSync(join(root, 'e2e-1.lock')), false);
});

test('preflight executes after the slot is acquired and refuses the child on failure', TIMEOUT, () => {
  const root = lockRoot();
  const preflight = join(root, 'preflight.mjs');
  const marker = join(root, 'child-ran');
  writeFileSync(preflight, `import {existsSync} from 'node:fs';if(!existsSync(process.env.SLOT_LOCK_DIR+'/heavy-1.lock'))process.exit(9);process.exit(7);`);
  const result = runSync(root, ['--preflight-node', preflight, 'heavy', 'writer', 'sh', '-c', `touch "${marker}"`]);
  assert.equal(result.status, 78, 'disk admission has a distinct refusal status: ' + result.stderr);
  assert.match(result.stderr, /disk admission refused/);
  assert.equal(existsSync(marker), false, 'the refused child never starts');
  assert.equal(existsSync(join(root, 'heavy-1.lock')), false, 'the slot is released');
});

test('queued free-space loss is checked after a held slot becomes available', TIMEOUT, async () => {
  const root = lockRoot();
  const held = holdSlot(root, 'heavy', 1);
  const free = join(root, 'free-blocks');
  const marker = join(root, 'child-ran');
  writeFileSync(free, '62500000');
  const preflight = join(root, 'check-free.mjs');
  writeFileSync(preflight, `import {readFileSync} from 'node:fs';process.exit(Number(readFileSync(${JSON.stringify(free)},'utf8'))<62500000?4:0);`);
  const queued = start(root, ['--preflight-node', preflight, 'heavy', 'writer', 'sh', '-c', `touch "${marker}"`]);
  await queued.waitFor('stderr', 'slot-lock: heavy busy');
  writeFileSync(free, '62499999');
  spawnSync('rm', ['-rf', held]);
  assert.deepEqual(await queued.exited, { code: 78, signal: null });
  assert.equal(existsSync(marker), false);
});

test('records the owner label while the command runs', TIMEOUT, () => {
  const root = lockRoot();
  const result = runSync(root, ['heavy', 'pr-42 typecheck', 'sh', '-c',
    `cat "${join(root, 'heavy-1.lock', 'owner')}"; cat "${join(root, 'heavy-1.lock', 'cwd')}"`]);
  const lines = result.stdout.trim().split('\n');
  assert.match(lines[0], /^pr-42 typecheck pid \d+ since \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(lines[1], process.cwd());
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

test('a nested request reuses its process tree heavy slot while the other slot is held', TIMEOUT, async () => {
  const root = lockRoot();
  holdSlot(root, 'heavy', 2, 'other writer');
  const nested = start(root, ['--slots', '2', 'heavy', 'outer writer',
    'bash', SCRIPT, '--slots', '1', 'heavy', 'frozen-render', 'echo', 'nested ran']);
  await nested.waitFor('stdout', 'nested ran');
  assert.deepEqual(await nested.exited, { code: 0, signal: null });
  assert.doesNotMatch(nested.seen.stderr, /slot-lock: heavy busy/);
});

test('an unrelated process still waits when every heavy slot is held', TIMEOUT, async () => {
  const root = lockRoot();
  const first = holdSlot(root, 'heavy', 1, 'first writer');
  holdSlot(root, 'heavy', 2, 'second writer');
  const unrelated = start(root, ['--slots', '2', 'heavy', 'unrelated writer', 'echo', 'unrelated ran']);
  await unrelated.waitFor('stderr', 'slot-lock: heavy busy');
  assert.equal(unrelated.seen.stdout, '');
  spawnSync('rm', ['-rf', first]);
  assert.deepEqual(await unrelated.exited, { code: 0, signal: null });
  assert.equal(unrelated.seen.stdout, 'unrelated ran\n');
});

test('does not reuse a held slot from a hyphen-suffixed lock name', TIMEOUT, async () => {
  const root = lockRoot();
  const held = holdSlot(root, 'heavy', 1, 'real holder');
  const lookalike = holdSlot(root, 'heavy-x', 1, 'lookalike holder');
  const request = start(root, ['heavy', 'nested writer', 'echo', 'nested ran'], {
    SLOT_LOCK_HELD_PATH: lookalike,
    SLOT_LOCK_HELD_PID: `${process.pid}`,
  });
  await request.waitFor('stderr', 'slot-lock: heavy busy');
  assert.equal(request.seen.stdout, '');
  spawnSync('rm', ['-rf', held]);
  assert.deepEqual(await request.exited, { code: 0, signal: null });
  assert.equal(request.seen.stdout, 'nested ran\n');
});

test('does not reuse an exact held slot owned by a live non-ancestor sibling', TIMEOUT, async () => {
  const root = lockRoot();
  const sibling = spawn('sleep', ['30']);
  const siblingExited = new Promise((resolve) => sibling.on('exit', resolve));
  try {
    const lookalike = holdSlot(root, 'heavy', 1, 'sibling holder');
    writeFileSync(join(lookalike, 'pid'), `${sibling.pid}\n`);
    holdSlot(root, 'heavy', 2, 'other holder');
    const request = start(root, ['--slots', '2', 'heavy', 'nested writer', 'echo', 'nested ran'], {
      SLOT_LOCK_HELD_PATH: lookalike,
      SLOT_LOCK_HELD_PID: `${sibling.pid}`,
    });
    await request.waitFor('stderr', 'slot-lock: heavy busy');
    assert.equal(request.seen.stdout, '');
    sibling.kill('SIGTERM');
    await siblingExited;
    assert.deepEqual(await request.exited, { code: 0, signal: null });
    assert.equal(request.seen.stdout, 'nested ran\n');
  } finally {
    if (sibling.exitCode === null) sibling.kill('SIGKILL');
  }
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
