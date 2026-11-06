// Usage:
//   node codex-session.mjs turn  <stateDir> <name> --prompt-file <file> [--cwd <dir>] [--ticket <slug>] [--model <m>] [--effort <e>] [--sandbox <mode>]
//   node codex-session.mjs steer <stateDir> <name> --prompt-file <file>
//   node codex-session.mjs last  <stateDir> <name> [--count <n>]
//   node codex-session.mjs end   <stateDir> <name> --reason stopped|merged
//   node codex-session.mjs interrupt <stateDir> <name> --reason <why reload cannot wait>
//   node codex-session.mjs reload <stateDir> <name> [--retry] (pump actor-acknowledged pages and retained work)
// `turn` starts a thread bound to --cwd when <stateDir>/<name>.json does not exist (a new session also needs
// --model, --effort and a prompt that starts with `$vibe`, since every writer is a vibe session), otherwise resumes the thread it names, then starts a turn with the prompt file's text. `steer` adds the prompt to the active turn.
// A new thread is named `<name> · <ticket>` (`<name>` without --ticket) and moved into the Codex app's "Fleet workers" sidebar section.
// `end` records the writer stopped or merged in its state file, then archives its thread; it refuses a thread
// with a running turn. A later `turn` on an ended session unarchives the thread first.
// A prompt that hands over another writer's work (a `Done:` line) also needs a `Re-verify:` line: takeover
// writers found a half-fixed thread, six broken tests and a 10 s per insert trigger behind "done" claims.
// `last` prints the thread's status line and its last <n> agent messages (default 1).
// The state file is the one codex-fleet-monitor reads for a `local|remote <name>` session line.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  connectViaProxy, daemonSocket, exitAfterTotalTimeout, isEntryPoint, readThreadState, summarize,
} from '../../codex-fleet-monitor/scripts/liveness.mjs';
import {
  archiveEndedWorker, assertWorkerNotLive, END_REASONS, endRecord, labelWorkerThread, WORKER_THREAD_SOURCE,
  workerThreadName,
} from '../../codex-fleet-monitor/scripts/thread-sidebar.mjs';
import { readSessionRecord } from '../../vibe/scripts/session-record.mjs';
import { isSkillReload, LoadBasis, loadedSkillEvidence, loadedSkillEvidenceProblem, reloadableSkill, skillReloadPage, SKILL_RELOAD } from '../../vibe/scripts/loaded-skill.mjs';
import { promptProblems } from './skill-freshness.mjs';
import { canonicalWorktree, ensureReloadFence, e2eLockDir as machineE2eLockDir, machineSlotLockDir, readE2eWaiters,
  regularJson, releaseReloadFence, waitsForReloadFence, writeAtomic } from '../../vibe/scripts/owned-state.mjs';
import { readProcessIdentity } from '../../../shared/process-identity.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const COMMANDS = new Set(['turn', 'steer', 'last', 'end', 'interrupt', 'reload']);
const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const SANDBOX_POLICIES = {
  'read-only': { type: 'readOnly' },
  'workspace-write': { type: 'workspaceWrite' },
  'danger-full-access': { type: 'dangerFullAccess' },
};
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EFFORT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const VIBE_PROMPT = /^\s*\$vibe\b/;
const DONE_CLAIMS = /^\s*Done:/m;
const REVERIFY = /^\s*Re-verify:\s*\S/m;

