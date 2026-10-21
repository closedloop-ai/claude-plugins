// Usage: node recover.mjs <stateDir> <session>...   one recovery pass over this host's sessions
//        node recover.mjs --report <stateDir> <where>  "recovery <where> <events> <last event>" for snapshot.sh, then
//                                                     "supervisor <where> <health>" when this host has a supervisor
// Sessions are given as for liveness.mjs. A session whose last turn failed with a TRANSIENT provider error
// is resumed after a backoff with a continue prompt. A thread still in systemError after the retries needs
// the App Server daemon restarted: that happens only with AUTO_RESTART_DAEMON=1, otherwise it is an ALERT.
// After a restart only sessions whose turn was active or failed are resumed; idle sessions stay idle.
// Every action prints an EVENT line and is appended to <stateDir>/.fleet-recovery/events.log, which rotates
// to events.log.1 at LOG_MAX_BYTES. A pass that outlasts PASS_TIMEOUT_SECONDS is abandoned with a
// pass-timeout EVENT: its App Server connections are closed and its pass lock is released.
// Settings (environment): RECOVERY_BACKOFF_SECONDS (default "120 300 600", one retry per value),
// CONTINUE_PROMPT_FILE, AUTO_RESTART_DAEMON, RESTART_COOLDOWN_SECONDS (default 1800), FLEET_SUPERVISOR_LOCK,
// PASS_TIMEOUT_SECONDS (default 300), LOG_MAX_BYTES (default 1048576), SUPERVISOR_RSS_CAP_MB (default 300).
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import {
  classifyTurnError, connectViaProxy, daemonSocket, Failure, isEntryPoint, parseSession, readThreadState,
} from './liveness.mjs';

export const DEFAULT_BACKOFF_SECONDS = [120, 300, 600];
export const DEFAULT_RESTART_COOLDOWN_SECONDS = 1800;
// Covers a pass that restarts the daemon (up to 120 seconds) and then resumes every session on the host.
export const DEFAULT_PASS_TIMEOUT_SECONDS = 300;
export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;
export const DEFAULT_RSS_CAP_MB = 300;
// A heartbeat older than this many supervisor intervals is STALE.
export const STALE_INTERVALS = 3;
export const DEFAULT_CONTINUE_PROMPT = [
  'Your last turn ended with a transient provider error (for example, the model was at capacity), and the fleet monitor resumed this session.',
  'Before you continue, check your real state: git status and HEAD, whether a merge or rebase is in progress, your background jobs and any slot or lock entries you hold, and what you last pushed.',
  'Do not redo steps that are already finished. Then continue the task from where it actually stands.',
].join('\n');

export function supervisorLockPath(env = process.env) {
  return env.FLEET_SUPERVISOR_LOCK || `${homedir()}/.codex/fleet-supervisor.lock`;
}

