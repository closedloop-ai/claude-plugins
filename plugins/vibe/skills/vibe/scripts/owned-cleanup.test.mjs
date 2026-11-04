import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hasPendingOwnedCleanups, pendingOwnedCleanups, registerFleetWriterRetirements,
  registerWorktreeRetirement, remainingCleanupBudget, sweepOwnedCleanups } from './owned-cleanup.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }).trim();
}

function fixture(t) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vibe-retirement-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bare = path.join(home, 'origin.git');
  const seed = path.join(home, 'seed');
  const repo = path.join(home, 'repo');
  git(home, 'init', '-q', '--bare', '--initial-branch=main', bare);
  git(home, 'init', '-q', '--initial-branch=main', seed);
  writeFileSync(path.join(seed, 'README.md'), 'base\n');
  mkdirSync(path.join(seed, 'scripts'));
  writeFileSync(path.join(seed, 'scripts', 'setup-local-env.sh'), '#!/bin/sh\nTARGETS=(\n  "apps/app/.env.local"\n)\n');
  writeFileSync(path.join(seed, '.gitignore'), [
    'node_modules/', '**/node_modules/', '.husky/_/', 'apps/app/.env.local', '.closedloop-ai/.env.setup',
    '.closedloop-ai/vibe-plans/', '.biome-noscan.jsonc', 'tsconfig.tsbuildinfo', '',
  ].join('\n'));
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'push', '-q', bare, 'main');
  git(home, 'clone', '-q', bare, repo);
  const worktree = path.join(repo, '.claude', 'worktrees', 'vibe-test');
  mkdirSync(path.dirname(worktree), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'vibe/test', worktree, 'origin/main');
  git(worktree, 'push', '-q', '-u', 'origin', 'HEAD');
  const head = git(worktree, 'rev-parse', 'HEAD');
  const pr = { repo: 'closedloop-ai/symphony-alpha', number: 42, head, branch: 'vibe/test', state: 'OPEN' };
  const sessionFile = path.join(git(worktree, 'rev-parse', '--absolute-git-dir'), 'vibe-session.json');
  writeFileSync(sessionFile, JSON.stringify({ status: 'handed-off', pullRequest: { repo: pr.repo, number: pr.number, head } }));
  const register = (overrides = {}) => registerWorktreeRetirement({ worktree, repo, pr: { ...pr, ...overrides },
    proof: { kind: 'vibe' }, ticket: 'ISS-13658' }, { home });
  const sweep = (overrides = {}, options = {}) => sweepOwnedCleanups({ home, readPr: async () => ({ ...pr, state: 'MERGED', ...overrides }),
    processAlive: () => false, lockHeld: () => false, ...options });
  return { home, bare, repo, worktree, head, pr, sessionFile, register, sweep };
}

test('stale ownerless sweep lock is reclaimed after its grace period', (t) => {
  const f = fixture(t);
  const lock = path.join(f.home, '.codex', 'vibe', 'cleanup', 'sweep.lock');
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  assert.ok(f.register(), 'registration proceeds after stale ownerless lock recovery');
  assert.equal(existsSync(lock), false);
});

test('registration refuses unpublished and changed remote branch heads', (t) => {
  const f = fixture(t);
  git(f.repo, 'push', '-q', 'origin', '--delete', 'vibe/test');
  assert.throws(() => f.register(), /remote branch is not published/);
  const g = fixture(t);
  writeFileSync(path.join(g.repo, 'README.md'), 'other head\n');
  git(g.repo, 'add', '.');
  git(g.repo, 'commit', '-qm', 'other branch head');
  git(g.repo, 'push', '-q', '--force', 'origin', 'HEAD:refs/heads/vibe/test');
  assert.throws(() => g.register(), /remote branch changed head/);
});

