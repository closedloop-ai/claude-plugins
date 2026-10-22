import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MONITOR = path.join(HERE, '..', '..', 'codex-fleet-monitor', 'scripts');
const run = (args, env = {}) => spawnSync(process.execPath, [path.join(HERE, 'fleet-home.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const tempRoot = (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fleet-home-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('a new program reads none of an earlier program; resume names the active one and its Claude writers to relaunch', (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  assert.match(run(['resume', '--home', home]).stdout, /^NO-ACTIVE-PROGRAM/m);
  assert.equal(run(['start', 'iss-1', '--home', home]).status, 0);
  const first = path.join(home, 'programs', 'iss-1');
  writeFileSync(path.join(first, 'resume-log.md'), '## old program\n');
  writeFileSync(path.join(first, 'board.json'), JSON.stringify({ writers: { 'green-keeper': { runtime: 'claude' }, w1: { runtime: 'codex' } } }));
  writeFileSync(path.join(first, 'prompts', 'green-keeper-01-start.md'), 'start\n');
  writeFileSync(path.join(first, 'prompts', 'green-keeper-02-resume.md'), 'resume\n');
  writeFileSync(path.join(home, 'lessons.md'), 'ledger\n');
  const resumed = run(['resume'], { FLEET_HOME: home }).stdout;
  assert.match(resumed, new RegExp(`^READ ${path.join(home, 'lessons.md')}$`, 'm'), 'the reusable layer is read by every program');
  assert.match(resumed, new RegExp(`^ACTIVE iss-1 ${first}$`, 'm'));
  assert.match(resumed, new RegExp(`^RELAUNCH green-keeper ${path.join(first, 'prompts', 'green-keeper-02-resume.md')}$`, 'm'));
  assert.doesNotMatch(resumed, /RELAUNCH w1/, 'Codex writers resume through fleet.sh, not a relaunch');

  const refused = run(['start', 'iss-2', '--home', home]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^ACTIVE iss-1: close it/m);
  assert.equal(run(['close', '--home', home]).status, 0);
  assert.equal(run(['start', 'iss-2', '--home', home]).status, 0);
  const second = run(['resume', '--home', home]).stdout;
  assert.match(second, /^ACTIVE iss-2 /m);
  assert.doesNotMatch(second, /iss-1/, 'the new program is shown nothing of the earlier one');
  assert.equal(readFileSync(path.join(home, 'programs', 'iss-2', 'resume-log.md'), 'utf8'), '');
});

test('check reports state written outside the home or the program, and passes once it is inside', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  run(['start', 'iss-1', '--home', home]);
  const program = path.join(home, 'programs', 'iss-1');
  assert.equal(run(['check', '--home', home]).status, 0);
  writeFileSync(path.join(root, 'resume-log.md'), 'outside\n');
  symlinkSync(path.join(root, 'resume-log.md'), path.join(program, 'resume-log-old.md'));
  writeFileSync(path.join(home, 'prs.txt'), '');
  writeFileSync(path.join(home, 'config.env'), `LOCAL_STATE_DIR=${root}/state\nREMOTE_STATE_DIR=/srv/vibe-remote\n`);
  writeFileSync(path.join(program, 'sessions.txt'), 'remote prd723-vibe\nlocal w1\nlocal audit tid-1\n');
  writeFileSync(path.join(program, 'w9-local.json'), JSON.stringify({ threadId: 't9', cwd: '/x' }));
  const out = run(['check', '--home', home]);
  assert.equal(out.status, 1);
  const lines = out.stdout.split('\n').filter(Boolean).map((line) => line.split(':')[0]);
  assert.deepEqual(lines.sort(), [
    'CONFIG LOCAL_STATE_DIR',
    `OUTSIDE programs/iss-1/resume-log-old.md -> ${path.join(root, 'resume-log.md')}`,
    'FLAT prs.txt',
    'SHARED-REMOTE REMOTE_STATE_DIR is shared by every program',
    'UNMANAGED local audit',
    'UNMANAGED local w1',
    'UNMANAGED remote prd723-vibe',
    `UNMANAGED-STATE ${path.join(program, 'w9-local.json')}`,
  ].sort());
  rmSync(path.join(program, 'resume-log-old.md'));
  rmSync(path.join(home, 'prs.txt'));
  rmSync(path.join(program, 'w9-local.json'));
  writeFileSync(path.join(home, 'config.env'), 'REMOTE_FLEET_HOME=/srv/fleet\n');
  writeFileSync(path.join(program, 'sessions.txt'), 'remote prd723-vibe\nlocal w1\n');
  writeFileSync(path.join(program, 'sessions', 'prd723-vibe.remote.json'), '{}\n');
  writeFileSync(path.join(program, 'sessions', 'w1.json'), JSON.stringify({ threadId: 't1' }));
  assert.equal(run(['check', '--home', home]).status, 0, run(['check', '--home', home]).stdout);
});

test('every script resolves the home to the active program, with per-program state dirs derived', (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  run(['start', 'iss-1', '--home', home]);
  writeFileSync(path.join(home, 'config.env'), 'CODEX_MODEL=m1\nREMOTE_FLEET_HOME=/srv/fleet\n');
  writeFileSync(path.join(home, 'programs', 'iss-1', 'config.env'), 'CODEX_MODEL=m2\n');
  const shell = (dir) => spawnSync('bash', ['-c', `lines=$(node ${JSON.stringify(path.join(MONITOR, 'work-dir.mjs'))} sh "$1") || exit 2; eval "$lines"; echo "$W|$CODEX_MODEL|$LOCAL_STATE_DIR|$REMOTE_STATE_DIR"`, 'x', dir], { encoding: 'utf8' });
  const program = path.join(home, 'programs', 'iss-1');
  const expected = `${program}|m2|${program}/sessions|/srv/fleet/programs/iss-1/sessions\n`;
  assert.equal(shell(home).stdout, expected);
  assert.equal(shell(program).stdout, expected);
  run(['close', '--home', home]);
  assert.equal(shell(home).status, 2, 'a home with no active program runs nothing');
});

