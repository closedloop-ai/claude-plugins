import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// A fleet home's active program dir (fleet-home.mjs), so a watched program is not reported as a flat layout.
const tempDir = (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'fleet-board-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, 'programs', 'p1'), { recursive: true });
  writeFileSync(path.join(home, 'current'), 'p1\n');
  return path.join(home, 'programs', 'p1');
};
const run = (args, env = {}) => spawnSync(process.execPath, [path.join(HERE, 'board.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('a writer row whose head is behind the pushed head is stale until the writer row is updated', (t) => {
  const dir = tempDir(t);
  assert.equal(run([dir, 'writer', 'w1', '--pr', '101', '--head', 'aaa', '--status', 'building', '--deps', 'w2']).status, 0);
  assert.equal(run([dir, 'writer', 'w2', '--head', 'ccc']).status, 0);
  const stale = run([dir, 'status', '--pushed', 'w1=bbb', '--pushed', 'w2=ccc']);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /^STALE w1 board head aaa, pushed bbb$/m);
  assert.doesNotMatch(stale.stdout, /STALE w2/);
  assert.match(stale.stdout, /board: 2 writers, 1 stale, 0 untold/);

  assert.equal(run([dir, 'writer', 'w1', '--head', 'bbb', '--status', 'QA ready']).status, 0);
  assert.equal(run([dir, 'status', '--pushed', 'w1=bbb']).status, 0);
  const page = readFileSync(path.join(dir, 'board.md'), 'utf8');
  assert.match(page, /^\| w1 \| #101 \| bbb \|  \| QA ready \| w2 \| /m, 'the update keeps the PR and dependencies');
  assert.match(page, /w1: head bbb, status QA ready/);
});

test('the pushed head is read from gh for a row with a PR and repo', (t) => {
  const dir = tempDir(t);
  const gh = path.join(dir, 'gh');
  writeFileSync(gh, '#!/bin/sh\necho "pushed-$3"\n');
  chmodSync(gh, 0o755);
  assert.equal(run([dir, 'writer', 'w1', '--pr', '7', '--repo', 'acme/app', '--head', 'old']).status, 0);
  const stale = run([dir, 'status'], { BOARD_GH: gh });
  assert.match(stale.stdout, /^STALE w1 board head old, pushed pushed-7$/m);
});

test('a ruling and a ready checkpoint stay untold until each recipient is told directly', (t) => {
  const dir = tempDir(t);
  const refused = run([dir, 'deliver', 'drag-chip', '--kind', 'ruling', '--to', 'w1,w2']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /saved once as a reference file/);
  assert.equal(run([dir, 'deliver', 'drag-chip', '--kind', 'ruling', '--reference', 'rulings/drag-chip.md', '--to', 'w1,w2,guide-102']).status, 0);
  assert.equal(run([dir, 'deliver', 'p-06', '--kind', 'checkpoint', '--head', 'abc', '--to', 'guide-102']).status, 0);
  assert.equal(run([dir, 'told', 'drag-chip', 'w1']).status, 0);
  assert.equal(run([dir, 'told', 'drag-chip', 'w9']).status, 2, 'only a named recipient can be told');
  const status = run([dir, 'status']);
  assert.equal(status.status, 1);
  assert.deepEqual(status.stdout.split('\n').filter((line) => line.startsWith('UNTOLD')), [
    'UNTOLD drag-chip w2',
    'UNTOLD drag-chip guide-102',
    'UNTOLD p-06 guide-102',
  ]);
  assert.match(readFileSync(path.join(dir, 'board.md'), 'utf8'), /- p-06 \(checkpoint\) for guide-102 at abc/);
  for (const [item, who] of [['drag-chip', 'w2'], ['drag-chip', 'guide-102'], ['p-06', 'guide-102']]) {
    assert.equal(run([dir, 'told', item, who]).status, 0);
  }
  assert.match(run([dir, 'status']).stdout, /board: 0 writers, 0 stale, 0 untold/);
});

test('a standing duty whose owner is stopped or unknown is UNOWNED-DUTY, and its owner cannot be stopped until it moves', (t) => {
  const dir = tempDir(t);
  const helpers = (args) => spawnSync(process.execPath, [path.join(HERE, 'helpers.mjs'), dir, ...args], { encoding: 'utf8' });
  assert.equal(run([dir, 'duty', 'main-health']).status, 2, 'a duty always names an owner');
  assert.equal(helpers(['start', 'main-ci-watch']).status, 0);
  assert.equal(run([dir, 'duty', 'main-health', '--owner', 'main-ci-watch']).status, 0);
  assert.equal(run([dir, 'duty', 'pr-shepherd', '--owner', 'w1']).status, 0);
  assert.equal(run([dir, 'writer', 'w1', '--head', 'aaa']).status, 0);
  assert.match(run([dir, 'status']).stdout, /board: 1 writers, 0 stale, 0 untold, 0 slow, 0 unowned duties/);
  assert.match(readFileSync(path.join(dir, 'board.md'), 'utf8'), /^- main-health: main-ci-watch \(since /m);

  const refused = helpers(['stopped', 'main-ci-watch']);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /^OWNS main-health; give it a new owner first/m);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'helpers.json'), 'utf8'))['main-ci-watch'].stoppedAt, undefined);

  assert.equal(run([dir, 'duty', 'main-health', '--owner', 'gone-helper']).status, 0);
  const unowned = run([dir, 'status']);
  assert.equal(unowned.status, 1);
  assert.match(unowned.stdout, /^UNOWNED-DUTY main-health owner gone-helper is not a writer or a running helper$/m);
  assert.equal(helpers(['stopped', 'main-ci-watch']).status, 0, 'once the duty moved, the old owner stops');
  assert.equal(run([dir, 'duty', 'main-health', '--owner', 'main-ci-watch']).status, 0);
  assert.match(run([dir, 'status']).stdout, /^UNOWNED-DUTY main-health owner main-ci-watch stopped /m);
});