test('registered terminal PR retires only its exact published worktree and preserves branches', async (t) => {
  const f = fixture(t);
  assert.ok(f.register(), 'registration must persist a proof outside the worktree');
  assert.equal(hasPendingOwnedCleanups({ home: f.home }), true);
  const result = await f.sweep();
  assert.deepEqual(result.removed, [f.worktree], 'terminal registered worktree is removed');
  assert.equal(existsSync(f.worktree), false);
  assert.equal(git(f.repo, 'branch', '--list', 'vibe/test'), 'vibe/test');
  assert.equal(git(f.repo, 'ls-remote', '--heads', 'origin', 'vibe/test').endsWith('refs/heads/vibe/test'), true);
  assert.equal(hasPendingOwnedCleanups({ home: f.home }), false, 'empty ledger costs the supervisor only a marker read');
});

test('bootstrapped symphony outputs are regenerable while unknown ignored content still blocks retirement', async (t) => {
  const f = fixture(t);
  for (const file of ['.husky/_/pre-commit', 'apps/app/.env.local', '.closedloop-ai/.env.setup',
    '.closedloop-ai/vibe-plans/session.md', '.biome-noscan.jsonc', 'tsconfig.tsbuildinfo',
    'containers/claude-runner/node_modules/package']) {
    mkdirSync(path.dirname(path.join(f.worktree, file)), { recursive: true });
    writeFileSync(path.join(f.worktree, file), 'generated');
  }
  mkdirSync(path.join(f.worktree, 'node_modules'));
  writeFileSync(path.join(f.worktree, 'node_modules', 'package'), 'generated');
  assert.ok(f.register());
  const retired = await f.sweep();
  assert.deepEqual(retired.removed, [f.worktree], JSON.stringify(retired));

  const g = fixture(t);
  writeFileSync(path.join(g.repo, '.git', 'info', 'exclude'), 'private-cache/\n');
  mkdirSync(path.join(g.worktree, 'private-cache'));
  writeFileSync(path.join(g.worktree, 'private-cache', 'human'), 'keep');
  assert.ok(g.register());
  assert.deepEqual((await g.sweep()).removed, []);
  assert.equal(readFileSync(path.join(g.worktree, 'private-cache', 'human'), 'utf8'), 'keep');
});

test('manual bounded sweep repairs a persisted retirement record whose pending marker was lost', async (t) => {
  const f = fixture(t);
  assert.ok(f.register());
  const marker = path.join(f.home, '.codex', 'vibe', 'cleanup', 'pending');
  rmSync(marker);
  assert.equal(hasPendingOwnedCleanups({ home: f.home }), false);
  assert.deepEqual((await f.sweep({}, { forceDiscovery: true })).removed, [f.worktree]);
});

test('fleet board writer PR evidence registers only a verified terminal worktree and backs off open PRs', async (t) => {
  const f = fixture(t);
  const orchDir = path.join(f.home, 'fleet');
  mkdirSync(orchDir);
  writeFileSync(path.join(orchDir, 'board.json'), JSON.stringify({ writers: {
    writer: { pr: '42', repo: f.pr.repo, head: f.head, worktree: f.worktree, where: 'local', runtime: 'codex' },
  } }));
  mkdirSync(path.join(orchDir, 'sessions'));
  writeFileSync(path.join(orchDir, 'sessions', 'writer.json'), JSON.stringify({ cwd: f.worktree }));
  const liveWriter = await registerFleetWriterRetirements(orchDir, { home: f.home, now: 0,
    readPr: async () => ({ ...f.pr, state: 'MERGED' }) });
  assert.deepEqual(liveWriter.registered, [], 'a live fleet writer is never registered for retirement');
  writeFileSync(path.join(orchDir, 'sessions', 'writer.json'), JSON.stringify({ cwd: f.worktree,
    ended: { reason: 'merged', at: new Date().toISOString() }, archivedAt: new Date().toISOString() }));
  let reads = 0;
  const open = await registerFleetWriterRetirements(orchDir, { home: f.home, now: 31 * 60_000, readPr: async () => {
    reads += 1;
    return { ...f.pr, state: 'OPEN' };
  } });
  assert.deepEqual(open.registered, []);
  await registerFleetWriterRetirements(orchDir, { home: f.home, now: 31 * 60_000 + 1, readPr: async () => {
    reads += 1;
    return { ...f.pr, state: 'OPEN' };
  } });
  assert.equal(reads, 1, 'open PR checks back off');
  const terminal = await registerFleetWriterRetirements(orchDir, { home: f.home, now: 62 * 60_000,
    readPr: async () => ({ ...f.pr, state: 'MERGED' }) });
  assert.deepEqual(terminal.registered, [f.worktree]);
  assert.deepEqual((await f.sweep()).removed, [f.worktree]);
});

