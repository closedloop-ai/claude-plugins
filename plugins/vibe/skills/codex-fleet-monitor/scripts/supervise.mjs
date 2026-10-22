// Usage: node supervise.mjs <workDir> [intervalSeconds]   (supervise.sh loads <workDir>/config.env first)
// Runs on the host that owns the Codex sessions, independent of any orchestrator session: every interval it
// runs one recover.mjs pass over the `local` lines of <workDir>/sessions.txt. One supervisor per host: the
// lock at FLEET_SUPERVISOR_LOCK (default ~/.codex/fleet-supervisor.lock) refuses a second one, and while it
// is held a watcher's own recovery pass steps aside.
// Each pass is bounded by PASS_TIMEOUT_SECONDS. After every pass it writes <stateDir>/.fleet-recovery/heartbeat.json
// (time, pid, pass count, last pass duration, last error, RSS), and once an hour it logs a summary line.
// It logs to stdout. When stdout is the file SUPERVISOR_LOG names (default <workDir>/supervisor.log), opened
// for append as the launchd and systemd templates do, it copies the file to <file>.1 and empties it at LOG_MAX_BYTES.
import { copyFileSync, fstatSync, ftruncateSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import {
  acquireLock, connectDaemon, DEFAULT_LOG_MAX_BYTES, heartbeatPath, positiveSetting, readConfig, restartDaemon,
  supervisorLockPath, timedPass, writeHeartbeat,
} from './recover.mjs';
import { isEntryPoint } from './liveness.mjs';
import { resolveWorkDir } from './work-dir.mjs';

export const DEFAULT_INTERVAL_SECONDS = 60;
export const SUMMARY_INTERVAL_MS = 3_600_000;

/** The `local` session specs in sessions.txt, in liveness.mjs form ("<name>" or "<label>=<threadId>"). */
export function localSpecs(workDir) {
  let text = '';
  try { text = readFileSync(`${workDir}/sessions.txt`, 'utf8'); } catch {}
  return text.split('\n').map((line) => line.trim().split(/\s+/)).filter((words) => words[0] === 'local' && words[1])
    .map((words) => (words.length >= 3 ? `${words[1]}=${words[2]}` : words[1]));
}

/**
 * Copies `path` to `<path>.1` and empties it once it reaches `maxBytes`, but only when `fd` is that same
 * file. Emptying in place keeps the descriptor launchd or systemd opened valid; with append mode the next
 * write lands at the new end.
 */
export function rotateIfOwnLog(fd, path, maxBytes) {
  let open;
  let named;
  try {
    open = fstatSync(fd);
    named = statSync(path);
  } catch {
    return false;
  }
  if (!open.isFile() || open.dev !== named.dev || open.ino !== named.ino || open.size < maxBytes) return false;
  copyFileSync(path, `${path}.1`);
  ftruncateSync(fd, 0);
  return true;
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function tick(workDir, stateDir, config) {
  const specs = localSpecs(workDir);
  if (!specs.length) return { lines: [], error: null };
  try {
    const events = await timedPass({ stateDir, specs, config, connect: connectDaemon, restart: restartDaemon });
    if (events === null) return { lines: [], error: 'skipped: the previous pass still holds the pass lock' };
    const timedOut = events.find((line) => line.includes('pass-timeout'));
    return { lines: events, error: timedOut ? oneLine(timedOut.replace(/^EVENT recovery /, '')) : null };
  } catch (error) {
    const message = oneLine(error.message);
    return { lines: [`EVENT recovery pass-failed: ${message}`], error: `pass-failed: ${message}` };
  }
}

async function main() {
  const [workDirArg, intervalArg] = process.argv.slice(2);
  if (!workDirArg) {
    console.error('Usage: supervise.mjs <workDir> [intervalSeconds]');
    process.exit(2);
  }
  const interval = Number(intervalArg ?? process.env.SUPERVISE_INTERVAL_SECONDS ?? DEFAULT_INTERVAL_SECONDS);
  if (!Number.isFinite(interval) || interval <= 0) {
    console.error('supervise: interval must be a positive number of seconds');
    process.exit(2);
  }
  let config;
  let logMaxBytes;
  try {
    config = readConfig();
    logMaxBytes = positiveSetting(process.env, 'LOG_MAX_BYTES', DEFAULT_LOG_MAX_BYTES);
  } catch (error) {
    console.error(`supervise: ${error.message}`);
    process.exit(2);
  }
  const workDir = resolveWorkDir(workDirArg).dir;
  const stateDir = process.env.LOCAL_STATE_DIR || workDir;
  const logPath = process.env.SUPERVISOR_LOG || `${workDir}/supervisor.log`;
  const log = (line) => {
    console.log(`${new Date().toISOString()} ${line}`);
    rotateIfOwnLog(1, logPath, logMaxBytes);
  };
  const path = supervisorLockPath();
  const lock = acquireLock(path);
  if (!lock.acquired) {
    console.error(`supervise: another supervisor (pid ${lock.pid}) holds ${path}`);
    process.exit(3);
  }
  // A clean stop removes the heartbeat, so a stopped supervisor is not reported STALE.
  const release = () => {
    try { unlinkSync(heartbeatPath(stateDir)); } catch {}
    lock.release();
  };
  const stop = () => {
    release();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('exit', () => lock.release());
  log(`supervise: pid ${process.pid} watching ${workDir} every ${interval}s, pass timeout ${config.passTimeoutMs / 1000}s${config.autoRestart ? ' (AUTO_RESTART_DAEMON on)' : ''}`);
  const stats = { passes: 0, hourPasses: 0, hourErrors: 0, hourMaxMs: 0, lastError: null, summaryAt: Date.now() };
  for (;;) {
    const started = Date.now();
    const { lines, error } = await tick(workDir, stateDir, config);
    const lastPassMs = Date.now() - started;
    for (const line of lines) log(line);
    stats.passes += 1;
    stats.hourPasses += 1;
    stats.hourMaxMs = Math.max(stats.hourMaxMs, lastPassMs);
    if (error) {
      stats.hourErrors += 1;
      stats.lastError = error;
    }
    const rssBytes = process.memoryUsage().rss;
    try {
      writeHeartbeat(stateDir, {
        at: new Date().toISOString(), pid: process.pid, intervalSeconds: interval, passes: stats.passes,
        lastPassMs, lastError: error, rssBytes,
      });
    } catch (writeError) {
      log(`supervise: heartbeat write failed: ${oneLine(writeError.message)}`);
    }
    if (Date.now() - stats.summaryAt >= SUMMARY_INTERVAL_MS) {
      log(`supervise: hourly passes=${stats.hourPasses} errors=${stats.hourErrors} maxPassMs=${stats.hourMaxMs} lastPassMs=${lastPassMs} rss=${Math.round(rssBytes / 1048576)}MB lastError=${stats.lastError ?? '-'}`);
      Object.assign(stats, { hourPasses: 0, hourErrors: 0, hourMaxMs: 0, summaryAt: Date.now() });
    }
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
}

if (isEntryPoint(import.meta.url)) await main();