test('a Codex writer with no push for 30 minutes on a PR with unresolved human threads is SLOW', (t) => {
  const dir = tempDir(t);
  assert.equal(run([dir, 'writer', 'w1', '--runtime', 'codex', '--head', 'aaa', '--now', '2026-10-21T12:00:00Z']).status, 0);
  assert.equal(run([dir, 'writer', 'w2', '--runtime', 'claude', '--head', 'bbb', '--now', '2026-10-21T12:00:00Z']).status, 0);
  assert.equal(run([dir, 'writer', 'w1', '--status', 'review fixes', '--now', '2026-10-21T12:20:00Z']).status, 0, 'a status update is not a push');
  const at = (time, threads = 'w1=9') => run([dir, 'status', '--threads', threads, '--threads', 'w2=4', '--now', time]);
  assert.equal(at('2026-10-21T12:29:00Z').status, 0);
  const slow = at('2026-10-21T12:35:00Z');
  assert.equal(slow.status, 1);
  assert.deepEqual(slow.stdout.split('\n').filter((line) => line.startsWith('SLOW')), [
    'SLOW w1 no push for 35m with 9 unresolved human threads; hand it to a Claude writer',
  ]);
  assert.equal(at('2026-10-21T12:35:00Z', 'w1=0').status, 0, 'no unresolved human thread, nothing to hand over');
  assert.equal(run([dir, 'writer', 'w1', '--head', 'ccc', '--now', '2026-10-21T12:40:00Z']).status, 0);
  assert.equal(at('2026-10-21T12:41:00Z').status, 0, 'a push restarts the clock');
  assert.equal(run([dir, 'writer', 'w3', '--runtime', 'gemini']).status, 2);
});

