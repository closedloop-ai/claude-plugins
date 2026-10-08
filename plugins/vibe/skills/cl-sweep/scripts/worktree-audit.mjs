#!/usr/bin/env node
// Read-only worktree audit for cl-sweep cleanup. It never removes, prunes, or
// edits anything; it reports each worktree joined with sweep ownership, PR
// state, tracked versus untracked dirt, the newest Codex rollout whose cwd is
// the worktree, a path class, and a suggested disposition.
//
// Usage: worktree-audit.mjs --repo <path> [--state-base <dir>] [--sessions-dir <dir>] [--no-gh]
//
// The idea follows pstack's poteto-mode/scripts/worktree-audit.sh (MIT,
// copyright 2026 Lauren Tan); this implementation is cl-sweep's own.

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TERMINAL_ROOT_EVENTS = new Set(['TERMINAL', 'ABANDONED']);
const TEMP_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'];

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, locked: false, prunable: false };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line.startsWith('locked')) current.locked = true;
    else if (line.startsWith('prunable')) current.prunable = true;
  }
  if (current) entries.push(current);
  return entries;
}

export function countDirt(porcelainStatus) {
  let tracked = 0;
  let untracked = 0;
  for (const line of porcelainStatus.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('??')) untracked += 1;
    else tracked += 1;
  }
  return { tracked, untracked };
}

/** Index sweep roots from the registry, and each root's ticket leases. */
export function loadSweepIndex(stateBase, now = Date.now()) {
  const roots = new Map();
  for (const record of readJsonLines(join(stateBase, 'registry.jsonl'))) {
    if (record.sweepId && record.rootPath) roots.set(record.sweepId, record);
  }
  return [...roots.values()].map((root) => {
    const leases = new Map();
    for (const record of readJsonLines(join(root.rootPath, 'ownership.jsonl'))) {
      if (record.ticket) leases.set(record.ticket, record);
    }
    const leaseState = (ticket) => {
      const record = leases.get(ticket);
      if (!record) return 'none';
      if (record.event === 'RELEASE') return 'released';
      if (record.expiresAt !== null && record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now) return 'expired';
      return 'active';
    };
    return {
      sweepId: root.sweepId,
      rootPath: canonical(root.rootPath),
      rootEvent: root.event,
      rootTerminal: TERMINAL_ROOT_EVENTS.has(root.event),
      leaseState,
    };
  });
}

/** Newest rollout per cwd, read from each rollout's first (session_meta) line only. */
export function newestRolloutByCwd(sessionsDir) {
  const newest = new Map();
  const walk = (dir) => {
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && /^rollout-.*\.jsonl$/.test(item.name)) {
        const cwd = firstLineCwd(path);
        if (!cwd) continue;
        const mtimeMs = statSync(path).mtimeMs;
        const key = canonical(cwd);
        const prior = newest.get(key);
        if (!prior || prior.mtimeMs < mtimeMs) newest.set(key, { path, mtimeMs });
      }
    }
  };
  walk(sessionsDir);
  return newest;
}

