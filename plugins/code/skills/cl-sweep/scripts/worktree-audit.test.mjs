import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  auditWorktrees,
  countDirt,
  loadSweepIndex,
  newestRolloutByCwd,
  parseArgs,
  parseWorktreeList,
  pathClass,
  suggest,
  ticketFromPath,
} from './worktree-audit.mjs';

const script = resolve(import.meta.dirname, 'worktree-audit.mjs');

test('parses git worktree list --porcelain', () => {
  const entries = parseWorktreeList([
    'worktree /repo',
    'HEAD aaa',
    'branch refs/heads/main',
    '',
    'worktree /tmp/review',
    'HEAD bbb',
    'detached',
    'locked',
    '',
    'worktree /tmp/gone',
    'HEAD ccc',
    'branch refs/heads/codex/x',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n'));
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { path: '/repo', head: 'aaa', branch: 'main', detached: false, locked: false, prunable: false });
  assert.equal(entries[1].detached, true);
  assert.equal(entries[1].locked, true);
  assert.equal(entries[2].prunable, true);
  assert.equal(entries[2].branch, 'codex/x');
});

test('splits tracked and untracked dirt', () => {
  assert.deepEqual(countDirt(' M a.ts\nA  b.ts\n?? c.ts\n?? d/\n'), { tracked: 2, untracked: 2 });
  assert.deepEqual(countDirt(''), { tracked: 0, untracked: 0 });
});

test('classifies paths and ticket slugs', () => {
  const context = { repoTop: '/src/repo', stateBase: '/home/.codex/cl-sweep-state' };
  assert.equal(pathClass('/src/repo', context), 'main-checkout');
  assert.equal(pathClass('/home/.codex/cl-sweep-state/sweeps/s1/worktrees/iss-1-g1', context), 'sweep-owned');
  assert.equal(pathClass('/private/tmp/workflow-review-worktrees/x', context), 'review');
  assert.equal(pathClass('/private/tmp/iss-10901-fix', context), 'ad-hoc-temp');
  assert.equal(pathClass('/src/repo-iss-2', context), 'sibling-checkout');
  assert.equal(ticketFromPath('/x/worktrees/iss-10574-g1-20260918t153749z'), 'ISS-10574');
  assert.equal(ticketFromPath('/x/worktrees/ISS-10408'), 'ISS-10408');
  assert.equal(ticketFromPath('/x/worktrees/scratch'), null);
});

test('suggestions never recommend touching live or dirty work', () => {
  const base = { class: 'sweep-owned', dirt: { tracked: 0, untracked: 0 }, pr: { state: 'MERGED' }, sweep: { leaseState: 'released', rootTerminal: false } };
  assert.equal(suggest({ ...base, class: 'main-checkout' }), 'keep-main');
  assert.equal(suggest({ ...base, sweep: { leaseState: 'active', rootTerminal: false } }), 'in-use');
  assert.equal(suggest({ ...base, dirt: { tracked: 3, untracked: 0 } }), 'hold-tracked-dirt');
  assert.equal(suggest({ ...base, pr: { state: 'OPEN' } }), 'hold-open-pr');
  assert.equal(suggest(base), 'terminal-uncleaned');
  assert.equal(suggest({ ...base, dirt: { tracked: 0, untracked: 2 } }), 'terminal-uncleaned-untracked');
  assert.equal(suggest({ ...base, pr: { state: 'NONE' }, sweep: { leaseState: 'expired', rootTerminal: false } }), 'owner-check');
  assert.equal(suggest({ ...base, pr: null, sweep: { leaseState: 'expired', rootTerminal: true } }), 'terminal-uncleaned');
  assert.equal(suggest({ ...base, class: 'review', sweep: null }), 'orphan-review');
  assert.equal(suggest({ ...base, class: 'ad-hoc-temp', sweep: null }), 'orphan-temp');
  assert.equal(suggest({ ...base, dirt: null }), 'review-unreadable');
});

test('joins sweep roots and ticket leases from durable state', () => {
  const stateBase = mkdtempSync(join(tmpdir(), 'audit-state-'));
  const rootPath = join(stateBase, 'sweeps', 's1');
  mkdirSync(rootPath, { recursive: true });
  writeFileSync(join(stateBase, 'registry.jsonl'), [
    JSON.stringify({ sweepId: 's1', event: 'CREATED', rootPath }),
    JSON.stringify({ sweepId: 's1', event: 'TERMINAL', rootPath }),
  ].join('\n'));
  const now = Date.parse('2026-09-29T00:00:00Z');
  writeFileSync(join(rootPath, 'ownership.jsonl'), [
    JSON.stringify({ ticket: 'ISS-1', event: 'ACQUIRE', expiresAt: null }),
    JSON.stringify({ ticket: 'ISS-2', event: 'ACQUIRE', expiresAt: '2026-09-28T00:00:00Z' }),
    JSON.stringify({ ticket: 'ISS-3', event: 'ACQUIRE', expiresAt: null }),
    JSON.stringify({ ticket: 'ISS-3', event: 'RELEASE', expiresAt: null }),
  ].join('\n'));
  const [root] = loadSweepIndex(stateBase, now);
  assert.equal(root.rootTerminal, true);
  assert.equal(root.leaseState('ISS-1'), 'active');
  assert.equal(root.leaseState('ISS-2'), 'expired');
  assert.equal(root.leaseState('ISS-3'), 'released');
  assert.equal(root.leaseState('ISS-4'), 'none');
});

test('finds the newest rollout per cwd from the session_meta line', () => {
  const sessions = mkdtempSync(join(tmpdir(), 'audit-sessions-'));
  const day = join(sessions, '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const meta = (cwd) => `${JSON.stringify({ type: 'session_meta', payload: { cwd } })}\n{"type":"x"}\n`;
  writeFileSync(join(day, 'rollout-a.jsonl'), meta('/wt/one'));
  writeFileSync(join(day, 'rollout-b.jsonl'), meta('/wt/one'));
  writeFileSync(join(day, 'rollout-c.jsonl'), meta('/wt/two'));
  writeFileSync(join(day, 'notes.jsonl'), meta('/wt/three'));
  utimesSync(join(day, 'rollout-a.jsonl'), new Date('2026-09-01'), new Date('2026-09-01'));
  utimesSync(join(day, 'rollout-b.jsonl'), new Date('2026-09-20'), new Date('2026-09-20'));
  const newest = newestRolloutByCwd(sessions);
  assert.equal(newest.get('/wt/one').path, join(day, 'rollout-b.jsonl'));
  assert.ok(newest.has('/wt/two'));
  assert.ok(!newest.has('/wt/three'));
});

test('audits a real repository read-only and joins every source', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'audit-e2e-')));
  const repo = join(home, 'repo');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const stateBase = join(home, 'state');
  const rootPath = join(stateBase, 'sweeps', 's1');
  const worktree = join(rootPath, 'worktrees', 'iss-7-g1');
  mkdirSync(join(rootPath, 'worktrees'), { recursive: true });
  git('worktree', 'add', '-q', '-b', 'codex/iss-7', worktree);
  writeFileSync(join(worktree, 'scratch.txt'), 'x');
  writeFileSync(join(stateBase, 'registry.jsonl'), `${JSON.stringify({ sweepId: 's1', event: 'CREATED', rootPath })}\n`);
  writeFileSync(join(rootPath, 'ownership.jsonl'), `${JSON.stringify({ ticket: 'ISS-7', event: 'ACQUIRE', expiresAt: null })}\n`);
  const sessions = join(home, 'sessions');
  mkdirSync(sessions);
  writeFileSync(join(sessions, 'rollout-1.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { cwd: worktree } })}\n`);

  const rows = auditWorktrees({ repo, stateBase, sessionsDir: sessions, gh: false });
  assert.equal(rows.length, 2);
  const [main, owned] = rows;
  assert.equal(main.class, 'main-checkout');
  assert.equal(owned.class, 'sweep-owned');
  assert.equal(owned.branch, 'codex/iss-7');
  assert.deepEqual(owned.sweep, { sweepId: 's1', rootEvent: 'CREATED', rootTerminal: false, ticket: 'ISS-7', leaseState: 'active' });
  assert.deepEqual(owned.dirt, { tracked: 0, untracked: 1 });
  assert.equal(owned.pr, null);
  assert.equal(owned.newestRollout.path, join(sessions, 'rollout-1.jsonl'));
  assert.equal(owned.suggestion, 'in-use');

  // The CLI is read-only: the worktree and its untracked file survive.
  const cli = spawnSync(process.execPath, [script, '--repo', repo, '--state-base', stateBase, '--sessions-dir', sessions, '--no-gh'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.schema, 'CL_SWEEP_WORKTREE_AUDIT v1');
  assert.equal(report.counts['in-use'], 1);
  assert.match(git('worktree', 'list'), /iss-7-g1/);
  assert.equal(execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' }), '?? scratch.txt\n');
});

test('reads gh PR state through an injected runner and never fails on gh errors', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'audit-gh-')));
  const repo = join(home, 'repo');
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'git' && args.includes('--show-toplevel')) return `${repo}\n`;
    if (command === 'git' && args.includes('list')) return `worktree ${repo}\nHEAD a\nbranch refs/heads/main\n\nworktree /private/tmp/iss-9-x\nHEAD b\nbranch refs/heads/codex/iss-9\n`;
    if (command === 'git') return '';
    if (args.includes('codex/iss-9')) return '[{"number":5,"state":"OPEN","url":"u"}]';
    throw new Error('gh down');
  };
  const rows = auditWorktrees({ repo, stateBase: join(home, 'state'), run, gh: true });
  assert.deepEqual(rows[0].pr, { state: 'UNKNOWN' });
  assert.deepEqual(rows[1].pr, { number: 5, state: 'OPEN', url: 'u' });
  assert.ok(calls.every((call) => !/\b(?:remove|prune|rm|delete|close)\b/.test(call)), 'no mutating command is ever run');
});

test('rejects bad arguments', () => {
  assert.throws(() => parseArgs([]), /--repo is required/);
  assert.throws(() => parseArgs(['--repo']), /needs a value/);
  assert.throws(() => parseArgs(['--repo', 'x', '--force']), /unknown argument/);
  assert.equal(parseArgs(['--repo', 'x', '--no-gh']).gh, false);
});
