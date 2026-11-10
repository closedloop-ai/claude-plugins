import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readProcessIdentity } from '../../../shared/process-identity.mjs';

export const OWNERSHIP_VERSION = 1;

/** Existing machine slot root, shared with slot-lock.sh; no additional configuration contract. */
export function machineSlotLockDir() {
  const root = process.env.SLOT_LOCK_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'fleet-orchestrator/locks');
  if (!path.isAbsolute(root)) throw new Error('machine slot lock root must be absolute so worktrees share one admission fence');
  return root;
}

/** Physical Git worktree root (including .git files), or the physical directory for a non-Git job. */
export function canonicalWorktree(cwd) {
  const physical = realpathSync(cwd);
  for (let dir = physical;; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return physical;
  }
}

function fenceFile(worktree, slotRoot) {
  return path.join(slotRoot, `reload-${createHash('sha256').update(worktree).digest('hex')}.json`);
}

/** Remove only the fence with this exact worktree/token, never another owner's replacement. */
export function releaseReloadFence(fence) {
  if (!fence || path.basename(fence.file ?? '') !== path.basename(fenceFile(fence.worktree ?? '', '.'))) return false;
  let saved;
  try { saved = regularJson(fence.file); } catch { return false; }
  if (!saved || saved.kind !== 'skill-reload' || saved.token !== fence.token || saved.worktree !== fence.worktree) return false;
  rmSync(fence.file);
  return true;
}

function inspectReloadFence(worktree, { slotRoot = machineSlotLockDir(), identityOf = readProcessIdentity } = {}) {
  const file = fenceFile(worktree, slotRoot);
  let owner;
  try { owner = regularJson(file); }
  catch (error) { return { held: error.code !== 'ENOENT', file, owner: null }; }
  if (!owner || owner.kind !== 'skill-reload' || owner.worktree !== worktree || !owner.token || !owner.reloadId || !owner.stateFile || !owner.threadId
    || !Number.isSafeInteger(owner.pid) || owner.pid <= 1 || !owner.identity) return { held: true, file, owner };
  let state;
  try { state = regularJson(owner.stateFile); }
  catch { return { held: true, file, owner }; }
  if (!state || state.threadId !== owner.threadId || typeof state.cwd !== 'string') return { held: true, file, owner };
  try { if (canonicalWorktree(state.cwd) !== worktree) return { held: true, file, owner }; }
  catch { return { held: true, file, owner }; }
  // The actor owns the fence across short-lived CLI pumps. A dead controller alone cannot release it.
  if (state.reload?.id === owner.reloadId && !state.ended) return { held: true, file, owner, owned: true };
  if (identityOf(owner.pid) === owner.identity) return { held: true, file, owner };
  // Admission readers never unlink: a stale observation must not retire a concurrently resumed generation.
  // The serialized reload controller recovers this stale record before publishing a fresh generation.
  return { held: false, file, owner, stale: true };
}

/** Inspect the machine fence without unlinking it; unknown actor authority stays held for safe recovery. */
export function reloadFenceStatus(worktree, options) {
  return inspectReloadFence(canonicalWorktree(worktree), options);
}

/** Exclusively publish a fresh generation, or resume the same actor's durable logical reload. */
export function ensureReloadFence(fence, { slotRoot = machineSlotLockDir(), identityOf = readProcessIdentity } = {}) {
  const worktree = canonicalWorktree(fence.worktree);
  const current = inspectReloadFence(worktree, { slotRoot, identityOf });
  if (current.held) {
    if (!current.owned || current.owner.reloadId !== fence.reloadId || current.owner.threadId !== fence.threadId
      || current.owner.stateFile !== fence.stateFile) throw new Error('reload fence is owned by another actor');
    return { ...fence, token: current.owner.token, worktree, file: current.file };
  }
  if (current.stale) releaseReloadFence({ ...current.owner, file: current.file });
  // Every physical publication gets a fresh generation, so old admission markers cannot survive recovery (ABA).
  const owner = { kind: 'skill-reload', token: randomUUID(), reloadId: fence.reloadId, worktree, stateFile: fence.stateFile, threadId: fence.threadId,
    pid: process.pid, identity: identityOf(process.pid) };
  if (!owner.identity) throw new Error('reload fence process identity is unreadable');
  try { writeAtomic(current.file, owner, { exclusive: true }); }
  catch (error) { releaseReloadFence({ ...owner, file: current.file }); throw error; }
  return { ...fence, token: owner.token, worktree, file: current.file };
}