test('remote fleet worktree registers only on the host with its ended session state', async (t) => {
  const f = fixture(t);
  const orchDir = path.join(f.home, 'fleet');
  const remoteState = path.join(f.home, 'remote-state');
  mkdirSync(orchDir);
  mkdirSync(remoteState);
  writeFileSync(path.join(orchDir, 'board.json'), JSON.stringify({ writers: {
    writer: { pr: '42', repo: f.pr.repo, head: f.head, worktree: f.worktree, where: 'remote', runtime: 'codex' },
  } }));
  writeFileSync(path.join(remoteState, 'writer.json'), JSON.stringify({ cwd: f.worktree,
    ended: { reason: 'merged', at: '2026-11-03T00:00:00Z' }, archivedAt: '2026-11-03T00:01:00Z' }));
  const readPr = async () => ({ ...f.pr, state: 'MERGED' });
  assert.deepEqual((await registerFleetWriterRetirements(orchDir, { home: f.home, readPr })).registered, [],
    'primary-host route skips remote rows');
  const remote = await registerFleetWriterRetirements(orchDir,
    { home: f.home, readPr, where: 'remote', stateDir: remoteState });
  assert.deepEqual(remote.registered, [f.worktree]);
  assert.deepEqual((await f.sweep()).removed, [f.worktree]);
});

