import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tempDir = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-board-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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
  assert.match(page, /^\| w1 \| #101 \| bbb \| QA ready \| w2 \| /m, 'the update keeps the PR and dependencies');
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
