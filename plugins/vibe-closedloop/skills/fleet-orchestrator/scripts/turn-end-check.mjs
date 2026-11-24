#!/usr/bin/env node
// Usage: node turn-end-check.mjs <orchDir> <writer> --worktree <path>
// Run before a writer ends its turn. A Codex writer ended four turns while the step it had started (an inventory
// in the heavy slot) was still running, and one of those runs was lost with the slot it held.
// A running step is a live holder of a machine slot lock (slot-lock.sh) whose owner label starts with <writer> or
// that runs in <worktree>. Each one must be handed to a recorded background job: one of its own or its ancestors'
// processes recorded with `helpers.mjs <orchDir> pid <job> <pid>`, same start time, while the fleet watcher runs
// (codex-fleet-monitor's watcher.mjs prints `watcher ok`). Prints `turn-end ok` (exit 0), or a `RUNNING` line per
// unhanded step and `turn-end REFUSED ...` (exit 1).
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { watcherState } from '../../codex-fleet-monitor/scripts/watcher.mjs';
import { vibeCore } from '../../../shared/vibe-core.mjs';
import { isEntryPoint } from '../../../shared/plugin-roots.mjs';

const { machineSlotLockDir } = await vibeCore('lib/vibe/scripts/owned-state.mjs');
const { helperEntries, isAlive, read: readLedger } = await vibeCore('lib/fleet-orchestrator/scripts/helpers.mjs');
const { readProcessStart } = await vibeCore('shared/process-identity.mjs');
const { resolveWorkDir } = await vibeCore('lib/codex-fleet-monitor/scripts/work-dir.mjs');

const SLOT_LOCK = /^(.+)-\d+\.lock$/;
const ANCESTOR_LIMIT = 32;
const OWNER_WORD = /^\S+/;

/** Live slot-lock holders on this machine: `{ lock, pid, owner, cwd }`. */
export function slotHolders(root = machineSlotLockDir(), alive = isAlive) {
  let names;
  try { names = readdirSync(root).filter((name) => SLOT_LOCK.test(name)); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const field = (name, file) => { try { return readFileSync(path.join(root, name, file), 'utf8').trim(); } catch { return ''; } };
  return names.map((lock) => ({ lock, pid: Number(field(lock, 'pid')), owner: field(lock, 'owner'), cwd: field(lock, 'cwd') }))
    .filter((holder) => Number.isSafeInteger(holder.pid) && holder.pid > 1 && alive(holder.pid));
}

/** Recorded background jobs: each helper's pids with the start time its recorded identity carries. */
export function recordedJobs(ledger) {
  return helperEntries(ledger).filter(([, helper]) => !helper.stoppedAt).flatMap(([name, helper]) =>
    (helper.pids ?? []).map((pid) => ({ name, pid, identity: helper.identities?.[pid] ?? '' })));
}

/**
 * The steps that block ending the turn. `startOf(pid)` is a process's start time and `parentOf(pid)` its parent;
 * a recorded pid counts only while its start time still matches, so a reused pid hands nothing over.
 */
export function turnEndProblems({ writer, worktree, holders, jobs, watcher, startOf = readProcessStart, parentOf = readParent }) {
  const related = holders.filter((holder) => OWNER_WORD.exec(holder.owner)?.[0] === writer || within(holder.cwd, worktree));
  const handedTo = (pid) => {
    for (let current = pid, depth = 0; current > 1 && depth < ANCESTOR_LIMIT; current = parentOf(current), depth += 1) {
      const start = startOf(current);
      const job = start && jobs.find((entry) => entry.pid === current && entry.identity.startsWith(start));
      if (job) return job.name;
    }
    return null;
  };
  const running = [];
  const handed = [];
  for (const holder of related) {
    const job = handedTo(holder.pid);
    if (job) handed.push({ ...holder, job });
    else running.push(holder);
  }
  const lines = running.map((holder) => `RUNNING ${holder.lock} ${holder.owner}`);
  if (running.length) {
    lines.push('turn-end REFUSED: wait for each running step, or run it detached and record its launcher with helpers.mjs <orchDir> pid <job> <pid>');
  } else if (handed.length && !watcher.ok) {
    lines.push(`turn-end REFUSED: handed step(s) ${handed.map((holder) => `${holder.lock} (${holder.job})`).join(', ')} have no watcher: ${watcher.line}`);
  }
  return { ok: lines.length === 0, lines: lines.length ? lines : [`turn-end ok${handed.length ? `; handed ${handed.map((holder) => `${holder.lock} to ${holder.job}`).join(', ')}` : ''}`] };
}

function within(cwd, worktree) {
  if (!cwd || !worktree) return false;
  let root;
  try { root = realpathSync(worktree); } catch { root = path.resolve(worktree); }
  return cwd === root || cwd.startsWith(`${root}${path.sep}`);
}

function readParent(pid) {
  const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) return 0;
  const parent = Number(result.stdout.trim());
  return Number.isSafeInteger(parent) ? parent : 0;
}

/** Verify the exact worktree's live slot ownership before a fleet completion or archive. */
export function fleetTurnEnd(orchDir, writer, worktree) {
  const dir = resolveWorkDir(orchDir).dir;
  return turnEndProblems({ writer, worktree, holders: slotHolders(),
    jobs: recordedJobs(readLedger(dir)), watcher: watcherState(dir) });
}

function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { worktree: { type: 'string' } } });
  const [orchDir, writer] = positionals;
  if (!orchDir || !writer || positionals.length !== 2 || !values.worktree) {
    process.stderr.write('Usage: turn-end-check.mjs <orchDir> <writer> --worktree <path>\n');
    return 2;
  }
  const { lines, ok } = fleetTurnEnd(orchDir, writer, values.worktree);
  process.stdout.write(`${lines.join('\n')}\n`);
  return ok ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) process.exit(main(process.argv.slice(2)));
