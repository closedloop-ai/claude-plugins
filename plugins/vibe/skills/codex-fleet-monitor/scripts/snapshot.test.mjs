import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  "pr list"*--author*) cat "$FAKE_ROOT/mine" 2>/dev/null ;;
  "pr list"*) printf '5\\n7\\n' ;;
  "pr view"*isDraft*) cat "$FAKE_ROOT/push-$3" 2>/dev/null || cat "$FAKE_ROOT/push" 2>/dev/null || echo "false $(date -u +%Y-%m-%dT%H:%M:%SZ)" ;;
  "pr view"*) cat "$FAKE_ROOT/view-$3" 2>/dev/null || cat "$FAKE_ROOT/view" 2>/dev/null || echo "OPEN abcdef12 APPROVED MERGEABLE" ;;
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
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat "${root}/claude-usage" 2>/dev/null || exit 1\n`);
  for (const name of ['gh', 'codex', 'claude']) chmodSync(join(bin, name), 0o755);
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
  // PR 8 is neither in prs.txt nor open in a watched repo (the fake lists 5 and 7, which are now watched).
  const gone = ['keep-st-acme_app-8.txt', 'keep-c-acme_app-8.txt', 'keep-ck-acme_app-8.txt', 'merge-acme_app-8.txt', 'checks-acme_app-8.txt', 'keep-st-other_repo-42.txt'];
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

test('an open PR needing its writer with no push for 45 minutes is STALE-PR, however busy the writer looks (#9123)', TIMEOUT, () => {
  const f = fixture();
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(join(f.root, 'threads'), '5\n');
  writeFileSync(join(f.root, 'push'), `false ${ago(46)}\n`);
  assert.match(f.run('ok'), /^pr acme\/app#42 .* threads=5 .*BLOCKED\(unresolved threads\) STALE-PR\(no push for 2700s\+\)$/m);
  writeFileSync(join(f.root, 'push'), `false ${ago(30)}\n`);
  assert.doesNotMatch(f.run('ok'), /STALE-PR/, 'a push within 45 minutes is fresh');
  writeFileSync(join(f.root, 'threads'), '0\n');
  writeFileSync(join(f.root, 'push'), `false ${ago(300)}\n`);
  assert.doesNotMatch(f.run('ok'), /STALE-PR/, 'an old PR with nothing for its writer to do is not stale');
  writeFileSync(join(f.root, 'push'), `true ${ago(60)}\n`);
  assert.match(f.run('ok'), /STALE-PR/, 'a draft needs its writer');
  writeFileSync(join(f.root, 'push'), `false ${ago(60)}\n`);
  writeFileSync(join(f.root, 'view'), 'OPEN abcdef12 APPROVED CONFLICTING\n');
  assert.match(f.run('ok'), /STALE-PR/, 'a conflict needs its writer');
});

test('the Claude usage line reads claude -p /usage on the Codex bands, at most once per CLAUDE_USAGE_SECONDS', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.root, 'claude-usage'), 'Current session: 51% used \u00b7 resets Oct 22 at 12:39pm (America/Chicago)\nCurrent week (all models): 69% used \u00b7 resets Oct 27 at 9am (America/Chicago)\n');
  assert.match(f.run('ok'), /^claude-usage local session=under80% week=under80%$/m);
  writeFileSync(join(f.root, 'claude-usage'), 'Current session: 91% used \u00b7 resets Oct 22 at 12:39pm (America/Chicago)\nCurrent week (all models): 69% used\n');
  assert.match(f.run('ok'), /^claude-usage local session=under80%/m, 'the cached line holds within the interval');
});

test('the watch set adds open PRs on any branch prefix and drops a merged PR after reporting it once (silent writer on fix/ PRs)', TIMEOUT, () => {
  const f = fixture();
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(join(f.work, 'prs.txt'), 'acme/app 42\nacme/app 9116 writer-9098\n');
  writeFileSync(join(f.root, 'view-42'), 'MERGED abcdef12 APPROVED UNKNOWN\n');
  writeFileSync(join(f.root, 'view-9116'), 'OPEN abcdef12 REVIEW_REQUIRED CONFLICTING\n');
  writeFileSync(join(f.root, 'mine'), '9149\n');
  writeFileSync(join(f.root, 'threads'), '1\n');
  writeFileSync(join(f.root, 'push-9149'), `false ${ago(100)}\n`);
  writeFileSync(join(f.root, 'push-9116'), `false ${ago(100)}\n`);
  const first = f.run('ok');
  assert.match(first, /^pr acme\/app#9149 OPEN .*STALE-PR\(no push for 2700s\+\)$/m, 'a fix/ PR nobody listed is watched and stale');
  assert.match(first, /^pr acme\/app#9116 .*STALE-PR\(no push for 2700s\+ owner=writer-9098\)$/m, 'the stale line names its writer');
  assert.match(first, /^pr acme\/app#42 MERGED /m, 'a merged PR is reported once');
  const watched = readFileSync(join(f.work, 'prs.txt'), 'utf8');
  assert.doesNotMatch(watched, /^acme\/app 42$/m);
  assert.match(watched, /^acme\/app 9149$/m);
  assert.match(watched, /^acme\/app 9116 writer-9098$/m);
  assert.doesNotMatch(f.run('ok'), /#42 /, 'and then it leaves the watch set');
});