test('fleet.sh in a home keeps local sessions and remote session markers in the program dir', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  run(['start', 'iss-1', '--home', home]);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'node'), `#!/usr/bin/env bash\ncase "$1" in *work-dir.mjs) exec ${JSON.stringify(process.execPath)} "$@";; esac\nprintf "arg:%s\\n" "$@"\n`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'ssh'), '#!/usr/bin/env bash\nexec bash -c "${@: -1}"\n', { mode: 0o755 });
  writeFileSync(path.join(home, 'config.env'), `REMOTE_HOST=box\nREMOTE_FLEET_HOME=${root}/remote\nREMOTE_SHELL="bash -c"\nCODEX_MODEL=m\nCODEX_EFFORT=high\n`);
  const prompt = path.join(home, 'programs', 'iss-1', 'prompts', 'w1-01.md');
  writeFileSync(prompt, '$vibe ISS-1\n');
  const fleet = (...args) => spawnSync('bash', [path.join(HERE, 'fleet.sh'), home, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const local = fleet('local', 'session', 'turn', 'w1', '--prompt-file', prompt);
  assert.match(local.stdout, new RegExp(`^arg:${path.join(home, 'programs', 'iss-1', 'sessions')}$`, 'm'));
  const remote = fleet('remote', 'session', 'turn', 'w2', '--prompt-file', prompt);
  assert.equal(remote.status, 0, remote.stderr);
  assert.match(remote.stdout, new RegExp(`^arg:${root}/remote/programs/iss-1/sessions$`, 'm'));
  assert.ok(existsSync(path.join(home, 'programs', 'iss-1', 'sessions', 'w2.remote.json')));
});

test('migrate turns a flat work dir into a home in place and repoints links beside it', (t) => {
  const root = tempRoot(t);
  const flat = path.join(root, 'orch');
  mkdirSync(path.join(flat, 'local-codex-state'), { recursive: true });
  mkdirSync(path.join(flat, 'prompts'));
  writeFileSync(path.join(flat, 'config.env'), `LOCAL_STATE_DIR=${flat}/local-codex-state\nCODEX_MODEL=m\n`);
  for (const name of ['lessons.md', 'handover.md', 'resume-log.md', 'rulings.md', 'prs.txt']) writeFileSync(path.join(flat, name), `${name}\n`);
  writeFileSync(path.join(flat, 'sessions.txt'), 'local w1\nremote prd723-vibe\n');
  writeFileSync(path.join(flat, 'local-codex-state', 'w1.json'), '{"threadId":"t1"}\n');
  symlinkSync(path.join(flat, 'resume-log.md'), path.join(root, 'program-resume.md'));
  symlinkSync(path.join(flat, 'lessons.md'), path.join(root, 'ledger.md'));
  symlinkSync(path.join(flat, 'resume-log.md'), path.join(flat, 'prompts', 'latest-log.md'));
  const dry = run(['migrate', '--from', flat, '--program', 'iss-1', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`^MOVE ${flat}/local-codex-state -> ${flat}/programs/iss-1/sessions$`, 'm'));
  assert.match(dry.stdout, /^SPLIT-RULINGS /m);
  assert.ok(existsSync(path.join(flat, 'resume-log.md')), 'a dry run moves nothing');

  const watcher = spawn('sleep', ['30']);
  t.after(() => watcher.kill());
  mkdirSync(path.join(flat, 'watch.lock'));
  writeFileSync(path.join(flat, 'watch.lock', 'pid'), `${watcher.pid}\n`);
  const live = run(['migrate', '--from', flat, '--program', 'iss-1']);
  assert.equal(live.status, 2);
  assert.match(live.stderr, /^WATCHER-LIVE /m);
  rmSync(path.join(flat, 'watch.lock'), { recursive: true });

  assert.equal(run(['migrate', '--from', flat, '--program', 'iss-1']).status, 0);
  const program = path.join(flat, 'programs', 'iss-1');
  for (const name of ['lessons.md', 'handover.md', 'config.env']) assert.ok(existsSync(path.join(flat, name)), name);
  for (const name of ['resume-log.md', 'rulings.md', 'prs.txt', 'sessions.txt', 'prompts', 'sessions/w1.json']) assert.ok(existsSync(path.join(program, name)), name);
  assert.equal(readlinkSync(path.join(root, 'program-resume.md')), path.join(program, 'resume-log.md'));
  assert.equal(readlinkSync(path.join(program, 'prompts', 'latest-log.md')), path.join(program, 'resume-log.md'), 'an absolute link inside the moved state follows it');
  assert.ok(lstatSync(path.join(root, 'ledger.md')).isSymbolicLink() && readlinkSync(path.join(root, 'ledger.md')) === path.join(flat, 'lessons.md'), 'a link to a reusable file is unchanged');
  assert.match(readFileSync(path.join(flat, 'config.env'), 'utf8'), /^# derived per program since vibe 1\.0\.78: LOCAL_STATE_DIR=/m);
  const check = run(['check', '--home', flat]);
  assert.match(check.stdout, /^UNMANAGED remote prd723-vibe/m, 'a remote session started without fleet.sh stays reported');
  assert.doesNotMatch(check.stdout, /^UNMANAGED local w1/m, 'the moved state dir is the program sessions dir');
  assert.doesNotMatch(check.stdout, /^(FLAT|CONFIG|OUTSIDE)/m);
});