test('unresolved human threads are read with gh for a Codex row with a PR and repo; bot threads do not count', (t) => {
  const dir = tempDir(t);
  const gh = path.join(dir, 'gh');
  const nodes = [
    { isResolved: false, comments: { nodes: [{ author: { login: 'reviewer' } }] } },
    { isResolved: false, comments: { nodes: [{ author: { login: 'review-bot' } }] } },
    { isResolved: true, comments: { nodes: [{ author: { login: 'reviewer' } }] } },
    { isResolved: false, comments: { nodes: [{ author: { login: 'lead' } }] } },
  ];
  writeFileSync(gh, `#!/bin/sh\ncase "$*" in\n  "api graphql"*) echo '${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } })}' ;;\n  *) echo aaa ;;\nesac\n`);
  chmodSync(gh, 0o755);
  assert.equal(run([dir, 'writer', 'w1', '--runtime', 'codex', '--pr', '7', '--repo', 'acme/app', '--head', 'aaa', '--now', '2026-10-21T12:00:00Z']).status, 0);
  const slow = run([dir, 'status', '--now', '2026-10-21T13:00:00Z'], { BOARD_GH: gh });
  assert.match(slow.stdout, /^SLOW w1 no push for 60m with 2 unresolved human threads; hand it to a Claude writer$/m);
});

test('a work dir that watches sessions or PRs fails status while its watcher is missing (7 quiet hours overnight)', (t) => {
  const dir = tempDir(t);
  assert.equal(run([dir, 'status']).status, 0, 'no watch list, no watcher expected');
  writeFileSync(path.join(dir, 'prs.txt'), 'acme/app 7\n');
  assert.equal(run([dir, 'duty', 'green-watch', '--owner', 'w1']).status, 0);
  assert.equal(run([dir, 'duty', 'status-sweep', '--owner', 'w1']).status, 0);
  assert.equal(run([dir, 'writer', 'w1']).status, 0);
  const missing = run([dir, 'status', '--now', '2026-10-22T06:00:00Z']);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /^WATCHER-MISSING \(no watcher\.json\): re-arm watch\.sh now/m);
  writeFileSync(path.join(dir, 'watcher.json'), JSON.stringify({ pid: process.pid, startedAt: '2026-10-22T05:50:00Z', lastTickAt: '2026-10-22T05:59:00Z', intervalSeconds: 120 }));
  const armed = run([dir, 'status', '--now', '2026-10-22T06:00:00Z']);
  assert.equal(armed.status, 0, armed.stdout);
  writeFileSync(path.join(dir, 'watcher.json'), JSON.stringify({ pid: process.pid, startedAt: '2026-10-22T05:50:00Z', lastTickAt: '2026-10-22T05:59:00Z', intervalSeconds: 120, exitedAt: '2026-10-22T05:59:00Z' }));
  assert.match(run([dir, 'status', '--now', '2026-10-22T13:00:00Z']).stdout, /^WATCHER-MISSING \(exited 421m ago\)/m);
});

test('a writer question waiting 15 minutes is QUESTION-UNANSWERED until answered (#9118)', (t) => {
  const dir = tempDir(t);
  assert.equal(run([dir, 'question', 'w1', '--id', 'q1', '--text', 'Sort by rank or updated? If no answer by 09:04Z: rank', '--now', '2026-10-22T08:34:00Z']).status, 0);
  assert.equal(run([dir, 'status', '--now', '2026-10-22T08:48:00Z']).status, 0, 'fourteen minutes is not yet late');
  const late = run([dir, 'status', '--now', '2026-10-22T08:49:00Z']);
  assert.equal(late.status, 1);
  assert.match(late.stdout, /^QUESTION-UNANSWERED w1 q1 15m: Sort by rank or updated\?/m);
  assert.equal(run([dir, 'answered', 'w1', '--id', 'q1', '--now', '2026-10-22T08:50:00Z']).status, 0);
  assert.equal(run([dir, 'ack', 'w1', '--id', 'q1', '--now', '2026-10-22T08:52:00Z']).status, 0);
  assert.equal(run([dir, 'status', '--now', '2026-10-22T13:00:00Z']).status, 0);
  assert.equal(run([dir, 'question', 'w1', '--text', 'x']).status, 2, 'a question carries an id');
});