test('fleet import stops new PR reads at the shared deadline and resumes its cursor', async (t) => {
  const f = fixture(t);
  const orchDir = path.join(f.home, 'fleet-budget');
  const sessions = path.join(orchDir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const row = (pr) => ({ pr: String(pr), repo: f.pr.repo, head: f.head, worktree: f.worktree,
    where: 'local', runtime: 'codex' });
  writeFileSync(path.join(orchDir, 'board.json'), JSON.stringify({ writers: { first: row(42), second: row(43) } }));
  for (const name of ['first', 'second']) writeFileSync(path.join(sessions, name + '.json'),
    JSON.stringify({ cwd: f.worktree, ended: { at: '2026-11-03T00:00:00Z' }, archivedAt: '2026-11-03T00:01:00Z' }));
  let tick = 0;
  const reads = [];
  const readPr = async (_repo, number) => { reads.push(number); tick = 31_000; return { ...f.pr, number, state: 'OPEN' }; };
  const first = await registerFleetWriterRetirements(orchDir, { home: f.home, readPr, now: 0,
    deadline: 30_000, clock: () => tick });
  assert.deepEqual(reads, [42]);
  assert.equal(first.visited, 1);
  assert.equal(JSON.parse(readFileSync(path.join(f.home, '.codex', 'vibe', 'cleanup', 'board-checks.json'), 'utf8')).__cursor, 1);
  tick = 0;
  await registerFleetWriterRetirements(orchDir, { home: f.home,
    readPr: async (_repo, number) => { reads.push(number); return { ...f.pr, number, state: 'OPEN' }; },
    now: 31 * 60_000, deadline: 30_000, clock: () => tick, maxRecords: 1 });
  assert.equal(reads[1], 43, 'the next pass starts with the previously unvisited PR');
});

test('missing fleet board retains a finite budget for other pending records', (t) => {
  const f = fixture(t);
  const root = path.join(f.home, '.codex', 'vibe', 'cleanup');
  const records = path.join(root, 'records');
  mkdirSync(records, { recursive: true });
  writeFileSync(path.join(records, 'pending.json'), JSON.stringify({ version: 99, state: 'pending' }));
  writeFileSync(path.join(root, 'pending'), '{}');
  const script = fileURLToPath(new URL('./e2e-lock.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'cleanup-sweep', 'sweep', '--orch-dir', path.join(f.home, 'missing-board')],
    { env: { ...process.env, HOME: f.home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pending.json/, 'the pending record is visited');
  assert.equal(remainingCleanupBudget(0), 20);
  assert.throws(() => remainingCleanupBudget(Number.NaN), /not finite/);
});

test('canonical ignored generated directories can clear before non-forced removal; unknown ignored data blocks', async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.worktree, '.gitignore'), 'node_modules/\n.turbo/\nprivate-cache/\n');
  git(f.worktree, 'add', '.gitignore');
  git(f.worktree, 'commit', '-qm', 'ignore generated output');
  git(f.worktree, 'push', '-q');
  f.pr.head = git(f.worktree, 'rev-parse', 'HEAD');
  writeFileSync(f.sessionFile, JSON.stringify({ status: 'handed-off',
    pullRequest: { repo: f.pr.repo, number: f.pr.number, head: f.pr.head } }));
  mkdirSync(path.join(f.worktree, 'node_modules'));
  writeFileSync(path.join(f.worktree, 'node_modules', 'generated'), 'safe');
  mkdirSync(path.join(f.worktree, '.turbo'));
  writeFileSync(path.join(f.worktree, '.turbo', 'generated'), 'safe');
  assert.ok(f.register());
  const removed = await f.sweep({ head: f.pr.head });
  assert.deepEqual(removed.removed, [f.worktree], 'known generated directories are cleared safely');

  const g = fixture(t);
  writeFileSync(path.join(g.worktree, '.gitignore'), 'private-cache/\n');
  git(g.worktree, 'add', '.gitignore');
  git(g.worktree, 'commit', '-qm', 'ignore private');
  git(g.worktree, 'push', '-q');
  g.pr.head = git(g.worktree, 'rev-parse', 'HEAD');
  writeFileSync(g.sessionFile, JSON.stringify({ status: 'handed-off',
    pullRequest: { repo: g.pr.repo, number: g.pr.number, head: g.pr.head } }));
  mkdirSync(path.join(g.worktree, 'private-cache'));
  writeFileSync(path.join(g.worktree, 'private-cache', 'keep'), 'user data');
  assert.ok(g.register());
  await g.sweep({ head: g.pr.head });
  assert.equal(readFileSync(path.join(g.worktree, 'private-cache', 'keep'), 'utf8'), 'user data');
});

test('worktree state changing after generated-file cleanup blocks non-forced removal', async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.worktree, '.gitignore'), 'node_modules/\n');
  git(f.worktree, 'add', '.gitignore');
  git(f.worktree, 'commit', '-qm', 'ignore generated');
  git(f.worktree, 'push', '-q');
  f.pr.head = git(f.worktree, 'rev-parse', 'HEAD');
  writeFileSync(f.sessionFile, JSON.stringify({ status: 'handed-off', pullRequest: { repo: f.pr.repo, number: f.pr.number, head: f.pr.head } }));
  mkdirSync(path.join(f.worktree, 'node_modules'));
  writeFileSync(path.join(f.worktree, 'node_modules', 'generated'), 'safe');
  assert.ok(f.register());
  const result = await f.sweep({ head: f.pr.head }, { beforeRemove: () => writeFileSync(path.join(f.worktree, 'draft.txt'), 'new work') });
  assert.deepEqual(result.removed, []);
  assert.equal(readFileSync(path.join(f.worktree, 'draft.txt'), 'utf8'), 'new work');
  assert.equal(readFileSync(path.join(f.worktree, 'node_modules', 'generated'), 'utf8'), 'safe',
    'generated content is not deleted before the final dirty-work check');
});