/** True only for a verified job that has stopped before final admission on this exact reload fence. */
export function waitsForReloadFence(owner, fence, identityOf = readProcessIdentity) {
  return Boolean(fence && owner?.admission === 'reload-wait' && owner.reloadFence === fence.token
    && owner.worktree === fence.worktree && Number.isSafeInteger(owner.pid) && owner.pid > 1
    && owner.identity && identityOf(owner.pid) === owner.identity);
}

/** Register-before-check admission handshake; finite waits preserve the job's original ownership identity. */
export async function waitForReloadFence(worktree, { recordFile, owner, slotRoot = machineSlotLockDir(),
  deadline = Date.now() + 60_000, pollMs = 100, signal, identityOf = readProcessIdentity } = {}) {
  const canonical = canonicalWorktree(worktree);
  const registered = { ...owner, worktree: canonical };
  const verifyOwner = () => {
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 1 || !owner.identity || identityOf(owner.pid) !== owner.identity) {
      throw new Error('job admission ownership is unverified');
    }
  };
  verifyOwner();
  // The caller already owns this waiter/slot directory. Never resurrect it after wrapper cleanup.
  writeAtomic(recordFile, { ...registered, admission: 'registered' }, { createParent: false });
  for (;;) {
    signal?.throwIfAborted();
    verifyOwner();
    const fence = inspectReloadFence(canonical, { slotRoot, identityOf });
    writeAtomic(recordFile, { ...registered, admission: fence.held ? 'reload-wait' : 'admitted',
      ...(fence.held ? { reloadFence: fence.owner?.token ?? 'unknown' } : {}) }, { createParent: false });
    if (!fence.held) return { ready: true };
    if (Date.now() >= deadline) return { ready: false, fence: fence.owner?.token ?? 'unknown' };
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}

/** The machine-wide E2E lock path for one home directory. */
export function e2eLockDir(home = os.homedir()) {
  return path.join(home, '.codex', 'vibe', 'locks', 'e2e-stack');
}

/** The existing E2E acquisition queue lives beside its holder directory. */
export function e2eWaitersDir(lockDir) { return `${lockDir}.waiters`; }

/** Read queue ownership without hiding unreadable/incomplete entries from safety consumers. */
export function readE2eWaiters(lockDir) {
  const dir = e2eWaitersDir(lockDir);
  let names;
  try { names = readdirSync(dir); }
  catch (error) { return error.code === 'ENOENT' ? [] : [{ file: dir, owner: null }]; }
  // Atomic-update staging files are not waiter registrations until renamed to their canonical .json path.
  return names.filter(name => !/\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(name)).map(name => {
    const file = path.join(dir, name);
    try { return { file, owner: regularJson(file) }; }
    catch { return { file, owner: null }; }
  });
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

/** Atomically replace a private record; exclusive publication refuses an existing owner without clobbering it. */
export function writeAtomic(file, value, { exclusive = false, createParent = true } = {}) {
  if (createParent) mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    // Hard-link publication is atomic and exclusive: no ownerless fence window and no clobber.
    if (exclusive) linkSync(temp, file); else renameSync(temp, file);
    chmodSync(file, 0o600);
  } finally { rmSync(temp, { force: true }); }
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
export function dockerRun(args, { timeoutMs = 30_000 } = {}) {
  return spawnSync(process.env.VIBE_E2E_DOCKER || 'docker', args, { encoding: 'utf8', timeout: timeoutMs });
}

/** Return stdout for a successful Docker command and preserve its exact failure. */
export function dockerResult(args, run = dockerRun) {
  const result = run(args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker ${args.slice(0, 2).join(' ')} failed: ${String(result.stderr ?? '').trim()}`);
  return String(result.stdout ?? '').trim();
}

// slot-lock.sh invokes this adapter only after it has recorded its slot, before preflight or job startup.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [action, slot, rawPid, name] = process.argv.slice(2);
    if (action !== 'admit-heavy' || !slot || !name || !Number.isSafeInteger(Number(rawPid)) || Number(rawPid) <= 1) throw new Error('Usage: owned-state.mjs admit-heavy <slot> <pid> <owner>');
    const pid = Number(rawPid); const identity = readProcessIdentity(pid);
    if (pid !== process.ppid || !identity || Number(readFileSync(path.join(slot, 'pid'), 'utf8')) !== pid) throw new Error('heavy slot ownership is unverified');
    const abort = new AbortController();
    const stop = () => abort.abort(new Error('heavy admission interrupted'));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const result = await waitForReloadFence(process.cwd(), { recordFile: path.join(slot, 'admission.json'),
        owner: { pid, identity, name, token: randomUUID(), cwd: process.cwd() }, signal: abort.signal });
      if (!result.ready) { process.stderr.write('slot-lock: reload fence busy; job not started\n'); process.exitCode = 75; }
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 75; }
}
