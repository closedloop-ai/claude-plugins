import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { historyOrigin } from './history-origin.mjs';
import { endProcesses, isAlive, orphans, parsePids, stopCandidates } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = (args) => spawnSync(process.execPath, [path.join(HERE, 'helpers.mjs'), ...args], { encoding: 'utf8' });
const tempDir = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-helpers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A pid this test started; anything else (empty output parses as 0) fails the test before any signal. */
const ownedPid = (text) => {
  const pid = Number(String(text).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid, `not a pid this test started: ${text}`);
  return pid;
};
/** Signals one owned pid, never its group. */
const killOwned = (pid) => {
  if (!(pid > 1) || pid === process.pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
};
/**
 * A background process the test owns, started through a shell that exits at
 * once, so its parent is not this test (a dead direct child would stay a
 * zombie while spawnSync blocks the loop). Killed in t.after if left running.
 */
const child = (t, command, args) => {
  const quoted = [command, ...args].map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(' ');
  const pid = ownedPid(spawnSync('sh', ['-c', `${quoted} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).stdout);
  t.after(() => killOwned(pid));
  return pid;
};
/**
 * A detached shell that leads its own process group and waits on a `sleep`
 * in that group, started through a node process that exits at once.
 */
const groupLeader = async (t, dir) => {
  const memberFile = path.join(dir, 'member.pid');
  const script = `const c = require('node:child_process').spawn('sh', ['-c', 'sleep 60 & echo $! > "$0"; wait', ${JSON.stringify(memberFile)}], { detached: true, stdio: 'ignore' }); c.unref(); process.stdout.write(String(c.pid));`;
  const leader = ownedPid(spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' }).stdout);
  t.after(() => killOwned(leader));
  for (let i = 0; i < 100 && !existsSync(memberFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const member = ownedPid(readFileSync(memberFile, 'utf8'));
  t.after(() => killOwned(member));
  return { leader, member };
};
/**
 * A fake process table for endProcesses, so its decisions are checked without
 * one real signal. Pids sit above every real pid_max, in case one leaks.
 */
const fakeTable = (processes) => {
  const table = new Map(processes.map((entry) => [entry.pid, { ...entry }]));
  const calls = [];
  const fail = (code) => Object.assign(new Error(code), { code });
  const kill = (target, signal) => {
    calls.push([target, signal]);
    if (target < 0) {
      const members = [...table.values()].filter((entry) => entry.pgid === -target && entry.state === 'alive');
      if (members.length === 0) throw fail('ESRCH');
      for (const entry of members) entry.state = 'gone';
      return;
    }
    const entry = table.get(target);
    if (!entry || entry.state === 'gone') throw fail('ESRCH');
    if (entry.state === 'foreign') throw fail('EPERM');
    if (signal !== 0) entry.state = 'gone';
  };
  const groupOf = (pid) => table.get(pid)?.pgid ?? null;
  const sent = () => calls.filter(([, signal]) => signal !== 0);
  const state = (pid) => table.get(pid)?.state;
  return { kill, groupOf, calls, sent, state };
};
const FAKE = 2_147_480_000;
const waitUntil = async (predicate) => {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return predicate();
};

test('a helper whose result was accepted and that still runs is a stop candidate', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-helpers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(run([dir, 'start', 'review-a', '--brief', 'prompts/review-a-01.md', '--now', '2026-10-21T10:00:00Z']).status, 0);
  assert.equal(run([dir, 'start', 'review-b', '--now', '2026-10-21T10:00:00Z']).status, 0);
  assert.equal(run([dir, 'accepted', 'review-a', '--now', '2026-10-21T10:10:00Z']).status, 0);
  const busy = run([dir, 'status', '--now', '2026-10-21T10:20:00Z']);
  assert.equal(busy.status, 1);
  assert.match(busy.stdout, /^STOP review-a accepted 10m ago; relaunch from prompts\/review-a-01\.md$/m);
  assert.match(busy.stdout, /helpers: 2 active, 1 to stop/);
  assert.equal(run([dir, 'status', '--now', '2026-10-21T10:12:00Z']).status, 0, 'inside the idle window');
  assert.equal(run([dir, 'stopped', 'review-a', '--now', '2026-10-21T10:21:00Z']).status, 0);
  assert.equal(run([dir, 'status', '--now', '2026-10-21T10:30:00Z']).status, 0);
  assert.deepEqual(stopCandidates({ x: { startedAt: 'a' } }, Date.now()), [], 'a running helper with no accepted result is not idle');
});

test('history attribution refuses a shallow clone', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).stdout.trim();
  git('init', '--quiet');
  writeFileSync(path.join(dir, 'route.ts'), '1\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'create route');
  const created = git('rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'route.ts'), '2\n');
  git('commit', '--quiet', '-am', 'change route');
  assert.deepEqual(historyOrigin(dir, 'route.ts'), { commit: created, subject: 'create route' });
  writeFileSync(path.join(dir, '.git', 'shallow'), `${git('rev-parse', 'HEAD')}\n`);
  assert.match(historyOrigin(dir, 'route.ts').reason, /shallow/);
});

test('stopping a helper ends the processes it recorded, and a stopped helper with live processes is an orphan', async (t) => {
  const dir = tempDir(t);
  const server = child(t, 'sleep', ['60']);
  assert.equal(run([dir, 'start', 'qa-a']).status, 0);
  assert.equal(run([dir, 'pid', 'qa-a', String(server), String(server)]).status, 0);
  assert.equal(run([dir, 'stopped', 'qa-a', '--grace-seconds', '5']).status, 0);
  assert.ok(await waitUntil(() => !isAlive(server)), 'the recorded dev server is gone');
  assert.equal(run([dir, 'status']).status, 0);

  const left = child(t, 'sleep', ['60']);
  assert.deepEqual(orphans({ 'qa-b': { stoppedAt: 'x', pids: [left] }, 'qa-c': { pids: [left] } }), [{ name: 'qa-b', pids: [left] }]);
  assert.deepEqual(orphans({ '#stacks': { s: { guide: 'g' } } }), []);
});

test('a process that ignores SIGTERM is killed after the grace; a survivor keeps the helper unstopped', async (t) => {
  const dir = tempDir(t);
  const stubborn = child(t, process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(run([dir, 'start', 'qa-d']).status, 0);
  assert.equal(run([dir, 'pid', 'qa-d', String(stubborn)]).status, 0);
  const stopped = run([dir, 'stopped', 'qa-d', '--grace-seconds', '1']);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.ok(await waitUntil(() => !isAlive(stubborn)));

  const ledger = path.join(dir, 'helpers.json');
  const left = child(t, 'sleep', ['60']);
  writeFileSync(ledger, JSON.stringify({ 'qa-e': { startedAt: 'x', pids: [left] }, 'qa-f': { stoppedAt: 'x', pids: [left] } }));
  const status = run([dir, 'status']);
  assert.equal(status.status, 1);
  assert.match(status.stdout, new RegExp(`^ORPHAN qa-f ${left} still running$`, 'm'));
  assert.match(status.stdout, /helpers: 1 active, 0 to stop, 1 orphaned/);
  assert.equal(run([dir, 'pid', 'qa-e', 'abc']).status, 2);
});

test('a pid of 1 or lower is never recorded: signalling group 1 reaches every process the user owns', () => {
  for (const unsafe of [['1'], ['0'], ['-1'], ['-42'], ['1.5'], ['abc'], []]) {
    assert.throws(() => parsePids(unsafe), /above 1/, unsafe.join(' '));
  }
  assert.deepEqual(parsePids(['2', String(FAKE)]), [2, FAKE]);
});

test('endProcesses never signals a pid of 1 or lower, this process or its parent, even when one is recorded', async () => {
  const fake = fakeTable([]);
  const unsafe = [0, 1, -1, -42, Number.NaN, 1.5, process.pid, process.ppid].map((pid) => ({ pid, group: true }));
  assert.deepEqual(await endProcesses(unsafe, 0, { kill: fake.kill, groupOf: fake.groupOf }), []);
  assert.deepEqual(fake.calls, [], 'not even a liveness probe');
});

test('endProcesses signals a pid alone unless it was recorded as a group the helper spawned and still leads', async () => {
  const fake = fakeTable([
    { pid: FAKE + 1, pgid: FAKE + 1, state: 'alive' },
    { pid: FAKE + 2, pgid: FAKE + 1, state: 'alive' },
    { pid: FAKE + 3, pgid: FAKE + 3, state: 'alive' },
    { pid: FAKE + 4, pgid: FAKE + 3, state: 'alive' },
    { pid: FAKE + 5, pgid: FAKE + 9, state: 'alive' },
    { pid: FAKE + 6, pgid: FAKE + 9, state: 'alive' },
  ]);
  const survivors = await endProcesses(
    [
      { pid: FAKE + 1, group: false },
      { pid: FAKE + 3, group: true },
      { pid: FAKE + 5, group: true },
    ],
    0,
    { kill: fake.kill, groupOf: fake.groupOf }
  );
  assert.deepEqual(survivors, []);
  assert.deepEqual(fake.sent(), [
    [FAKE + 1, 'SIGTERM'],
    [-(FAKE + 3), 'SIGTERM'],
    [FAKE + 5, 'SIGTERM'],
  ]);
  assert.equal(fake.state(FAKE + 2), 'alive', 'a group leader recorded without --group is signalled alone');
  assert.equal(fake.state(FAKE + 4), 'gone', 'a recorded group that the pid still leads is ended whole');
  assert.equal(fake.state(FAKE + 6), 'alive', 'a recorded group pid that no longer leads its group is signalled alone');
});

test('endProcesses never signals a pid the system says is not ours (EPERM), and does not count it as a survivor', async () => {
  const fake = fakeTable([{ pid: FAKE + 7, pgid: FAKE + 7, state: 'foreign' }]);
  assert.deepEqual(await endProcesses([{ pid: FAKE + 7, group: true }], 0, { kill: fake.kill, groupOf: fake.groupOf }), []);
  assert.deepEqual(fake.sent(), []);
  assert.equal(isAlive(FAKE + 7), false, 'a fake pid above pid_max does not exist');
});

test('stopping a helper recorded with --group ends its whole process group', { timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const { leader, member } = await groupLeader(t, dir);
  assert.equal(run([dir, 'start', 'qa-h']).status, 0);
  assert.equal(run([dir, 'pid', 'qa-h', String(leader), '--group']).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'helpers.json'), 'utf8'))['qa-h'].groups, [leader]);
  const stopped = run([dir, 'stopped', 'qa-h', '--grace-seconds', '5']);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.ok(await waitUntil(() => !isAlive(leader)), 'the leader is gone');
  assert.ok(await waitUntil(() => !isAlive(member)), 'the process it started in its group is gone');
});

test('a stack handed to a human cannot be used by another helper until it is released', (t) => {
  const dir = tempDir(t);
  assert.equal(run([dir, 'hand', 'preview-3000', '--to', 'qa-guide-12']).status, 0);
  const refused = run([dir, 'start', 'qa-rerun', '--stack', 'preview-3000']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /handed to qa-guide-12; launch this helper on its own stack/);
  assert.equal(run([dir, 'start', 'qa-rerun', '--stack', 'qa-rerun-own']).status, 0);
  assert.equal(run([dir, 'hand', 'x']).status, 2, 'hand needs a guide');
  assert.equal(run([dir, 'unhand', 'preview-3000']).status, 0);
  assert.equal(run([dir, 'start', 'qa-rerun-2', '--stack', 'preview-3000']).status, 0);
  const status = run([dir, 'status']);
  assert.match(status.stdout, /helpers: 2 active, 0 to stop, 0 orphaned/);
});