test('a missing vibe session record or changed fleet session witness cannot authorize removal', async (t) => {
  const f = fixture(t);
  assert.ok(f.register());
  rmSync(f.sessionFile);
  assert.deepEqual((await f.sweep()).removed, [], 'missing vibe proof leaves the checkout');
  assert.equal(existsSync(f.worktree), true);

  const g = fixture(t);
  const stateDir = path.join(g.home, 'sessions');
  mkdirSync(stateDir);
  writeFileSync(path.join(stateDir, 'writer.json'), JSON.stringify({ cwd: g.worktree,
    ended: { at: '2026-11-03T00:00:00Z' }, archivedAt: '2026-11-03T00:01:00Z' }));
  registerWorktreeRetirement({ worktree: g.worktree, repo: g.repo, pr: g.pr,
    proof: { kind: 'fleet', stateDir, sessionName: 'writer', endedAt: '2026-11-03T00:00:00Z', archivedAt: '2026-11-03T00:01:00Z' } }, { home: g.home });
  writeFileSync(path.join(stateDir, 'writer.json'), JSON.stringify({ cwd: g.worktree }));
  assert.deepEqual((await g.sweep()).removed, [], 'resumed fleet writer leaves the checkout');
  assert.equal(existsSync(g.worktree), true);
});

test('dirty, untracked, unpushed, open PR and changed PR identity retain the worktree', async (t) => {
  const cases = [
    ['dirty', (f) => writeFileSync(path.join(f.worktree, 'README.md'), 'dirty\n')],
    ['untracked', (f) => writeFileSync(path.join(f.worktree, 'draft.txt'), 'private')],
    ['unpushed', (f) => { writeFileSync(path.join(f.worktree, 'draft.txt'), 'committed'); git(f.worktree, 'add', '.'); git(f.worktree, 'commit', '-qm', 'local only'); }],
    ['open', () => {}, { state: 'OPEN' }],
    ['head mismatch', () => {}, { head: '0'.repeat(40) }],
    ['repo mismatch', () => {}, { repo: 'other/repo' }],
    ['branch mismatch', () => {}, { branch: 'vibe/other' }],
  ];
  for (const [name, mutate, pr] of cases) {
    const f = fixture(t);
    assert.ok(f.register(), name);
    mutate(f);
    await f.sweep(pr);
    assert.equal(existsSync(f.worktree), true, `${name} stays`);
  }
});

test('every refused worktree cleanup backs off instead of repeating GitHub reads each supervisor tick', async (t) => {
  const f = fixture(t);
  assert.ok(f.register());
  writeFileSync(path.join(f.worktree, 'README.md'), 'dirty\n');
  let reads = 0;
  const readPr = async () => { reads += 1; return { ...f.pr, state: 'MERGED' }; };
  await sweepOwnedCleanups({ home: f.home, readPr, now: 0, deadline: Date.now() + 30_000,
    processCwds: () => [], slotHeld: () => false });
  await sweepOwnedCleanups({ home: f.home, readPr: async () => { throw new Error('backoff was ignored'); },
    now: 1_000, deadline: Date.now() + 30_000, processCwds: () => [], slotHeld: () => false });
  assert.equal(reads, 1);
});

test('live process or lock, missing remote, foreign worktree and PID reuse leave the worktree alone', async (t) => {
  const f = fixture(t);
  assert.ok(f.register());
  const gitDir = git(f.worktree, 'rev-parse', '--absolute-git-dir');
  writeFileSync(path.join(gitDir, 'vibe-session.json'), JSON.stringify({ status: 'handed-off',
    pullRequest: { repo: f.pr.repo, number: f.pr.number, head: f.pr.head }, stack: { storybookPid: 2147480000 } }));
  await sweepOwnedCleanups({ home: f.home, readPr: async () => ({ ...f.pr, state: 'MERGED' }), processAlive: () => true, lockHeld: () => false });
  assert.equal(existsSync(f.worktree), true, 'live session stays');
  await sweepOwnedCleanups({ home: f.home, readPr: async () => ({ ...f.pr, state: 'MERGED' }), processAlive: () => false, lockHeld: () => true });
  assert.equal(existsSync(f.worktree), true, 'live lock stays');
  await sweepOwnedCleanups({ home: f.home, readPr: async () => ({ ...f.pr, state: 'MERGED' }), processAlive: () => true,
    processIdentity: () => 'reused-pid', lockHeld: () => false });
  assert.equal(existsSync(f.worktree), true, 'reused PID is not a cleanup warrant');
  git(f.repo, 'remote', 'remove', 'origin');
  await f.sweep();
  assert.equal(existsSync(f.worktree), true, 'missing remote stays');
  const foreign = path.join(f.home, 'foreign');
  mkdirSync(foreign);
  assert.equal(existsSync(foreign), true);
});