export function readConfig(env = process.env) {
  const backoff = (env.RECOVERY_BACKOFF_SECONDS ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (backoff.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('RECOVERY_BACKOFF_SECONDS must be non-negative numbers separated by spaces or commas');
  }
  const cooldown = Number(env.RESTART_COOLDOWN_SECONDS || DEFAULT_RESTART_COOLDOWN_SECONDS);
  if (!Number.isFinite(cooldown) || cooldown < 0) throw new Error('RESTART_COOLDOWN_SECONDS must be a non-negative number');
  return {
    backoffMs: (backoff.length ? backoff : DEFAULT_BACKOFF_SECONDS).map((seconds) => seconds * 1000),
    prompt: env.CONTINUE_PROMPT_FILE ? readFileSync(env.CONTINUE_PROMPT_FILE, 'utf8') : DEFAULT_CONTINUE_PROMPT,
    autoRestart: env.AUTO_RESTART_DAEMON === '1',
    restartCooldownMs: cooldown * 1000,
    passTimeoutMs: positiveSetting(env, 'PASS_TIMEOUT_SECONDS', DEFAULT_PASS_TIMEOUT_SECONDS) * 1000,
    logMaxBytes: positiveSetting(env, 'LOG_MAX_BYTES', DEFAULT_LOG_MAX_BYTES),
  };
}

/** A positive number from `env[name]`, the default when unset or blank; anything else throws. */
export function positiveSetting(env, name, fallback) {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

/**
 * Appends `text` to `path`, first moving the file to `<path>.1` (replacing an older one) when the append
 * would take it past `maxBytes`. For a file only this process appends to and opens per write.
 */
export function appendRotated(path, text, maxBytes = DEFAULT_LOG_MAX_BYTES) {
  let size = 0;
  try { size = statSync(path).size; } catch {}
  if (size > 0 && size + Buffer.byteLength(text) > maxBytes) renameSync(path, `${path}.1`);
  appendFileSync(path, text);
}

/**
 * Takes `path` for this process. A lock whose recorded pid is gone is stale and taken over.
 * Returns { acquired: true, release } or { acquired: false, pid } naming the live holder.
 */
export function acquireLock(path, pid = process.pid) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, `${pid}\n`);
      closeSync(fd);
      return { acquired: true, release: () => releaseLock(path, pid) };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = lockHolder(path);
    if (holder) return { acquired: false, pid: holder };
    try { unlinkSync(path); } catch {}
  }
  return { acquired: false, pid: lockHolder(path) };
}

/** The live pid holding `path`, or null when the file is missing, unreadable or names a dead process. */
export function lockHolder(path) {
  let pid;
  try { pid = Number.parseInt(readFileSync(path, 'utf8'), 10); } catch { return null; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return error.code === 'EPERM' ? pid : null;
  }
}

function releaseLock(path, pid) {
  if (lockHolder(path) === pid) {
    try { unlinkSync(path); } catch {}
  }
}

export function recoveryDir(stateDir) {
  return `${stateDir}/.fleet-recovery`;
}

function loadState(stateDir) {
  try {
    const state = JSON.parse(readFileSync(`${recoveryDir(stateDir)}/state.json`, 'utf8'));
    return { sessions: state.sessions ?? {}, lastRestartAt: state.lastRestartAt ?? null, alerted: state.alerted ?? null, beforeRestart: state.beforeRestart ?? null };
  } catch {
    return { sessions: {}, lastRestartAt: null, alerted: null, beforeRestart: null };
  }
}

function saveState(stateDir, state) {
  const target = `${recoveryDir(stateDir)}/state.json`;
  writeFileSync(`${target}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${target}.tmp`, target);
}

/** "recovery <where> <eventCount> <last event>": the line snapshot.sh prints, so a new event wakes the watcher. */
export function reportLine(stateDir, where = 'local') {
  let lines = [];
  try { lines = readFileSync(`${recoveryDir(stateDir)}/events.log`, 'utf8').split('\n').filter(Boolean); } catch {}
  const last = lines.at(-1)?.replace(/^\S+ EVENT /, '') ?? '-';
  return `recovery ${where} ${lines.length} ${last}`;
}

function textInput(text) {
  return [{ type: 'text', text, text_elements: [] }];
}

function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => typeof value === 'string' && value));
}

/** The cwd, model, effort and sandbox a fleet-orchestrator state file records, so a resume keeps them. */
export function savedOptions(spec, stateDir) {
  if (spec.includes('=')) return {};
  try {
    const { cwd, model, effort, sandbox } = JSON.parse(readFileSync(`${stateDir}/${spec}.json`, 'utf8'));
    return defined({ cwd, model, effort, sandbox });
  } catch {
    return {};
  }
}

/**
 * Reloads the thread into the App Server, then starts a turn with the continue prompt; returns the turn id.
 * approvalPolicy is `never`: this client disconnects once the turn is accepted, so nobody could approve.
 */
