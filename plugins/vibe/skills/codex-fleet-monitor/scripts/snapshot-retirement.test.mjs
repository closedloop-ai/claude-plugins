import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { snapshotFixture } from './snapshot-test-fixture.mjs';

const TIMEOUT = { timeout: 60_000 };

function fixture(options) {
  return snapshotFixture({ ...options, inspect(result) {
    assert.equal(result.status, 0, result.stderr);
  } });
}


test('ISS-14476 snapshot excludes retired writer state and exact PR before scheduling watcher events', TIMEOUT, () => {
  const f = fixture({ fleetHome: true });
  writeFileSync(join(f.work, 'board.json'), JSON.stringify({ writers: {
    done: { pr: '42', repo: 'acme/app', retiredAt: '2026-11-20T00:10:00Z', retiredReason: 'verified merge' },
  } }));
  writeFileSync(join(f.work, 'sessions.txt'), 'local done RETIRED\n');
  writeFileSync(join(f.work, 'prs.txt'), 'acme/app 42 done\nacme/app 43 other\n');
  writeFileSync(join(f.work, 'config.env'), 'CLAUDE_USAGE=0\n');
  const snapshot = f.run('ok');
  assert.doesNotMatch(snapshot, /acme\/app#42|^local done |board .* done/m);
  assert.match(snapshot, /^pr acme\/app#43 OPEN/m);
});

test('ISS-14476 the watcher does not wake merely because previously tracked rows retired', TIMEOUT, () => {
  const f = fixture({ fleetHome: true });
  const fake = join(f.root, 'next-snapshot.sh');
  writeFileSync(fake, 'printf "%s\\n" "pr acme/app#43 OPEN"\n', { mode: 0o700 });
  writeFileSync(join(f.work, 'board.json'), JSON.stringify({ writers: {
    done: { pr: '42', repo: 'acme/app', retiredAt: '2026-11-20T00:10:00Z', retiredReason: 'verified merge' },
  } }));
  const prior = 'session local done active\nboard PUSH-READY-UNKNOWN done\npr acme/app#42 MERGED\npr acme/app#43 OPEN\n';
  writeFileSync(join(f.work, 'last-snapshot.txt'), prior);
  const watch = fileURLToPath(new URL('./watch.sh', import.meta.url));
  const result = spawnSync('zsh', [watch, f.work, '1'], {
    env: { ...process.env, WATCH_SNAPSHOT: fake, HEARTBEAT_SECONDS: '1' }, encoding: 'utf8', timeout: 8_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^HEARTBEAT/);
  assert.doesNotMatch(result.stdout, /^EVENT/m);
  assert.equal(readFileSync(join(f.work, 'last-snapshot.txt'), 'utf8'), 'pr acme/app#43 OPEN\n');
});
