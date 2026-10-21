// Usage: node supervise.mjs <workDir> [intervalSeconds]   (supervise.sh loads <workDir>/config.env first)
// Runs on the host that owns the Codex sessions, independent of any orchestrator session: every interval it
// runs one recover.mjs pass over the `local` lines of <workDir>/sessions.txt. One supervisor per host: the
// lock at FLEET_SUPERVISOR_LOCK (default ~/.codex/fleet-supervisor.lock) refuses a second one, and while it
// is held a watcher's own recovery pass steps aside.
import { readFileSync } from 'node:fs';
import {
  acquireLock, connectDaemon, lockedPass, readConfig, restartDaemon, supervisorLockPath,
} from './recover.mjs';
import { isEntryPoint } from './liveness.mjs';

export const DEFAULT_INTERVAL_SECONDS = 60;

/** The `local` session specs in sessions.txt, in liveness.mjs form ("<name>" or "<label>=<threadId>"). */
export function localSpecs(workDir) {
  let text = '';
  try { text = readFileSync(`${workDir}/sessions.txt`, 'utf8'); } catch {}
  return text.split('\n').map((line) => line.trim().split(/\s+/)).filter((words) => words[0] === 'local' && words[1])
    .map((words) => (words.length >= 3 ? `${words[1]}=${words[2]}` : words[1]));
}

async function tick(workDir, stateDir, config) {
  const specs = localSpecs(workDir);
  if (!specs.length) return;
  try {
    const events = await lockedPass({ stateDir, specs, config, connect: connectDaemon, restart: restartDaemon });
    for (const line of events ?? []) console.log(`${new Date().toISOString()} ${line}`);
  } catch (error) {
    console.log(`${new Date().toISOString()} EVENT recovery pass-failed: ${String(error.message).replace(/\s+/g, ' ')}`);
  }
}

async function main() {
  const [workDir, intervalArg] = process.argv.slice(2);
  if (!workDir) {
    console.error('Usage: supervise.mjs <workDir> [intervalSeconds]');
    process.exit(2);
  }
  const interval = Number(intervalArg ?? process.env.SUPERVISE_INTERVAL_SECONDS ?? DEFAULT_INTERVAL_SECONDS);
  if (!Number.isFinite(interval) || interval <= 0) {
    console.error('supervise: interval must be a positive number of seconds');
    process.exit(2);
  }
  let config;
  try {
    config = readConfig();
  } catch (error) {
    console.error(`supervise: ${error.message}`);
    process.exit(2);
  }
  const stateDir = process.env.LOCAL_STATE_DIR || workDir;
  const path = supervisorLockPath();
  const lock = acquireLock(path);
  if (!lock.acquired) {
    console.error(`supervise: another supervisor (pid ${lock.pid}) holds ${path}`);
    process.exit(3);
  }
  const stop = () => {
    lock.release();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('exit', () => lock.release());
  console.log(`${new Date().toISOString()} supervise: pid ${process.pid} watching ${workDir} every ${interval}s${config.autoRestart ? ' (AUTO_RESTART_DAEMON on)' : ''}`);
  for (;;) {
    await tick(workDir, stateDir, config);
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
}

if (isEntryPoint(import.meta.url)) await main();
