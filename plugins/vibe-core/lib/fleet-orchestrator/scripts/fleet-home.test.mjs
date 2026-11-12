import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LoadBasis, loadedSkillEvidence } from '../../vibe/scripts/loaded-skill.mjs';
import { writeRemoteCodexStub } from '../../../../vibe/skills/fleet-orchestrator/scripts/fleet-test-support.mjs';
import { vibeRoot } from '../../../shared/vibe-install.mjs';
import { ambiguousHome, bindChat, captureBinding, chatBinding, programChats, programFor, reclaimStaleLock, releaseLeftoverClaims, restoreBinding, unbindChat } from './chat-binding.mjs';
import { closeProgram, startProgram } from './fleet-home.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Whether the temp volume ignores case (macOS by default; Linux CI does not), for the cases that need it.
const CASE_INSENSITIVE_TMP = (() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-home-case-'));
  writeFileSync(path.join(dir, 'a'), '');
  const insensitive = existsSync(path.join(dir, 'A'));
  rmSync(dir, { recursive: true, force: true });
  return insensitive;
})();
const PLUGIN_ROOT = vibeRoot();
// fleet.sh and board.mjs stay in vibe; these cases run them against this module.
const VIBE_FLEET_SCRIPTS = path.join(PLUGIN_ROOT, 'skills', 'fleet-orchestrator', 'scripts');
const actorLoad = (actor = 'test') => loadedSkillEvidence(actor, 'codex', PLUGIN_ROOT, 'fleet-orchestrator', LoadBasis.HookObserved);
const MONITOR = path.join(HERE, '..', '..', 'codex-fleet-monitor', 'scripts');
// Cases run outside any chat (no harness ids) with a private HOME, so the chat bindings fleet-home.mjs writes
// never reach the real ~/.vibe-hook-scope; a case that tests a chat passes its id in `env`.
const TEST_HOME = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fleet-home-user-')));
process.on('exit', () => rmSync(TEST_HOME, { recursive: true, force: true }));
const outsideChat = (env) => {
  const base = { ...process.env, HOME: TEST_HOME };
  Reflect.deleteProperty(base, 'CLAUDE_CODE_SESSION_ID');
  Reflect.deleteProperty(base, 'CODEX_THREAD_ID');
  Reflect.deleteProperty(base, 'FLEET_HOME');
  return { ...base, ...env };
};
const run = (args, env = {}) => spawnSync(process.execPath, [path.join(HERE, 'fleet-home.mjs'), ...args], { encoding: 'utf8', env: outsideChat(env) });
const tempRoot = (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fleet-home-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('a new program reads none of an earlier program; resume names the active one and its Claude writers to relaunch', (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  assert.match(run(['resume', '--home', home]).stdout, /^NO-ACTIVE-PROGRAM/m);
  assert.equal(run(['start', 'iss-1', '--shape', 'fleet', '--home', home]).status, 0);
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

  const refused = run(['start', 'iss-2', '--shape', 'fleet', '--home', home]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^ACTIVE iss-1: close it/m);
  assert.equal(run(['close', '--home', home]).status, 0);
  assert.equal(run(['start', 'iss-2', '--shape', 'fleet', '--home', home]).status, 0);
  const second = run(['resume', '--home', home]).stdout;
  assert.match(second, /^ACTIVE iss-2 /m);
  assert.doesNotMatch(second, /^ACTIVE iss-1 |\/programs\/iss-1(?:\/|$)/m, 'the new program is shown nothing of the earlier one');
  assert.equal(readFileSync(path.join(home, 'programs', 'iss-2', 'resume-log.md'), 'utf8'), '');
});

test('check reports state written outside the home or the program, and passes once it is inside', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  run(['start', 'iss-1', '--shape', 'fleet', '--home', home]);
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

test('check reports a pending remote marker as recoverable rather than unmanaged', (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  assert.equal(run(['start', 'iss-1', '--shape', 'fleet', '--home', home]).status, 0);
  const program = path.join(home, 'programs', 'iss-1');
  writeFileSync(path.join(program, 'sessions.txt'), 'remote writer\n');
  const pending = path.join(program, 'sessions', 'writer.remote.pending.json');
  writeFileSync(pending, '{"host":"box","stateDir":"/remote/sessions","owner":{"pid":99,"started":"prior","attempt":"one"}}\n');
  const checked = run(['check', '--home', home]);
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /^PENDING-REMOTE remote writer:/m);
  assert.doesNotMatch(checked.stdout, /^UNMANAGED remote writer:/m);
  rmSync(path.join(program, 'sessions.txt'));
  const withoutRoster = run(['check', '--home', home]);
  assert.match(withoutRoster.stdout, /^PENDING-REMOTE remote writer:/m,
    'pending ownership remains discoverable before the roster names the writer');
  const legacy = path.join(program, 'sessions', 'legacy.remote.pending');
  mkdirSync(legacy);
  writeFileSync(path.join(program, 'sessions.txt'), 'remote legacy\n');
  const withLegacy = run(['check', '--home', home]);
  assert.match(withLegacy.stdout, /^PENDING-REMOTE-LEGACY remote legacy:/m);
  assert.doesNotMatch(withLegacy.stdout, /^UNMANAGED remote legacy:/m);
});

test('every script resolves the home to the active program, with per-program state dirs derived', (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  run(['start', 'iss-1', '--shape', 'fleet', '--home', home]);
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
  run(['start', 'iss-1', '--shape', 'fleet', '--home', home]);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'node'), `#!/usr/bin/env bash\ncase "$1" in *ship-plugins.mjs|*work-dir.mjs) exec ${JSON.stringify(process.execPath)} "$@";; esac\nprintf "arg:%s\\n" "$@"\n`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'ssh'), '#!/usr/bin/env bash\nexec bash -c "${@: -1}"\n', { mode: 0o755 });
  writeRemoteCodexStub(bin, PLUGIN_ROOT);
  writeFileSync(path.join(home, 'config.env'), `REMOTE_HOST=box\nREMOTE_FLEET_HOME=${root}/remote\nREMOTE_SHELL="bash -c"\nCODEX_MODEL=m\nCODEX_EFFORT=high\n`);
  const prompt = path.join(home, 'programs', 'iss-1', 'prompts', 'w1-01.md');
  writeFileSync(prompt, '$vibe ISS-1\n');
  const fleet = (...args) => spawnSync('bash', [path.join(VIBE_FLEET_SCRIPTS, 'fleet.sh'), home, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
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

test('a program records its shape at start, resume says what applies, and the board refuses a writer the shape does not allow', (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  const missing = run(['start', 'solo', '--home', home]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--shape must be one of no-writer, one-writer, fleet/);
  const started = run(['start', 'solo', '--shape', 'no-writer', '--home', home]);
  assert.equal(started.status, 0, started.stderr);
  const program = path.join(home, 'programs', 'solo');
  assert.deepEqual(JSON.parse(readFileSync(path.join(program, 'program.json'), 'utf8')), { shape: 'no-writer' });
  assert.match(run(['resume', '--home', home]).stdout, /^SHAPE no-writer: nobody writes code; the resume log, rulings, research and evidence rules apply/m);

  const board = (...args) => spawnSync(process.execPath, [path.join(VIBE_FLEET_SCRIPTS, 'board.mjs'), home, ...args], { encoding: 'utf8' });
  const evidence = path.join(tempRoot(t), 'placement.json');
  writeFileSync(evidence, JSON.stringify({ codeOnly: false, needsRunningApp: true, localEvidence: [] }));
  assert.equal(board('placement', 'ISS-1', '--evidence', evidence).status, 0, 'a writer start needs its ticket placed');
  const refused = board('writer', 'w1', '--tickets', 'ISS-1', '--runtime', 'claude');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /recorded as no-writer; record its new shape with fleet-home\.mjs shape one-writer\|fleet before adding a writer/);
  assert.equal(run(['shape', 'one-writer', '--home', home]).status, 0);
  assert.equal(board('writer', 'w1', '--tickets', 'ISS-1', '--runtime', 'claude').status, 0);
  assert.equal(board('writer', 'w1', '--tickets', 'ISS-1', '--status', 'building').status, 0, 'the one writer keeps updating its row');
  const second = board('writer', 'w2', '--tickets', 'ISS-1', '--runtime', 'codex');
  assert.equal(second.status, 2);
  assert.match(second.stderr, /recorded as one-writer \(writer w1\); record its new shape with fleet-home\.mjs shape fleet/);
  assert.equal(run(['shape', 'fleet', '--home', home]).status, 0);
  assert.equal(board('writer', 'w2', '--tickets', 'ISS-1', '--runtime', 'codex').status, 0);
  assert.equal(run(['shape', 'several', '--home', home]).status, 2);
});

test('resume tells a new chat to run the plugin version check, and flags an outdated plugin nobody answered', (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  run(['start', 'p1', '--shape', 'one-writer', '--home', home]);
  const program = path.join(home, 'programs', 'p1');
  assert.match(run(['resume', '--home', home]).stdout, new RegExp(`^PLUGIN-VERSION-UNCHECKED: run \`node \\S+/vibe/scripts/plugin-version\\.mjs check --state ${program}/plugin-version\\.json\``, 'm'));
  writeFileSync(path.join(program, 'plugin-version.json'), JSON.stringify({ status: 'outdated', versions: 'vibe: you have 1.0.84, the latest is 1.0.85', checkedAt: 'then' }));
  assert.match(run(['resume', '--home', home]).stdout, /^PLUGIN-VERSION-UNANSWERED vibe: you have 1\.0\.84, the latest is 1\.0\.85: ask the operator to update now or proceed knowing an outdated plugin could give worse results/m);
  writeFileSync(path.join(program, 'plugin-version.json'), JSON.stringify({ status: 'outdated', versions: 'v', checkedAt: 'then', choice: { choice: 'proceed' },
    runtime: 'codex', loadedSkill: actorLoad('c'), harnesses: [] }));
  assert.match(run(['resume', '--home', home]).stdout, /^PLUGIN-VERSION outdated proceed at then: run `.+` in every chat; in the same chat it keeps the recorded answer$/m);
  assert.equal(run(['check', '--home', home]).status, 0, 'program.json and plugin-version.json are program state, not strays');
});

test('resume refuses a stale loaded skill until the current installed release is recorded', (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  run(['start', 'p1', '--shape', 'one-writer', '--home', home]);
  const program = path.join(home, 'programs', 'p1');
  writeFileSync(path.join(program, 'plugin-version.json'), JSON.stringify({ status: 'current', runtime: 'codex', checkedAt: 'then', loadedSkill: { ...actorLoad('same-chat'), version: '1.0.85' }, harnesses: [] }));
  assert.match(run(['resume', '--home', home]).stdout, /PLUGIN-RELOAD-REQUIRED: target actor loaded 1\.0\.85/);
  writeFileSync(path.join(program, 'plugin-version.json'), JSON.stringify({ status: 'current', runtime: 'codex', checkedAt: 'now', loadedSkill: actorLoad('new-chat'), harnesses: [] }));
  assert.match(run(['resume', '--home', home]).stdout, /^PLUGIN-VERSION current at now/m);
});

test('resume writes the editable context-guard file once and never overwrites an edited one', (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  assert.equal(run(['start', 'prog-a', '--shape', 'one-writer', '--home', home]).status, 0);
  const guardFile = path.join(home, 'context-guard.json');
  assert.equal(run(['resume', '--home', home]).status, 0);
  const seeded = JSON.parse(readFileSync(guardFile, 'utf8'));
  assert.deepEqual([seeded.enabled, seeded.compactWindowTokens, seeded.flushAtPercent], [true, 300000, 85]);
  assert.equal(run(['check', '--home', home]).status, 0, run(['check', '--home', home]).stdout);
  writeFileSync(guardFile, JSON.stringify({ compactWindowTokens: 400000 }));
  run(['resume', '--home', home]);
  assert.deepEqual(JSON.parse(readFileSync(guardFile, 'utf8')), { compactWindowTokens: 400000 }, 'an edited file is never overwritten');
  for (const broken of ['{broken', JSON.stringify({ compactWindowTokens: 2000000 })]) {
    writeFileSync(guardFile, broken);
    assert.match(run(['resume', '--home', home]).stdout, new RegExp(`^CONTEXT-GUARD-INVALID ${guardFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `, 'm'), broken);
  }
  assert.equal(run(['resume', '--home', path.join(home, 'absent')]).status, 0);
  assert.equal(existsSync(path.join(home, 'absent')), false, 'resume creates no home');
});

test('a resume that cannot seed context-guard.json still prints the whole reading list', (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  assert.equal(run(['start', 'prog-a', '--shape', 'one-writer', '--home', home]).status, 0);
  chmodSync(home, 0o555);
  let result;
  try {
    result = run(['resume', '--home', home]);
  } finally {
    chmodSync(home, 0o755);
  }
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^CONTEXT-GUARD-UNSEEDED .*context-guard\.json: /m);
  assert.match(result.stdout, /^ACTIVE prog-a /m);
  assert.equal(existsSync(path.join(home, 'context-guard.json')), false);
});

