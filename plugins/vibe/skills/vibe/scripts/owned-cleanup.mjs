import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProcessIdentity } from '../../../shared/process-identity.mjs';
import { readSessionRecord } from './session-record.mjs';
import { reconcileGeneratedE2E } from './owned-docker.mjs';
import { cleanupDir, dockerRun, e2eLockDir as defaultLockDir, markPending, OWNERSHIP_VERSION as VERSION,
  refreshMarker, regularJson, writeAtomic } from './owned-state.mjs';
import { sameWorktreeEntry } from './e2e-lock.mjs';

const MAX_RECORDS = 20;
const MAX_MS = 30_000;
const OPEN_PR_BACKOFF_MS = 30 * 60_000;
const SHA = /^[a-f0-9]{40}$/i;

/** Refuse malformed fleet accounting before it can disable pending cleanup. */
export function remainingCleanupBudget(visits) {
  if (!Number.isSafeInteger(visits) || visits < 0 || visits > MAX_RECORDS) {
    throw new Error('Fleet cleanup visit count is not finite and bounded');
  }
  return MAX_RECORDS - visits;
}


function recordsDir(home) { return path.join(cleanupDir(home), 'records'); }
function marker(home) { return path.join(cleanupDir(home), 'pending'); }
function cursorFile(home) { return path.join(cleanupDir(home), 'sweep.cursor'); }

function sweepLock(home) { return path.join(cleanupDir(home), 'sweep.lock'); }

function git(cwd, args, { timeoutMs = 20_000 } = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }).trim();
}

function gitBytes(cwd, args, { timeoutMs = 20_000 } = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
}

function remainingTimeout(deadline, clock, maximum = 20_000) {
  const remaining = deadline - clock();
  if (remaining <= 0) throw cleanupDeadline('cleanup deadline reached before command');
  return Math.min(maximum, remaining);
}

function cleanupDeadline(message) {
  const error = new Error(message);
  error.code = 'CLEANUP_DEADLINE';
  return error;
}

function acquireSweepLock(home, { waitMs = 2_000, clock = Date.now } = {}) {
  const lock = sweepLock(home);
  const owner = { pid: process.pid, identity: readProcessIdentity(process.pid), token: randomUUID() };
  if (!owner.identity) throw new Error('sweep process birth identity is unreadable');
  mkdirSync(cleanupDir(home), { recursive: true, mode: 0o700 });
  const deadline = clock() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeAtomic(path.join(lock, 'owner.json'), owner);
      return () => {
        try {
          if (regularJson(path.join(lock, 'owner.json')).token === owner.token) rmSync(lock, { recursive: true });
        } catch { /* A peer's lock is never removed on release. */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let saved;
      try { saved = regularJson(path.join(lock, 'owner.json')); } catch { saved = null; }
      if (saved?.identity && readProcessIdentity(saved.pid) === saved.identity
        || !saved && Date.now() - statSync(lock).mtimeMs < 60_000) {
        if (clock() >= deadline) return null;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50, deadline - clock()));
        continue;
      }
      // Re-read before reclaiming a stale lock; never remove a newly replaced one.
      let current;
      try { current = regularJson(path.join(lock, 'owner.json')); } catch { current = null; }
      if (current?.token !== saved?.token) continue;
      rmSync(lock, { recursive: true });
    }
  }
}

function recordPath(home, worktree) {
  const digest = createHash('sha256').update(worktree).digest('hex');
  return path.join(recordsDir(home), `${digest}.json`);
}

/** Cheap marker used by the always-on supervisor before any ledger or PR read. */
export function hasPendingOwnedCleanups({ home = os.homedir() } = {}) {
  return existsSync(marker(home));
}

