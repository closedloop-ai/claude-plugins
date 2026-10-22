#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (['expect-clean', 'force', 'delete-branch', 'force-delete-branch'].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function git(cwd, args, options = {}) {
  const output = execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
  return output?.trim() ?? '';
}

function required(args, key) {
  if (!args[key]) fail(`--${key} is required`);
  return args[key];
}

function repoRoot(repo) {
  return realpathSync(git(resolve(repo), ['rev-parse', '--show-toplevel']));
}

function commonDir(cwd) {
  const raw = git(cwd, ['rev-parse', '--git-common-dir']);
  return realpathSync(resolve(cwd, raw));
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function canonicalizeProspectivePath(pathValue) {
  const tail = [];
  let cursor = resolve(pathValue);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) fail(`Cannot resolve path: ${pathValue}`);
    tail.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...tail);
}

function currentCheckpointFingerprint(worktree) {
  const command = (args) => execFileSync('git', ['-C', worktree, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const working = command(['diff', 'HEAD', '--binary', '--no-ext-diff']);
  const index = command(['diff', '--cached', '--binary', '--no-ext-diff']);
  const status = command(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const paths = command(['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  const untracked = paths.map((path) => {
    const absolute = resolve(worktree, path);
    const stat = lstatSync(absolute);
    const descriptor = stat.isSymbolicLink()
      ? Buffer.from(`symlink:${readlinkSync(absolute)}`)
      : readFileSync(absolute);
    return { path, type: stat.isSymbolicLink() ? 'symlink' : 'file', mode: stat.mode & 0o777, sha256: sha256(descriptor) };
  });
  return {
    statusSha256: sha256(status),
    payloads: { 'working.patch': sha256(working), 'index.patch': sha256(index) },
    untracked,
  };
}

function inspect(repo, worktree, expectedBranch, expectClean) {
  if (!existsSync(worktree)) fail(`Worktree does not exist: ${worktree}`);
  const root = realpathSync(git(worktree, ['rev-parse', '--show-toplevel']));
  if (root !== realpathSync(worktree)) fail(`Path is not a worktree root: ${worktree}`);
  if (commonDir(repo) !== commonDir(worktree)) fail('Worktree belongs to a different repository');
  const branch = git(worktree, ['branch', '--show-current']);
  if (!branch) fail('Detached worktrees are not valid ticket worktrees');
  if (expectedBranch && branch !== expectedBranch) {
    fail(`Expected branch ${expectedBranch}, found ${branch}`);
  }
  const status = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (expectClean && status) fail('Worktree is not clean');
  return {
    schema: 'cl-sweep-cli-worktree/v1',
    repo: repoRoot(repo),
    worktree: root,
    branch,
    head: git(worktree, ['rev-parse', 'HEAD']),
    clean: status.length === 0,
  };
}

function create(args) {
  const repo = repoRoot(required(args, 'repo'));
  const worktree = resolve(required(args, 'path'));
  const branch = required(args, 'branch');
  const base = required(args, 'base');
  if (isWithin(repo, worktree)) fail('Ticket worktree must be outside the source worktree');
  if (existsSync(worktree)) fail(`Refusing to reuse existing path: ${worktree}`);
  try {
    git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    fail(`Refusing to reuse existing branch: ${branch}`);
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const expectedHead = git(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
  let added = false;
  try {
    git(repo, ['worktree', 'add', '-b', branch, worktree, expectedHead]);
    added = true;
    const result = inspect(repo, worktree, branch, true);
    if (result.head !== expectedHead) fail('Created worktree HEAD does not match requested base');
    return result;
  } catch (error) {
    if (added) {
      try { git(repo, ['worktree', 'remove', '--force', worktree]); } catch {}
      try { git(repo, ['branch', '-D', branch]); } catch {}
    }
    throw error;
  }
}

function validate(args) {
  return inspect(
    repoRoot(required(args, 'repo')),
    resolve(required(args, 'path')),
    args.branch,
    Boolean(args['expect-clean']),
  );
}

function remove(args) {
  const repo = repoRoot(required(args, 'repo'));
  const worktree = resolve(required(args, 'path'));
  const state = inspect(repo, worktree, args.branch, !args.force);
  const destructive = Boolean(args.force || args['force-delete-branch']);
  let cleanup = null;
  if (destructive) {
    const checkpoint = required(args, 'checkpoint');
    const cleanupReason = required(args, 'cleanup-reason').trim();
    if (!cleanupReason) fail('--cleanup-reason must not be blank');
    const cleanupLedger = canonicalizeProspectivePath(required(args, 'cleanup-ledger'));
    if (isWithin(worktree, cleanupLedger)) fail('Cleanup ledger must be outside the worktree');
    const verified = JSON.parse(execFileSync(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), 'checkpoint-worktree.mjs'), 'verify', '--checkpoint', checkpoint], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const current = currentCheckpointFingerprint(worktree);
    const checkpointPayloads = Object.fromEntries(verified.payloads.map((item) => [item.name, item.sha256]));
    if (realpathSync(verified.sourceWorktree) !== realpathSync(worktree)
      || verified.head !== state.head
      || verified.statusSha256 !== current.statusSha256
      || checkpointPayloads['working.patch'] !== current.payloads['working.patch']
      || checkpointPayloads['index.patch'] !== current.payloads['index.patch']
      || JSON.stringify(verified.untracked) !== JSON.stringify(current.untracked)) {
      fail('Checkpoint does not match the current worktree state');
    }
    cleanup = {
      schema: 'CL_SWEEP_WORKTREE_CLEANUP v1',
      event: 'CLEANUP_AUTHORIZED',
      at: new Date().toISOString(),
      repo,
      worktree,
      branch: state.branch,
      head: state.head,
      checkpoint: realpathSync(checkpoint),
      checkpointManifestSha256: verified.manifestSha256,
      cleanupReason,
      forceWorktreeRemoval: Boolean(args.force),
      forceDeleteBranch: Boolean(args['force-delete-branch']),
    };
    mkdirSync(dirname(cleanupLedger), { recursive: true });
    appendFileSync(cleanupLedger, `${JSON.stringify(cleanup)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(cleanupLedger, 0o600);
    cleanup.ledger = cleanupLedger;
  }
  const removeArgs = ['worktree', 'remove'];
  if (args.force) removeArgs.push('--force');
  removeArgs.push(worktree);
  git(repo, removeArgs);
  if (args['delete-branch'] || args['force-delete-branch']) {
    git(repo, ['branch', args['force-delete-branch'] ? '-D' : '-d', state.branch]);
  }
  if (cleanup) {
    appendFileSync(cleanup.ledger, `${JSON.stringify({ ...cleanup, event: 'CLEANUP_COMPLETED', at: new Date().toISOString() })}\n`);
  }
  return { ...state, removed: true, cleanup };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!['create', 'validate', 'remove'].includes(args.command)) {
    fail('Usage: cli-worktree.mjs <create|validate|remove> [options]');
  }
  const result = args.command === 'create' ? create(args) : args.command === 'validate' ? validate(args) : remove(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.stderr?.toString().trim() || error.message}\n`);
  process.exitCode = 1;
}