export async function resumeSession(client, threadId, prompt, options = {}) {
  const { cwd, model, effort, sandbox } = options;
  await client.request('thread/resume', { threadId, ...defined({ cwd, model, sandbox }), approvalPolicy: 'never' });
  const started = await client.request('turn/start', { threadId, input: textInput(prompt), ...defined({ cwd, model, effort }), approvalPolicy: 'never' });
  const turnId = started?.turn?.id;
  if (!turnId) throw new Error('App Server returned no turn id');
  return turnId;
}

export function restartDaemon(codex = 'codex') {
  execFileSync(codex, ['app-server', 'daemon', 'restart'], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function errorCode(error) {
  const info = error?.codexErrorInfo;
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object') return Object.keys(info)[0] ?? 'unknown';
  return 'none';
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * One recovery pass. `connect()` returns an initialized client; `restart()` restarts the daemon.
 * Returns the EVENT lines it emitted, which are also appended to the events log.
 */
export async function recoverPass({ stateDir, specs, config, connect, restart, now = Date.now(), host = hostname() }) {
  mkdirSync(recoveryDir(stateDir), { recursive: true });
  const state = loadState(stateDir);
  const events = [];
  const emit = (text) => {
    const line = `EVENT recovery ${text}`;
    events.push(line);
    appendEvent(stateDir, line, config.logMaxBytes, now);
  };
  const retries = config.backoffMs.length;
  let client = await connect();
  const sessions = [];
  try {
    for (const spec of specs) {
      let session;
      try {
        session = parseSession(spec, stateDir);
        const { thread, turn } = await readThreadState(client, session.threadId);
        sessions.push({ ...session, options: savedOptions(spec, stateDir), thread, turn });
      } catch {
        // An unreadable session is the monitor's READFAIL line; nothing here can recover it.
      }
    }
    const stuck = [];
    for (const { label, threadId, options, thread, turn } of sessions) {
      const systemError = thread?.status?.type === 'systemError';
      let record = state.sessions[label];
      if (!turn?.error || classifyTurnError(turn.error) !== Failure.Transient) {
        if (record && turn?.status === 'completed') {
          emit(`${label} recovered after ${plural(record.attempts, 'retry', 'retries')}`);
          delete state.sessions[label];
        }
        continue;
      }
      if (record?.turnId !== turn.id) {
        record = { turnId: turn.id, attempts: record?.attempts ?? 0, nextAt: now + config.backoffMs[Math.min(record?.attempts ?? 0, retries - 1)], gaveUp: false };
        state.sessions[label] = record;
        if (record.attempts < retries) {
          emit(`${label} transient-failure turn=${turn.id} code=${errorCode(turn.error)} retry=${record.attempts + 1}/${retries} in=${Math.round((record.nextAt - now) / 1000)}s: ${oneLine(turn.error.message)}`);
        }
      }
      if (record.attempts < retries && now >= record.nextAt) {
        record.attempts += 1;
        try {
          const turnId = await resumeSession(client, threadId, config.prompt, options);
          emit(`${label} resumed attempt=${record.attempts}/${retries} turn=${turnId}`);
          continue;
        } catch (error) {
          emit(`${label} resume-failed attempt=${record.attempts}/${retries}: ${oneLine(error.message)}`);
          if (record.attempts < retries) {
            record.nextAt = now + config.backoffMs[record.attempts];
            continue;
          }
        }
      }
      if (record.attempts < retries) continue;
      if (systemError) stuck.push(label);
      else if (!record.gaveUp) {
        record.gaveUp = true;
        emit(`${label} gave-up after ${plural(retries, 'retry', 'retries')}; needs a human`);
      }
    }
    if (stuck.length) client = await handleStuck({ stuck, sessions, state, config, connect, restart, now, host, emit, client });
    else state.alerted = null;
  } finally {
    client?.close?.();
    saveState(stateDir, state);
  }
  return events;
}

/** A turn the restart interrupts (active) or that already failed needs the continue prompt; an idle one does not. */
export function needsResumeAfterRestart(thread, turn) {
  return thread?.status?.type === 'active' || turn?.status === 'inProgress' || turn?.status === 'failed';
}

/**
 * Restarts the daemon for threads stuck in systemError when allowed. Each session's state just before the
 * restart is recorded; afterwards only those with an active or failed turn are resumed, and idle ones stay idle.
 */
async function handleStuck({ stuck, sessions, state, config, connect, restart, now, host, emit, client }) {
  const key = stuck.join(',');
  if (!config.autoRestart) {
    if (state.alerted !== key) {
      state.alerted = key;
      emit(`ALERT ${host} daemon-restart-needed sessions=${key}: still in systemError after the retries and AUTO_RESTART_DAEMON is off; run codex app-server daemon restart, then resume each session`);
    }
    return client;
  }
  if (state.lastRestartAt !== null && now - state.lastRestartAt < config.restartCooldownMs) {
    if (state.alerted !== `cooldown:${key}`) {
      state.alerted = `cooldown:${key}`;
      emit(`ALERT ${host} restart-cooldown sessions=${key}: the daemon was restarted ${Math.round((now - state.lastRestartAt) / 1000)}s ago and they are still in systemError; needs a human`);
    }
    return client;
  }
  const loud = `!!! RESTARTING the Codex App Server daemon on ${host}: sessions=${key} are stuck in systemError; sessions with an active or failed turn will be resumed`;
  console.error(loud);
  emit(loud);
  state.beforeRestart = {};
  for (const { label, thread, turn } of sessions) {
    const before = { thread: thread?.status?.type ?? 'unknown', turn: turn?.status ?? 'none' };
    state.beforeRestart[label] = before;
    emit(`${label} before-restart thread=${before.thread} turn=${before.turn}`);
  }
  state.lastRestartAt = now;
  state.alerted = null;
  client?.close?.();
  try {
    restart();
  } catch (error) {
    emit(`ALERT ${host} daemon-restart-failed: ${oneLine(error.message)}`);
    return null;
  }
  const fresh = await connect();
  for (const { label, threadId, options, thread, turn } of sessions) {
    delete state.sessions[label];
    if (!needsResumeAfterRestart(thread, turn)) {
      emit(`${label} left-idle-after-restart`);
      continue;
    }
    try {
      emit(`${label} resumed-after-restart turn=${await resumeSession(fresh, threadId, config.prompt, options)}`);
    } catch (error) {
      emit(`${label} resume-failed-after-restart: ${oneLine(error.message)}`);
    }
  }
  return fresh;
}

/** Holds `<stateDir>/.fleet-recovery/pass.lock` for one pass; returns null when another pass holds it. */
export async function lockedPass(options) {
  mkdirSync(recoveryDir(options.stateDir), { recursive: true });
  const lock = acquireLock(`${recoveryDir(options.stateDir)}/pass.lock`);
  if (!lock.acquired) return null;
  try {
    return await recoverPass(options);
  } finally {
    lock.release();
  }
}

/** `track` sees the client before it is initialized, so a pass timeout can close a connection that never opened. */
export async function connectDaemon(track = () => {}) {
  const client = connectViaProxy(daemonSocket());
  track(client);
  await client.initialize();
  return client;
}

/**
 * lockedPass bounded by `config.passTimeoutMs`. On timeout it appends and returns a pass-timeout EVENT and
 * closes every connection the pass opened, which fails its pending requests so it unwinds and releases the
 * pass lock; a connection it opens later is closed at once. Returns null when another pass holds the lock.
 */
export async function timedPass(options) {
  const { stateDir, config, connect } = options;
  const clients = new Set();
  let timedOut = false;
  const track = (client) => {
    clients.add(client);
    if (timedOut) client.close?.();
  };
  const tracked = async () => {
    if (timedOut) throw new Error('the pass timed out');
    const client = await connect(track);
    track(client);
    return client;
  };
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, config.passTimeoutMs, PASS_TIMED_OUT); });
  const pass = lockedPass({ ...options, connect: tracked });
  try {
    const result = await Promise.race([pass, timeout]);
    if (result !== PASS_TIMED_OUT) return result;
  } finally {
    clearTimeout(timer);
  }
  timedOut = true;
  for (const client of clients) client.close?.();
  pass.catch(() => {});
  const line = `EVENT recovery pass-timeout after ${Math.round(config.passTimeoutMs / 1000)}s; its App Server connections were closed`;
  appendEvent(stateDir, line, config.logMaxBytes);
  return [line];
}