test('an answer the writer has not acknowledged in 15 minutes is UNACKED (answers sent three times)', (t) => {
  const dir = tempDir(t);
  assert.equal(run([dir, 'question', 'w2', '--id', 'url-cap', '--text', 'Cap URLs at 2000? Default: yes', '--now', '2026-10-22T10:00:00Z']).status, 0);
  assert.equal(run([dir, 'answered', 'w2', '--id', 'url-cap', '--now', '2026-10-22T10:05:00Z']).status, 0);
  assert.equal(run([dir, 'status', '--now', '2026-10-22T10:19:00Z']).status, 0, 'an answer has 15 minutes to be acknowledged');
  const unacked = run([dir, 'status', '--now', '2026-10-22T10:20:00Z']);
  assert.equal(unacked.status, 1);
  assert.match(unacked.stdout, /^UNACKED w2 url-cap 15m: the writer has not acknowledged your answer/m);
  assert.doesNotMatch(unacked.stdout, /QUESTION-UNANSWERED/, 'an answered question is no longer unanswered');
  assert.equal(run([dir, 'ack', 'w2', '--id', 'other']).status, 2, 'an ack names a recorded question');
  assert.equal(run([dir, 'ack', 'w2', '--id', 'url-cap', '--now', '2026-10-22T10:21:00Z']).status, 0);
  assert.equal(run([dir, 'status', '--now', '2026-10-22T11:00:00Z']).status, 0);
});

test('a watched program needs a green-watch owner; REQUIRED_DUTIES names others', (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'prs.txt'), 'acme/app 7\n');
  writeFileSync(path.join(dir, 'watcher.json'), JSON.stringify({ pid: process.pid, startedAt: '2026-10-22T05:50:00Z', lastTickAt: '2026-10-22T05:59:00Z', intervalSeconds: 120 }));
  const now = ['--now', '2026-10-22T06:00:00Z'];
  const bare = run([dir, 'status', ...now]);
  assert.equal(bare.status, 1);
  assert.match(bare.stdout, /^MISSING-DUTY green-watch: give it an owner/m);
  assert.equal(run([dir, 'writer', 'keeper']).status, 0);
  assert.equal(run([dir, 'duty', 'green-watch', '--owner', 'keeper']).status, 0);
  assert.match(run([dir, 'status', ...now]).stdout, /^MISSING-DUTY status-sweep/m, 'the status sweep is a standing duty too');
  assert.equal(run([dir, 'duty', 'status-sweep', '--owner', 'keeper']).status, 0);
  assert.equal(run([dir, 'status', ...now]).status, 0);
  writeFileSync(path.join(dir, 'config.env'), 'REQUIRED_DUTIES="green-watch pr-shepherd"\n');
  assert.match(run([dir, 'status', ...now]).stdout, /^MISSING-DUTY pr-shepherd/m);
});

test('a head is pushed for a writer only when the writer declared it ready (a partial commit was pushed)', (t) => {
  const dir = tempDir(t);
  assert.equal(run([dir, 'writer', 'w1', '--head', 'a77421d8fa00']).status, 0);
  const none = run([dir, 'push-check', 'w1', '--head', 'a77421d8fa00']);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /^NOT-READY w1 head a77421d8fa00, declared ready none/);
  assert.equal(run([dir, 'writer', 'w1', '--ready', '5ec6633da7ff']).status, 0);
  assert.equal(run([dir, 'push-check', 'w1', '--head', 'a77421d8fa00']).status, 1, 'the committed head is not the ready one');
  assert.equal(run([dir, 'push-check', 'w1', '--head', '5ec6633da7']).status, 0);
  assert.equal(run([dir, 'push-check', 'w1', '--head', '5ec']).status, 1, 'a short prefix proves nothing');
  assert.match(readFileSync(path.join(dir, 'board.md'), 'utf8'), /\| w1 \|  \| a77421d8fa00 \| 5ec6633da7ff \|/);
});

