#!/usr/bin/env node
// Owns one slot command in a detached process group and drains that complete group before exiting.
// run-bounded.mjs owns the same TERM/grace/KILL policy, but its required wall-clock limit and heavy-budget
// semantics cannot safely wrap arbitrary slot commands. This helper is deliberately limited to lifecycle.

import { spawn } from 'node:child_process';
import os from 'node:os';

const GRACE_MS = 2_000;
const POLL_MS = 25;
const [command, ...args] = process.argv.slice(2);

if (!command) {
  process.stderr.write('slot-lock-child: command required\n');
  process.exit(2);
}

let child;
let group;
let directResult;
let directClosedResolve;
const directClosed = new Promise((resolve) => { directClosedResolve = resolve; });
let spawnReadyResolve;
const spawnReady = new Promise((resolve) => { spawnReadyResolve = resolve; });
let cleanup;

function groupAlive() {
  if (!(group > 1) || group === process.pid) return false;
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    // Only ESRCH establishes absence. Any other result keeps capacity reserved fail-closed.
    return error?.code !== 'ESRCH';
  }
}

function signalGroup(signal) {
  if (!(group > 1) || group === process.pid) return;
  try {
    process.kill(-group, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH' && error?.code !== 'EPERM') throw error;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForGroup(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (groupAlive() && Date.now() < deadline) await delay(POLL_MS);
  return !groupAlive();
}

function resultCode(code, signal) {
  if (code !== null) return code;
  return 128 + (os.constants.signals[signal] ?? 0);
}

async function drain(exitCode) {
  if (cleanup) return cleanup;
  cleanup = (async () => {
    await spawnReady;
    signalGroup('SIGTERM');
    if (!await waitForGroup(GRACE_MS)) {
      signalGroup('SIGKILL');
      while (groupAlive()) await delay(POLL_MS);
    }
    await directClosed;
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    process.off('SIGHUP', onHup);
    process.exit(exitCode ?? directResult ?? 1);
  })();
  return cleanup;
}

function onTerm() { void drain(143); }
function onInt() { void drain(130); }
function onHup() { void drain(129); }

// Register persistent ownership before the detached group can exist. Node dispatches JS signal callbacks
// only after this synchronous spawn/listener setup yields, so an immediately pending signal enters drain().
process.on('SIGTERM', onTerm);
process.on('SIGINT', onInt);
process.on('SIGHUP', onHup);

try {
  child = spawn(command, args, { detached: true, stdio: 'inherit' });
  group = child.pid;
  child.once('error', (error) => {
    process.stderr.write(`slot-lock-child: ${error.message}\n`);
    directClosedResolve();
    void drain(127);
  });
  child.once('close', (code, signal) => {
    directResult = resultCode(code, signal);
    directClosedResolve();
    void drain(directResult);
  });
  spawnReadyResolve();
} catch (error) {
  process.stderr.write(`slot-lock-child: ${error.message}\n`);
  directClosedResolve();
  spawnReadyResolve();
  void drain(127);
}
