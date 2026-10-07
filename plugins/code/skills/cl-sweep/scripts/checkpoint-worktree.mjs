#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SCHEMA = 'cl-sweep-worktree-checkpoint/v1';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || !value) fail(`Invalid argument near ${key ?? '<end>'}`);
    args[key.slice(2)] = value;
  }
  return args;
}

function required(args, key) {
  if (!args[key]) fail(`--${key} is required`);
  return args[key];
}

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: options.encoding ?? 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    // A dirty terminal worktree can legitimately contain a multi-megabyte
    // binary patch (for example, a deleted lockfile). Preserve it instead of
    // failing at Node's small default child-process buffer.
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function safeRelativePath(path) {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error(`Unsafe checkpoint path: ${path}`);
  }
  return path;
}

function payload(checkpoint, name) {
  return join(checkpoint, 'payload', name);
}

function writePayload(checkpoint, name, data) {
  const path = payload(checkpoint, name);
  writeFileSync(path, data);
  return { name, sha256: sha256(data), bytes: Buffer.byteLength(data) };
}

function copyUntracked(worktree, checkpoint, path) {
  safeRelativePath(path);
  const source = join(worktree, path);
  const target = join(checkpoint, 'untracked', path);
  mkdirSync(dirname(target), { recursive: true });
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
  else if (stat.isFile()) copyFileSync(source, target);
  else cpSync(source, target, { recursive: true, dereference: false });
  const descriptor = stat.isSymbolicLink()
    ? Buffer.from(`symlink:${readlinkSync(source)}`)
    : readFileSync(source);
  return { path, type: stat.isSymbolicLink() ? 'symlink' : 'file', mode: stat.mode & 0o777, sha256: sha256(descriptor) };
}

function loadManifest(checkpoint) {
  const manifestPath = join(checkpoint, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('Checkpoint manifest is missing');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== SCHEMA) throw new Error(`Unsupported checkpoint schema: ${manifest.schema}`);
  return manifest;
}

function verify(checkpoint) {
  const manifestData = readFileSync(join(checkpoint, 'manifest.json'));
  const manifest = loadManifest(checkpoint);
  for (const item of manifest.payloads) {
    const data = readFileSync(payload(checkpoint, safeRelativePath(item.name)));
    if (data.length !== item.bytes || sha256(data) !== item.sha256) {
      throw new Error(`Checkpoint payload failed verification: ${item.name}`);
    }
  }
  for (const item of manifest.untracked) {
    const source = join(checkpoint, 'untracked', safeRelativePath(item.path));
    const stat = lstatSync(source);
    const descriptor = stat.isSymbolicLink()
      ? Buffer.from(`symlink:${readlinkSync(source)}`)
      : readFileSync(source);
    if (sha256(descriptor) !== item.sha256) throw new Error(`Untracked file failed verification: ${item.path}`);
    if (!stat.isSymbolicLink() && (stat.mode & 0o777) !== item.mode) throw new Error(`Untracked file mode failed verification: ${item.path}`);
  }
  return { ...manifest, manifestSha256: sha256(manifestData) };
}

function pathExists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function canonicalizeProspectivePath(pathValue) {
  const tail = [];
  let cursor = resolve(pathValue);
  while (!pathExists(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) fail(`Cannot resolve checkpoint output: ${pathValue}`);
    tail.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...tail);
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}

