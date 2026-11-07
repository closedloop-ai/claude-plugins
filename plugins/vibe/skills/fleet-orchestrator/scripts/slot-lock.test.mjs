import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./slot-lock.sh', import.meta.url));
const CHILD_SCRIPT = fileURLToPath(new URL('./slot-lock-child.mjs', import.meta.url));
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
function start(root, args, envOverrides = {}, spawnOptions = {}) {
  const child = spawn('bash', [SCRIPT, ...args], { ...spawnOptions, env: { ...env(root), ...envOverrides } });
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

test('the child helper owns signals before it creates the detached group', TIMEOUT, () => {
  const source = readFileSync(CHILD_SCRIPT, 'utf8');
  const spawnAt = source.indexOf("child = spawn(command");
  assert.ok(spawnAt > 0);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const handlerAt = source.indexOf(`process.on('${signal}'`);
    assert.ok(handlerAt > 0 && handlerAt < spawnAt, `${signal} is persistent before spawn`);
  }
  // Node delivers JS signal callbacks only after the synchronous spawn/listener turn yields. The
  // spawnReady fence covers a pending signal, while this failed-spawn path proves no group is orphaned.
  const root = lockRoot();
  const failed = runSync(root, ['e2e', 'w1', join(root, 'missing-command')]);
  assert.equal(failed.status, 127, failed.stderr);
  assert.equal(existsSync(join(root, 'e2e-1.lock')), false);
});

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

test('nested TERM cleanup keeps the owning slot until the descendant exits', TIMEOUT, async () => {
  const root = lockRoot();
  const marker = join(root, 'nested-done');
  const leaf = `trap 'sleep 1; touch "$1"; exit 0' TERM; echo nested-ready; while :; do sleep 0.05; done`;
  const outer = start(root, ['heavy', 'outer writer',
    'bash', SCRIPT, 'heavy', 'nested writer', 'sh', '-c', leaf, '_', marker]);
  await outer.waitFor('stdout', 'nested-ready');
  outer.child.kill('SIGTERM');

  const contender = start(root, ['heavy', 'next writer', 'echo', 'contender ran']);
  await contender.waitFor('stderr', 'slot-lock: heavy busy');
  assert.equal(existsSync(marker), false, 'the descendant is still cleaning up');
  assert.equal(existsSync(join(root, 'heavy-1.lock')), true, 'capacity stays held during nested cleanup');
  assert.equal(contender.seen.stdout, '');

  assert.deepEqual(await outer.exited, { code: 143, signal: null });
  assert.equal(existsSync(marker), true, 'the descendant finished its TERM cleanup');
  assert.deepEqual(await contender.exited, { code: 0, signal: null });
  assert.equal(contender.seen.stdout, 'contender ran\n');
  assert.equal(existsSync(join(root, 'heavy-1.lock')), false, 'capacity is released after cleanup');
});

test('a process-group TERM and the wrapper forward share one cleanup without releasing early', TIMEOUT, async () => {
  const root = lockRoot();
  const marker = join(root, 'group-term-done');
  const leaf = `trap 'sleep 1; touch "$1"; exit 0' TERM; echo group-term-ready; while :; do sleep 0.05; done`;
  const outer = start(root, ['heavy', 'outer writer',
    'bash', SCRIPT, 'heavy', 'nested writer', 'sh', '-c', leaf, '_', marker], {}, { detached: true });
  await outer.waitFor('stdout', 'group-term-ready');
  assert.ok(outer.child.pid > 1);
  process.kill(-outer.child.pid, 'SIGTERM');

  const contender = start(root, ['heavy', 'next writer', 'echo', 'contender ran']);
  await contender.waitFor('stderr', 'slot-lock: heavy busy');
  assert.equal(existsSync(marker), false, 'the repeated TERM path is still draining');
  assert.equal(existsSync(join(root, 'heavy-1.lock')), true, 'capacity remains held during repeated TERM');
  assert.equal(contender.seen.stdout, '');

  assert.deepEqual(await outer.exited, { code: 143, signal: null });
  assert.equal(existsSync(marker), true);
  assert.deepEqual(await contender.exited, { code: 0, signal: null });
  assert.equal(contender.seen.stdout, 'contender ran\n');
});

test('SIGHUP drains nested descendants before releasing capacity', TIMEOUT, async () => {
  const root = lockRoot();
  const marker = join(root, 'hup-done');
  const leaf = `trap 'sleep 1; touch "$1"; exit 0' TERM; echo hup-ready; while :; do sleep 0.05; done`;
  const outer = start(root, ['heavy', 'outer writer',
    'bash', SCRIPT, 'heavy', 'nested writer', 'sh', '-c', leaf, '_', marker], {}, { detached: true });
  await outer.waitFor('stdout', 'hup-ready');
  assert.ok(outer.child.pid > 1);
  process.kill(-outer.child.pid, 'SIGHUP');

  const contender = start(root, ['heavy', 'next writer', 'echo', 'contender ran']);
  await contender.waitFor('stderr', 'slot-lock: heavy busy');
  assert.equal(existsSync(marker), false, 'the SIGHUP path is still draining');
  assert.equal(existsSync(join(root, 'heavy-1.lock')), true, 'capacity remains held during SIGHUP cleanup');
  assert.equal(contender.seen.stdout, '');

  assert.deepEqual(await outer.exited, { code: 129, signal: null });
  assert.equal(existsSync(marker), true);
  assert.deepEqual(await contender.exited, { code: 0, signal: null });
  assert.equal(contender.seen.stdout, 'contender ran\n');
});

