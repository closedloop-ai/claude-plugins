import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SNAPSHOT = fileURLToPath(new URL('./snapshot.sh', import.meta.url));
const TIMEOUT = { timeout: 60_000 };

// A fake gh: answers each call snapshot.sh makes while <root>/gh-mode says ok, prints nothing and fails otherwise.
const FAKE_GH = `#!/bin/sh
[ "$(cat "$FAKE_ROOT/gh-mode")" = ok ] || exit 1
case "$*" in
  "api user"*) echo me ;;
  "api graphql"*) cat "$FAKE_ROOT/threads" 2>/dev/null || echo 0 ;;
  "pr list"*) printf '5\\n7\\n' ;;
  "pr view"*) echo "OPEN abcdef12 APPROVED MERGEABLE" ;;
  "pr checks"*) printf 'build\\tpass\\t1m\\nlint\\tpass\\t1m\\n' ;;
  *"/issues/"*) echo 2 ;;
  *"/reviews"*) echo 1 ;;
  *"/comments"*) echo 3 ;;
  *) exit 1 ;;
esac
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-snapshot-'));
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  // No App Server here: codex fails, so the usage line reads READFAIL on every run.
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 1\n');
  for (const name of ['gh', 'codex']) chmodSync(join(bin, name), 0o755);
  writeFileSync(join(work, 'config.env'), 'WATCH_NEW_PR_REPOS="acme/app"\n');
  writeFileSync(join(work, 'prs.txt'), 'acme/app 42\n');
  const env = { ...process.env, FAKE_ROOT: root, PATH: `${bin}:${process.env.PATH}`, FLEET_SUPERVISOR_LOCK: join(root, 'supervisor.lock') };
  const run = (mode) => {
    writeFileSync(join(root, 'gh-mode'), mode);
    const result = spawnSync('zsh', [SNAPSHOT, work], { env, encoding: 'utf8', timeout: 50_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return { root, work, run };
}

test('a blank gh read keeps the last value for each key, so it is not an event', TIMEOUT, () => {
  const f = fixture();
  const good = f.run('ok');
  assert.match(good, /^open-prs acme\/app 5 7 $/m);
  assert.match(good, /^pr acme\/app#42 OPEN abcdef12 APPROVED MERGEABLE comments=2 reviews=1 inline=3 threads=0 checks=/m);
  assert.equal(f.run('fail'), good);
  assert.equal(f.run('ok'), good);
});

test('the recovery events log is a snapshot line, so a recovery action wakes the watcher', TIMEOUT, () => {
  const f = fixture();
  const state = join(f.root, 'state');
  mkdirSync(join(state, '.fleet-recovery'), { recursive: true });
  writeFileSync(join(f.work, 'config.env'), `LOCAL_STATE_DIR=${state}\n`);
  writeFileSync(join(f.work, 'sessions.txt'), 'local w1 T1\n');
  writeFileSync(join(f.work, 'prs.txt'), '');
  assert.match(f.run('ok'), /^recovery local 0 -$/m);
  writeFileSync(join(state, '.fleet-recovery', 'events.log'), '2026-01-01T00:00:00.000Z EVENT recovery w1 resumed attempt=1/3 turn=t2\n');
  assert.match(f.run('ok'), /^recovery local 1 recovery w1 resumed attempt=1\/3 turn=t2$/m);
});

/** A work dir with one local session and no PRs; its heartbeat file and supervisor lock are the fixture's to write. */
function supervised() {
  const f = fixture();
  const state = join(f.root, 'state');
  mkdirSync(join(state, '.fleet-recovery'), { recursive: true });
  writeFileSync(join(f.work, 'config.env'), `LOCAL_STATE_DIR=${state}\n`);
  writeFileSync(join(f.work, 'sessions.txt'), 'local w1 T1\n');
  writeFileSync(join(f.work, 'prs.txt'), '');
  const heartbeat = (ageSeconds, rssMb = 50) => writeFileSync(join(state, '.fleet-recovery', 'heartbeat.json'), JSON.stringify({
    at: new Date(Date.now() - ageSeconds * 1000).toISOString(), pid: 1, intervalSeconds: 60, passes: 3, lastPassMs: 40, lastError: null, rssBytes: rssMb * 1024 * 1024,
  }));
  return { ...f, heartbeat, lock: () => writeFileSync(join(f.root, 'supervisor.lock'), `${process.pid}\n`) };
}

test('the supervisor heartbeat is a snapshot line: ok, STALE past 3 intervals, RSS-HIGH over the cap', TIMEOUT, () => {
  const f = supervised();
  assert.doesNotMatch(f.run('ok'), /^supervisor /m, 'no supervisor, no line');
  f.heartbeat(30);
  assert.match(f.run('ok'), /^supervisor local ok$/m);
  f.heartbeat(181);
  assert.match(f.run('ok'), /^supervisor local STALE\(>180s\)$/m);
  f.heartbeat(30, 400);
  assert.match(f.run('ok'), /^supervisor local RSS-HIGH\(>300MB\)$/m);
  f.heartbeat(500, 400);
  assert.match(f.run('ok'), /^supervisor local STALE\(>180s\),RSS-HIGH\(>300MB\)$/m);
});

test('a supervisor lock with no heartbeat is MISSING', TIMEOUT, () => {
  const f = supervised();
  f.lock();
  assert.match(f.run('ok'), /^supervisor local MISSING$/m);
});

test('state files of a PR that left prs.txt are removed; those of a watched PR stay', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.work, 'prs.txt'), 'acme/app 42\n');
  f.run('ok');
  const gone = ['keep-st-acme_app-7.txt', 'keep-c-acme_app-7.txt', 'keep-ck-acme_app-7.txt', 'merge-acme_app-7.txt', 'checks-acme_app-7.txt', 'keep-st-other_repo-42.txt'];
  for (const name of gone) writeFileSync(join(f.work, name), 'x\n');
  f.run('ok');
  for (const name of gone) assert.equal(existsSync(join(f.work, name)), false, `${name} is pruned`);
  for (const name of ['keep-st-acme_app-42.txt', 'keep-ck-acme_app-42.txt', 'merge-acme_app-42.txt', 'checks-acme_app-42.txt', 'keep-open-acme_app.txt']) {
    assert.equal(existsSync(join(f.work, name)), true, `${name} stays`);
  }
});

test('an approved PR with unresolved review threads is BLOCKED, apart from its reviews and checks', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.root, 'threads'), '2\n');
  const blocked = f.run('ok');
  assert.match(blocked, /^pr acme\/app#42 OPEN abcdef12 APPROVED MERGEABLE comments=2 reviews=1 inline=3 threads=2 checks=.*pass.* BLOCKED\(unresolved threads\)$/m);
  assert.equal(f.run('fail'), blocked, 'a failed read keeps the block');
  writeFileSync(join(f.root, 'threads'), '0\n');
  const clear = f.run('ok');
  assert.match(clear, /^pr acme\/app#42 .* threads=0 checks=/m);
  assert.doesNotMatch(clear, /BLOCKED/);
});
