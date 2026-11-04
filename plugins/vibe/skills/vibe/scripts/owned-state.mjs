import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OWNERSHIP_VERSION = 1;

/** The machine-wide E2E lock path for one home directory. */
export function e2eLockDir(home = os.homedir()) {
  return path.join(home, '.codex', 'vibe', 'locks', 'e2e-stack');
}

/** Machine-local private cleanup state stays outside any worktree it may retire. */
export function cleanupDir(home = os.homedir()) {
  return path.join(home, '.codex', 'vibe', 'cleanup');
}

/** Read one private cleanup record only when it is a regular file. */
export function regularJson(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('cleanup record is not a regular file');
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Atomically replace a private JSON ownership record. */
export function writeAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

function pendingMarker(home) {
  return path.join(cleanupDir(home), 'pending');
}

/** Mark that at least one owner-recorded cleanup needs a bounded sweep. */
export function markPending(home) {
  mkdirSync(cleanupDir(home), { recursive: true, mode: 0o700 });
  writeAtomic(pendingMarker(home), { pending: true });
}

/** Recompute the cheap pending marker from exact owner-recorded ledgers. */
export function refreshMarker(home) {
  const records = path.join(cleanupDir(home), 'records');
  const worktreePending = existsSync(records) && readdirSync(records).some((name) => {
    try { return regularJson(path.join(records, name)).state !== 'complete'; }
    catch { return true; }
  });
  const e2eDir = path.dirname(e2eLockDir(home));
  const e2ePending = existsSync(e2eDir) && readdirSync(e2eDir)
    .filter((name) => /^e2e-cleanup-[\w-]+\.json$/.test(name))
    .some((name) => { try { return regularJson(path.join(e2eDir, name)).state !== 'complete'; } catch { return true; } });
  const scratchDir = path.join(cleanupDir(home), 'scratch-programs');
  const scratchPending = existsSync(scratchDir) && readdirSync(scratchDir).some((name) => name.endsWith('.json'));
  if (worktreePending || e2ePending || scratchPending) markPending(home);
  else rmSync(pendingMarker(home), { force: true });
}

/** Run one bounded Docker command for owner verification and cleanup. */
export function dockerRun(args) {
  return spawnSync(process.env.VIBE_E2E_DOCKER || 'docker', args, { encoding: 'utf8', timeout: 30_000 });
}

/** Return stdout for a successful Docker command and preserve its exact failure. */
export function dockerResult(args, run = dockerRun) {
  const result = run(args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker ${args.slice(0, 2).join(' ')} failed: ${String(result.stderr ?? '').trim()}`);
  return String(result.stdout ?? '').trim();
}