/** A root hint is transport data, never authority: verify it against this host's enabled installation. */
export function verifiedPluginRoot(requested, { list = () => JSON.parse(execFileSync('codex', ['plugin', 'list', '--json'],
  { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })) } = {}) {
  const installed = list().installed?.filter(row => row.name === 'vibe' && row.installed === true && row.enabled === true);
  if (installed?.length !== 1 || typeof installed[0].source?.path !== 'string') throw new Error('cannot establish one verified installed root for vibe');
  const root = realpathSync(installed[0].source.path);
  if (requested && (!existsSync(requested) || realpathSync(requested) !== root)) throw new Error('--plugin-root differs from the verified installed root');
  return root;
}

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'prompt-file': { type: 'string' },
      cwd: { type: 'string' },
      ticket: { type: 'string' },
      reason: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      sandbox: { type: 'string' },
      count: { type: 'string' },
      'plugin-root': { type: 'string' },
      retry: { type: 'boolean' },
    },
  });
  const [command, stateDir, name, ...extra] = positionals;
  if (!COMMANDS.has(command)) throw new Error(`command must be one of: ${[...COMMANDS].join(', ')}`);
  if (!stateDir || !name || extra.length) throw new Error('expected <stateDir> <name>');
  if (!NAME_PATTERN.test(name)) throw new Error('name must be letters, digits, dot, dash or underscore');
  if (command === 'turn' || command === 'steer') {
    if (!values['prompt-file']) throw new Error(`${command} needs --prompt-file`);
  } else if (values['prompt-file'] !== undefined) throw new Error(`--prompt-file applies to turn and steer only`);
  if (command === 'end' && !END_REASONS.includes(values.reason)) throw new Error(`end needs --reason ${END_REASONS.join('|')}`);
  if (command === 'interrupt' && (!values.reason?.trim() || values.reason.length > 1000)) throw new Error('interrupt needs a nonempty --reason (at most 1000 characters)');
  if (!['end', 'interrupt'].includes(command) && values.reason !== undefined) throw new Error('--reason applies to end only or interrupt');
  if (command !== 'turn') {
    for (const key of ['cwd', 'ticket', 'model', 'effort', 'sandbox']) {
      if (values[key] !== undefined) throw new Error(`--${key} applies to turn only`);
    }
  }
  if (!['turn', 'steer', 'reload'].includes(command) && values['plugin-root'] !== undefined) throw new Error('--plugin-root applies to turn, steer and reload only');
  if (values.retry && command !== 'reload') throw new Error('--retry applies to reload only');
  if (command !== 'last' && values.count !== undefined) throw new Error('--count applies to last only');
  if (values.effort !== undefined && !EFFORT_PATTERN.test(values.effort)) throw new Error('effort must be an identifier such as high');
  if (values.sandbox !== undefined && !SANDBOXES.has(values.sandbox)) throw new Error(`sandbox must be one of: ${[...SANDBOXES].join(', ')}`);
  const count = values.count === undefined ? 1 : Number(values.count);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('count must be a positive integer');
  return {
    command,
    stateDir,
    name,
    promptFile: values['prompt-file'],
    cwd: values.cwd === undefined ? undefined : resolve(values.cwd),
    ticket: values.ticket,
    reason: values.reason,
    model: values.model,
    effort: values.effort,
    sandbox: values.sandbox,
    count,
    ...(values['plugin-root'] === undefined ? {} : { pluginRoot: resolve(values['plugin-root']) }),
    ...(values.retry ? { retry: true } : {}),
  };
}

export function statePath(stateDir, name) {
  return `${stateDir}/${name}.json`;
}