// ISS-14028: two orchestrator chats on one machine each run their own program with no launch environment variable.
const chatEnv = (chat) => ({ CLAUDE_CODE_SESSION_ID: chat });
const ORCHESTRATOR_TRANSCRIPT = `${JSON.stringify({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'Base directory for this skill: /plugins/vibe/skills/fleet-orchestrator\n\n# fleet-orchestrator' }] } })}\n`;
const hookEvent = (root, chat, extra = {}) => {
  const transcript = path.join(root, `${chat}.jsonl`);
  if (!existsSync(transcript)) writeFileSync(transcript, ORCHESTRATOR_TRANSCRIPT);
  return { session_id: chat, transcript_path: transcript, ...extra };
};
const usage = (root, chat, tokens) => writeFileSync(path.join(root, `${chat}.jsonl`), `${ORCHESTRATOR_TRANSCRIPT}${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: tokens } } })}\n`);
const { contextGuard, compactionInstructions } = await import('../../../hooks/context-guard.mjs');
const { fleetResume } = await import('../../../hooks/fleet-resume.mjs');

test('two chats bound to two programs in one home each resolve their own program in commands and hooks', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  const startA = run(['start', 'prog-a', '--shape', 'fleet', '--home', home], chatEnv('chat-a'));
  assert.equal(startA.status, 0, startA.stderr);
  assert.match(startA.stdout, /^BOUND prog-a chat-a$/m);
  const startB = run(['start', 'prog-b', '--shape', 'one-writer', '--home', home], chatEnv('chat-b'));
  assert.equal(startB.status, 0, 'a second chat starts its own program while the first one runs');
  assert.match(startB.stdout, /^BOUND prog-b chat-b$/m);
  assert.equal(readFileSync(path.join(home, 'current'), 'utf8'), 'prog-a\n', "the first chat's current program is left alone");
  writeFileSync(path.join(home, 'lessons.md'), 'shared ledger\n');
  const programA = path.join(home, 'programs', 'prog-a');
  const programB = path.join(home, 'programs', 'prog-b');

  for (const [chat, own, other] of [['chat-a', programA, programB], ['chat-b', programB, programA]]) {
    const resumed = run(['resume'], { ...chatEnv(chat) }).stdout;
    assert.match(resumed, new RegExp(`^READ ${path.join(home, 'lessons.md')}$`, 'm'), 'both chats share the home files');
    assert.match(resumed, new RegExp(`^ACTIVE ${path.basename(own)} ${own}$`, 'm'), `${chat} resumes its own program without FLEET_HOME`);
    assert.ok(!resumed.includes(other), `${chat} is shown nothing of the other program`);
    const shell = spawnSync('bash', ['-c', `lines=$(node ${JSON.stringify(path.join(MONITOR, 'work-dir.mjs'))} sh "$1") || exit 2; eval "$lines"; echo "$W"`, 'x', home], { encoding: 'utf8', env: outsideChat(chatEnv(chat)) });
    assert.equal(shell.stdout, `${own}\n`, `scripts given the home path resolve ${chat}'s program`);

    const env = { HOME: TEST_HOME };
    usage(root, chat, 290_000);
    const flush = contextGuard(hookEvent(root, chat), env)?.context ?? '';
    assert.ok(flush.includes(`state files in ${own} current`), `${chat}'s flush prompt names its own program: ${flush}`);
    assert.ok(!flush.includes(other));
    const instructions = compactionInstructions(hookEvent(root, chat), env) ?? '';
    assert.ok(instructions.includes(path.join(own, 'resume-log.md')) && !instructions.includes(other), instructions);
    const reading = fleetResume(hookEvent(root, chat, { source: 'compact' }), env)?.context ?? '';
    assert.ok(reading.includes(`ACTIVE ${path.basename(own)} ${own}`) && !reading.includes(other), reading);
  }
  for (const env of [{}, chatEnv('chat-worker')]) {
    const unbound = spawnSync(process.execPath, [path.join(MONITOR, 'work-dir.mjs'), 'sh', home], { encoding: 'utf8', env: outsideChat(env) });
    assert.equal(unbound.status, 2, 'with two chats bound in one home, a caller bound to nothing cannot tell whose current it would get');
    assert.match(unbound.stderr, /^AMBIGUOUS-HOME .* runs several chats' programs \(prog-a current, prog-b\): pass the program dir/m);
    const direct = spawnSync(process.execPath, [path.join(MONITOR, 'work-dir.mjs'), 'sh', programB], { encoding: 'utf8', env: outsideChat(env) });
    assert.match(direct.stdout, new RegExp(`^W='${programB}'$`, 'm'), 'the program dir always works');
  }

  const refused = run(['start', 'prog-c', '--shape', 'fleet', '--home', home], chatEnv('chat-b'));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^ACTIVE prog-b: close it/m, "a chat's own open program still blocks it from starting another");
  assert.match(run(['close', '--home', home], chatEnv('chat-b')).stdout, /^closed prog-b for this chat; prog-a stays current/m);
  assert.equal(readFileSync(path.join(home, 'current'), 'utf8'), 'prog-a\n');
  assert.match(run(['resume', '--home', home], chatEnv('chat-a')).stdout, /^ACTIVE prog-a /m, 'closing one chat leaves the other bound');
});