function create(args) {
  const worktree = realpathSync(required(args, 'worktree'));
  const checkpoint = canonicalizeProspectivePath(required(args, 'output'));
  if (isWithin(worktree, checkpoint)) fail('Checkpoint output must be outside the source worktree');
  if (existsSync(checkpoint)) fail(`Refusing to overwrite checkpoint: ${checkpoint}`);
  mkdirSync(join(checkpoint, 'payload'), { recursive: true });
  mkdirSync(join(checkpoint, 'untracked'), { recursive: true });
  const root = realpathSync(git(worktree, ['rev-parse', '--show-toplevel']).trim());
  if (root !== worktree) fail('Checkpoint source must be a worktree root');
  const workingPatch = git(worktree, ['diff', 'HEAD', '--binary', '--no-ext-diff'], { encoding: 'buffer' });
  const indexPatch = git(worktree, ['diff', '--cached', '--binary', '--no-ext-diff'], { encoding: 'buffer' });
  const status = git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'buffer' });
  const untrackedBuffer = git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'buffer' });
  const untrackedPaths = untrackedBuffer.subarray(0, Math.max(0, untrackedBuffer.length - 1)).toString('utf8').split('\0').filter(Boolean);
  const roundTrippedPaths = Buffer.from(`${untrackedPaths.join('\0')}${untrackedPaths.length ? '\0' : ''}`);
  if (!roundTrippedPaths.equals(untrackedBuffer)) fail('Untracked filenames must be valid UTF-8 for checkpointing');
  const manifest = {
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    sourceWorktree: worktree,
    repoCommonDir: realpathSync(resolve(worktree, git(worktree, ['rev-parse', '--git-common-dir']).trim())),
    branch: git(worktree, ['branch', '--show-current']).trim() || null,
    head: git(worktree, ['rev-parse', 'HEAD']).trim(),
    ownerSurface: required(args, 'owner-surface'),
    generation: Number.parseInt(required(args, 'generation'), 10),
    statusSha256: sha256(status),
    payloads: [
      writePayload(checkpoint, 'working.patch', workingPatch),
      writePayload(checkpoint, 'index.patch', indexPatch),
      writePayload(checkpoint, 'status.porcelain-v1-z', status),
    ],
    untracked: untrackedPaths.map((path) => copyUntracked(worktree, checkpoint, path)),
  };
  if (!Number.isSafeInteger(manifest.generation) || manifest.generation < 1) fail('--generation must be a positive integer');
  writeFileSync(join(checkpoint, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return verify(checkpoint);
}

function applyPatch(worktree, patch, args) {
  if (readFileSync(patch).length === 0) return;
  git(worktree, ['apply', '--binary', ...args, patch]);
}

function rehydrate(args) {
  const checkpoint = realpathSync(required(args, 'checkpoint'));
  const manifest = verify(checkpoint);
  const worktree = realpathSync(required(args, 'worktree'));
  const targetRoot = realpathSync(git(worktree, ['rev-parse', '--show-toplevel']).trim());
  if (targetRoot !== worktree) fail('Rehydrate target must be a worktree root');
  if (git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']).trim()) fail('Rehydrate target must be clean');
  const head = git(worktree, ['rev-parse', 'HEAD']).trim();
  if (head !== manifest.head) fail(`Rehydrate HEAD mismatch: expected ${manifest.head}, found ${head}`);
  const targetCommonDir = realpathSync(resolve(worktree, git(worktree, ['rev-parse', '--git-common-dir']).trim()));
  if (targetCommonDir !== manifest.repoCommonDir) fail('Rehydrate target belongs to a different repository');
  const workingPatch = payload(checkpoint, 'working.patch');
  const indexPatch = payload(checkpoint, 'index.patch');
  applyPatch(worktree, workingPatch, ['--check']);
  applyPatch(worktree, indexPatch, ['--cached', '--check']);
  for (const item of manifest.untracked) {
    const target = join(worktree, safeRelativePath(item.path));
    if (pathExists(target)) fail(`Refusing to overwrite target path: ${item.path}`);
  }
  applyPatch(worktree, workingPatch, []);
  for (const item of manifest.untracked) {
    const source = join(checkpoint, 'untracked', item.path);
    const target = join(worktree, item.path);
    mkdirSync(dirname(target), { recursive: true });
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else {
      copyFileSync(source, target);
      chmodSync(target, item.mode);
    }
  }
  applyPatch(worktree, indexPatch, ['--cached']);
  const status = git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'buffer' });
  const statusSha256 = sha256(status);
  if (statusSha256 !== manifest.statusSha256) fail('Rehydrated worktree status does not match checkpoint');
  return {
    schema: SCHEMA,
    checkpoint,
    worktree,
    branch: git(worktree, ['branch', '--show-current']).trim() || null,
    head,
    ownerSurface: manifest.ownerSurface,
    generation: manifest.generation,
    manifestSha256: manifest.manifestSha256,
    statusSha256,
    rehydrated: true,
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.command === 'create') result = create(args);
  else if (args.command === 'verify') result = verify(realpathSync(required(args, 'checkpoint')));
  else if (args.command === 'rehydrate') result = rehydrate(args);
  else fail('Usage: checkpoint-worktree.mjs <create|verify|rehydrate> [options]');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.stderr?.toString().trim() || error.message}\n`);
  process.exitCode = 1;
}