test('a process cwd or fleet slot rooted in the worktree blocks retirement', async (t) => {
  const f = fixture(t);
  assert.ok(f.register());
  await f.sweep({}, { processCwds: () => [4242], slotHeld: () => false });
  assert.equal(existsSync(f.worktree), true, 'process cwd keeps the checkout');

  const g = fixture(t);
  assert.ok(g.register());
  await g.sweep({}, { processCwds: () => [], slotHeld: () => true });
  assert.equal(existsSync(g.worktree), true, 'slot owner keeps the checkout');
});

test('legacy, malformed and future-version records remain visible without deletion authority', async (t) => {
  const f = fixture(t);
  const dir = path.join(f.home, '.codex', 'vibe', 'cleanup');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'e2e-cleanup-legacy.json'), JSON.stringify({ project: 'vibe-e2e-old', owner: { token: 'old' } }));
  const oldLockDir = path.join(f.home, '.codex', 'vibe', 'locks');
  mkdirSync(oldLockDir, { recursive: true });
  writeFileSync(path.join(oldLockDir, 'e2e-cleanup-original.json'), JSON.stringify({ project: 'vibe-e2e-old', owner: { token: 'original' } }));
  writeFileSync(path.join(dir, 'malformed.json'), '{bad');
  writeFileSync(path.join(dir, 'future.json'), JSON.stringify({ version: 99, kind: 'worktree', worktree: f.worktree }));
  mkdirSync(path.join(dir, 'records'));
  writeFileSync(path.join(dir, 'records', 'future-record.json'), JSON.stringify({ version: 99, kind: 'worktree', state: 'pending', worktree: f.worktree }));
  const pending = pendingOwnedCleanups({ home: f.home });
  assert.ok(pending.some((item) => item.includes('e2e-cleanup-legacy.json')), 'old pending record is visible');
  assert.ok(pending.some((item) => item.includes('e2e-cleanup-original.json')), 'original legacy location is visible');
  assert.ok(pending.some((item) => item.includes('malformed.json')), 'malformed record is visible');
  assert.ok(pending.some((item) => item.includes('future.json')), 'version-skewed record is visible');
  assert.ok(pending.some((item) => item.includes('future-record.json')), 'future record remains visible');
  const first = await sweepOwnedCleanups({ home: f.home, forceDiscovery: true, now: 0, deadline: Date.now() + 30_000 });
  assert.ok(first.leftover.some((line) => line.includes('e2e-cleanup-legacy.json')));
  assert.ok(first.leftover.some((line) => line.includes('e2e-cleanup-original.json')));
  const second = await sweepOwnedCleanups({ home: f.home, forceDiscovery: true, now: 1_000, deadline: Date.now() + 30_000 });
  assert.equal(second.leftover.some((line) => line.includes('e2e-cleanup-legacy.json')), false);
  assert.equal(existsSync(f.worktree), true, 'untrusted records never authorize deletion');
});