test('a chat with no binding is told how to bind, never handed the program another chat runs', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  assert.equal(run(['start', 'prog-a', '--shape', 'fleet', '--home', home], chatEnv('chat-a')).status, 0);
  const programA = path.join(home, 'programs', 'prog-a');
  const env = { HOME: TEST_HOME, FLEET_HOME: home };

  const resumed = run(['resume'], { ...chatEnv('chat-c'), FLEET_HOME: home });
  assert.equal(resumed.status, 0);
  assert.match(resumed.stdout, /^UNBOUND: this chat has no fleet program in .*; its current program prog-a is bound to chat chat-a \(bound \d{4}-[^)]*\)\. If that chat has finished, take the program over with fleet-home\.mjs resume prog-a --takeover; otherwise start your own/m);
  assert.match(resumed.stdout, /^PROGRAM prog-a chat chat-a$/m);
  assert.doesNotMatch(resumed.stdout, /^(ACTIVE|BOUND) /m);
  assert.ok(!resumed.stdout.includes(programA));

  usage(root, 'chat-c', 290_000);
  const flush = contextGuard(hookEvent(root, 'chat-c'), env)?.context ?? '';
  assert.match(flush, /no fleet program of its own to bring current\. UNBOUND: /);
  assert.ok(!flush.includes(programA), flush);
  assert.equal(compactionInstructions(hookEvent(root, 'chat-c'), env), null, 'the summary is pointed at no program files');
  const reading = fleetResume(hookEvent(root, 'chat-c', { source: 'compact' }), env)?.context ?? '';
  assert.match(reading, /^Your context was just compacted\. UNBOUND: /);
  assert.ok(!reading.includes(programA), reading);

  const taken = run(['resume', 'prog-a', '--takeover'], { ...chatEnv('chat-c'), FLEET_HOME: home });
  assert.equal(taken.status, 0, taken.stderr);
  assert.match(taken.stdout, /^TAKEOVER chat-a: that chat ran prog-a/m, 'an explicit takeover moves the program and says from whom');
  assert.match(taken.stdout, /^BOUND prog-a chat-c$/m);
  assert.match(taken.stdout, new RegExp(`^ACTIVE prog-a ${programA}$`, 'm'));
  assert.match(run(['resume'], { ...chatEnv('chat-a'), FLEET_HOME: home }).stdout, /^UNBOUND: .*is bound to chat chat-c /m, 'the chat it was taken from is told, not left writing it');
  run(['close'], { ...chatEnv('chat-c'), FLEET_HOME: home });
  const afterClose = spawnSync(process.execPath, [path.join(MONITOR, 'work-dir.mjs'), 'sh', home], { encoding: 'utf8', env: outsideChat(chatEnv('chat-a')) });
  assert.doesNotMatch(afterClose.stderr, /TAKEN-OVER/, 'once the chat that took over lets the program go, the takeover note no longer applies');
});

test('a chat bound in a second home finds it with no FLEET_HOME, and FLEET_HOME still overrides the home', (t) => {
  const root = tempRoot(t);
  const first = path.join(root, 'fleet');
  const second = path.join(root, 'fleet-two');
  assert.equal(run(['start', 'prog-a', '--shape', 'fleet', '--home', first], chatEnv('chat-a')).status, 0);
  assert.equal(run(['start', 'prog-x', '--shape', 'fleet', '--home', second], chatEnv('chat-x')).status, 0);
  const resumed = run(['resume'], chatEnv('chat-x')).stdout;
  assert.match(resumed, new RegExp(`^ACTIVE prog-x ${path.join(second, 'programs', 'prog-x')}$`, 'm'), 'the bound home is used with no environment variable');
  const flush = (usage(root, 'chat-x', 290_000), contextGuard(hookEvent(root, 'chat-x'), { HOME: TEST_HOME })?.context ?? '');
  assert.ok(flush.includes(path.join(second, 'programs', 'prog-x')), flush);
  const overridden = run(['resume'], { ...chatEnv('chat-x'), FLEET_HOME: first }).stdout;
  assert.match(overridden, /^UNBOUND: .*prog-a is bound to chat chat-a /m, 'FLEET_HOME picks the home; the chat has no program of its own there');
  assert.match(run(['resume'], { ...chatEnv('chat-new'), FLEET_HOME: second }).stdout, /^UNBOUND: /m);
});

test('with one orchestrator a chat binds to the home current program on its first resume and nothing else changes', (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  assert.equal(run(['start', 'prog-a', '--shape', 'fleet', '--home', home]).status, 0, 'a program started before bindings, outside any chat');
  const resumed = run(['resume', '--home', home], chatEnv('chat-a')).stdout;
  assert.match(resumed, /^BOUND prog-a chat-a$/m);
  assert.match(resumed, /^ACTIVE prog-a /m);
  assert.match(run(['resume', '--home', home], chatEnv('chat-a')).stdout, /^ACTIVE prog-a /m);
  assert.equal(run(['close', '--home', home], chatEnv('chat-a')).status, 0);
  assert.equal(existsSync(path.join(home, 'current')), false, "close clears the chat's own current program");
  assert.match(run(['resume', '--home', home], chatEnv('chat-a')).stdout, /^NO-ACTIVE-PROGRAM/m);
});