test('status fails on state outside the fleet home: a flat watched dir, and a session not started through fleet.sh', (t) => {
  const flat = mkdtempSync(path.join(os.tmpdir(), 'fleet-board-flat-'));
  t.after(() => rmSync(flat, { recursive: true, force: true }));
  writeFileSync(path.join(flat, 'prs.txt'), '');
  const watcher = JSON.stringify({ pid: process.pid, startedAt: '2026-10-22T05:50:00Z', lastTickAt: '2026-10-22T05:59:00Z', intervalSeconds: 120 });
  writeFileSync(path.join(flat, 'watcher.json'), watcher);
  writeFileSync(path.join(flat, 'config.env'), 'REQUIRED_DUTIES=""\n');
  const now = ['--now', '2026-10-22T06:00:00Z'];
  const flatStatus = run([flat, 'status', ...now]);
  assert.equal(flatStatus.status, 1);
  assert.match(flatStatus.stdout, /^FLAT-LAYOUT /m);
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'watcher.json'), watcher);
  writeFileSync(path.join(dir, 'config.env'), 'REQUIRED_DUTIES=""\n');
  writeFileSync(path.join(dir, 'sessions.txt'), 'remote prd723-vibe\n');
  const home = path.dirname(path.dirname(dir));
  assert.match(run([home, 'status', ...now]).stdout, /^UNMANAGED remote prd723-vibe: not started through fleet.sh/m, 'the home resolves to its active program');
  mkdirSync(path.join(dir, 'sessions'));
  writeFileSync(path.join(dir, 'sessions', 'prd723-vibe.remote.json'), '{}\n');
  assert.equal(run([home, 'status', ...now]).status, 0);
});

// 2026-10-26: a Claude pane writer committed items 1 to 3 and sat in long verification runs for over an
// hour; the answer and two scope additions sent at 14:55 and 15:15 never reached it, and its worktree stayed clean
// at that one commit. Every send reported success and nothing flagged it until the operator asked.
const gitRepo = (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'fleet-board-wt-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(path.join(repo, 'filters.ts'), 'export const quickFilters = true;\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t', 'commit', '-qm', 'items 1 to 3');
  return repo;
};

