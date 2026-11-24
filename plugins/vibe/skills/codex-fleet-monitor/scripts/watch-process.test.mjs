// watch.sh as a process: its pid record, single-copy lock, heartbeat exit, event wake and owned TERM exit.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { watcherState } from './watcher.mjs';
import { workDir } from './test-support.mjs';

const WATCH = fileURLToPath(new URL('./watch.sh', import.meta.url));

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

test('a second watch.sh on the same work dir is refused while the first runs, and starts once it is gone', { timeout: 30_000 }, async (t) => {
  const dir = workDir(t);
  writeFileSync(join(dir, 'last-snapshot.txt'), 'session local a RUN\n');
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
  for (let i = 0; i < 100 && !existsSync(join(dir, 'watcher.json')); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  // Detached too, so if it is not refused, killing its group also ends the sleep it would wait in.
  const second = spawn('zsh', [WATCH, dir, '600'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  t.after(() => {
    if (second.pid > 1) {
      try {
        process.kill(-second.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });
  let stderr = '';
  second.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await Promise.race([
    new Promise((resolve) => second.on('exit', resolve)),
    new Promise((resolve) => setTimeout(() => resolve('still running'), 5_000)),
  ]);
  assert.equal(status, 3);
  assert.match(stderr, new RegExp(`watcher pid ${child.pid} already runs`));
  assert.match(stderr, new RegExp(`kill-guard\\.mjs own ${child.pid}' and 'kill ${child.pid}' as two steps`));
  assert.match(stderr, /run_in_background\), never with &/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'watcher.json'), 'utf8')).pid, child.pid, 'the refused copy leaves the live watcher record alone');
  const exited = new Promise((resolve) => child.on('exit', resolve));
  killGroup();
  await exited;
  // SIGKILL skips the EXIT trap, so the lock is left behind with a dead pid; the next start takes it over.
  const third = spawn('zsh', [WATCH, dir, '600'], { stdio: 'ignore', detached: true });
  t.after(() => {
    if (third.pid > 1) {
      try {
        process.kill(-third.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });
  let state = null;
  for (let i = 0; i < 100 && state?.pid !== third.pid; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { state = JSON.parse(readFileSync(join(dir, 'watcher.json'), 'utf8')); } catch { state = null; }
  }
  assert.equal(state?.pid, third.pid);
});

test('an armed watcher with no change exits with HEARTBEAT after HEARTBEAT_SECONDS (7 quiet hours overnight)', { timeout: 30_000 }, (t) => {
  const dir = workDir(t);
  const snapshot = join(dir, 'fake-snapshot.sh');
  writeFileSync(snapshot, 'print "session local a RUN"\n');
  writeFileSync(join(dir, 'config.env'), 'HEARTBEAT_SECONDS=2\n');
  const run = spawnSync('zsh', [WATCH, dir, '1'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, WATCH_SNAPSHOT: snapshot } });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /^HEARTBEAT no change for 2s: read every teammate message/m);
  assert.ok(JSON.parse(readFileSync(join(dir, 'watcher.json'), 'utf8')).exitedAt, 'the heartbeat exit is recorded, so watcher.mjs says to re-arm');
});

test('new usage read times do not emit an event when the usage band is unchanged', { timeout: 30_000 }, (t) => {
  const dir = workDir(t);
  const snapshot = join(dir, 'fake-usage-snapshot.sh');
  writeFileSync(snapshot, 'print "codex-usage local under80% ok resets=0 read=$(date -u +%Y-%m-%dT%H:%M:%SZ) source=snapshot"\n');
  writeFileSync(join(dir, 'config.env'), 'HEARTBEAT_SECONDS=2\n');
  const run = spawnSync('zsh', [WATCH, dir, '1'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, WATCH_SNAPSHOT: snapshot } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^HEARTBEAT no change for 2s:/m);
  assert.doesNotMatch(run.stdout, /^EVENT$/m);
  assert.match(readFileSync(join(dir, 'last-snapshot.txt'), 'utf8'), /read=\d{4}-\d{2}-\d{2}T/);
});

test('a watcher without SendMessage surfaces a new event file', { timeout: 30_000 }, async (t) => {
  const dir = workDir(t);
  const snapshot = join(dir, 'fake-snapshot.sh');
  writeFileSync(snapshot, 'print "session local a RUN"\n');
  const child = spawn('zsh', [WATCH, dir, '1'], {
    env: { ...process.env, WATCH_SNAPSHOT: snapshot }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  for (let i = 0; i < 100 && !existsSync(join(dir, 'last-snapshot.txt')); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  mkdirSync(join(dir, 'events'), { recursive: true });
  writeFileSync(join(dir, 'events', 'green-moved.md'), '# Green moved\n');
  const status = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(status, 0);
  assert.match(stdout, /^EVENT$/m);
  assert.match(stdout, /green-moved\.md/);
});

test("AC-089 review watcher TERM records the owned generation exit", async t => {
  const dir = workDir(t);
  writeFileSync(join(dir, "last-snapshot.txt"), "fixture\n");
  const snapshot = join(dir, "fixture.sh");
  writeFileSync(snapshot, "echo fixture\n");
  const child = spawn("zsh", [WATCH, dir, "1"], {stdio:"ignore", env:{...process.env, WATCH_SNAPSHOT:snapshot}});
  const finished = new Promise(resolve => child.once("close",resolve));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  const file = join(dir,"watcher.json");
  for (let i=0; i<100 && !existsSync(file); i++) await new Promise(resolve => setTimeout(resolve,50));
  assert.equal(JSON.parse(readFileSync(file,"utf8")).pid,child.pid);
  child.kill("SIGTERM");
  await finished;
  const record = JSON.parse(readFileSync(file,"utf8"));
  assert.equal(record.pid,child.pid);
  assert.ok(Number.isFinite(Date.parse(record.exitedAt)));
  assert.equal(existsSync(join(dir,"watch.lock")),false);
});