test('launcher prints and installs fleet-claude, which starts Claude Code with the home compaction window', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  run(['start', 'prog-a', '--shape', 'fleet', '--home', home]);
  writeFileSync(path.join(home, 'context-guard.json'), JSON.stringify({ compactWindowTokens: 450000 }));
  assert.match(run(['launcher', '--home', home]).stdout, /^LAUNCH CLAUDE_CODE_AUTO_COMPACT_WINDOW=450000 claude$/m);
  const bin = path.join(root, 'bin');
  const installed = run(['launcher', '--install', '--bin', bin, '--home', home]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, new RegExp(`^INSTALLED ${path.join(bin, 'fleet-claude')}: `, 'm'));
  assert.match(installed.stdout, /^NOT-ON-PATH /m);
  const stubs = path.join(root, 'stubs');
  mkdirSync(stubs);
  writeFileSync(path.join(stubs, 'claude'), '#!/bin/sh\necho "window=$CLAUDE_CODE_AUTO_COMPACT_WINDOW args=$*"\n', { mode: 0o755 });
  const launch = (env) => spawnSync(path.join(bin, 'fleet-claude'), ['--resume', 's-1'], { encoding: 'utf8', env: { PATH: `${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, ...env } });
  assert.equal(launch({}).stdout, 'window=450000 args=--resume s-1\n', 'the home it was installed for, with no FLEET_HOME');
  const otherHome = path.join(root, 'other');
  mkdirSync(otherHome);
  writeFileSync(path.join(otherHome, 'context-guard.json'), JSON.stringify({ compactWindowTokens: 600000 }));
  assert.equal(launch({ FLEET_HOME: otherHome }).stdout, 'window=600000 args=--resume s-1\n', 'FLEET_HOME still overrides the home');
  assert.equal(launch({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' }).stdout, 'window=200000 args=--resume s-1\n', 'a window set by hand wins');
  writeFileSync(path.join(home, 'context-guard.json'), '{broken');
  assert.equal(launch({}).stdout, 'window=300000 args=--resume s-1\n', 'an unreadable file falls back to the default window');
  writeFileSync(path.join(bin, 'fleet-claude'), '#!/bin/sh\necho mine\n');
  const foreign = run(['launcher', '--install', '--bin', bin, '--home', home]);
  assert.equal(foreign.status, 2);
  assert.match(foreign.stderr, /was not written by fleet-home\.mjs launcher/);
  assert.equal(readFileSync(path.join(bin, 'fleet-claude'), 'utf8'), '#!/bin/sh\necho mine\n');
});

// ISS-14024: migrate half-moved a tree on a target collision and overwrote an existing home's files.
const treeSnapshot = (dir) => {
  const entries = [];
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const file = path.join(at, name);
      const stat = lstatSync(file);
      const rel = path.relative(dir, file);
      if (stat.isSymbolicLink()) entries.push(`${rel} -> ${readlinkSync(file)}`);
      else if (stat.isDirectory()) {
        entries.push(`${rel}/`);
        walk(file);
      } else entries.push(`${rel}: ${readFileSync(file, 'utf8')}`);
    }
  };
  walk(dir);
  return entries;
};

test('migrate refuses a LOCAL_STATE_DIR that collides with a flat sessions/ in the dry run and the real run, moving nothing', (t) => {
  const root = tempRoot(t);
  const flat = path.join(root, 'orch');
  mkdirSync(path.join(flat, 'local-codex-state'), { recursive: true });
  mkdirSync(path.join(flat, 'sessions'));
  writeFileSync(path.join(flat, 'config.env'), `LOCAL_STATE_DIR=${flat}/local-codex-state\n`);
  writeFileSync(path.join(flat, 'local-codex-state', 'w1.json'), '{"threadId":"t1"}\n');
  writeFileSync(path.join(flat, 'sessions', 'w2.remote.json'), '{}\n');
  writeFileSync(path.join(flat, 'resume-log.md'), 'log\n');
  const before = treeSnapshot(root);
  const target = path.join(flat, 'programs', 'iss-1', 'sessions');
  for (const args of [['--dry-run'], []]) {
    const result = run(['migrate', '--from', flat, '--program', 'iss-1', ...args]);
    assert.equal(result.status, 1, `${args.join(' ') || 'real run'} refuses`);
    assert.match(result.stdout, new RegExp(`^COLLISION ${target} is the target of ${flat}/local-codex-state and ${flat}/sessions: `, 'm'));
    assert.match(result.stdout, /^REFUSED: nothing was moved/m);
    assert.deepEqual(treeSnapshot(root), before, 'the tree is untouched');
  }
});

test('migrate --home into an existing home merges lessons.md, refuses a differing config.env and never overwrites either', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  assert.equal(run(['start', 'other', '--shape', 'fleet', '--home', home]).status, 0);
  writeFileSync(path.join(home, 'config.env'), 'CODEX_MODEL=home\n');
  const row = (n) => `2026-11-0${n} | new | #${n} | finding ${n} | w${n} | fix ${n}`;
  writeFileSync(path.join(home, 'lessons.md'), `${row(1)}\n${row(2)}\n`);
  const flat = path.join(root, 'orch');
  mkdirSync(flat);
  writeFileSync(path.join(flat, 'config.env'), 'CODEX_MODEL=flat\n');
  writeFileSync(path.join(flat, 'lessons.md'), `${row(2)}\n${row(3)}\n`);
  writeFileSync(path.join(flat, 'resume-log.md'), 'log\n');
  const before = treeSnapshot(root);

  const dry = run(['migrate', '--from', flat, '--program', 'iss-1', '--home', home, '--dry-run']);
  assert.equal(dry.status, 1);
  assert.match(dry.stdout, new RegExp(`^COLLISION ${path.join(home, 'config.env')} already exists and differs from ${path.join(flat, 'config.env')}: `, 'm'));
  assert.match(dry.stdout, new RegExp(`^MERGE ${path.join(flat, 'lessons.md')} -> ${path.join(home, 'lessons.md')} \\(1 lines the home lacks are appended\\)$`, 'm'));
  assert.equal(run(['migrate', '--from', flat, '--program', 'iss-1', '--home', home]).status, 1);
  assert.deepEqual(treeSnapshot(root), before, 'a refused run changes nothing');

  writeFileSync(path.join(flat, 'config.env'), 'CODEX_MODEL=home\n');
  const merged = run(['migrate', '--from', flat, '--program', 'iss-1', '--home', home]);
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert.match(merged.stdout, new RegExp(`^SAME ${path.join(flat, 'config.env')} = ${path.join(home, 'config.env')}`, 'm'));
  assert.match(merged.stdout, /^CURRENT kept other: /m);
  assert.equal(readFileSync(path.join(home, 'lessons.md'), 'utf8'), `${row(1)}\n${row(2)}\n${row(3)}\n`, 'the home ledger keeps its lines and gains the new one');
  assert.equal(readFileSync(path.join(home, 'config.env'), 'utf8'), 'CODEX_MODEL=home\n');
  assert.equal(readFileSync(path.join(home, 'current'), 'utf8'), 'other\n', "the home's current program is not replaced");
  assert.equal(readFileSync(path.join(home, 'programs', 'iss-1', 'resume-log.md'), 'utf8'), 'log\n');
  assert.deepEqual(readdirSync(flat), []);
});

test('a migrate that fails partway undoes every step it made', async (t) => {
  const { migrate } = await import('./fleet-migrate.mjs');
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  const flat = path.join(root, 'orch');
  mkdirSync(path.join(flat, 'prompts'), { recursive: true });
  writeFileSync(path.join(flat, 'handover.md'), 'handover\n');
  writeFileSync(path.join(flat, 'prs.txt'), 'prs\n');
  writeFileSync(path.join(flat, 'resume-log.md'), 'log\n');
  symlinkSync(path.join(flat, 'resume-log.md'), path.join(root, 'log-link.md'));
  const before = treeSnapshot(root);
  let calls = 0;
  const rename = (source, target) => {
    calls += 1;
    if (calls === 3) throw new Error('disk full');
    renameSync(source, target);
  };
  assert.throws(() => migrate(flat, home, 'iss-1', { reusable: ['handover.md', 'lessons.md', 'config.env'], skip: ['programs', 'current'], programDirs: ['sessions'], env: { HOME: TEST_HOME }, ops: { rename } }),
    /^Error: ROLLED-BACK migrate stopped \(disk full\); every completed step was undone/);
  assert.equal(calls, 3, 'two moves ran before the failure');
  assert.deepEqual(treeSnapshot(root), before, 'the source is as it was and nothing was left in the home');
});

test("binding a program another chat holds is refused by default and needs --takeover", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  assert.equal(run(['start', 'prog-h', '--shape', 'fleet', '--home', home], chatEnv('chat-holder')).status, 0);
  const holder = JSON.parse(readFileSync(path.join(TEST_HOME, '.vibe-hook-scope', 'fleet-binding', 'chat-holder.json'), 'utf8'));
  for (const args of [['resume', 'prog-h'], ['start', 'prog-h', '--shape', 'fleet']]) {
    const refused = run([...args, '--home', home], chatEnv('chat-intruder'));
    assert.equal(refused.status, 2, `${args[0]} is refused`);
    assert.equal(refused.stderr, `HELD prog-h is bound to chat chat-holder (bound ${holder.boundAt}). Pass --takeover only if that chat has finished; it is then told it has no program, and its scripts given the home path are refused\n`);
    assert.match(run(['resume', '--home', home], chatEnv('chat-holder')).stdout, /^ACTIVE prog-h /m, 'the holder keeps its program');
  }
  assert.equal(existsSync(path.join(TEST_HOME, '.vibe-hook-scope', 'fleet-binding', 'chat-intruder.json')), false, 'a refused chat is bound to nothing');

  const transcripts = path.join(TEST_HOME, '.claude', 'projects', 'fleet-home-test');
  mkdirSync(transcripts, { recursive: true });
  const transcript = path.join(transcripts, 'chat-holder.jsonl');
  writeFileSync(transcript, '{}\n');
  t.after(() => rmSync(transcript, { force: true }));
  assert.doesNotMatch(run(['resume', 'prog-h', '--home', home], chatEnv('chat-intruder')).stderr, /looks stale/, 'a holder writing now is not called stale');
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(transcript, old, old);
  const stale = run(['resume', 'prog-h', '--home', home], chatEnv('chat-intruder'));
  assert.equal(stale.status, 2, 'a stale-looking holder still needs the flag');
  assert.match(stale.stderr, new RegExp(`its transcript was last written ${old.toISOString().slice(0, 16)}.*; it looks stale\\)`));

  const taken = run(['resume', 'prog-h', '--takeover', '--home', home], chatEnv('chat-intruder'));
  assert.equal(taken.status, 0, taken.stderr);
  assert.match(taken.stdout, /^TAKEOVER chat-holder: /m);
  assert.match(taken.stdout, /^BOUND prog-h chat-intruder$/m);
  assert.match(run(['resume', '--home', home], chatEnv('chat-holder')).stdout, /^UNBOUND: .*is bound to chat chat-intruder /m, 'the old holder resolves no program after the takeover');
  const oldHolder = spawnSync(process.execPath, [path.join(MONITOR, 'work-dir.mjs'), 'sh', home], { encoding: 'utf8', env: outsideChat(chatEnv('chat-holder')) });
  assert.equal(oldHolder.status, 2, "the old holder's scripts given the home path are refused, not handed current");
  assert.match(oldHolder.stderr, /^TAKEN-OVER prog-h: chat chat-intruder took this chat's program over/m);
  const worker = spawnSync(process.execPath, [path.join(MONITOR, 'work-dir.mjs'), 'sh', home], { encoding: 'utf8', env: outsideChat(chatEnv('chat-worker-h')) });
  assert.match(worker.stdout, new RegExp(`^W='${path.join(home, 'programs', 'prog-h')}'$`, 'm'), 'a worker bound to nothing still gets current');
  assert.equal(run(['start', 'prog-new', '--shape', 'fleet', '--home', home], chatEnv('chat-holder')).status, 0);
  assert.match(spawnSync(process.execPath, [path.join(MONITOR, 'work-dir.mjs'), 'sh', home], { encoding: 'utf8', env: outsideChat(chatEnv('chat-holder')) }).stdout,
    new RegExp(`^W='${path.join(home, 'programs', 'prog-new')}'$`, 'm'), 'binding again clears the takeover note');
});

test("a chat from before bindings still cannot start a second program while its current one is open", (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  assert.equal(run(['start', 'old', '--shape', 'fleet', '--home', home]).status, 0, 'started outside any chat, as before bindings');
  const refused = run(['start', 'new', '--shape', 'fleet', '--home', home], chatEnv('chat-legacy'));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^ACTIVE old: close it with fleet-home\.mjs close before starting new; if another chat runs old, have it run fleet-home\.mjs resume there/m);
  assert.equal(existsSync(path.join(home, 'programs', 'new')), false);
});

test('migrate refuses a program another chat holds before moving anything', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  assert.equal(run(['start', 'iss-1', '--shape', 'fleet', '--home', home], chatEnv('chat-holder-m')).status, 0);
  rmSync(path.join(home, 'programs', 'iss-1'), { recursive: true });
  const flat = path.join(root, 'orch');
  mkdirSync(flat);
  writeFileSync(path.join(flat, 'resume-log.md'), 'log\n');
  const before = treeSnapshot(root);
  for (const args of [['--dry-run'], []]) {
    const result = run(['migrate', '--from', flat, '--program', 'iss-1', '--home', home, ...args], chatEnv('chat-migrator'));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^HELD iss-1 is bound to chat chat-holder-m /m);
    assert.deepEqual(treeSnapshot(root), before);
  }
});

