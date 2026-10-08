import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./checkpoint-worktree.mjs', import.meta.url));

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', ...options }).trim();
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cl-checkpoint-test-'));
  const repo = join(root, 'repo');
  run('git', ['init', repo]);
  run('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  run('git', ['-C', repo, 'config', 'user.name', 'Test User']);
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  run('git', ['-C', repo, 'add', 'tracked.txt']);
  run('git', ['-C', repo, 'commit', '-m', 'base']);
  return { root, repo };
}

test('round-trips staged, unstaged, untracked, and symlink state', () => {
  const { root, repo } = initRepo();
  writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
  run('git', ['-C', repo, 'add', 'tracked.txt']);
  writeFileSync(join(repo, 'tracked.txt'), 'staged\nunstaged\n');
  writeFileSync(join(repo, 'new.txt'), 'untracked\n');
  symlinkSync('new.txt', join(repo, 'new-link'));

  const checkpoint = join(root, 'checkpoint');
  const manifest = JSON.parse(run('node', [script, 'create', '--worktree', repo, '--output', checkpoint, '--owner-surface', 'desktop', '--generation', '4']));
  assert.equal(manifest.generation, 4);
  assert.equal(manifest.untracked.length, 2);
  JSON.parse(run('node', [script, 'verify', '--checkpoint', checkpoint]));

  const target = join(root, 'target');
  run('git', ['-C', repo, 'worktree', 'add', '-b', 'codex/rehydrate', target, 'HEAD']);
  const result = JSON.parse(run('node', [script, 'rehydrate', '--checkpoint', checkpoint, '--worktree', target]));
  assert.equal(result.rehydrated, true);
  assert.equal(readFileSync(join(target, 'tracked.txt'), 'utf8'), 'staged\nunstaged\n');
  assert.equal(readFileSync(join(target, 'new.txt'), 'utf8'), 'untracked\n');
  assert.match(run('git', ['-C', target, 'diff', '--cached']), /\+staged/);
  assert.match(run('git', ['-C', target, 'diff']), /\+unstaged/);
});

test('detects payload tampering and refuses dirty rehydrate targets', () => {
  const { root, repo } = initRepo();
  writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
  const checkpoint = join(root, 'checkpoint');
  run('node', [script, 'create', '--worktree', repo, '--output', checkpoint, '--owner-surface', 'desktop', '--generation', '1']);
  const target = join(root, 'target');
  run('git', ['-C', repo, 'worktree', 'add', '-b', 'codex/dirty-target', target, 'HEAD']);
  writeFileSync(join(target, 'local.txt'), 'dirty\n');
  const dirty = spawnSync('node', [script, 'rehydrate', '--checkpoint', checkpoint, '--worktree', target], { encoding: 'utf8' });
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /must be clean/);

  writeFileSync(join(checkpoint, 'payload', 'working.patch'), 'tampered\n');
  const verify = spawnSync('node', [script, 'verify', '--checkpoint', checkpoint], { encoding: 'utf8' });
  assert.notEqual(verify.status, 0);
  assert.match(verify.stderr, /failed verification/);
});

test('rejects checkpoint outputs inside the source worktree through direct and symlink paths', () => {
  const { root, repo } = initRepo();
  const direct = join(repo, 'checkpoint');
  const directResult = spawnSync('node', [script, 'create', '--worktree', repo, '--output', direct, '--owner-surface', 'cli', '--generation', '1'], { encoding: 'utf8' });
  assert.notEqual(directResult.status, 0);
  assert.match(directResult.stderr, /outside the source worktree/);
  assert.equal(existsSync(direct), false);

  const alias = join(root, 'repo-alias');
  symlinkSync(repo, alias, 'dir');
  const viaAlias = join(alias, 'checkpoint-via-alias');
  const aliasResult = spawnSync('node', [script, 'create', '--worktree', repo, '--output', viaAlias, '--owner-surface', 'cli', '--generation', '1'], { encoding: 'utf8' });
  assert.notEqual(aliasResult.status, 0);
  assert.match(aliasResult.stderr, /outside the source worktree/);
  assert.equal(existsSync(join(repo, 'checkpoint-via-alias')), false);
});