/** Refuses a fleet writer whose exact worktree has no active vibe session record. */
export function assertVibeSession(worktree) {
  if (!worktree) throw new Error('a vibe writer needs a session worktree');
  let record;
  try {
    record = readSessionRecord(worktree);
  } catch {
    throw new Error(`vibe session record cannot be read in ${worktree}`);
  }
  if (!record) throw new Error(`no vibe session record in ${worktree}; the first $vibe turn must create it before any resume`);
  if (record.status !== 'active' || typeof record.branch !== 'string' || !record.branch
    || typeof record.slug !== 'string' || !record.slug || typeof record.summary !== 'string' || !record.summary
    || typeof record.operator !== 'object' || !record.operator || !/^[a-f0-9]{40}$/.test(record.baseCommit ?? '')
    || !Number.isFinite(Date.parse(record.createdAt ?? ''))) {
    throw new Error(`no active vibe session record in ${worktree}`);
  }
  const branch = execFileSync('git', ['-C', worktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  if (branch !== record.branch) throw new Error(`vibe session branch ${record.branch} does not match ${branch}`);
  return record;
}

/** A new `$vibe` turn creates its record; every saved thread must resume that exact session. */
export function requireResumeSession(saved, requestedCwd) {
  if (!saved) return null;
  return assertVibeSession(saved.cwd ?? requestedCwd);
}

/** Returns the saved state, or null when the session has none yet. */
export function loadState(stateDir, name) {
  let text;
  try {
    text = readFileSync(statePath(stateDir, name), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const state = JSON.parse(text);
  if (typeof state?.threadId !== 'string' || !state.threadId || typeof state.cwd !== 'string' || !state.cwd) {
    throw new Error(`${statePath(stateDir, name)} has no threadId and cwd`);
  }
  return state;
}

/** Write through a temp file and rename, so a crash never leaves the monitor a half-written state file. */
export function saveState(stateDir, name, state) {
  const target = statePath(stateDir, name);
  const temp = `${target}.${process.pid}.tmp`;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, target);
}

/**
 * Merges the options into the saved state for the next turn. A session stays bound to the worktree it
 * started in, so a different --cwd on an existing session is refused rather than silently moved.
 */
export function nextState(saved, options) {
  if (saved && options.cwd && options.cwd !== saved.cwd) {
    throw new Error(`session is bound to ${saved.cwd}; start a new session name for ${options.cwd}`);
  }
  if (!saved && !options.cwd) throw new Error('a new session needs --cwd');
  if (saved && options.ticket && saved.ticket && options.ticket !== saved.ticket) {
    throw new Error(`session is for ${saved.ticket}; start a new session name for ${options.ticket}`);
  }
  if (!saved && !options.effort) throw new Error('a new session needs --effort');
  // Sessions started without a model once came up on a slower one and had to be restarted.
  if (!saved && !options.model) throw new Error('a new session needs --model (set CODEX_MODEL in config.env)');
  return {
    ...saved,
    threadId: saved?.threadId,
    cwd: saved?.cwd ?? options.cwd,
    model: options.model ?? saved?.model,
    effort: options.effort ?? saved?.effort,
    sandbox: options.sandbox ?? saved?.sandbox,
    turns: saved?.turns ?? [],
    ...((saved?.ticket ?? options.ticket) ? { ticket: saved?.ticket ?? options.ticket } : {}),
    ...(saved?.ended ? { ended: saved.ended } : {}),
    ...(saved?.archivedAt ? { archivedAt: saved.archivedAt } : {}),
    ...(saved?.loadedSkill ? { loadedSkill: saved.loadedSkill } : {}),
  };
}

/** Serialize control mutations against the actor's existing state; a live controller is never displaced. */
function control(stateDir, name, operation, { identityOf = readProcessIdentity, writeOwner = writeAtomic, clock = Date.now } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const lock = `${statePath(stateDir, name)}.control`;
  const busy = () => new Error(`session control busy: ${name}; retry after its current command completes`);
  const ownerOf = dir => { try { return regularJson(path.join(dir, 'owner.json')); } catch { return null; } };
  const orphan = dir => {
    const stat = statSync(dir); const saved = ownerOf(dir);
    if (!saved && clock() - stat.mtimeMs < 60_000) throw busy(); // bounded grace for creation/legacy PID-only records
    if (saved && Number.isSafeInteger(saved.pid) && saved.pid > 1 && saved.identity && identityOf(saved.pid) === saved.identity) throw busy();
    const current = statSync(dir);
    if (current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || JSON.stringify(ownerOf(dir)) !== JSON.stringify(saved)) throw busy();
    rmSync(dir, { recursive: true }); // only the proven orphan; never signal any PID
  };
  const owner = { pid: process.pid, identity: identityOf(process.pid), token: randomUUID() };
  if (!owner.identity) throw new Error('session control process identity is unreadable');
  const take = dir => {
    mkdirSync(dir);
    try { writeOwner(path.join(dir, 'owner.json'), owner); }
    catch (error) { rmSync(dir, { recursive: true }); throw error; }
  };
  try { take(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const reclaim = `${lock}.reclaim`;
    try { take(reclaim); }
    catch (failure) {
      if (failure.code !== 'EEXIST') throw failure;
      orphan(reclaim); take(reclaim);
    }
    try { orphan(lock); take(lock); }
    finally { if (ownerOf(reclaim)?.token === owner.token) rmSync(reclaim, { recursive: true }); }
  }
  const release = () => { if (ownerOf(lock)?.token === owner.token) rmSync(lock, { recursive: true }); };
  try {
    const result = operation();
    if (result?.then) return result.finally(release);
    release(); return result;
  } catch (error) { release(); throw error; }
}

function sameWorktree(left, right) {
  if (typeof left !== 'string') return false;
  const canonical = value => {
    const absolute = resolve(value);
    try { return realpathSync(absolute); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(absolute);
      return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute));
    }
  };
  const a = canonical(left); const b = canonical(right);
  return a === b || a.startsWith(`${b}${path.sep}`);
}

/** Inspect existing ownership files, conservatively retaining even dead or incompletely written locks. */
export function reloadBlockers(state, { slotRoot = machineSlotLockDir(),
  e2eLockDir = machineE2eLockDir(), identityOf = readProcessIdentity, reloadFence } = {}) {
  const blockers = [];
  let slots;
  try { slots = readdirSync(slotRoot).filter(name => /^heavy-\d+\.lock$/.test(name)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; slots = []; }
  for (const name of slots) {
    let cwd;
    try { cwd = readFileSync(path.join(slotRoot, name, 'cwd'), 'utf8').trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cwd && sameWorktree(cwd, state.cwd) && reloadFence) {
      try {
        const admission = regularJson(path.join(slotRoot, name, 'admission.json'));
        if (admission.pid === Number(readFileSync(path.join(slotRoot, name, 'pid'), 'utf8'))
          && waitsForReloadFence(admission, reloadFence, identityOf)) continue;
      } catch { /* an incomplete slot remains a blocker */ }
    }
    if (!cwd || sameWorktree(cwd, state.cwd)) blockers.push(`heavy slot ${name}`);
  }
  const scope = owner => {
    if (!owner || typeof owner !== 'object') return 'unknown';
    if (typeof state.name === 'string' && owner.name === state.name) return 'related';
    const paths = [owner.worktree, owner.cwd].filter(value => value !== undefined);
    if (!paths.length || paths.some(value => typeof value !== 'string' || !value)) return 'unknown';
    return paths.some(value => sameWorktree(value, state.cwd)) ? 'related' : 'foreign';
  };
  // Read waiters before the holder: acquisition installs its holder before removing its waiter.
  // This ordering cannot mistake the waiter-to-holder handover for a safe point.
  for (const { owner } of readE2eWaiters(e2eLockDir)) {
    if (waitsForReloadFence(owner, reloadFence, identityOf)) continue;
    const relevance = scope(owner);
    if (relevance === 'foreign') continue;
    // A different birth witness proves a reused PID; missing/unreadable ownership proves no safe release.
    let current;
    if (relevance === 'related' && Number.isSafeInteger(owner?.pid) && owner.pid > 1
      && typeof owner.identity === 'string' && owner.identity) {
      try { current = identityOf(owner.pid); } catch { /* preserve uncertain ownership */ }
      if (typeof current === 'string' && current && current !== owner.identity) continue;
    }
    blockers.push('e2e waiter');
  }
  if (existsSync(e2eLockDir)) {
    let owner;
    try { owner = regularJson(path.join(e2eLockDir, 'owner.json')); } catch { /* admission/cleanup in flight */ }
    if (scope(owner) !== 'foreign') blockers.push('e2e lock');
  }
  return blockers;
}

function reloadTarget(state, pluginRoot) {
  if (state.loadedSkill?.actorId !== state.threadId) throw new Error('target actor has no recorded loaded skill evidence');
  return loadedSkillEvidence(state.threadId, 'codex', pluginRoot, state.loadedSkill.skill, LoadBasis.ReloadAcknowledged);
}

/** Look only at bounded items on the exact recorded turn, never shell stdout or another actor's claim. */
async function reloadItems(client, threadId, turnId, matches, scan, checkpoint) {
  if (!turnId) throw new Error('receipt scan has no bound turn');
  if (scan && (scan.turnId !== turnId || typeof scan.cursor !== 'string' || !scan.cursor)) throw new Error('invalid receipt scan binding');
  const items = []; let cursor = scan?.cursor; let probeHead = Boolean(cursor);
  for (let page = 0; page < 5; page += 1) {
    const result = await client.request('thread/items/list', { threadId, turnId, limit: 100, sortDirection: 'desc', ...(!probeHead && cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data)) throw new Error('unreadable receipt page');
    const batch = result.data.map(row => row.item);
    items.push(...batch);
    if (batch.some(matches)) { checkpoint(null); return { items, more: false }; }
    // A resumed pump first notices a newly arrived ACK, then continues its durable older-history cursor.
    if (probeHead) { probeHead = false; continue; }
    if (result.nextCursor != null && (typeof result.nextCursor !== 'string' || !result.nextCursor)) throw new Error('invalid receipt continuation cursor');
    checkpoint(result.nextCursor ? { turnId, cursor: result.nextCursor } : null);
    if (!result.nextCursor) return { items, more: false };
    cursor = result.nextCursor;
  }
  return { items, more: true };
}

function userText(item) {
  return item?.type === 'userMessage' ? (item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n') : null;
}

/** Pump one bound page/replay. A recovery shell can request delivery, but only the actor can acknowledge it. */
export async function deliverReload(options, { client, ...dependencies } = {}) {
  if (!client?.request) throw new Error('reload needs the bound App Server client; stdout is not actor delivery');
  return control(options.stateDir, options.name, () => deliverReloadControlled(client, options, dependencies), dependencies.control);
}

async function deliverReloadControlled(client, options, dependencies = {}) {
  const queued = loadState(options.stateDir, options.name);
  if (!queued?.reload?.turnId) throw new Error('no App Server turn bound to queued skill reload');
  if (queued.ended) throw new Error('session ended; use turn to reopen before reloading');
  queued.reload.id ??= queued.reload.fence?.reloadId ?? randomUUID();
  const proposed = queued.reload.fence ?? { token: randomUUID(), reloadId: queued.reload.id, worktree: canonicalWorktree(queued.cwd),
    stateFile: realpathSync(statePath(options.stateDir, options.name)), threadId: queued.threadId,
    started: Boolean(queued.reload.cursor || queued.reload.delivery?.sent) };
  queued.reload.fence = proposed;
  saveState(options.stateDir, options.name, queued); // durable actor ownership precedes fence publication
  let fence;
  try {
    fence = ensureReloadFence(proposed, { slotRoot: dependencies.slotRoot, identityOf: dependencies.identityOf });
    queued.reload.fence = fence; saveState(options.stateDir, options.name, queued);
    return await deliverReloadFenced(client, options, { ...dependencies, reloadFence: fence });
  } finally {
    const latest = loadState(options.stateDir, options.name);
    if (!latest?.reload || !(latest.reload.fence?.started ?? proposed.started)) {
      if (fence) releaseReloadFence(fence);
      if (latest?.reload?.fence?.token === (fence?.token ?? proposed.token)) {
        delete latest.reload.fence; saveState(options.stateDir, options.name, latest);
      }
    }
  }
}

async function deliverReloadFenced(client, options, dependencies) {
  let state = loadState(options.stateDir, options.name);
  if (!state?.reload?.turnId) throw new Error('no App Server turn bound to queued skill reload');
  const blockers = reloadBlockers({ ...state, name: options.name }, dependencies);
  if (blockers.length) throw new Error(`reload queued until safe point: release ${blockers.join(', ')} first`);
  const target = reloadTarget(state, options.pluginRoot ?? PLUGIN_ROOT);
  if (JSON.stringify(target) !== JSON.stringify(state.reload.target)) throw new Error('installed reload target changed; queue a new mechanical reload');
  const live = await readThreadState(client, state.threadId);
  if (live.thread?.id !== state.threadId || !live.turn?.id || live.thread.status?.type === 'systemError') throw new Error('App Server reload actor is unverified');
  const persist = () => saveState(options.stateDir, options.name, state);
  const pending = state.reload.delivery;
  if (pending) {
    const turnId = pending.turnId ?? pending.scan?.turnId ?? live.turn.id;
    let receipt;
    const checkpoint = scan => { if (scan) pending.scan = scan; else delete pending.scan; persist(); };
    try {
      receipt = await reloadItems(client, state.threadId, turnId, item =>
        (item?.type === 'agentMessage' && item.text === `VIBE_SKILL_RELOAD_ACK v1 ${pending.nonce}`)
        || (pending.kind === 'brief' && userText(item) === pending.text), pending.scan, checkpoint);
    } catch (error) {
      if (!options.retry || !pending.scan) throw error;
      checkpoint(null); // explicit recovery from a failed cursor lookup; preserve the original nonce/text and work
      receipt = { items: [], more: false };
    }
    const { items } = receipt;
    const acknowledged = items.some(item => item?.type === 'agentMessage' && item.text === `VIBE_SKILL_RELOAD_ACK v1 ${pending.nonce}`);
    const replayed = items.some(item => userText(item) === pending.text);
    if (!pending.turnId && (acknowledged || replayed)) {
      pending.turnId = turnId;
      pending.sent = true;
      state.reload.turnId = turnId;
      persist();
    }
    if (receipt.more) return { complete: false, waitingFor: 'receipt scan', threadId: state.threadId, turnId };
    if (pending.kind === 'page' && acknowledged) {
      state.reload.cursor = pending.end;
      state.reload.turnId = turnId;
      delete state.reload.delivery;
      persist();
    } else if (pending.kind === 'brief' && replayed) {
      state.reloadReceipt = { target, turnId, replayNonce: pending.nonce };
      delete state.reload; persist();
      return { complete: true, replayed: true, threadId: state.threadId, turnId };
    } else {
      if (live.turn.id !== (pending.turnId ?? pending.baselineTurnId)
        && !(options.retry && live.turn.id === state.reload.turnId)) throw new Error('reload delivery turn changed without acknowledgement; retained for reconciliation');
      if (pending.sent && !options.retry) return { complete: false, waitingFor: pending.kind === 'page' ? 'actor acknowledgement' : 'brief delivery', turnId };
    }
  }
  if (live.turn.id !== state.reload.turnId) throw new Error('App Server reload turn differs from the recorded writer turn');
  if (!state.reload.delivery) {
    const lines = readFileSync(path.join(target.pluginRoot, target.definition), 'utf8').split('\n');
    const cursor = state.reload.cursor ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > lines.length) throw new Error('invalid reload cursor');
    const nonce = randomUUID();
    if (cursor < lines.length) {
      const end = Math.min(cursor + 160, lines.length);
      const page = { threadId: state.threadId, nonce, definition: target.definition, definitionSha256: target.definitionSha256,
        start: cursor + 1, end, total: lines.length, content: lines.slice(cursor, end).join('\n') };
      state.reload.delivery = { kind: 'page', nonce, end, page, text: skillReloadPage(page), baselineTurnId: live.turn.id };
    } else {
      state.loadedSkill = target; // every page has a causal assistant acknowledgement on its recorded App Server turn
      if (!state.reload.pendingPrompt) { delete state.reload; persist(); return { complete: true, threadId: state.threadId }; }
      state.reload.delivery = { kind: 'brief', nonce, baselineTurnId: live.turn.id,
        text: textInput(`${state.reload.pendingPrompt}\nVIBE_RETAINED_BRIEF v1 ${nonce}`)[0].text };
    }
    persist(); // retain nonce and original brief before any fallible delivery
  }
  const delivery = state.reload.delivery;
  const mechanical = delivery.kind === 'page';
  if (JSON.stringify(reloadTarget(state, options.pluginRoot ?? PLUGIN_ROOT)) !== JSON.stringify(target)) throw new Error('reload target changed during delivery');
  const lateBlockers = reloadBlockers({ ...state, name: options.name }, dependencies);
  if (lateBlockers.length) throw new Error(`reload queued until safe point: release ${lateBlockers.join(', ')} first`);
  state.reload.fence.started = true; persist(); // retain the fence even if an RPC reply is lost or this CLI exits
  if (live.turn.status === 'inProgress') {
    const response = await client.request('turn/steer', { threadId: state.threadId, expectedTurnId: live.turn.id,
      input: textInput(delivery.text, { mechanical, page: delivery.page }) });
    if (response.turnId !== live.turn.id) throw new Error('App Server acknowledged a different reload turn');
    delivery.turnId = response.turnId;
  } else if (['completed', 'interrupted', 'failed'].includes(live.turn.status)) {
    const next = await startTurn(client, state, delivery.text, '[retained reload]', { name: options.name, mechanical, page: delivery.page });
    delivery.turnId = next.turns.at(-1).turnId;
    state.turns = next.turns;
  } else throw new Error('App Server reload turn status is unverified');
  state.reload.turnId = delivery.turnId;
  delivery.sent = true;
  if (delivery.kind === 'brief') {
    state.reloadReceipt = { target, turnId: delivery.turnId, replayNonce: delivery.nonce };
    delete state.reload; persist();
    return { complete: true, replayed: true, threadId: state.threadId, turnId: state.reloadReceipt.turnId };
  }
  persist();
  return { complete: false, waitingFor: 'actor acknowledgement', threadId: state.threadId, turnId: delivery.turnId };
}

/** Interrupt through the owned protocol, persist why before dispatch, and confirm the exact turn stopped. */
export async function interruptSession(client, options, state, { wait = delay, attempts = 20 } = {}) {
  if (!options.reason?.trim() || options.reason.length > 1000) throw new Error('interrupt needs a nonempty --reason');
  if (state.ended) throw new Error('cannot interrupt an ended session');
  const current = await readThreadState(client, state.threadId);
  if (current.turn?.status !== 'inProgress') throw new Error('no active turn to interrupt');
  const turnId = current.turn.id;
  const next = { ...state, interrupt: { turnId, reason: options.reason, requestedAt: new Date().toISOString() } };
  saveState(options.stateDir, options.name, next);
  await client.request('turn/interrupt', { threadId: state.threadId, turnId });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const observed = await readThreadState(client, state.threadId);
    if (observed.turn?.id !== turnId) throw new Error('interrupt confirmation saw a different turn; stop is unconfirmed');
    if (['interrupted', 'completed', 'failed'].includes(observed.turn.status) && observed.thread?.status?.type !== 'systemError') {
      next.interrupt.completedAt = new Date().toISOString();
      const fence = next.reload?.fence;
      if (fence) releaseReloadFence(fence); // exact actor turn is stopped; release before clearing its durable binding
      if (fence) delete next.reload.fence;
      saveState(options.stateDir, options.name, next);
      return `${options.name} interrupted ${state.threadId} ${turnId}`;
    }
    await wait(250);
  }
  throw new Error('interrupt stop is unconfirmed; reason retained, retry status before resuming');
}

/**
 * Ends every turn and steer this client sends. A vibe session once wrote its parent orchestrator's capacity stop
 * into its findings and its writer's brief as a "Human capacity-stop ruling" (2026-10-26): a driven session cannot
 * tell whose words its user turn carries unless the turn says so.
 */
export const ORCHESTRATOR_PROVENANCE = 'From the fleet orchestrator, not the operator: its own directions are operational and are recorded as `(orchestrator)`, never as a human ruling; only operator words it quotes, with their source, are rulings.';

function textInput(text, { mechanical = false, page } = {}) {
  if (mechanical) {
    if (!isSkillReload(text, page)) throw new Error('invalid mechanical reload envelope');
    return [{ type: 'text', text: page ? text : SKILL_RELOAD, text_elements: [] }];
  }
  const sent = text.includes(ORCHESTRATOR_PROVENANCE) ? text : `${text}\n${ORCHESTRATOR_PROVENANCE}`;
  return [{ type: 'text', text: sent, text_elements: [] }];
}

function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/**
 * Starts or resumes the thread, then starts a turn. approvalPolicy is always `never`: this client
 * disconnects once the turn is accepted, so an approval request would have nobody to answer it.
 * `warn` receives each sidebar step an older App Server could not apply.
 */
export async function startTurn(client, state, prompt, promptFile, { name, warn = () => {}, mechanical = false, page } = {}) {
  const threadOptions = defined({ cwd: state.cwd, model: state.model, sandbox: state.sandbox, approvalPolicy: 'never' });
  let { threadId } = state;
  const { ended, archivedAt, ...open } = state;
  if (threadId) {
    if (archivedAt) await client.request('thread/unarchive', { threadId });
    await client.request('thread/resume', { threadId, ...threadOptions });
  } else {
    const started = await client.request('thread/start', { ...threadOptions, threadSource: WORKER_THREAD_SOURCE });
    threadId = started?.thread?.id;
    if (!threadId) throw new Error('App Server returned no thread id');
    for (const warning of await labelWorkerThread(client, threadId, workerThreadName(name, state.ticket))) warn(warning);
  }
  const result = await client.request('turn/start', defined({
    threadId,
    input: textInput(prompt, { mechanical, page }),
    cwd: state.cwd,
    model: state.model,
    effort: state.effort,
    sandboxPolicy: state.sandbox && SANDBOX_POLICIES[state.sandbox],
    approvalPolicy: 'never',
  }));
  const turnId = result?.turn?.id;
  if (!turnId) throw new Error('App Server returned no turn id');
  return { ...open, threadId, turns: [...state.turns, { turnId, kind: 'turn', promptFile }] };
}

export async function readThread(client, threadId) {
  const { thread } = await client.request('thread/read', { threadId, includeTurns: true });
  return thread;
}

export async function steerTurn(client, state, prompt, promptFile, inputOptions = {}) {
  if (state.ended) throw new Error(`session ended (${state.ended.reason}); use turn to reopen it`);
  const turn = (await readThread(client, state.threadId))?.turns?.at(-1);
  if (turn?.status !== 'inProgress') throw new Error(`no active turn to steer (last turn is ${turn?.status ?? 'none'}); use turn`);
  const result = await client.request('turn/steer', { threadId: state.threadId, expectedTurnId: turn.id, input: textInput(prompt, inputOptions) });
  if (result?.turnId !== turn.id) throw new Error('App Server steered a different turn');
  return { ...state, turns: [...state.turns, { turnId: turn.id, kind: 'steer', promptFile }] };
}

/** The status line codex-fleet-monitor prints, then the last `count` agent messages, oldest first. */
export function lastMessages(name, thread, count) {
  const messages = (thread?.turns ?? [])
    .flatMap((turn) => (turn.items ?? []).filter((item) => item.type === 'agentMessage').map((item) => ({ turn, item })))
    .slice(-count);
  return [
    summarize(name, thread),
    ...messages.map(({ turn, item }) => `--- turn ${turn.id} ${turn.status}\n${item.text ?? ''}`),
  ].join('\n');
}

/** Records the writer stopped or merged, then archives its thread; a running turn is refused before either. */
export async function endSession(client, stateDir, name, saved, reason) {
  let state = saved;
  if (!state.ended) {
    await assertWorkerNotLive(client, state.threadId);
    state = { ...state, ended: endRecord(reason) };
    const fence = state.reload?.fence;
    if (fence) releaseReloadFence(fence);
    if (fence) delete state.reload.fence;
    saveState(stateDir, name, state);
  }
  if (!state.archivedAt) {
    await archiveEndedWorker(client, state.threadId, state.ended);
    state = { ...state, archivedAt: new Date().toISOString() };
    saveState(stateDir, name, state);
  }
  return `${name} ended ${state.threadId} ${state.ended.reason}`;
}

export function run(client, options, dependencies = {}) {
  return control(options.stateDir, options.name, () => runControlled(client, options, dependencies), dependencies.control);
}

async function runControlled(client, options, { warn = (text) => console.error(`codex-session: ${text}`), ...dependencies } = {}) {
  let saved = loadState(options.stateDir, options.name);
  if (options.command === 'reload') return JSON.stringify(await deliverReloadControlled(client, options, dependencies));
  if (options.command === 'last') {
    if (!saved) throw new Error(`no session ${options.name} in ${options.stateDir}`);
    return lastMessages(options.name, await readThread(client, saved.threadId), options.count);
  }
  if (options.command === 'end') {
    if (!saved) throw new Error(`no session ${options.name} in ${options.stateDir}`);
    return endSession(client, options.stateDir, options.name, saved, options.reason);
  }
  if (options.command === 'interrupt') {
    if (!saved) throw new Error(`no session ${options.name} in ${options.stateDir}`);
    return interruptSession(client, options, saved, dependencies);
  }
  let prompt = readFileSync(options.promptFile, 'utf8');
  let mechanicalDispatch = false;
  let beginIdleReload = false;
  if (!prompt.trim()) throw new Error(`${options.promptFile} is empty`);
  if (options.command === 'turn' && !saved && !VIBE_PROMPT.test(prompt)) {
    throw new Error(`a new session's prompt must start with $vibe; ${options.promptFile} does not`);
  }
  if (DONE_CLAIMS.test(prompt) && !REVERIFY.test(prompt)) {
    throw new Error(`${options.promptFile} hands over "Done:" claims with no "Re-verify:" line; the writer re-verifies each with a test or a measurement before building on it`);
  }
  const promptFile = resolve(options.promptFile);
  if (options.command === 'turn') nextState(saved, options); // validate identity/options before queue persistence
  const pluginRoot = options.pluginRoot ?? PLUGIN_ROOT;
  if (saved?.reload && !isSkillReload(prompt) && !loadedSkillEvidenceProblem(saved.loadedSkill, { actorId: saved.threadId, pluginRoot })) {
    throw new Error('finish the queued reload delivery before another brief');
  }
  if (saved?.loadedSkill) {
    const stale = loadedSkillEvidenceProblem(saved.loadedSkill, { actorId: saved.threadId, pluginRoot });
    const recoverable = reloadableSkill(saved.loadedSkill, { actorId: saved.threadId, pluginRoot });
    const mechanical = isSkillReload(prompt);
    const migration = stale && recoverable && options.command === 'turn' && !saved.reload;
    beginIdleReload = Boolean(migration && !mechanical);
    const problems = promptProblems({ loadedSkill: saved.loadedSkill }, migration ? SKILL_RELOAD : prompt, { actorId: saved.threadId, pluginRoot, worktree: saved.cwd });
    if (problems.length) throw new Error(problems.join('; '));
    if (migration) {
      const originalProblems = promptProblems({ loadedSkill: loadedSkillEvidence(saved.threadId, 'codex', pluginRoot, saved.loadedSkill.skill, LoadBasis.ReloadAcknowledged) },
        prompt, { actorId: saved.threadId, pluginRoot, worktree: saved.cwd });
      if (originalProblems.length) throw new Error(originalProblems.join('; '));
    }
    if (stale && (mechanical || migration)) {
      if (options.command === 'turn') {
        const live = await readThreadState(client, saved.threadId);
        if (live.turn?.status === 'inProgress' || live.thread?.status?.type === 'active' || live.thread?.status?.type === 'systemError') throw new Error(`${stale}; running writer needs a mechanical reload steer`);
      }
      const target = reloadTarget(saved, pluginRoot);
      const sameTarget = JSON.stringify(saved.reload?.target) === JSON.stringify(target);
      saved = { ...saved, reload: sameTarget ? saved.reload : { target, cursor: 0, queuedAt: new Date().toISOString(),
        ...(saved.reload?.id ? { id: saved.reload.id } : {}),
        ...(saved.reload?.fence ? { fence: saved.reload.fence } : {}),
        ...(migration && !mechanical ? { pendingPrompt: prompt, pendingPromptFile: promptFile } : saved.reload?.pendingPrompt ? { pendingPrompt: saved.reload.pendingPrompt, pendingPromptFile: saved.reload.pendingPromptFile } : {}) } };
      saveState(options.stateDir, options.name, saved);
      prompt = SKILL_RELOAD;
      mechanicalDispatch = true;
    }
    if (saved.reload && isSkillReload(prompt)) mechanicalDispatch = true;
  }
  let state;
  if (options.command === 'turn') state = await startTurn(client, nextState(saved, options), prompt, promptFile, { name: options.name, warn, mechanical: mechanicalDispatch });
  else {
    if (!saved) throw new Error(`no session ${options.name} in ${options.stateDir}`);
    state = await steerTurn(client, saved, prompt, promptFile, { mechanical: mechanicalDispatch });
  }
  // A fresh thread reads the installed skill on its first $vibe turn; this records that definition
  // at spawn, which is not an observation of the read.
  if (!saved) state.loadedSkill = loadedSkillEvidence(state.threadId, 'codex', options.pluginRoot ?? PLUGIN_ROOT, 'vibe', LoadBasis.InstalledAtSpawn);
  if (mechanicalDispatch) state.reload.turnId = state.turns.at(-1).turnId;
  saveState(options.stateDir, options.name, state);
  const { turnId, kind } = state.turns.at(-1);
  // The next idle turn starts loading immediately; held jobs leave the same durable queue for a milestone pump.
  if (beginIdleReload && !reloadBlockers({ ...state, name: options.name }, dependencies).length) {
    await deliverReloadControlled(client, options, dependencies);
  }
  return `${options.name} ${kind} ${state.threadId} ${turnId}`;
}

async function main() {
  exitAfterTotalTimeout();
  let options;
  try {
    options = parseCli(process.argv.slice(2));
    if (options.command === 'turn') {
      const saved = loadState(options.stateDir, options.name);
      requireResumeSession(saved, options.cwd);
    }
    if (['turn', 'steer', 'reload'].includes(options.command)) options.pluginRoot = verifiedPluginRoot(options.pluginRoot);
  } catch (error) {
    console.error(`codex-session: ${error.message}`);
    process.exit(2);
  }
  const client = connectViaProxy(daemonSocket());
  let code = 0;
  try {
    await client.initialize();
    console.log(await run(client, options));
  } catch (error) {
    console.error(`codex-session: ${error.message}`);
    code = 1;
  }
  client.close();
  process.exit(code);
}

if (isEntryPoint(import.meta.url)) await main();