test('an orchestrator chat from before bindings holds its program on its next tool call, so a newer chat cannot take it with a plain resume', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  assert.equal(run(['start', 'old', '--shape', 'fleet', '--home', home]).status, 0, 'started before bindings, outside any chat');
  const program = path.join(home, 'programs', 'old');
  usage(root, 'chat-legacy', 10_000);
  contextGuard(hookEvent(root, 'chat-legacy'), { HOME: TEST_HOME, FLEET_HOME: home });
  assert.equal(JSON.parse(readFileSync(path.join(TEST_HOME, '.vibe-hook-scope', 'fleet-binding', 'chat-legacy.json'), 'utf8')).program, 'old');
  const newcomer = run(['resume'], { ...chatEnv('chat-newcomer'), FLEET_HOME: home });
  assert.match(newcomer.stdout, /^UNBOUND: .*its current program old is bound to chat chat-legacy /m);
  assert.doesNotMatch(newcomer.stdout, /^BOUND /m);
  assert.match(run(['resume'], { ...chatEnv('chat-legacy'), FLEET_HOME: home }).stdout, new RegExp(`^ACTIVE old ${program}$`, 'm'));
});

test('migrate refuses merging append-only files whose entries span several lines, and an existing program dir', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  assert.equal(run(['start', 'iss-1', '--shape', 'fleet', '--home', home]).status, 0);
  writeFileSync(path.join(home, 'standing-rulings.md'), '- Ruling 2026-11-01 (operator message): one line\n');
  const flat = path.join(root, 'orch');
  mkdirSync(flat);
  writeFileSync(path.join(flat, 'standing-rulings.md'), '## alpha\n- Why: a reason\nthat wraps onto a second line\n');
  writeFileSync(path.join(flat, 'resume-log.md'), 'log\n');
  const before = treeSnapshot(root);
  const result = run(['migrate', '--from', flat, '--program', 'iss-1', '--home', home, '--dry-run']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`^COLLISION ${path.join(home, 'standing-rulings.md')} already exists and differs from ${path.join(flat, 'standing-rulings.md')}, and an entry spans several lines`, 'm'));
  assert.match(result.stdout, new RegExp(`^COLLISION ${path.join(home, 'programs', 'iss-1')} already exists: migrate into a new program slug`, 'm'));
  assert.equal(run(['migrate', '--from', flat, '--program', 'iss-1', '--home', home]).status, 1);
  assert.deepEqual(treeSnapshot(root), before);
});

test("a Codex thread that inherited another chat's Claude id binds only its own id, so that chat never resolves or closes it", (t) => {
  const home = path.join(tempRoot(t), 'fleet');
  assert.equal(run(['start', 'other', '--shape', 'fleet', '--home', home], chatEnv('claude-parent')).status, 0);
  // No ps on PATH, so harness-identity.mjs cannot read the ancestry and picks the Codex thread, as in a sandbox.
  const thread = { CLAUDE_CODE_SESSION_ID: 'claude-parent', CODEX_THREAD_ID: 'codex-thread', PATH: path.dirname(process.execPath) };
  const started = run(['start', 'pz', '--shape', 'fleet', '--home', home], thread);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /^BOUND pz codex-thread$/m);
  assert.doesNotMatch(readFileSync(path.join(TEST_HOME, '.vibe-hook-scope', 'fleet-binding', 'codex-thread.json'), 'utf8'), /claude-parent/, 'the inherited id is not recorded');
  assert.match(run(['resume', '--home', home], chatEnv('claude-parent')).stdout, /^ACTIVE other /m, 'the Claude chat keeps its own program');
  run(['close', '--home', home], chatEnv('claude-parent'));
  assert.match(run(['resume', '--home', home], chatEnv('codex-thread')).stdout, /^ACTIVE pz /m, "the Claude chat's close leaves the thread's binding alone");
});

test('two chats claiming one program at the same moment: exactly one wins and the other gets HELD', async (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs'), { recursive: true });
  const userHome = path.join(root, 'user');
  mkdirSync(userHome);
  const claimer = `import { bindChat } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'chat-binding.mjs')).href)};
const [chat, home, program, at] = process.argv.slice(1);
while (Date.now() < Number(at)) {}
try { bindChat(chat, home, program, { HOME: process.env.HOME }); console.log('WON'); }
catch (error) { console.log(String(error.message).startsWith('HELD ') ? 'HELD' : 'ERROR ' + error.message); }`;
  const claim = (chat, program, at) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', claimer, chat, home, program, String(at)], { env: { PATH: process.env.PATH, HOME: userHome } });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  });
  for (let round = 0; round < 12; round += 1) {
    const program = `race-${round}`;
    // Odd rounds race chats moving off a program they already hold, whose old binding is still in place mid-claim.
    if (round % 2 === 1) {
      bindChat(`racer-a-${round}`, home, `old-a-${round}`, { HOME: userHome });
      bindChat(`racer-b-${round}`, home, `old-b-${round}`, { HOME: userHome });
    }
    const at = Date.now() + 400;
    const results = await Promise.all([claim(`racer-a-${round}`, program, at), claim(`racer-b-${round}`, program, at)]);
    assert.deepEqual([...results].sort(), ['HELD', 'WON'], `round ${round}: ${results.join(', ')}`);
    const winner = results[0] === 'WON' ? `racer-a-${round}` : `racer-b-${round}`;
    const loser = winner.includes('-a-') ? `racer-b-${round}` : `racer-a-${round}`;
    const bindings = path.join(userHome, '.vibe-hook-scope', 'fleet-binding');
    assert.equal(JSON.parse(readFileSync(path.join(bindings, `${winner}.json`), 'utf8')).program, program);
    if (round % 2 === 1) {
      assert.equal(JSON.parse(readFileSync(path.join(bindings, `${loser}.json`), 'utf8')).program, loser.replace(/^racer-(.)-/, 'old-$1-'), 'the loser keeps its own program');
    } else {
      assert.equal(existsSync(path.join(bindings, `${loser}.json`)), false, 'the loser is bound to nothing');
    }
  }
});

test('eight chats claiming one program at once: exactly one wins every round', async (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs'), { recursive: true });
  const userHome = path.join(root, 'user');
  mkdirSync(userHome);
  const claimer = `import { bindChat } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'chat-binding.mjs')).href)};
const [chat, home, program, at] = process.argv.slice(1);
while (Date.now() < Number(at)) {}
try { bindChat(chat, home, program, { HOME: process.env.HOME }); console.log('WON'); }
catch (error) { console.log(String(error.message).startsWith('HELD ') ? 'HELD' : 'ERROR ' + error.message); }`;
  const claim = (chat, program, at) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', claimer, chat, home, program, String(at)], { env: { PATH: process.env.PATH, HOME: userHome } });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  });
  for (let round = 0; round < 6; round += 1) {
    const at = Date.now() + 600;
    const results = await Promise.all(Array.from({ length: 8 }, (_, n) => claim(`crowd-${round}-${n}`, `crowd-${round}`, at)));
    assert.equal(results.filter((result) => result === 'WON').length, 1, `round ${round}: ${results.join(', ')}`);
    assert.equal(results.filter((result) => result === 'HELD').length, 7, `round ${round}: ${results.join(', ')}`);
  }
});

test('a lock file mid-write is never taken for an abandoned one, and an abandoned one is reclaimed', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('lock-probe', home, 'locked', env);
  const claims = path.join(env.HOME, '.vibe-hook-scope', 'fleet-binding', 'claims');
  const lock = path.join(claims, readdirSync(claims).find((name) => name.endsWith('.locked.json')) + '.lock');
  writeFileSync(lock, '');
  assert.throws(() => bindChat('lock-probe', home, 'locked', env), /^Error: BUSY locked: /, 'an empty lock still being written is waited on, not deleted');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.deepEqual(bindChat('lock-probe', home, 'locked', env), [], 'an unreadable lock older than the stale limit is reclaimed');
  writeFileSync(lock, '2147483646 dead-owner\n');
  assert.deepEqual(bindChat('lock-probe', home, 'locked', env), [], 'a lock whose owner exited is reclaimed');
  assert.equal(existsSync(lock), false, 'the lock is removed after the bind');
});

