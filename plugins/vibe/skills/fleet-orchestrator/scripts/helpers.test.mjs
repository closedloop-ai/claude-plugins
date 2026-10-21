import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { historyOrigin } from './history-origin.mjs';
import { stopCandidates } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = (args) => spawnSync(process.execPath, [path.join(HERE, 'helpers.mjs'), ...args], { encoding: 'utf8' });

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