const PASS_TIMED_OUT = Symbol('pass timed out');

function appendEvent(stateDir, line, maxBytes, now = Date.now()) {
  mkdirSync(recoveryDir(stateDir), { recursive: true });
  appendRotated(`${recoveryDir(stateDir)}/events.log`, `${new Date(now).toISOString()} ${line}\n`, maxBytes);
}

export function heartbeatPath(stateDir) {
  return `${recoveryDir(stateDir)}/heartbeat.json`;
}

/** The supervisor's heartbeat: { at, pid, intervalSeconds, passes, lastPassMs, lastError, rssBytes }. */
export function writeHeartbeat(stateDir, heartbeat) {
  mkdirSync(recoveryDir(stateDir), { recursive: true });
  const path = heartbeatPath(stateDir);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(heartbeat)}\n`);
  renameSync(`${path}.tmp`, path);
}

/**
 * "supervisor <where> <state>" for snapshot.sh: ok, or the comma-joined problems STALE (heartbeat older than
 * STALE_INTERVALS of its interval), RSS-HIGH (over the cap) and UNREADABLE; MISSING when the supervisor lock
 * exists and no heartbeat does. Null when there is neither, so a host without a supervisor prints nothing.
 * The values are fixed per setting, so the line changes only when the state does.
 */
export function healthLine(stateDir, where, { now = Date.now(), rssCapMb = DEFAULT_RSS_CAP_MB, lockPath = supervisorLockPath() } = {}) {
  let text;
  try { text = readFileSync(heartbeatPath(stateDir), 'utf8'); } catch {
    return existsSync(lockPath) ? `supervisor ${where} MISSING` : null;
  }
  let heartbeat;
  try { heartbeat = JSON.parse(text); } catch {
    return `supervisor ${where} UNREADABLE`;
  }
  const at = Date.parse(heartbeat?.at);
  const interval = Number(heartbeat?.intervalSeconds);
  if (!Number.isFinite(at) || !(interval > 0)) return `supervisor ${where} UNREADABLE`;
  const problems = [];
  const staleSeconds = STALE_INTERVALS * interval;
  if (now - at > staleSeconds * 1000) problems.push(`STALE(>${staleSeconds}s)`);
  if (Number(heartbeat.rssBytes) > rssCapMb * 1024 * 1024) problems.push(`RSS-HIGH(>${rssCapMb}MB)`);
  return `supervisor ${where} ${problems.join(',') || 'ok'}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--report') {
    console.log(reportLine(args[1], args[2]));
    const health = healthLine(args[1], args[2], { rssCapMb: positiveSetting(process.env, 'SUPERVISOR_RSS_CAP_MB', DEFAULT_RSS_CAP_MB) });
    if (health) console.log(health);
    process.exit(0);
  }
  const [stateDir, ...specs] = args;
  // A running supervisor owns recovery on this host, so a watcher's pass steps aside.
  if (!stateDir || !specs.length || lockHolder(supervisorLockPath())) process.exit(0);
  let events;
  try {
    const config = readConfig();
    // A backstop for a pass stuck in synchronous work, where the pass timer cannot fire.
    setTimeout(() => process.exit(1), config.passTimeoutMs + 60_000).unref();
    events = await timedPass({ stateDir, specs, config, connect: connectDaemon, restart: restartDaemon });
  } catch (error) {
    console.log(`EVENT recovery pass-failed: ${oneLine(error.message)}`);
    process.exit(1);
  }
  for (const line of events ?? []) console.log(line);
  process.exit(0);
}

if (isEntryPoint(import.meta.url)) await main();