test('a migrate whose final bind fails is rolled back with the rest', async (t) => {
  const { migrate } = await import('./fleet-migrate.mjs');
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  const flat = path.join(root, 'orch');
  mkdirSync(flat);
  writeFileSync(path.join(flat, 'resume-log.md'), 'log\n');
  writeFileSync(path.join(flat, 'handover.md'), 'handover\n');
  const userHome = path.join(root, 'user');
  const bindings = path.join(userHome, '.vibe-hook-scope', 'fleet-binding');
  mkdirSync(bindings, { recursive: true });
  chmodSync(bindings, 0o500);
  let restored = false;
  const restore = () => {
    if (!restored) chmodSync(bindings, 0o700);
    restored = true;
  };
  const before = treeSnapshot(flat);
  assert.throws(() => migrate(flat, home, 'iss-1', { reusable: ['handover.md'], skip: ['programs', 'current'], programDirs: ['sessions'], chat: 'chat-migrate', env: { HOME: userHome } }),
    /^Error: ROLLED-BACK migrate stopped/);
  restore();
  assert.deepEqual(treeSnapshot(flat), before, 'the source is as it was');
  assert.equal(existsSync(home), false, 'nothing is left in the home');
});

test("several chats meeting a dead owner's lock at once: exactly one wins every round", async (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs'), { recursive: true });
  const userHome = path.join(root, 'user');
  const claims = path.join(userHome, '.vibe-hook-scope', 'fleet-binding', 'claims');
  mkdirSync(claims, { recursive: true });
  const key = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);
  const claimer = `import { bindChat } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'chat-binding.mjs')).href)};
const [chat, home, program, at] = process.argv.slice(1);
while (Date.now() < Number(at)) {}
try { bindChat(chat, home, program, { HOME: process.env.HOME }); console.log('WON'); }
catch (error) { console.log(String(error.message).startsWith('HELD ') ? 'HELD' : 'ERROR ' + error.message); }`;
  const claim = (chat, program, at) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', claimer, chat, home, program, String(at)], { env: { PATH: process.env.PATH, HOME: userHome } });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  });
  for (let round = 0; round < 5; round += 1) {
    const program = `dead-${round}`;
    writeFileSync(path.join(claims, `${key}.${program}.json.lock`), '2147483646 dead-owner\n');
    const at = Date.now() + 600;
    const results = await Promise.all(Array.from({ length: 6 }, (_, n) => claim(`dead-${round}-${n}`, program, at)));
    assert.equal(results.filter((result) => result === 'WON').length, 1, `round ${round}: ${results.join(', ')}`);
    assert.equal(results.filter((result) => result === 'HELD').length, 5, `round ${round}: ${results.join(', ')}`);
  }
});

test("a bind that cannot get the lock of the program it leaves still succeeds, and that claim reads as stale", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'p0'), { recursive: true });
  mkdirSync(path.join(home, 'programs', 'p1'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-leaving', home, 'p0', env);
  const key = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);
  const lock = path.join(env.HOME, '.vibe-hook-scope', 'fleet-binding', 'claims', `${key}.p0.json.lock`);
  writeFileSync(lock, `${process.pid} held-by-test\n`);
  assert.deepEqual(bindChat('chat-leaving', home, 'p1', env), [], 'the busy lock on the program left behind does not fail the bind');
  assert.equal(chatBinding('chat-leaving', env).program, 'p1');
  assert.deepEqual(programChats(home, 'p0', env), [], 'the claim it could not remove no longer holds p0');
  rmSync(lock);
  unbindChat('chat-leaving', env);
  assert.deepEqual(programChats(home, 'p0', env), [], 'after the chat unbinds, the leftover claim still holds nothing');
  assert.equal(readdirSync(path.dirname(lock)).some((name) => name === `${key}.p0.json`), false, 'and unbinding released it');
  assert.deepEqual(bindChat('chat-next', home, 'p0', env), [], 'another chat binds p0 with no takeover');
});

test('a migrate rolled back after its bind committed restores the chat to the program it held', async (t) => {
  const { migrate } = await import('./fleet-migrate.mjs');
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'prog-old'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-mig', home, 'prog-old', env);
  const flat = path.join(root, 'orch');
  mkdirSync(flat);
  writeFileSync(path.join(flat, 'resume-log.md'), 'log\n');
  const failAfterBind = (...args) => {
    bindChat(...args);
    throw new Error('injected after the bind committed');
  };
  assert.throws(() => migrate(flat, home, 'iss-1', { reusable: [], skip: ['programs', 'current'], programDirs: ['sessions'], chat: 'chat-mig', env, ops: { bind: failAfterBind } }),
    /^Error: ROLLED-BACK migrate stopped \(injected after the bind committed\)/);
  assert.equal(chatBinding('chat-mig', env).program, 'prog-old', 'the earlier binding is back');
  assert.deepEqual(programChats(home, 'prog-old', env), ['chat-mig'], 'and so is its claim');
  assert.deepEqual(programChats(home, 'iss-1', env), []);
  assert.equal(existsSync(path.join(home, 'programs', 'iss-1')), false);
});

const tombstoneFor = (lock, seen) => `${lock}.reclaim.${createHash('sha256').update(seen).digest('hex').slice(0, 32)}`;
const reclaimFiles = (lock) => readdirSync(path.dirname(lock)).filter((name) => name.startsWith(`${path.basename(lock)}.reclaim.`));

test('only the holder of the tombstone for a stale lock removes it, and only the lock it read', (t) => {
  const root = tempRoot(t);
  const lock = path.join(root, 'p.json.lock');
  const stale = '2147483646 dead-owner\n';
  assert.equal(reclaimStaleLock(lock, ''), false, 'a lock that is gone is not reclaimed as an empty one');
  writeFileSync(lock, stale);
  writeFileSync(tombstoneFor(lock, stale), `${process.pid} another-reclaimer\n`);
  assert.equal(reclaimStaleLock(lock, stale), false);
  assert.equal(readFileSync(lock, 'utf8'), stale, 'while a live process holds the tombstone, this one removes nothing');
  rmSync(tombstoneFor(lock, stale));
  writeFileSync(lock, `${process.pid} live-owner\n`);
  assert.equal(reclaimStaleLock(lock, stale), false);
  assert.equal(readFileSync(lock, 'utf8'), `${process.pid} live-owner\n`, 'a lock replaced since it was read is left alone');
  writeFileSync(lock, stale);
  assert.equal(reclaimStaleLock(lock, stale), true);
  assert.equal(existsSync(lock), false, 'the stale lock it read is removed');
  assert.deepEqual(reclaimFiles(lock), [], 'and its tombstone with it');
});

test("a paused live reclaimer's tombstone is never cleared, however old: the lock stays BUSY", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  const claims = path.join(env.HOME, '.vibe-hook-scope', 'fleet-binding', 'claims');
  mkdirSync(claims, { recursive: true });
  const key = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);
  const lock = path.join(claims, `${key}.paused.json.lock`);
  const stale = '2147483646 dead-owner\n';
  writeFileSync(lock, stale);
  const tomb = tombstoneFor(lock, stale);
  writeFileSync(tomb, `${process.pid} paused-reclaimer\n`);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(tomb, old, old);
  assert.throws(() => bindChat('chat-impatient', home, 'paused', env), /^Error: BUSY paused: /);
  assert.equal(readFileSync(tomb, 'utf8'), `${process.pid} paused-reclaimer\n`, 'the live holder keeps its tombstone');
  assert.equal(readFileSync(lock, 'utf8'), stale, 'and nobody else removes the lock it is reclaiming');
});

test("a dead reclaimer's tombstone passes to exactly one next reclaimer", (t) => {
  const root = tempRoot(t);
  const lock = path.join(root, 'r.json.lock');
  const stale = '2147483646 dead-owner\n';
  writeFileSync(lock, stale);
  writeFileSync(tombstoneFor(lock, stale), '2147483645 dead-reclaimer\n');
  const others = [];
  const removed = reclaimStaleLock(lock, stale, { beforeRemove: () => {
    // Two more takers arrive while the first holds the next tombstone, the interleaving that let two in before.
    others.push(reclaimStaleLock(lock, stale), reclaimStaleLock(lock, stale));
  } });
  assert.equal(removed, true, 'one reclaimer moves on from the dead holder and removes the lock');
  assert.deepEqual(others, [false, false], 'the others remove nothing while it holds the next tombstone');
  assert.equal(existsSync(lock), false);
  assert.deepEqual(reclaimFiles(lock), [], "with the token lock gone for good, its own tombstone and the dead holder's are removed");
});