test('a scope change the writer never acknowledges is UNACKED-SCOPE, and a worktree still clean at the old head is SCOPE-NOT-STARTED (2026-10-26)', (t) => {
  const dir = tempDir(t);
  const worktree = gitRepo(t);
  assert.equal(run([dir, 'writer', 'fix-13096', '--runtime', 'claude', '--worktree', worktree, '--now', '2026-10-26T14:49:00Z']).status, 0);
  assert.equal(run([dir, 'deliver', 'item-5', '--kind', 'scope', '--to', 'fix-13096', '--text', 'restore legacy Project Detail row selection (AC-5)', '--now', '2026-10-26T15:15:00Z']).status, 0);
  assert.equal(run([dir, 'told', 'item-5', 'fix-13096', '--now', '2026-10-26T15:15:30Z']).status, 0);
  const at = (time) => run([dir, 'status', '--now', time]);
  assert.equal(at('2026-10-26T15:29:00Z').status, 0, 'a told change has 15 minutes to be acknowledged');
  const unacked = at('2026-10-26T15:31:00Z');
  assert.equal(unacked.status, 1);
  assert.match(unacked.stdout, /^UNACKED-SCOPE item-5 fix-13096 15m: the writer has not acknowledged this scope change/m);
  assert.doesNotMatch(unacked.stdout, /SCOPE-NOT-STARTED/, 'thirty minutes pass before an unmoved head counts');
  const incident = at('2026-10-26T16:52:00Z');
  assert.match(incident.stdout, /^UNACKED-SCOPE item-5 fix-13096 96m/m);
  assert.match(incident.stdout, /^SCOPE-NOT-STARTED item-5 fix-13096 96m: its worktree is clean at [0-9a-f]{10}, the head it had when the change was sent/m);
  assert.match(incident.stdout, /1 scope unacked, 1 scope not started/);
  assert.equal(
    run([dir, 'watch-lines', '--now', '2026-10-26T16:52:00Z']).stdout,
    'board UNACKED-SCOPE item-5 fix-13096\nboard SCOPE-NOT-STARTED item-5 fix-13096\n',
    'watch lines carry no minutes, so the watcher wakes once when each appears',
  );
  assert.equal(run([dir, 'watch-lines', '--now', '2026-10-26T17:30:00Z']).stdout, run([dir, 'watch-lines', '--now', '2026-10-26T16:52:00Z']).stdout);

  const pending = run([dir, 'pending', 'fix-13096']);
  assert.equal(pending.status, 1, 'the writer reads its own pending list without waiting for the mailbox');
  assert.match(pending.stdout, /^SCOPE item-5: restore legacy Project Detail row selection \(AC-5\)$/m);
  assert.equal(run([dir, 'ack', 'fix-13096', '--id', 'item-5', '--now', '2026-10-26T16:53:00Z']).status, 0);
  assert.equal(run([dir, 'pending', 'fix-13096']).status, 0);
  const acked = at('2026-10-26T16:54:00Z');
  assert.doesNotMatch(acked.stdout, /UNACKED-SCOPE/);
  assert.match(acked.stdout, /^SCOPE-NOT-STARTED item-5 fix-13096/m, 'an acknowledgement alone does not start the work');
  writeFileSync(path.join(worktree, 'selection.ts'), 'export const rowSelection = true;\n');
  assert.equal(at('2026-10-26T16:55:00Z').status, 0, 'a change in the worktree is the work starting');
});

test('a scope change needs content and a writer whose worktree status can read; a pending answer carries its text', (t) => {
  const dir = tempDir(t);
  assert.equal(run([dir, 'writer', 'w1']).status, 0);
  const noTree = run([dir, 'deliver', 'c1', '--kind', 'scope', '--to', 'w1', '--text', 'add item 4']);
  assert.equal(noTree.status, 2);
  assert.match(noTree.stderr, /board writer with a worktree/);
  assert.equal(run([dir, 'writer', 'w1', '--worktree', gitRepo(t)]).status, 0);
  const empty = run([dir, 'deliver', 'c1', '--kind', 'scope', '--to', 'w1']);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /carries its content/);
  assert.equal(run([dir, 'deliver', 'c1', '--kind', 'scope', '--to', 'w1', '--text', 'add item 4']).status, 0);
  assert.match(readFileSync(path.join(dir, 'board.md'), 'utf8'), /^- c1 for w1: add item 4$/m);
  assert.equal(run([dir, 'ack', 'w2', '--id', 'c1']).status, 2, 'only a recipient acknowledges a scope change');

  assert.equal(run([dir, 'question', 'w1', '--id', 'hide-default', '--text', 'Hide completed ON by default? Default: OFF']).status, 0);
  assert.equal(run([dir, 'answered', 'w1', '--id', 'hide-default', '--text', 'ON, with legacy persistence']).status, 0);
  const pending = run([dir, 'pending', 'w1']);
  assert.match(pending.stdout, /^SCOPE c1: add item 4$/m);
  assert.match(pending.stdout, /^ANSWERED hide-default: ON, with legacy persistence$/m);
  assert.equal(run([dir, 'ack', 'w1', '--id', 'hide-default']).status, 0);
  assert.equal(run([dir, 'ack', 'w1', '--id', 'c1']).status, 0);
  assert.equal(run([dir, 'pending', 'w1']).stdout, 'pending: none\n');
});
