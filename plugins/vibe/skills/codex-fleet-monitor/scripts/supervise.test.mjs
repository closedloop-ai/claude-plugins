import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SUPERVISE = fileURLToPath(new URL('./supervise.mjs', import.meta.url));

// A fake codex. hang: the proxy never answers the WebSocket upgrade, like a stuck daemon. fail: it exits at once.
const FAKE_CODEX = `#!/bin/sh
case "$*" in
  "app-server proxy"*) if [ "$FAKE_CODEX_MODE" = hang ]; then exec sleep 30; fi; exit 1 ;;
  *) exit 1 ;;
esac
`;

function fixture(mode, env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-supervise-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), FAKE_CODEX);
  chmodSync(join(bin, 'codex'), 0o755);
  writeFileSync(join(root, 'sessions.txt'), 'local w1 T1\n');
  return {
    root,
    env: {
      ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, FAKE_CODEX_MODE: mode,
      LOCAL_STATE_DIR: root, FLEET_SUPERVISOR_LOCK: join(root, 'supervisor.lock'), ...env,
    },
  };
}

async function until(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

test('a pass stuck on a daemon that never answers times out with an EVENT, and the loop goes on', { timeout: 30_000 }, async () => {
  const f = fixture('hang', { PASS_TIMEOUT_SECONDS: '1' });
  const child = spawn(process.execPath, [SUPERVISE, f.root, '0.2'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  try {
    await until(() => (out.match(/EVENT recovery pass-timeout after 1s/g) ?? []).length >= 2, 20_000, 'two pass-timeout events');
    const events = readFileSync(join(f.root, '.fleet-recovery', 'events.log'), 'utf8');
    assert.match(events, /EVENT recovery pass-timeout after 1s/);
    const heartbeat = JSON.parse(readFileSync(join(f.root, '.fleet-recovery', 'heartbeat.json'), 'utf8'));
    assert.equal(heartbeat.pid, child.pid);
    assert.ok(heartbeat.passes >= 1);
    assert.match(heartbeat.lastError, /pass-timeout/);
    assert.ok(heartbeat.lastPassMs >= 1000);
    assert.equal(heartbeat.intervalSeconds, 0.2);
    assert.ok(heartbeat.rssBytes > 0);
    assert.ok(Number.isFinite(Date.parse(heartbeat.at)));
  } finally {
    await stop(child);
  }
  assert.equal(existsSync(join(f.root, '.fleet-recovery', 'heartbeat.json')), false, 'a clean stop removes the heartbeat');
});

test('the supervisor log, opened for append as launchd does, moves to supervisor.log.1 at LOG_MAX_BYTES', { timeout: 30_000 }, async () => {
  const f = fixture('fail', { LOG_MAX_BYTES: '600' });
  const log = join(f.root, 'supervisor.log');
  const fd = openSync(log, 'a');
  const child = spawn(process.execPath, [SUPERVISE, f.root, '0.05'], { env: f.env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  try {
    await until(() => existsSync(`${log}.1`), 20_000, 'supervisor.log.1');
    await until(() => readFileSync(log, 'utf8').includes('pass-failed'), 10_000, 'a line after the rotation');
  } finally {
    await stop(child);
  }
  assert.ok(statSync(log).size < 600, `supervisor.log is ${statSync(log).size} bytes`);
  assert.ok(statSync(`${log}.1`).size >= 600);
  assert.match(readFileSync(`${log}.1`, 'utf8'), /EVENT recovery pass-failed/);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /\0/, 'the emptied file has no hole of zero bytes');
});

test('supervisor repairs a missing pending marker on its bounded discovery pass', { timeout: 20_000 }, async () => {
  const f = fixture('fail');
  const records = join(f.root, '.codex', 'vibe', 'cleanup', 'records');
  mkdirSync(records, { recursive: true });
  writeFileSync(join(records, 'crashed.json'), '{unreadable');
  const child = spawn(process.execPath, [SUPERVISE, f.root, '0.05'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  try {
    await until(() => output.includes('LEFTOVER crashed.json'), 10_000, 'marker-loss discovery');
    assert.equal(existsSync(join(f.root, '.codex', 'vibe', 'cleanup', 'pending')), true);
  } finally { await stop(child); }
});

test('supervisor tick retires an expired scratch helper only after its vibe lease ends', { timeout: 20_000 }, async () => {
  const f = fixture('fail');
  const worktree = join(f.root, 'scratch-worktree');
  mkdirSync(worktree);
  spawnSync('git', ['init', '-q', '-b', 'main', worktree]);
  const gitDir = spawnSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(gitDir, 'vibe-session.json'), JSON.stringify({ createdAt: '2026-11-03T00:00:00Z', status: 'handed-off' }));
  const helper = { scratch: { kind: 'scratch', owner: 'writer', ticket: 'ticket-one', ownerToken: 'token',
    project: 'vibe-scratch-test', worktree, startedAt: '2026-11-03T00:00:00Z',
    expiresAt: '2026-11-03T00:10:00Z', writerLease: { kind: 'vibe', createdAt: '2026-11-03T00:00:00Z' }, pids: [] } };
  writeFileSync(join(f.root, 'helpers.json'), JSON.stringify(helper));
  const cleanup = join(f.root, '.codex', 'vibe', 'cleanup');
  const programs = join(cleanup, 'scratch-programs');
  mkdirSync(programs, { recursive: true });
  writeFileSync(join(programs, createHash('sha256').update(f.root).digest('hex') + '.json'), JSON.stringify({ orchDir: f.root }));
  writeFileSync(join(cleanup, 'pending'), '{}');
  const docker = join(f.root, 'docker');
  writeFileSync(docker, '#!/bin/sh\ncase "$2" in ls) exit 0;; esac\nexit 2\n', { mode: 0o755 });
  const child = spawn(process.execPath, [SUPERVISE, f.root, '0.05'],
    { env: { ...f.env, VIBE_E2E_DOCKER: docker }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await until(() => {
      try { return Boolean(JSON.parse(readFileSync(join(f.root, 'helpers.json'), 'utf8')).scratch.stoppedAt); }
      catch { return false; }
    }, 10_000, 'scheduled scratch retirement');
  } finally { await stop(child); }
});
