import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { watcherState } from './watcher.mjs';

const WATCH = fileURLToPath(new URL('./watch.sh', import.meta.url));
const WATCHER = fileURLToPath(new URL('./watcher.mjs', import.meta.url));
const NOW = Date.parse('2026-10-21T12:00:00Z');

function workDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-watcher-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const write = (dir, state) => writeFileSync(join(dir, 'watcher.json'), JSON.stringify(state));
const at = (seconds) => new Date(NOW - seconds * 1000).toISOString();

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

test('a live watcher that ticked recently is ok', (t) => {
  const dir = workDir(t);
  write(dir, { pid: process.pid, startedAt: at(600), lastTickAt: at(100), intervalSeconds: 120 });
  assert.deepEqual(watcherState(dir, NOW), { ok: true, line: `watcher ok pid=${process.pid} tick=100s ago` });
});

test('each lapse is MISSING with its reason', (t) => {
  const dir = workDir(t);
  assert.deepEqual(watcherState(dir, NOW), { ok: false, line: 'watcher MISSING(no watcher.json)' });
  write(dir, { pid: process.pid, startedAt: at(9000), lastTickAt: at(7300), intervalSeconds: 120, exitedAt: at(7200) });
  assert.equal(watcherState(dir, NOW).line, 'watcher MISSING(exited 120m ago)');
  const dead = deadPid();
  write(dir, { pid: dead, startedAt: at(600), lastTickAt: at(10), intervalSeconds: 120 });
  assert.equal(watcherState(dir, NOW).line, `watcher MISSING(pid ${dead} dead)`);
  write(dir, { pid: process.pid, startedAt: at(900), lastTickAt: at(361), intervalSeconds: 120 });
  assert.equal(watcherState(dir, NOW).line, 'watcher MISSING(no tick for 361s)');
  write(dir, { pid: process.pid, startedAt: at(900), lastTickAt: at(360), intervalSeconds: 120 });
  assert.equal(watcherState(dir, NOW).ok, true, 'twice the interval plus 120 seconds is still live');
});

test('the command prints the line and exits 1 for a missing watcher', (t) => {
  const dir = workDir(t);
  const missing = spawnSync(process.execPath, [WATCHER, dir], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, 'watcher MISSING(no watcher.json)\n');
  write(dir, { pid: process.pid, startedAt: at(60), lastTickAt: at(30), intervalSeconds: 120 });
  const live = spawnSync(process.execPath, [WATCHER, dir, '--now', new Date(NOW).toISOString()], { encoding: 'utf8' });
  assert.equal(live.status, 0);
});

test('watch.sh records its pid at start, and a killed watcher reads as dead', { timeout: 30_000 }, async (t) => {
  const dir = workDir(t);
  writeFileSync(join(dir, 'last-snapshot.txt'), 'session local a RUN\n');
  // Its own process group, so killing it also ends the `sleep` it is waiting in.
  const child = spawn('zsh', [WATCH, dir, '600'], { stdio: 'ignore', detached: true });
  const killGroup = () => {
    if (!(child.pid > 1)) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  };
  t.after(killGroup);
  const file = join(dir, 'watcher.json');
  for (let i = 0; i < 100 && !existsSync(file); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(state.pid, child.pid);
  assert.equal(state.intervalSeconds, 600);
  assert.equal(watcherState(dir).ok, true);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  killGroup();
  await exited;
  assert.equal(watcherState(dir).line, `watcher MISSING(pid ${child.pid} dead)`);
});