test('bounded cursor advances only past records actually visited before a deadline', async (t) => {
  const f = fixture(t);
  const dir = path.join(f.home, '.codex', 'vibe', 'cleanup');
  const records = path.join(dir, 'records');
  mkdirSync(records, { recursive: true });
  writeFileSync(path.join(records, 'a.json'), JSON.stringify({ version: 99, state: 'pending' }));
  writeFileSync(path.join(records, 'b.json'), JSON.stringify({ version: 99, state: 'pending' }));
  writeFileSync(path.join(dir, 'pending'), '{}');
  let ticks = 0;
  const first = await sweepOwnedCleanups({ home: f.home, deadline: 30_000,
    clock: () => ticks++ < 3 ? 0 : 31_000 });
  assert.equal(first.leftover.some((line) => line.includes('a.json')), true);
  assert.equal(first.leftover.some((line) => line.includes('b.json')), false);
  const cursor = JSON.parse(readFileSync(path.join(dir, 'sweep.cursor'), 'utf8'));
  assert.equal(cursor.next, 1, 'the unvisited second record is next');
  const second = await sweepOwnedCleanups({ home: f.home, deadline: 30_000, clock: () => 0, maxRecords: 1 });
  assert.equal(second.leftover.some((line) => line.includes('b.json')), true);
});

test('completed worktree and E2E records are deleted before they can consume a bounded visit', async (t) => {
  const f = fixture(t);
  const cleanup = path.join(f.home, '.codex', 'vibe', 'cleanup');
  const records = path.join(cleanup, 'records');
  const locks = path.join(f.home, '.codex', 'vibe', 'locks');
  mkdirSync(records, { recursive: true });
  mkdirSync(locks, { recursive: true });
  const complete = path.join(records, 'a.json');
  const pending = path.join(records, 'b.json');
  const e2e = path.join(locks, 'e2e-cleanup-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json');
  writeFileSync(complete, JSON.stringify({ version: 1, kind: 'worktree', state: 'complete' }));
  writeFileSync(pending, JSON.stringify({ version: 99, kind: 'worktree', state: 'pending' }));
  writeFileSync(e2e, JSON.stringify({ version: 1, kind: 'e2e', state: 'complete' }));
  writeFileSync(path.join(cleanup, 'pending'), '{}');
  const result = await sweepOwnedCleanups({ home: f.home, maxRecords: 1, deadline: Date.now() + 30_000 });
  assert.equal(existsSync(complete), false);
  assert.equal(existsSync(e2e), false);
  assert.ok(result.leftover.some((line) => line.includes('b.json')), 'pending work receives the visit');
});

test('scheduled bounded sweep visits registered scratch programs within the shared budget', async (t) => {
  const f = fixture(t);
  const orchDir = path.join(f.home, 'scratch-orchestrator');
  mkdirSync(orchDir);
  const root = path.join(f.home, '.codex', 'vibe', 'cleanup');
  const programs = path.join(root, 'scratch-programs');
  mkdirSync(programs, { recursive: true });
  const digest = createHash('sha256').update(orchDir).digest('hex');
  writeFileSync(path.join(programs, digest + '.json'), JSON.stringify({ orchDir }));
  writeFileSync(path.join(root, 'pending'), '{}');
  const calls = [];
  const result = await sweepOwnedCleanups({ home: f.home, deadline: Date.now() + 30_000,
    scratchSweep: async (dir, options) => {
      calls.push([dir, options.maxRecords]);
      return { visited: 1, removed: ['scratch-pg'], leftover: [] };
    } });
  assert.deepEqual(calls, [[orchDir, 6]]);
  assert.deepEqual(result.removed, ['scratch-pg']);
});

