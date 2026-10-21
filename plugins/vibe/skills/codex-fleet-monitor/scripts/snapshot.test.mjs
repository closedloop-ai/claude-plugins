import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  const env = { ...process.env, FAKE_ROOT: root, PATH: `${bin}:${process.env.PATH}` };
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
  assert.match(good, /^pr acme\/app#42 OPEN abcdef12 APPROVED MERGEABLE comments=2 reviews=1 inline=3 checks=/m);
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
