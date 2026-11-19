import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { turnEndProblems } from './turn-end-check.mjs';
import { vibeCore } from '../../../shared/vibe-core.mjs';

const { readProcessIdentity } = await vibeCore('shared/process-identity.mjs');

const CHECK = fileURLToPath(new URL('./turn-end-check.mjs', import.meta.url));
const SLOT_LOCK = fileURLToPath(new URL('./slot-lock.sh', import.meta.url));
const WATCHER_OK = { ok: true, line: 'watcher ok pid=1 tick=0s ago' };
const WATCHER_MISSING = { ok: false, line: 'watcher MISSING(no watcher.json)' };
const START = 'Tue Nov 18 07:10:00 2026';
// The heavy slot's holder (slot-lock.sh, pid 30) is a child of the detached launcher the writer recorded (pid 20).
const PARENTS = { 30: 20, 20: 10, 10: 1 };
const tree = { startOf: () => START, parentOf: (pid) => PARENTS[pid] ?? 1 };
const holder = (owner, cwd = '/elsewhere') => ({ lock: 'heavy-1.lock', pid: 30, owner: `${owner} pid 30 since 2026-11-18 07:10`, cwd });
const job = (pid, start = START) => ({ name: 'inventory', pid, identity: `${start} bash fleet.sh` });

test('a step the writer started still holding a slot refuses the turn end until it is handed to a watched job', () => {
  const base = { writer: 'w1', worktree: '/wt/w1', ...tree };
  const unhanded = turnEndProblems({ ...base, holders: [holder('w1 inventory')], jobs: [], watcher: WATCHER_OK });
  assert.equal(unhanded.ok, false);
  assert.match(unhanded.lines[0], /^RUNNING heavy-1\.lock w1 inventory/);
  assert.match(unhanded.lines.at(-1), /^turn-end REFUSED: wait for each running step/);

  const handed = turnEndProblems({ ...base, holders: [holder('w1 inventory')], jobs: [job(20)], watcher: WATCHER_OK });
  assert.deepEqual(handed, { ok: true, lines: ['turn-end ok; handed heavy-1.lock to inventory'] });

  const unwatched = turnEndProblems({ ...base, holders: [holder('w1 inventory')], jobs: [job(20)], watcher: WATCHER_MISSING });
  assert.equal(unwatched.ok, false);
  assert.match(unwatched.lines[0], /have no watcher: watcher MISSING/);

  const reused = turnEndProblems({ ...base, holders: [holder('w1 inventory')], jobs: [job(20, 'Mon Nov 17 01:00:00 2026')], watcher: WATCHER_OK });
  assert.equal(reused.ok, false, 'a recorded pid with another start time is a reused pid, not the job');
});

test('a slot held in the writer worktree counts under any owner label; another writer slot does not', () => {
  const base = { writer: 'w1', worktree: '/wt/w1', jobs: [], watcher: WATCHER_OK, ...tree };
  assert.equal(turnEndProblems({ ...base, holders: [holder('lane-a', '/wt/w1/packages/x')] }).ok, false);
  assert.deepEqual(turnEndProblems({ ...base, holders: [holder('w2 tests', '/wt/w2'), holder('w10 lint', '/wt/w10')] }),
    { ok: true, lines: ['turn-end ok'] });
});

test('the CLI refuses while a real slot holder runs, and passes once its launcher is recorded and the watcher ticks', { timeout: 30_000 }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turn-end-')));
  const orch = join(root, 'orch');
  const worktree = join(root, 'wt');
  const locks = join(root, 'locks');
  mkdirSync(orch);
  mkdirSync(worktree);
  const started = join(root, 'started');
  const slot = spawn('bash', [SLOT_LOCK, 'light', 'w1 inventory', 'bash', '-c', `touch ${JSON.stringify(started)}; sleep 30`],
    { cwd: worktree, env: { ...process.env, SLOT_LOCK_DIR: locks }, stdio: 'ignore' });
  const closed = new Promise((resolve) => slot.once('close', resolve));
  t.after(async () => {
    slot.kill('SIGTERM');
    await closed;
    rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 300 && !existsSync(started); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(started));
  const check = () => spawnSync(process.execPath, [CHECK, orch, 'w1', '--worktree', worktree],
    { encoding: 'utf8', env: { ...process.env, SLOT_LOCK_DIR: locks } });

  const refused = check();
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stdout, /^RUNNING light-1\.lock w1 inventory pid \d+/);

  writeFileSync(join(orch, 'helpers.json'), JSON.stringify({ inventory: { name: 'inventory', kind: 'other',
    pids: [slot.pid], identities: { [slot.pid]: readProcessIdentity(slot.pid) } } }));
  const noWatcher = check();
  assert.equal(noWatcher.status, 1);
  assert.match(noWatcher.stdout, /have no watcher/);

  const now = new Date().toISOString();
  writeFileSync(join(orch, 'watcher.json'), JSON.stringify({ pid: process.pid, startedAt: now, lastTickAt: now, intervalSeconds: 60 }));
  const ok = check();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout, 'turn-end ok; handed light-1.lock to inventory\n');
});
