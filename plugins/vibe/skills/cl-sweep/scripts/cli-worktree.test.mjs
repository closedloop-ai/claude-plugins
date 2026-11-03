import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./cli-worktree.mjs', import.meta.url));

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', ...options }).trim();
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cl-worktree-test-'));
  const repo = join(root, 'repo');
  run('git', ['init', repo]);
  run('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  run('git', ['-C', repo, 'config', 'user.name', 'Test User']);
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  run('git', ['-C', repo, 'add', 'tracked.txt']);
  run('git', ['-C', repo, 'commit', '-m', 'base']);
  return { root, repo };
}

test('creates, validates, and safely removes an explicit ticket worktree', () => {
  const { root, repo } = initRepo();
  const worktree = join(root, 'ticket');
  const created = JSON.parse(run('node', [script, 'create', '--repo', repo, '--path', worktree, '--branch', 'codex/FEA-1', '--base', 'HEAD']));
  assert.equal(created.branch, 'codex/FEA-1');
  assert.equal(created.clean, true);

  const validated = JSON.parse(run('node', [script, 'validate', '--repo', repo, '--path', worktree, '--branch', 'codex/FEA-1', '--expect-clean']));
  assert.equal(validated.head, created.head);

  writeFileSync(join(worktree, 'tracked.txt'), 'dirty\n');
  const blocked = spawnSync('node', [script, 'remove', '--repo', repo, '--path', worktree, '--branch', 'codex/FEA-1'], { encoding: 'utf8' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /not clean/);

  const checkpointScript = fileURLToPath(new URL('./checkpoint-worktree.mjs', import.meta.url));
  const checkpoint = join(root, 'checkpoint');
  const cleanupLedger = join(root, 'cleanup.jsonl');
  run('node', [checkpointScript, 'create', '--worktree', worktree, '--output', checkpoint, '--owner-surface', 'cli', '--generation', '1']);
  writeFileSync(join(worktree, 'tracked.txt'), 'newer dirty state\n');
  const staleCheckpoint = spawnSync('node', [script, 'remove', '--repo', repo, '--path', worktree, '--branch', 'codex/FEA-1', '--force', '--checkpoint', checkpoint, '--cleanup-reason', 'terminal_cleanup', '--cleanup-ledger', cleanupLedger], { encoding: 'utf8' });
  assert.notEqual(staleCheckpoint.status, 0);
  assert.match(staleCheckpoint.stderr, /does not match/);
  writeFileSync(join(worktree, 'tracked.txt'), 'dirty\n');
  const removed = JSON.parse(run('node', [script, 'remove', '--repo', repo, '--path', worktree, '--branch', 'codex/FEA-1', '--force', '--checkpoint', checkpoint, '--force-delete-branch', '--cleanup-reason', 'terminal_cleanup', '--cleanup-ledger', cleanupLedger]));
  assert.equal(removed.removed, true);
  const cleanupEvents = readFileSync(cleanupLedger, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(cleanupEvents.map((event) => event.event), ['CLEANUP_AUTHORIZED', 'CLEANUP_COMPLETED']);
  assert.equal(cleanupEvents[0].cleanupReason, 'terminal_cleanup');
});

test('refuses branch and path reuse', () => {
  const { root, repo } = initRepo();
  run('git', ['-C', repo, 'branch', 'codex/existing']);
  const result = spawnSync('node', [script, 'create', '--repo', repo, '--path', join(root, 'ticket'), '--branch', 'codex/existing', '--base', 'HEAD'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /existing branch/);
});

test('force-delete-branch requires a verified checkpoint and durable cleanup reason', () => {
  const { root, repo } = initRepo();
  const worktree = join(root, 'ticket');
  run('node', [script, 'create', '--repo', repo, '--path', worktree, '--branch', 'codex/FEA-2', '--base', 'HEAD']);
  const result = spawnSync('node', [script, 'remove', '--repo', repo, '--path', worktree, '--branch', 'codex/FEA-2', '--force-delete-branch'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--checkpoint is required/);
  const checkpointScript = fileURLToPath(new URL('./checkpoint-worktree.mjs', import.meta.url));
  const checkpoint = join(root, 'checkpoint');
  run('node', [checkpointScript, 'create', '--worktree', worktree, '--output', checkpoint, '--owner-surface', 'cli', '--generation', '1']);
  const missingReason = spawnSync('node', [script, 'remove', '--repo', repo, '--path', worktree, '--branch', 'codex/FEA-2', '--force-delete-branch', '--checkpoint', checkpoint], { encoding: 'utf8' });
  assert.notEqual(missingReason.status, 0);
  assert.match(missingReason.stderr, /--cleanup-reason is required/);
  JSON.parse(run('node', [script, 'validate', '--repo', repo, '--path', worktree, '--branch', 'codex/FEA-2']));
});