test("takers meeting a dead owner's lock and a dead reclaimer's tombstone at once: exactly one wins", async (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs'), { recursive: true });
  const userHome = path.join(root, 'user');
  const claims = path.join(userHome, '.vibe-hook-scope', 'fleet-binding', 'claims');
  mkdirSync(claims, { recursive: true });
  const key = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);
  const claimer = `import { bindChat } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'chat-binding.mjs')).href)};
const [chat, home, program, at] = process.argv.slice(1);
while (Date.now() < Number(at)) {}
try { bindChat(chat, home, program, { HOME: process.env.HOME }); console.log('WON'); }
catch (error) { console.log(String(error.message).startsWith('HELD ') ? 'HELD' : 'ERROR ' + error.message); }`;
  const claim = (chat, program, at) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', claimer, chat, home, program, String(at)], { env: { PATH: process.env.PATH, HOME: userHome } });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  });
  for (let round = 0; round < 5; round += 1) {
    const program = `abandoned-${round}`;
    const lock = path.join(claims, `${key}.${program}.json.lock`);
    const stale = `2147483646 dead-owner-${round}\n`;
    writeFileSync(lock, stale);
    writeFileSync(tombstoneFor(lock, stale), '2147483645 dead-reclaimer\n');
    const at = Date.now() + 600;
    const results = await Promise.all(Array.from({ length: 6 }, (_, n) => claim(`abandoned-${round}-${n}`, program, at)));
    assert.equal(results.filter((result) => result === 'WON').length, 1, `round ${round}: ${results.join(', ')}`);
    assert.equal(results.filter((result) => result === 'HELD').length, 5, `round ${round}: ${results.join(', ')}`);
  }
});

test('a migrate undo that races another chat claiming its previous program leaves that program with one holder', async (t) => {
  const { migrate } = await import('./fleet-migrate.mjs');
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'prog-old'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-undo', home, 'prog-old', env);
  const flat = path.join(root, 'orch');
  mkdirSync(flat);
  writeFileSync(path.join(flat, 'resume-log.md'), 'log\n');
  const raced = (...args) => {
    bindChat(...args);
    bindChat('chat-other', home, 'prog-old', env);
    throw new Error('injected after another chat claimed prog-old');
  };
  assert.throws(() => migrate(flat, home, 'iss-1', { reusable: [], skip: ['programs', 'current'], programDirs: ['sessions'], chat: 'chat-undo', env, ops: { bind: raced } }), /^Error: ROLLED-BACK/);
  assert.deepEqual(programChats(home, 'prog-old', env), ['chat-other']);
  assert.equal(chatBinding('chat-undo', env), null, 'the undone chat gets no program rather than a second claim on prog-old');
  assert.deepEqual(programChats(home, 'iss-1', env), []);
});

test('a migrate undo that races a takeover of the migrated program leaves it with the chat that took it', async (t) => {
  const { migrate } = await import('./fleet-migrate.mjs');
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'prog-old'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-undo', home, 'prog-old', env);
  const flat = path.join(root, 'orch');
  mkdirSync(flat);
  writeFileSync(path.join(flat, 'resume-log.md'), 'log\n');
  let tookOver;
  const raced = (chat, at, program, bindEnv, options) => {
    bindChat(chat, at, program, bindEnv, options);
    mkdirSync(path.join(home, 'programs', program), { recursive: true });
    tookOver = bindChat('chat-taker', home, program, env, { takeover: true });
    throw new Error('injected after a takeover');
  };
  assert.throws(() => migrate(flat, home, 'iss-1', { reusable: [], skip: ['programs', 'current'], programDirs: ['sessions'], chat: 'chat-undo', env, ops: { bind: raced } }), /^Error: ROLLED-BACK/);
  assert.deepEqual(tookOver, ['chat-undo']);
  assert.equal(chatBinding('chat-taker', env).program, 'iss-1');
  assert.equal(readBindingFileForTest(env, home, 'iss-1')?.chat, 'chat-taker', "the undo leaves the taker's claim");
  assert.equal(chatBinding('chat-undo', env).program, 'prog-old', 'the undone chat gets its own previous program back');
  assert.deepEqual(programChats(home, 'prog-old', env), ['chat-undo']);
});

const readBindingFileForTest = (env, home, program) => {
  const key = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);
  try {
    return JSON.parse(readFileSync(path.join(env.HOME, '.vibe-hook-scope', 'fleet-binding', 'claims', `${key}.${program}.json`), 'utf8'));
  } catch {
    return null;
  }
};

test('a claim whose chat is bound to nothing holds nothing', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'ghost-prog'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  const claims = path.join(env.HOME, '.vibe-hook-scope', 'fleet-binding', 'claims');
  mkdirSync(claims, { recursive: true });
  const key = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);
  writeFileSync(path.join(claims, `${key}.ghost-prog.json`), `${JSON.stringify({ chat: 'ghost', home, program: 'ghost-prog', boundAt: '2026-11-11T00:00:00.000Z' })}\n`);
  assert.deepEqual(programChats(home, 'ghost-prog', env), [], 'a claim left by a chat that unbound, or died before writing its binding, is stale');
  assert.deepEqual(bindChat('chat-real', home, 'ghost-prog', env), [], 'and another chat binds the program without --takeover');
});

test("releasing a chat's leftover claims never releases the program it is bound to now", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'q'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-moved', home, 'q', env);
  releaseLeftoverClaims('chat-moved', env, null);
  assert.deepEqual(programChats(home, 'q', env), ['chat-moved'], 'a chat taken over elsewhere that has since bound q keeps q');
  assert.throws(() => bindChat('chat-third', home, 'q', env), /^Error: HELD q /);
});

test('a rollback after takeovers leaves the program with nobody rather than give it to a chat that lost it', async (t) => {
  const { migrate } = await import('./fleet-migrate.mjs');
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'prog-old'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-undo', home, 'prog-old', env);
  bindChat('chat-first', home, 'iss-1', env);
  const flat = path.join(root, 'orch');
  mkdirSync(flat);
  writeFileSync(path.join(flat, 'resume-log.md'), 'log\n');
  const raced = (chat, at, program, bindEnv) => {
    bindChat('chat-second', home, program, env, { takeover: true });
    bindChat(chat, at, program, bindEnv, { takeover: true });
    throw new Error('injected after two takeovers');
  };
  assert.throws(() => migrate(flat, home, 'iss-1', { reusable: [], skip: ['programs', 'current'], programDirs: ['sessions'], chat: 'chat-undo', takeover: true, env, ops: { bind: raced } }), /^Error: ROLLED-BACK/);
  assert.equal(readBindingFileForTest(env, home, 'iss-1'), null, 'nobody holds iss-1');
  assert.equal(chatBinding('chat-second', env), null, 'the chat this bind took over stays taken over');
  assert.equal(chatBinding('chat-first', env), null);
  assert.equal(chatBinding('chat-undo', env).program, 'prog-old');
  assert.deepEqual(bindChat('chat-second', home, 'iss-1', env), [], 'and can take the program back with no takeover');
});

test("a bind that fails between its claim and its binding leaves the earlier holder's claim in place", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'p'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-holder-v', home, 'p', env);
  const before = captureBinding('chat-failing', home, 'p', env);
  const bindings = path.join(env.HOME, '.vibe-hook-scope', 'fleet-binding');
  chmodSync(bindings, 0o500);
  let restored = false;
  const restore = () => {
    if (!restored) chmodSync(bindings, 0o700);
    restored = true;
  };
  t.after(restore);
  assert.throws(() => bindChat('chat-failing', home, 'p', env, { takeover: true }), /EACCES/, 'the claim is written, then the binding write fails');
  restore();
  restoreBinding(before, env);
  assert.deepEqual(programChats(home, 'p', env), ['chat-holder-v'], 'the chat still bound to p keeps its claim');
  assert.throws(() => bindChat('chat-third', home, 'p', env), /^Error: HELD p /);
});

test("a rollback never restores a previous program whose captured claim was another chat's", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'q'), { recursive: true });
  mkdirSync(path.join(home, 'programs', 'p'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-c', home, 'q', env);
  const capturedBinding = readFileSync(path.join(env.HOME, '.vibe-hook-scope', 'fleet-binding', 'chat-c.json'), 'utf8');
  bindChat('chat-z', home, 'q', env, { takeover: true });
  const key = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);
  const zClaim = readFileSync(path.join(env.HOME, '.vibe-hook-scope', 'fleet-binding', 'claims', `${key}.q.json`), 'utf8');
  // The takeover lands inside captureBinding: it read chat-c's binding on q, then z's claim on q.
  const snapshot = { chat: 'chat-c', home: path.resolve(home), program: 'p', binding: capturedBinding, taken: null, claim: null,
    previous: { home: path.resolve(home), program: 'q', claim: zClaim } };
  bindChat('chat-c', home, 'p', env);
  unbindChat('chat-z', env);
  restoreBinding(snapshot, env);
  assert.equal(chatBinding('chat-c', env), null, 'chat-c gets no program rather than q on a claim that was never its own');
  assert.deepEqual(bindChat('chat-w', home, 'q', env), []);
  assert.deepEqual(programChats(home, 'q', env), ['chat-w']);
});