function firstLineCwd(path) {
  // session_meta puts cwd before the long instruction payload, so 16 KB is enough.
  const buffer = Buffer.alloc(16 * 1024);
  let fd;
  try {
    fd = openSync(path, 'r');
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytes).toString('utf8');
    const newline = text.indexOf('\n');
    const first = newline >= 0 ? text.slice(0, newline) : text;
    const cwdMatch = first.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    return cwdMatch ? JSON.parse(`"${cwdMatch[1]}"`) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function pathClass(path, { repoTop, stateBase }) {
  if (path === repoTop) return 'main-checkout';
  if (isWithin(join(stateBase, 'sweeps'), path)) return 'sweep-owned';
  if (path.includes('workflow-review-worktrees')) return 'review';
  if (TEMP_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'ad-hoc-temp';
  return 'sibling-checkout';
}

export function ticketFromPath(path) {
  const match = basename(path).match(/^([a-z]+-\d+)/i);
  return match ? match[1].toUpperCase() : null;
}

/** Suggest a disposition. Suggestions are advisory; nothing is ever removed. */
export function suggest(row) {
  if (row.class === 'main-checkout') return 'keep-main';
  if (row.sweep?.leaseState === 'active' && !row.sweep.rootTerminal) return 'in-use';
  if (row.dirt === null) return 'review-unreadable';
  if (row.dirt.tracked > 0) return 'hold-tracked-dirt';
  if (row.pr?.state === 'OPEN') return 'hold-open-pr';
  if (row.class === 'sweep-owned') {
    const terminal = row.sweep?.rootTerminal || row.sweep?.leaseState === 'released'
      || row.pr?.state === 'MERGED' || row.pr?.state === 'CLOSED';
    if (!terminal) return 'owner-check';
    return row.dirt.untracked > 0 ? 'terminal-uncleaned-untracked' : 'terminal-uncleaned';
  }
  if (row.class === 'review') return 'orphan-review';
  if (row.class === 'ad-hoc-temp') return 'orphan-temp';
  return 'review';
}

function defaultRunner(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

export function auditWorktrees(options) {
  const run = options.run ?? defaultRunner;
  const stateBase = canonical(options.stateBase);
  const repoTop = canonical(run('git', ['-C', options.repo, 'rev-parse', '--show-toplevel'], options.repo).trim());
  const sweeps = loadSweepIndex(stateBase, options.now);
  const rollouts = options.sessionsDir ? newestRolloutByCwd(options.sessionsDir) : new Map();
  const worktrees = parseWorktreeList(run('git', ['-C', repoTop, 'worktree', 'list', '--porcelain'], repoTop));

  return worktrees.map((worktree) => {
    const path = canonical(worktree.path);
    const cls = pathClass(path, { repoTop, stateBase });
    const root = sweeps.find((item) => isWithin(item.rootPath, path));
    const ticket = root ? ticketFromPath(path) : null;
    let dirt = null;
    if (existsSync(path)) {
      try {
        // --no-optional-locks keeps status from refreshing the index, so the audit writes nothing.
        dirt = countDirt(run('git', ['--no-optional-locks', '-C', path, 'status', '--porcelain=v1', '--untracked-files=all'], path));
      } catch {
        dirt = null;
      }
    }
    let pr = null;
    if (options.gh !== false && worktree.branch) {
      try {
        const rows = JSON.parse(run('gh', ['pr', 'list', '--head', worktree.branch, '--state', 'all', '--limit', '1', '--json', 'number,state,url'], repoTop) || '[]');
        pr = rows[0] ?? { state: 'NONE' };
      } catch {
        pr = { state: 'UNKNOWN' };
      }
    }
    const rollout = rollouts.get(path) ?? null;
    const row = {
      path,
      class: cls,
      branch: worktree.branch,
      head: worktree.head,
      detached: worktree.detached,
      locked: worktree.locked,
      prunable: worktree.prunable,
      exists: existsSync(path),
      sweep: root
        ? { sweepId: root.sweepId, rootEvent: root.rootEvent, rootTerminal: root.rootTerminal, ticket, leaseState: ticket ? root.leaseState(ticket) : 'none' }
        : null,
      dirt,
      pr,
      newestRollout: rollout ? { path: rollout.path, modifiedAt: new Date(rollout.mtimeMs).toISOString() } : null,
    };
    return { ...row, suggestion: suggest(row) };
  });
}

export function parseArgs(argv) {
  const options = {
    repo: null,
    stateBase: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'cl-sweep-state'),
    sessionsDir: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
    gh: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-gh') options.gh = false;
    else if (['--repo', '--state-base', '--sessions-dir'].includes(arg)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      options[{ '--repo': 'repo', '--state-base': 'stateBase', '--sessions-dir': 'sessionsDir' }[arg]] = value;
      i += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.repo) throw new Error('--repo is required');
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`worktree-audit: ${error.message}\nusage: worktree-audit.mjs --repo <path> [--state-base <dir>] [--sessions-dir <dir>] [--no-gh]\n`);
    return 2;
  }
  const rows = auditWorktrees(options);
  const counts = {};
  for (const row of rows) counts[row.suggestion] = (counts[row.suggestion] ?? 0) + 1;
  process.stdout.write(`${JSON.stringify({ schema: 'CL_SWEEP_WORKTREE_AUDIT v1', repo: canonical(options.repo), counts, worktrees: rows }, null, 2)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