test('signaling only a reused wrapper delegates bounded cleanup to the verified owner', TIMEOUT, async () => {
  const root = lockRoot();
  const pidsFile = join(root, 'reused-wrapper-pids');
  const leaf = `trap '' HUP INT TERM; echo "$PPID $$" > "$1"; echo reused-ready; while :; do sleep 0.05; done`;
  const outer = start(root, ['heavy', 'outer writer',
    'bash', SCRIPT, 'heavy', 'nested writer', 'sh', '-c', leaf, '_', pidsFile]);
  await outer.waitFor('stdout', 'reused-ready');
  const [innerPid, leafPid] = readFileSync(pidsFile, 'utf8').trim().split(/\s+/).map(Number);
  process.kill(innerPid, 'SIGTERM');

  const contender = start(root, ['heavy', 'next writer', 'echo', 'contender ran']);
  await contender.waitFor('stderr', 'slot-lock: heavy busy');
  assert.equal(contender.seen.stdout, '');
  assert.equal(existsSync(join(root, 'heavy-1.lock')), true, 'the verified owner retains capacity');

  assert.deepEqual(await outer.exited, { code: 143, signal: null });
  for (const pid of [innerPid, leafPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await contender.exited, { code: 0, signal: null });
  assert.equal(contender.seen.stdout, 'contender ran\n');
  assert.equal(existsSync(join(root, 'heavy-1.lock')), false);
});

test('a reused wrapper rechecks ownership before relaying its terminating signal', TIMEOUT, async () => {
  const root = lockRoot();
  const pidsFile = join(root, 'stale-relay-pids');
  const leaf = `trap '' HUP INT TERM; echo "$PPID $$" > "$1"; echo stale-relay-ready; while :; do sleep 0.05; done`;
  const outer = start(root, ['heavy', 'outer writer',
    'bash', SCRIPT, 'heavy', 'nested writer', 'sh', '-c', leaf, '_', pidsFile]);
  await outer.waitFor('stdout', 'stale-relay-ready');
  const lockPidFile = join(root, 'heavy-1.lock', 'pid');
  const ownerPid = Number(readFileSync(lockPidFile, 'utf8'));
  const [innerPid, leafPid] = readFileSync(pidsFile, 'utf8').trim().split(/\s+/).map(Number);
  writeFileSync(lockPidFile, `${process.pid}\n`); // Invalidate the proof after reuse was admitted.
  process.kill(innerPid, 'SIGTERM');

  const contender = start(root, ['heavy', 'next writer', 'echo', 'contender ran']);
  await contender.waitFor('stderr', 'slot-lock: heavy busy');
  const ownerStayedRunning = await Promise.race([
    outer.exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 300)),
  ]);
  assert.equal(ownerStayedRunning, true, 'stale proof must not signal the former relay target');
  assert.doesNotThrow(() => process.kill(ownerPid, 0));
  assert.equal(existsSync(join(root, 'heavy-1.lock')), true, 'local cleanup fails closed with capacity held');
  assert.equal(contender.seen.stdout, '');

  writeFileSync(lockPidFile, `${ownerPid}\n`);
  outer.child.kill('SIGTERM');
  assert.deepEqual(await outer.exited, { code: 143, signal: null });
  for (const pid of [innerPid, leafPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await contender.exited, { code: 0, signal: null });
  assert.equal(contender.seen.stdout, 'contender ran\n');
});

test('nested TERM cleanup force-stops a descendant chain that ignores TERM', TIMEOUT, async () => {
  const root = lockRoot();
  const pidsFile = join(root, 'stubborn-pids');
  const leaf = `trap '' TERM; sleep 30 & echo "$$ $!" > "$1"; echo stubborn-ready; wait`;
  const outer = start(root, ['heavy', 'outer writer',
    'bash', SCRIPT, 'heavy', 'nested writer', 'sh', '-c', leaf, '_', pidsFile]);
  await outer.waitFor('stdout', 'stubborn-ready');
  const pids = readFileSync(pidsFile, 'utf8').trim().split(/\s+/).map(Number);
  const started = Date.now();
  outer.child.kill('SIGTERM');

  const contender = start(root, ['heavy', 'next writer', 'echo', 'contender ran']);
  await contender.waitFor('stderr', 'slot-lock: heavy busy');
  assert.equal(contender.seen.stdout, '');
  assert.equal(existsSync(join(root, 'heavy-1.lock')), true, 'capacity stays held during the grace period');

  assert.deepEqual(await outer.exited, { code: 143, signal: null });
  assert.ok(Date.now() - started >= 1_800, 'the TERM grace elapses before forced cleanup');
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await contender.exited, { code: 0, signal: null });
  assert.equal(contender.seen.stdout, 'contender ran\n');
  assert.equal(existsSync(join(root, 'heavy-1.lock')), false, 'capacity is released after forced cleanup');
});

test('rejects bad arguments with usage and exit 2', TIMEOUT, () => {
  const root = lockRoot();
  for (const args of [[], ['e2e', 'w1'], ['--slots', '0', 'e2e', 'w1', 'true'], ['--slots', 'x', 'e2e', 'w1', 'true'], ['../e2e', 'w1', 'true'], ['--status']]) {
    const result = runSync(root, args);
    assert.equal(result.status, 2, `args ${JSON.stringify(args)}`);
    assert.match(result.stderr, /Usage: slot-lock\.sh/);
  }
});
