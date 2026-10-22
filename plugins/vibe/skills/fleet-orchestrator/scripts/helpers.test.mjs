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
  const table = new Map(processes.map((entry) => [entry.pid, { identity: `id-${entry.pid}`, ...entry }]));
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
    if (signal === 'SIGTERM' && entry.reusedOnTerm) {
      // The process exits on SIGTERM and the system hands its pid to another of the user's apps.
      entry.identity = entry.reusedOnTerm;
      return;
    }
    if (signal !== 0) entry.state = 'gone';
  };
  const groupOf = (pid) => table.get(pid)?.pgid ?? null;
  const identityOf = (pid) => {
    const entry = table.get(pid);
    return entry && entry.state !== 'gone' ? entry.identity : null;
  };
  const sent = () => calls.filter(([, signal]) => signal !== 0);
  const state = (pid) => table.get(pid)?.state;
  return { kill, groupOf, identityOf, calls, sent, state };
};
/** A target as `stopped` builds it from the ledger, with the identity recorded at `pid` time. */
const recorded = (pid, group, identity = `id-${pid}`) => ({ pid, group, identity });
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
  assert.deepEqual(await endProcesses(unsafe, 0, { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }), []);
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
    [recorded(FAKE + 1, false), recorded(FAKE + 3, true), recorded(FAKE + 5, true)],
    0,
    { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }
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
  assert.deepEqual(await endProcesses([recorded(FAKE + 7, true)], 0, { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }), []);
  assert.deepEqual(fake.sent(), []);
  assert.equal(isAlive(FAKE + 7), false, 'a fake pid above pid_max does not exist');
});

test('a reused pid whose start time or command differs from the record is never signalled', async () => {
  const fake = fakeTable([{ pid: FAKE + 10, pgid: FAKE + 30, state: 'alive', identity: 'Wed Oct 21 16:00:01 2026 /Applications/Slack.app/Contents/MacOS/Slack' }]);
  const targets = [recorded(FAKE + 10, false, 'Wed Oct 21 15:00:00 2026 node dev-server.js')];
  assert.deepEqual(await endProcesses(targets, 0, { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }), []);
  assert.deepEqual(fake.sent(), []);
  assert.equal(fake.state(FAKE + 10), 'alive');
});

test('a reused pid that now leads its own group, as a launchd app does, is never group-killed', async () => {
  const fake = fakeTable([
    { pid: FAKE + 11, pgid: FAKE + 11, state: 'alive', identity: 'Wed Oct 21 16:05:00 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { pid: FAKE + 12, pgid: FAKE + 11, state: 'alive', identity: 'Wed Oct 21 16:05:01 2026 Google Chrome Helper' },
  ]);
  const targets = [recorded(FAKE + 11, true, 'Wed Oct 21 15:00:00 2026 sh -c next dev')];
  assert.deepEqual(await endProcesses(targets, 0, { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }), []);
  assert.deepEqual(fake.sent(), []);
  assert.equal(fake.state(FAKE + 12), 'alive', 'the app and its group are untouched');
});

test('a record with no identity, as an older ledger has, is never signalled', async () => {
  const fake = fakeTable([{ pid: FAKE + 13, pgid: FAKE + 13, state: 'alive' }]);
  for (const identity of [undefined, '', null]) {
    assert.deepEqual(await endProcesses([{ pid: FAKE + 13, group: true, identity }], 0, { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }), []);
  }
  assert.deepEqual(fake.sent(), []);
  assert.equal(fake.state(FAKE + 13), 'alive');
});

test('identity is read again before every signal: a pid reused during the grace gets no SIGKILL', async () => {
  const fake = fakeTable([{ pid: FAKE + 14, pgid: FAKE + 40, state: 'alive', reusedOnTerm: 'Wed Oct 21 16:10:00 2026 /Applications/iTerm.app/Contents/MacOS/iTerm2' }]);
  assert.deepEqual(await endProcesses([recorded(FAKE + 14, false)], 0, { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }), []);
  assert.deepEqual(fake.sent(), [[FAKE + 14, 'SIGTERM']]);
  assert.equal(fake.state(FAKE + 14), 'alive', 'the app now holding the pid is not killed');
});

test('pid records each process with its start time and command, and refuses one it cannot read', (t) => {
  const dir = tempDir(t);
  const server = child(t, 'sleep', ['60']);
  assert.equal(run([dir, 'pid', 'qa-i', String(server)]).status, 0);
  const identity = JSON.parse(readFileSync(path.join(dir, 'helpers.json'), 'utf8'))['qa-i'].identities[server];
  assert.match(identity, /sleep 60/);
  const refused = run([dir, 'pid', 'qa-j', String(FAKE + 15)]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /cannot read the start time and command/);
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