test('exhausted first scratch program leaves the second next in the cursor', async (t) => {
  const f = fixture(t);
  const root = path.join(f.home, '.codex', 'vibe', 'cleanup');
  const programs = path.join(root, 'scratch-programs');
  mkdirSync(programs, { recursive: true });
  const dirs = ['a', 'b'].map((name) => path.join(f.home, name));
  const first = dirs.toSorted((left, right) => createHash('sha256').update(left).digest('hex')
    .localeCompare(createHash('sha256').update(right).digest('hex')))[0];
  const second = dirs.find((dir) => dir !== first);
  for (const dir of dirs) {
    mkdirSync(dir);
    writeFileSync(path.join(programs, createHash('sha256').update(dir).digest('hex') + '.json'), JSON.stringify({ orchDir: dir }));
  }
  writeFileSync(path.join(root, 'pending'), '{}');
  const calls = [];
  const sweep = async () => sweepOwnedCleanups({ home: f.home, deadline: Date.now() + 30_000,
    scratchSweep: async (dir, options) => {
      calls.push([dir, options.maxRecords]);
      return { visited: dir === first ? 6 : 1, removed: [], leftover: [] };
    } });
  await sweep();
  assert.deepEqual(calls, [[first, 6]]);
  await sweep();
  assert.equal(calls[1][0], second);
});

test('timed-out PR read backs off so scratch and E2E progress on the next tick', async (t) => {
  const f = fixture(t);
  f.register();
  const root = path.join(f.home, '.codex', 'vibe', 'cleanup');
  const programs = path.join(root, 'scratch-programs');
  const orchDir = path.join(f.home, 'scratch-program');
  mkdirSync(orchDir);
  mkdirSync(programs, { recursive: true });
  writeFileSync(path.join(programs, createHash('sha256').update(orchDir).digest('hex') + '.json'), JSON.stringify({ orchDir }));
  const e2eDir = path.join(f.home, '.codex', 'vibe', 'locks');
  mkdirSync(e2eDir, { recursive: true });
  writeFileSync(path.join(e2eDir, 'e2e-cleanup-' + 'c'.repeat(32) + '.json'), JSON.stringify({ version: 99 }));
  let timedOut = false;
  const readPr = async () => { timedOut = true; throw new Error('PR timeout'); };
  await sweepOwnedCleanups({ home: f.home, readPr, now: 0, deadline: 100,
    clock: () => timedOut ? 101 : 0 });
  let scratchVisits = 0;
  const second = await sweepOwnedCleanups({ home: f.home, readPr: async () => { throw new Error('read retried too early'); },
    now: 1000, deadline: Date.now() + 30_000,
    scratchSweep: async () => { scratchVisits += 1; return { visited: 1, removed: [], leftover: [] }; } });
  assert.equal(scratchVisits, 1);
  assert.ok(second.leftover.some((line) => line.includes('Legacy E2E reservation')));
  const third = await sweepOwnedCleanups({ home: f.home, now: 2_000, deadline: Date.now() + 30_000,
    scratchSweep: async () => ({ visited: 0, removed: [], leftover: [] }) });
  assert.equal(third.leftover.some((line) => line.includes('Legacy E2E reservation')), false,
    'legacy record is reported once per backoff window');
});

test('worktree retirement waits for scratch TTL cleanup so its lease proof survives', async (t) => {
  const f = fixture(t);
  assert.ok(f.register());
  const orchDir = path.join(f.home, 'scratch-before-retirement');
  mkdirSync(orchDir);
  const registry = path.join(f.home, '.codex', 'vibe', 'cleanup', 'scratch-programs');
  mkdirSync(registry, { recursive: true });
  const digest = createHash('sha256').update(orchDir).digest('hex');
  writeFileSync(path.join(registry, digest + '.json'), JSON.stringify({ orchDir }));
  const file = path.join(orchDir, 'helpers.json');
  writeFileSync(file, JSON.stringify({ scratch: { kind: 'scratch', worktree: f.worktree,
    project: 'scratch-project', expiresAt: '2099-11-03T00:00:00Z' } }));
  const waiting = await f.sweep();
  assert.deepEqual(waiting.removed, []);
  assert.equal(existsSync(f.worktree), true, 'scratch lease proof stays available until expiry');
  writeFileSync(file, JSON.stringify({ scratch: { kind: 'scratch', worktree: f.worktree, stoppedAt: '2026-11-03T00:00:00Z' } }));
  const retired = await f.sweep({}, { now: Date.now() + 31 * 60_000 });
  assert.deepEqual(retired.removed, [f.worktree]);
});