/** Register a verified published checkout without trusting branch-name patterns. */
export function registerWorktreeRetirement({ worktree, repo, pr, proof, ticket = null }, { home = os.homedir() } = {}) {
  if (!pr || !/^[\w.-]+\/[\w.-]+$/.test(pr.repo ?? '') || !Number.isSafeInteger(pr.number) || pr.number <= 0
    || !SHA.test(pr.head ?? '') || typeof pr.branch !== 'string') throw new Error('retirement needs exact PR repo, number, head and branch');
  if (proof?.kind !== 'vibe' && proof?.kind !== 'fleet') throw new Error('retirement needs a session proof kind');
  if (proof.kind === 'fleet' && (!proof.stateDir || !proof.sessionName || !proof.endedAt || !proof.archivedAt)) {
    throw new Error('fleet retirement needs ended and archived session witnesses');
  }
  const root = realpathSync(worktree);
  const retained = realpathSync(repo);
  if (root === retained) throw new Error('retirement cannot remove its retained checkout');
  if (git(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error('worktree path changed');
  const branch = git(root, ['branch', '--show-current']);
  const head = git(root, ['rev-parse', 'HEAD']);
  if (branch !== pr.branch || head !== pr.head) throw new Error('PR head or branch differs from the worktree');
  const commonDir = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (commonDir !== realpathSync(git(retained, ['rev-parse', '--path-format=absolute', '--git-common-dir']))) {
    throw new Error('worktree belongs to another Git repository');
  }
  verifyOrigin({ repo: retained, branch, head }, pr.state ?? 'OPEN');
  const file = recordPath(home, root);
  const record = { version: VERSION, kind: 'worktree', state: 'pending', id: path.basename(file, '.json'),
    worktree: root, repo: retained, commonDir, branch, head, pr: { repo: pr.repo, number: pr.number, head: pr.head, branch },
    proof, ticket, createdAt: new Date().toISOString(), nextCheckAt: null };
  const release = acquireSweepLock(home);
  if (!release) throw new Error('cleanup sweep holds the retirement ledger');
  try {
    markPending(home);
    writeAtomic(file, record);
    refreshMarker(home);
  } finally { release(); }
  return record;
}

function currentPr(repo, number, { timeoutMs = 30_000 } = {}) {
  const raw = execFileSync('gh', ['api', `repos/${repo}/pulls/${number}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.min(30_000, Math.max(1, timeoutMs)) });
  const value = JSON.parse(raw);
  return { repo: value.base?.repo?.full_name, number: value.number, head: value.head?.sha,
    branch: value.head?.ref, state: value.merged_at ? 'MERGED' : String(value.state ?? '').toUpperCase() };
}

/** Import only the fleet board's exact writer/PR evidence after a live terminal read. */
export async function registerFleetWriterRetirements(orchDir, { home = os.homedir(), readPr = currentPr,
  now = Date.now(), where = 'local', stateDir = process.env.LOCAL_STATE_DIR || path.join(orchDir, 'sessions'),
  deadline = Date.now() + MAX_MS, clock = Date.now, maxRecords = MAX_RECORDS } = {}) {
  const boardFile = path.join(orchDir, 'board.json');
  if (!existsSync(boardFile)) return { registered: [], leftover: [], visited: 0 };
  const board = regularJson(boardFile);
  const registered = [];
  const leftover = [];
  const cacheFile = path.join(cleanupDir(home), 'board-checks.json');
  let checks = {};
  try { checks = regularJson(cacheFile); } catch { /* First run or malformed cache retries conservatively. */ }
  const writers = Object.entries(board.writers ?? {});
  const offset = writers.length ? (Number(checks.__cursor) || 0) % writers.length : 0;
  const selected = Array.from({ length: Math.min(MAX_RECORDS, writers.length) }, (_, index) => writers[(offset + index) % writers.length]);
  let visits = 0;
  for (const [name, row] of selected) {
    if (visits >= maxRecords || clock() >= deadline) break;
    visits += 1;
    if (!row.pr || !row.repo || !row.worktree || row.where !== where) continue;
    try {
      if (regularJson(recordPath(home, path.resolve(row.worktree))).state === 'complete') continue;
    } catch { /* This writer has no completed retirement receipt. */ }
    const key = `${row.repo}#${row.pr}`;
    if (checks[key] && now < Date.parse(checks[key])) continue;
    try {
      if (row.runtime === 'codex') {
        const state = regularJson(path.join(stateDir, `${name}.json`));
        if (state.cwd !== row.worktree || !state.ended || !state.archivedAt) throw new Error('fleet writer session is live');
      } else if (row.runtime === 'claude') {
        const session = readSessionRecord(row.worktree);
        if (session?.status !== 'handed-off') throw new Error('fleet Claude writer session is not handed off');
      } else throw new Error('fleet writer runtime cannot be verified');
      if (clock() >= deadline) { visits -= 1; break; }
      const live = await readPr(row.repo, Number(row.pr), { timeoutMs: deadline - clock() });
      if (!['MERGED', 'CLOSED'].includes(live.state)) {
        checks[key] = new Date(now + OPEN_PR_BACKOFF_MS).toISOString();
        continue;
      }
      if (live.repo !== row.repo || Number(live.number) !== Number(row.pr)
        || live.head !== row.head || live.branch !== git(row.worktree, ['branch', '--show-current'])) {
        throw new Error('fleet board PR identity changed');
      }
      const commonDir = git(row.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const proof = row.runtime === 'codex'
        ? { kind: 'fleet', stateDir, sessionName: name, endedAt: regularJson(path.join(stateDir, `${name}.json`)).ended.at,
          archivedAt: regularJson(path.join(stateDir, `${name}.json`)).archivedAt }
        : { kind: 'vibe' };
      const record = registerWorktreeRetirement({ worktree: row.worktree, repo: path.dirname(commonDir),
        pr: { repo: row.repo, number: Number(row.pr), head: live.head, branch: live.branch, state: live.state },
        proof, ticket: row.ticket ?? null }, { home });
      registered.push(record.worktree);
      delete checks[key];
    } catch (error) {
      leftover.push(`LEFTOVER ${name}: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
      checks[key] = new Date(now + OPEN_PR_BACKOFF_MS).toISOString();
    }
  }
  checks.__cursor = writers.length ? (offset + visits) % writers.length : 0;
  writeAtomic(cacheFile, checks);
  return { registered, leftover, visited: visits };
}

function activePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function defaultLockHeld(worktree) {
  return Boolean(sameWorktreeEntry(defaultLockDir(), worktree));
}

function setupEnvTargets(worktree) {
  try {
    const source = readFileSync(path.join(worktree, 'scripts', 'setup-local-env.sh'), 'utf8');
    const block = /TARGETS=\(\n([\s\S]*?)\n\)/.exec(source)?.[1] ?? '';
    return new Set([...block.matchAll(/^\s*["']([^"']+)["']\s*$/gm)].map((match) => match[1]));
  } catch { return new Set(); }
}

function generatedIgnored(relative, worktree, envTargets = setupEnvTargets(worktree), publishedPlans = false) {
  const clean = relative.replace(/\/$/, '');
  if (envTargets.has(clean)) return true;
  if (publishedPlans && /^\.closedloop-ai\/(?:vibe-plans|plans)(?:\/.*)?$/.test(clean)) return true;
  return /^(?:coverage|\.perf|tsconfig\.tsbuildinfo)$/.test(clean)
    || /(?:^|\/)(?:node_modules|\.turbo|\.next|\.cache)$/.test(clean)
    || /^(?:\.husky\/_)(?:\/.*)?$/.test(clean)
    || /^(?:\.closedloop-ai\/\.env\.setup|\.biome-noscan\.jsonc)$/.test(clean)
    || /^(?:apps|packages)\/[^/]+\/(?:node_modules|\.turbo|\.next|\.cache|dist|generated)$/.test(clean)
    || /^(?:apps|packages)\/[^/]+\/(?:tsconfig(?:\.[^/]+)?\.tsbuildinfo|next-env\.d\.ts)$/.test(clean)
    || /^apps\/desktop\/src\/(?:main\/database\/(?:generated|migration\/migrations-manifest\.ts)|main\/docs-help\/docs-bundle-manifest\.ts|shared\/(?:auth-handoff-assets\.generated\.ts|build-info\.ts))$/.test(clean)
    || /^apps\/web\/\.source$/.test(clean);
}

function generatedIgnoredTree(relative, worktree, envTargets, publishedPlans) {
  if (generatedIgnored(relative, worktree, envTargets, publishedPlans)) return true;
  const absolute = path.join(worktree, relative);
  let entries;
  try { entries = readdirSync(absolute, { withFileTypes: true }); } catch { return false; }
  return entries.length > 0 && entries.every((entry) => {
    const child = path.relative(worktree, path.join(absolute, entry.name));
    if (entry.isSymbolicLink()) return envTargets.has(child);
    return entry.isDirectory() ? generatedIgnoredTree(child, worktree, envTargets, publishedPlans)
      : generatedIgnored(child, worktree, envTargets, publishedPlans);
  });
}

function ignoredPaths(worktree, options) {
  const raw = gitBytes(worktree, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], options);
  return raw.toString('utf8').split('\0').filter(Boolean);
}

function cleanGit(worktree, options) {
  return gitBytes(worktree, ['status', '--porcelain=v1', '-z'], options).length === 0;
}

function defaultProcessCwds(worktree, { deadline = Infinity, clock = Date.now } = {}) {
  const owned = [];
  if (existsSync('/proc')) {
    for (const name of readdirSync('/proc').filter((value) => /^\d+$/.test(value))) {
      try {
        const cwd = realpathSync(path.join('/proc', name, 'cwd'));
        if (cwd === worktree || cwd.startsWith(`${worktree}${path.sep}`)) owned.push(Number(name));
      } catch { /* A process can exit or deny inspection between reads. */ }
    }
    return owned;
  }
  const listed = spawnSync('lsof', ['-n', '-a', '-d', 'cwd', '-Fpn'],
    { encoding: 'utf8', timeout: remainingTimeout(deadline, clock, 5_000) });
  if (listed.error?.code === 'ETIMEDOUT') throw cleanupDeadline('cleanup deadline reached during process cwd inventory');
  if (listed.error || listed.status !== 0) throw new Error('process cwd inventory is unreadable');
  let pid = null;
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n') && pid && (line.slice(1) === worktree || line.slice(1).startsWith(`${worktree}${path.sep}`))) owned.push(pid);
  }
  return owned;
}

function defaultSlotHeld(worktree, home) {
  const state = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  const root = path.join(state, 'fleet-orchestrator', 'locks');
  if (!existsSync(root)) return false;
  return readdirSync(root).filter((name) => name.endsWith('.lock')).some((name) => {
    try {
      const dir = path.join(root, name);
      const pid = Number(readFileSync(path.join(dir, 'pid'), 'utf8').trim());
      const cwd = realpathSync(readFileSync(path.join(dir, 'cwd'), 'utf8').trim());
      return activePid(pid) && (cwd === worktree || cwd.startsWith(`${worktree}${path.sep}`));
    } catch { return false; }
  });
}

function savedSessionSafe(record, processAlive) {
  const { worktree } = record;
  if (record.proof?.kind === 'fleet') {
    try {
      const state = regularJson(path.join(record.proof.stateDir, `${record.proof.sessionName}.json`));
      if (state.cwd !== worktree || state.ended?.at !== record.proof.endedAt
        || state.archivedAt !== record.proof.archivedAt) return false;
    } catch { return false; }
  } else if (record.proof?.kind !== 'vibe') return false;
  let session;
  try { session = readSessionRecord(worktree); }
  catch { return false; }
  if (!session) return record.proof.kind === 'fleet';
  if (session.status !== 'handed-off') return false;
  if (record.proof.kind === 'vibe' && (session.pullRequest?.repo !== record.pr.repo
    || session.pullRequest?.number !== record.pr.number || session.pullRequest?.head !== record.pr.head)) return false;
  for (const pid of [session.stack?.storybookPid, session.stack?.desktopPid]) {
    if (pid !== undefined && pid !== null && processAlive(Number(pid))) return false;
  }
  return true;
}

function matchPr(saved, live) {
  return live && live.repo === saved.repo && Number(live.number) === saved.number
    && live.head === saved.head && live.branch === saved.branch;
}

function verifyOrigin(record, state, options) {
  git(record.repo, ['remote', 'get-url', 'origin'], options);
  const remote = git(record.repo, ['ls-remote', '--heads', 'origin', record.branch], options);
  if (!remote && state !== 'MERGED') throw new Error('remote branch is not published');
  if (remote && !remote.startsWith(`${record.head}\t`)) throw new Error('remote branch changed head');
}

function pendingScratchForWorktree(record, home) {
  const registry = path.join(cleanupDir(home), 'scratch-programs');
  if (!existsSync(registry)) return false;
  for (const name of readdirSync(registry).filter((item) => item.endsWith('.json'))) {
    const program = regularJson(path.join(registry, name));
    const expected = createHash('sha256').update(path.resolve(program.orchDir)).digest('hex') + '.json';
    if (name !== expected) throw new Error('scratch program identity changed');
    const ledgerFile = path.join(program.orchDir, 'helpers.json');
    if (!existsSync(ledgerFile)) continue;
    const ledger = regularJson(ledgerFile);
    if (Object.values(ledger).some((helper) => helper?.kind === 'scratch'
      && helper.worktree === record.worktree && !helper.stoppedAt)) return true;
  }
  return false;
}

function verifyWorktree(record, processAlive, lockHeld, home, { processCwds = defaultProcessCwds,
  slotHeld = defaultSlotHeld, deadline = Infinity, clock = Date.now } = {}) {
  if (!SHA.test(record.head ?? '') || !existsSync(record.worktree)) throw new Error('worktree witness missing');
  const root = realpathSync(record.worktree);
  if (root !== record.worktree || realpathSync(record.repo) === root) throw new Error('worktree identity changed');
  const executionRoot = realpathSync(process.cwd());
  if (executionRoot === root || executionRoot.startsWith(`${root}${path.sep}`)) throw new Error('cleanup must run outside its target worktree');
  const commandOptions = () => ({ timeoutMs: remainingTimeout(deadline, clock) });
  if (realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], commandOptions())) !== record.commonDir
    || git(root, ['rev-parse', '--show-toplevel'], commandOptions()) !== root
    || git(root, ['branch', '--show-current'], commandOptions()) !== record.branch
    || git(root, ['rev-parse', 'HEAD'], commandOptions()) !== record.head) throw new Error('Git worktree branch, head or common dir changed');
  const listed = git(record.repo, ['worktree', 'list', '--porcelain'], commandOptions());
  if (!listed.split('\n').includes(`worktree ${root}`)) throw new Error('worktree is not registered with retained clone');
  if (!savedSessionSafe(record, processAlive) || lockHeld(root)
    || processCwds(root, { deadline, clock }).length || slotHeld(root, home)) {
    throw new Error('session, process or lock remains active');
  }
  if (pendingScratchForWorktree(record, home)) throw new Error('registered scratch stack must retire before its worktree');
  if (!cleanGit(root, commandOptions())) throw new Error('worktree has dirty or untracked files');
  const ignored = ignoredPaths(root, commandOptions());
  const envTargets = setupEnvTargets(root);
  const session = readSessionRecord(root);
  const publishedPlans = Boolean(session?.livePlan && ['APPROVED', 'EXECUTED'].includes(session.livePlanStatus));
  const unknown = ignored.filter((relative) => !generatedIgnoredTree(relative, root, envTargets, publishedPlans));
  if (unknown.length) throw new Error('worktree has unknown ignored data: ' + unknown.slice(0, 3).join(', '));
  for (const relative of ignored) {
    const absolute = path.resolve(root, relative);
    const clean = relative.replace(/\/$/, '');
    if (!absolute.startsWith(`${root}${path.sep}`)
      || lstatSync(absolute).isSymbolicLink() && !envTargets.has(clean)) {
      throw new Error('generated path escaped or became a symlink');
    }
  }
  return ignored;
}

/** List pending, malformed and legacy records without promoting any to ownership. */
export function pendingOwnedCleanups({ home = os.homedir() } = {}) {
  const root = cleanupDir(home);
  const metadata = new Set(['board-checks.json', 'e2e-backoff.json', 'vibe-builder.json']);
  const names = existsSync(root) ? readdirSync(root).filter((name) => name.endsWith('.json') && !metadata.has(name)) : [];
  const dir = recordsDir(home);
  const modern = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join('records', name)) : [];
  const legacyDir = path.dirname(defaultLockDir(home));
  const legacy = existsSync(legacyDir) ? readdirSync(legacyDir).filter((name) => /^e2e-cleanup-[\w-]+\.json$/.test(name))
    .map((name) => path.join(legacyDir, name)) : [];
  return [...names, ...modern].filter((name) => {
    try { return regularJson(path.join(root, name)).state !== 'complete'; }
    catch { return true; }
  }).map((name) => `LEFTOVER ${name}`).concat(legacy.filter((file) => {
    try { return regularJson(file).state !== 'complete'; } catch { return true; }
  }).map((file) => `LEFTOVER ${path.basename(file)}`));
}

/** Reconcile up to one bounded batch; every target is rechecked before non-forced removal. */
export async function sweepOwnedCleanups({ home = os.homedir(), readPr = currentPr,
  processAlive = activePid, lockHeld = defaultLockHeld, beforeRemove = () => {},
  processCwds = defaultProcessCwds, slotHeld = defaultSlotHeld,
  docker = dockerRun, now = Date.now(), maxRecords = MAX_RECORDS, forceDiscovery = false,
  deadline = Date.now() + MAX_MS, clock = Date.now, scratchSweep } = {}) {
  const result = { removed: [], leftover: [] };
  const dir = recordsDir(home);
  if (!forceDiscovery && !hasPendingOwnedCleanups({ home })) return result;
  if (clock() >= deadline || maxRecords <= 0) return result;
  const release = acquireSweepLock(home, { waitMs: 0, clock });
  if (!release) return { removed: [], leftover: ['LEFTOVER sweep lock is held'] };
  try {
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort().filter((name) => {
    const file = path.join(dir, name);
    try {
      if (regularJson(file).state === 'complete') { rmSync(file); return false; }
    } catch { /* Unreadable records stay visible. */ }
    return true;
  }) : [];
  let offset = 0;
  try { offset = Number(regularJson(cursorFile(home)).next) || 0; } catch { /* Start at the first record. */ }
  const selected = Array.from({ length: Math.min(maxRecords, 8, names.length) },
    (_, index) => names[(offset + index) % names.length]);
  let worktreeVisits = 0;
  for (const name of selected) {
    if (clock() >= deadline) break;
    worktreeVisits += 1;
    const file = path.join(dir, name);
    let record;
    try { record = regularJson(file); }
    catch { result.leftover.push(`LEFTOVER ${name}: unreadable record`); continue; }
    if (record.version !== VERSION || record.kind !== 'worktree') {
      result.leftover.push(`LEFTOVER ${name}: unsupported ownership record`); continue;
    }
    if (record.nextCheckAt && now < Date.parse(record.nextCheckAt)) continue;
    try {
      if (!existsSync(record.worktree)) {
        const listed = git(record.repo, ['worktree', 'list', '--porcelain'], { timeoutMs: remainingTimeout(deadline, clock) });
        if (listed.split('\n').includes(`worktree ${record.worktree}`)) throw new Error('missing worktree is still registered');
        rmSync(file);
        continue;
      }
      if (clock() >= deadline) { worktreeVisits -= 1; break; }
      const live = await readPr(record.pr.repo, record.pr.number, { timeoutMs: deadline - clock() });
      if (!matchPr(record.pr, live)) throw new Error('live PR identity changed');
      if (!['MERGED', 'CLOSED'].includes(live.state)) {
        record.nextCheckAt = new Date(now + OPEN_PR_BACKOFF_MS).toISOString();
        writeAtomic(file, record);
        result.leftover.push(`LEFTOVER ${name}: PR remains open`);
        continue;
      }
      verifyOrigin(record, live.state, { timeoutMs: remainingTimeout(deadline, clock) });
      verifyWorktree(record, processAlive, lockHeld, home, { processCwds, slotHeld, deadline, clock });
      await beforeRemove(record);
      verifyWorktree(record, processAlive, lockHeld, home, { processCwds, slotHeld, deadline, clock });
      if (clock() >= deadline) throw cleanupDeadline('cleanup deadline reached before final PR read');
      const latest = await readPr(record.pr.repo, record.pr.number, { timeoutMs: deadline - clock() });
      if (!matchPr(record.pr, latest) || !['MERGED', 'CLOSED'].includes(latest.state)) throw new Error('PR changed before removal');
      verifyOrigin(record, latest.state, { timeoutMs: remainingTimeout(deadline, clock) });
      const ignored = verifyWorktree(record, processAlive, lockHeld, home, { processCwds, slotHeld, deadline, clock });
      for (const relative of ignored) rmSync(path.join(record.worktree, relative), { recursive: true, force: true });
      git(record.repo, ['worktree', 'remove', record.worktree], { timeoutMs: remainingTimeout(deadline, clock) });
      rmSync(file);
      result.removed.push(record.worktree);
    } catch (error) {
      record.state = 'leftover';
      record.lastError = String(error instanceof Error ? error.message : error).slice(0, 200);
      const deadlineHit = error?.code === 'CLEANUP_DEADLINE' || error?.code === 'ETIMEDOUT' || clock() >= deadline;
      record.nextCheckAt = deadlineHit ? null : new Date(now + OPEN_PR_BACKOFF_MS).toISOString();
      writeAtomic(file, record);
      result.leftover.push(`LEFTOVER ${name}: ${record.lastError}`);
      if (deadlineHit) break;
    }
  }
  if (names.length) writeAtomic(cursorFile(home), { next: (offset + worktreeVisits) % names.length });
  const scratchDir = path.join(cleanupDir(home), 'scratch-programs');
  const scratchNames = existsSync(scratchDir) ? readdirSync(scratchDir).filter((name) => name.endsWith('.json')).sort() : [];
  let scratchOffset = 0;
  try { scratchOffset = Number(regularJson(path.join(cleanupDir(home), 'scratch.cursor')).next) || 0; } catch { /* First pass. */ }
  let scratchVisits = 0;
  let programsVisited = 0;
  const runScratch = scratchSweep ?? (async (orchDir, options) => {
    const { sweepScratchHelpers } = await import('../../fleet-orchestrator/scripts/scratch-cleanup.mjs');
    return sweepScratchHelpers(orchDir, options);
  });
  for (let index = 0; index < Math.min(scratchNames.length, 6); index += 1) {
    if (clock() >= deadline || worktreeVisits + scratchVisits >= maxRecords || scratchVisits >= 6) break;
    const name = scratchNames[(scratchOffset + index) % scratchNames.length];
    programsVisited += 1;
    try {
      const program = regularJson(path.join(scratchDir, name));
      const expected = createHash('sha256').update(path.resolve(program.orchDir)).digest('hex') + '.json';
      if (name !== expected) throw new Error('scratch program identity changed');
      const remaining = Math.min(6 - scratchVisits, maxRecords - worktreeVisits - scratchVisits);
      if (remaining <= 0) break;
      const outcome = await runScratch(program.orchDir, { home, deadline, clock, maxRecords: remaining, now });
      if (!Number.isSafeInteger(outcome.visited) || outcome.visited < 0 || outcome.visited > remaining) {
        throw new Error('scratch cleanup visit count is invalid');
      }
      scratchVisits += outcome.visited;
      result.removed.push(...(outcome.removed ?? []));
      result.leftover.push(...(outcome.leftover ?? []));
    } catch (error) { result.leftover.push('LEFTOVER scratch program ' + name + ': ' + error.message); }
  }
  if (scratchNames.length) writeAtomic(path.join(cleanupDir(home), 'scratch.cursor'),
    { next: (scratchOffset + programsVisited) % scratchNames.length });
  const e2eDir = path.dirname(defaultLockDir(home));
  const backoffFile = path.join(cleanupDir(home), 'e2e-backoff.json');
  let e2eBackoff = {};
  try { e2eBackoff = regularJson(backoffFile); } catch { /* First pass. */ }
  const e2eCandidates = [
    ...(existsSync(e2eDir) ? readdirSync(e2eDir).filter((name) => /^e2e-cleanup-[\w-]+\.json$/i.test(name))
      .map((name) => ({ name, file: path.join(e2eDir, name), key: 'locks/' + name })) : []),
    ...(existsSync(cleanupDir(home)) ? readdirSync(cleanupDir(home)).filter((name) => /^e2e-cleanup-[\w-]+\.json$/i.test(name))
      .map((name) => ({ name, file: path.join(cleanupDir(home), name), key: 'cleanup/' + name })) : []),
  ].sort((left, right) => left.key.localeCompare(right.key) || left.file.localeCompare(right.file)).filter(({ file, key }) => {
    try {
      if (regularJson(file).state === 'complete') { rmSync(file); delete e2eBackoff[key]; return false; }
    } catch { /* Unreadable records stay visible. */ }
    return !e2eBackoff[key] || now >= Date.parse(e2eBackoff[key]);
  });
  let e2eOffset = 0;
  try { e2eOffset = Number(regularJson(path.join(cleanupDir(home), 'e2e.cursor')).next) || 0; } catch { /* First pass. */ }
  const e2eSelected = Array.from({ length: Math.min(e2eCandidates.length, 6, Math.max(0, maxRecords - worktreeVisits - scratchVisits)) },
    (_, index) => e2eCandidates[(e2eOffset + index) % e2eCandidates.length]);
  let e2eVisits = 0;
  for (const { name, file, key } of e2eSelected) {
    if (clock() >= deadline) break;
    e2eVisits += 1;
    let record;
    try { record = regularJson(file); } catch { result.leftover.push('LEFTOVER ' + name + ': unreadable E2E record'); continue; }
    try {
      if (record.version !== VERSION || record.kind !== 'e2e' || record.absentAtReservation !== true) {
        throw new Error('Legacy E2E reservation has no exact ownership proof');
      }
      const ownerToken = record.owner?.token;
      if (typeof ownerToken !== 'string' || ownerToken.replace(/-/g, '') !== record.token
        || name !== 'e2e-cleanup-' + ownerToken + '.json') throw new Error('E2E record token and path differ');
      record.file = file;
      const cleaned = reconcileGeneratedE2E(record, { run: docker,
        ownerAlive: (saved) => readProcessIdentity(saved.pid) === saved.identity,
        lockHeld: () => false, pruneBuilder: false, home, deadline, clock });
      result.removed.push(...cleaned.removed.map((entry) => entry.id));
      delete e2eBackoff[key];
    } catch (error) {
      result.leftover.push('LEFTOVER ' + name + ': ' + String(error instanceof Error ? error.message : error).slice(0, 160));
      e2eBackoff[key] = new Date(now + OPEN_PR_BACKOFF_MS).toISOString();
    }
  }
  if (Object.keys(e2eBackoff).length) writeAtomic(backoffFile, e2eBackoff); else rmSync(backoffFile, { force: true });
  if (e2eCandidates.length) writeAtomic(path.join(cleanupDir(home), 'e2e.cursor'),
    { next: (e2eOffset + e2eVisits) % e2eCandidates.length });
  refreshMarker(home);
  return result;
  } finally { release(); }
}