test('an old takeover note never makes a rollback hand the program back', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  for (const program of ['p', 'r']) mkdirSync(path.join(home, 'programs', program), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-v', home, 'p', env);
  bindChat('chat-c', home, 'p', env, { takeover: true });
  bindChat('chat-c', home, 'r', env);
  const before = captureBinding('chat-c', home, 'p', env);
  bindChat('chat-c', home, 'p', env);
  restoreBinding(before, env);
  assert.equal(chatBinding('chat-v', env), null, 'the chat taken over long ago is not handed p');
  assert.deepEqual(programChats(home, 'p', env), []);
  assert.equal(chatBinding('chat-c', env).program, 'r', 'the undone chat is back on r');
});

test('undoing a bind to the program the chat already held leaves it held', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'p'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-same', home, 'p', env);
  const before = captureBinding('chat-same', home, 'p', env);
  bindChat('chat-same', home, 'p', env);
  restoreBinding(before, env);
  assert.equal(chatBinding('chat-same', env)?.program, 'p');
  assert.deepEqual(programChats(home, 'p', env), ['chat-same']);
});

test('a tombstone cut short to nothing is passed like a dead one', (t) => {
  const root = tempRoot(t);
  const lock = path.join(root, 'e.json.lock');
  const stale = '2147483646 dead-owner\n';
  writeFileSync(lock, stale);
  writeFileSync(tombstoneFor(lock, stale), '');
  assert.equal(reclaimStaleLock(lock, stale), true, 'an empty tombstone does not keep the lock BUSY forever');
  assert.equal(existsSync(lock), false);
});

test("an unreadable lock's chain keeps the dead holders' tombstones, so takers of a repeated empty lock pass the same links", (t) => {
  const root = tempRoot(t);
  const lock = path.join(root, 'u.json.lock');
  writeFileSync(lock, '');
  writeFileSync(tombstoneFor(lock, ''), '2147483645 dead-reclaimer\n');
  assert.equal(reclaimStaleLock(lock, ''), true);
  assert.deepEqual(reclaimFiles(lock), [path.basename(tombstoneFor(lock, ''))], "the dead holder's tombstone stays; only the reclaimer's own goes");
});

// Write-order cases: a write that fails partway stands in for a process killed between two writes.
const lockedBindings = (t, env) => {
  const bindings = path.join(env.HOME, '.vibe-hook-scope', 'fleet-binding');
  let open = true;
  const unlock = () => {
    if (!open) chmodSync(bindings, 0o700);
    open = true;
  };
  t.after(unlock);
  return { lock: () => { chmodSync(bindings, 0o500); open = false; }, unlock };
};

test("a takeover cut short before it removes the old holder's binding hands the claim to nobody else", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'p'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-e', home, 'p', env);
  const files = lockedBindings(t, env);
  files.lock();
  assert.throws(() => bindChat('chat-a', home, 'p', env, { takeover: true }), /EACCES/);
  files.unlock();
  assert.throws(() => bindChat('chat-y', home, 'p', env), /^Error: HELD p /, 'the old holder still holds p; no third chat binds it');
});

test("an unbind cut short leaves a stale claim, never a binding with no claim", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'p'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-e', home, 'p', env);
  const files = lockedBindings(t, env);
  files.lock();
  assert.throws(() => unbindChat('chat-e', env), /EACCES/);
  files.unlock();
  assert.throws(() => bindChat('chat-y', home, 'p', env), /^Error: HELD p /, 'chat-e is still bound to p and still holds it');
});

test('a rollback cut short leaves a stale claim, never a binding with no claim', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'p'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  const before = captureBinding('chat-a', home, 'p', env);
  bindChat('chat-a', home, 'p', env);
  const files = lockedBindings(t, env);
  files.lock();
  assert.throws(() => restoreBinding(before, env), /EACCES/);
  files.unlock();
  assert.throws(() => bindChat('chat-y', home, 'p', env), /^Error: HELD p /, 'chat-a is still bound to p and still holds it');
});

test('two spellings of one program, P and p, share one claim', { skip: !CASE_INSENSITIVE_TMP && 'needs a case-insensitive volume' }, (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'P'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-e', home, 'P', env);
  assert.throws(() => bindChat('chat-y', home, 'p', env), /^Error: HELD P /);
});

test('two spellings of one home, a path and a symlink to it, share one claim', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'p'), { recursive: true });
  symlinkSync(home, path.join(root, 'fleet-alias'));
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-e', home, 'p', env);
  assert.throws(() => bindChat('chat-y', path.join(root, 'fleet-alias'), 'p', env), /^Error: HELD p /);
});

test('two case spellings of one home share one claim', { skip: !CASE_INSENSITIVE_TMP && 'needs a case-insensitive volume' }, (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'p'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-e', home, 'p', env);
  assert.throws(() => bindChat('chat-y', path.join(root, 'FLEET'), 'p', env), /^Error: HELD p /);
});

test('a takeover of a program whose dir was renamed from P to p after its bind leaves the old chat with nothing', { skip: !CASE_INSENSITIVE_TMP && 'needs a case-insensitive volume' }, (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'P'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  bindChat('chat-e', home, 'P', env);
  renameSync(path.join(home, 'programs', 'P'), path.join(home, 'programs', 'p'));
  assert.deepEqual(bindChat('chat-y', home, 'p', env, { takeover: true }), ['chat-e']);
  assert.equal(chatBinding('chat-e', env), null);
  assert.equal(programFor(home, 'chat-e', env).program, null);
  assert.deepEqual(programFor(home, 'chat-y', env), { program: 'p', source: 'bound' });
});

test("a program started under another case spelling of its dir is current under the dir's name, and close clears it", { skip: !CASE_INSENSITIVE_TMP && 'needs a case-insensitive volume' }, (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'p'), { recursive: true });
  const env = { HOME: path.join(root, 'user') };
  startProgram(home, 'P', 'no-writer', { env, chat: 'chat-e' });
  assert.equal(readFileSync(path.join(home, 'current'), 'utf8'), 'p\n');
  assert.equal(chatBinding('chat-e', env).program, 'p');
  assert.equal(ambiguousHome(home, env), null);
  closeProgram(home, { env, chat: 'chat-e' });
  assert.equal(existsSync(path.join(home, 'current')), false);
  assert.deepEqual(programFor(home, 'chat-y', env), { program: null, current: null });
  // A current file written in another spelling, as before this release, reads as the dir's name.
  writeFileSync(path.join(home, 'current'), 'P\n');
  bindChat('chat-e', home, 'p', env);
  assert.equal(ambiguousHome(home, env), null);
  closeProgram(home, { env, chat: 'chat-e' });
  assert.equal(existsSync(path.join(home, 'current')), false);
});

test('close through a symlink to the home unbinds the chat bound through its real path', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  const env = { HOME: path.join(root, 'user') };
  startProgram(home, 'p', 'no-writer', { env, chat: 'chat-e' });
  symlinkSync(home, path.join(root, 'fleet-alias'));
  closeProgram(path.join(root, 'fleet-alias'), { env, chat: 'chat-e' });
  assert.equal(chatBinding('chat-e', env), null);
  assert.deepEqual(programChats(home, 'p', env), []);
  assert.equal(existsSync(path.join(home, 'current')), false);
});

test('a close that waits on the lock while a takeover removes its binding finishes and leaves the taker holding', async (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'fleet');
  mkdirSync(path.join(home, 'programs', 'p'), { recursive: true });
  const userHome = path.join(root, 'user');
  const env = { HOME: userHome };
  bindChat('chat-e', home, 'p', env);
  const bindings = path.join(userHome, '.vibe-hook-scope', 'fleet-binding');
  const claims = path.join(bindings, 'claims');
  const claim = path.join(claims, readdirSync(claims).find((name) => name.endsWith('.p.json')));
  const lock = `${claim}.lock`;
  writeFileSync(lock, `${process.pid} held-by-test\n`);
  const closer = `import { unbindChat } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'chat-binding.mjs')).href)};
try { unbindChat('chat-e', { HOME: process.env.HOME }); console.log('OK'); } catch (error) { console.log('ERROR ' + error.message); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', closer], { env: { PATH: process.env.PATH, HOME: userHome } });
  const done = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  });
  // The closer has read its binding once its lock temp file exists.
  const waiting = () => readdirSync(claims).some((name) => name.startsWith(`${path.basename(lock)}.`) && name.endsWith('.tmp'));
  for (const deadline = Date.now() + 4000; !waiting() && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(waiting(), 'the closer is waiting on the lock');
  // What a takeover by chat-y writes under the lock.
  const record = JSON.stringify({ chat: 'chat-y', home, program: 'p', boundAt: new Date().toISOString() });
  rmSync(path.join(bindings, 'chat-e.json'));
  writeFileSync(claim, record);
  writeFileSync(path.join(bindings, 'chat-y.json'), record);
  rmSync(lock);
  assert.equal(await done, 'OK');
  assert.deepEqual(programChats(home, 'p', env), ['chat-y']);
});
