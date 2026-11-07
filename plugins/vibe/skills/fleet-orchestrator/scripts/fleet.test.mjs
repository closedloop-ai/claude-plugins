import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LoadBasis, loadedSkillEvidence } from '../../vibe/scripts/loaded-skill.mjs';
import { writeLoopbackSsh, writeRemoteCodexStub } from './fleet-test-support.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const FLEET = join(SCRIPTS, 'fleet.sh');
const LOAD_CHECK = join(SCRIPTS, 'load-check.sh');
const TIMEOUT = { timeout: 20_000 };
const RELATIVE_IMPORT = /^import [^;]*? from (['"])(\.{1,2}\/[^'"]+)\1;/gms;
const PLUGIN_ROOT = realpathSync(join(SCRIPTS, '..', '..', '..'));
const loadEvidence = (actor = 'test', runtime = 'codex') => loadedSkillEvidence(actor, runtime, PLUGIN_ROOT, 'fleet-orchestrator', LoadBasis.InstalledAtSpawn);

/**
 * An orchestration dir plus a bin dir that shadows `node` (prints its argv, one per line) and `ssh`
 * (records its argv and runs the remote command line locally with bash, stdin included).
 */
function fixture(config) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-')));
  const orch = join(root, 'orch');
  const bin = join(root, 'bin');
  mkdirSync(orch);
  mkdirSync(bin);
  if (config !== undefined) writeFileSync(join(orch, 'config.env'), config);
  writeFileSync(join(orch, 'plugin-version.json'), JSON.stringify({ status: 'current', runtime: 'codex', checkedAt: 'now', loadedSkill: loadEvidence(), harnesses: [] }));
  // Resolution, freshness and owned admission use real Node; other operational calls remain recorded.
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash\ncase "$1" in *work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*slot-lock-child.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *e2e-lock.mjs) [ "$2" = intent ] && exec ${JSON.stringify(process.execPath)} "$@";; esac\nprintf "arg:%s\\n" "$@"\n`);
  writeLoopbackSsh(bin, join(root, 'ssh-args'));
  writeFileSync(join(bin, 'cut'), '#!/bin/sh\nprintf "%s\\n" "${FLEET_TEST_LOAD:-0}"\n');
  writeFileSync(join(bin, 'sysctl'), '#!/bin/sh\nprintf "{ %s 0 0 }\\n" "${FLEET_TEST_LOAD:-0}"\n');
  writeFileSync(join(bin, 'getconf'), '#!/bin/sh\nprintf "%s\\n" "${FLEET_TEST_CORES:-8}"\n');
  writeRemoteCodexStub(bin, PLUGIN_ROOT);
  for (const command of ['node', 'ssh', 'cut', 'sysctl', 'getconf']) chmodSync(join(bin, command), 0o755);
  const prompt = join(root, 'prompts', 'w1-01-start.md');
  mkdirSync(join(root, 'prompts'));
  writeFileSync(prompt, '$vibe ISS-1\n');
  const run = (args, env = {}) => spawnSync('bash', [FLEET, orch, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SLOT_LOCK_DIR: join(root, 'locks'), ...env },
  });
  const argv = (result) => result.stdout.split('\n').filter((l) => l.startsWith('arg:')).map((l) => l.slice(4));
  return { root, orch, prompt, run, argv };
}

const remoteConfig = (root, extra = '') => `REMOTE_HOST=box\nREMOTE_STATE_DIR=${root}/remote/sessions\nREMOTE_SHELL="bash -c"\n${extra}`;

function remotePlugin(root, version, withGate) {
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'skills', 'vibe'), { recursive: true });
  mkdirSync(join(root, 'skills', 'fleet-orchestrator'), { recursive: true });
  mkdirSync(join(root, 'skills', 'handoff', 'scripts'), { recursive: true });
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'vibe', version }));
  writeFileSync(join(root, 'skills', 'vibe', 'SKILL.md'), '# vibe\n');
  writeFileSync(join(root, 'skills', 'fleet-orchestrator', 'SKILL.md'), '# fleet\n');
  if (withGate) writeFileSync(join(root, 'skills', 'handoff', 'scripts', 'handoff-gate.mjs'), 'export {};\n');
}

test('a single machine needs no config: local sessions use <orchDir>/sessions', TIMEOUT, () => {
  const f = fixture();
  const result = f.run(['local', 'session', 'last', 'w1']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.argv(result), [join(SCRIPTS, 'codex-session.mjs'), 'last', join(f.orch, 'sessions'), 'w1']);
  assert.ok(existsSync(join(f.orch, 'sessions')));
});

test('turn takes model and effort from config unless given; other commands get neither', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), `LOCAL_STATE_DIR=${f.root}/state\nCODEX_MODEL=main-model\nCODEX_EFFORT=high\n`);
  const turn = f.argv(f.run(['local', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--cwd', '/wt']));
  assert.deepEqual(turn.slice(1), ['turn', join(f.root, 'state'), 'w1', '--prompt-file', f.prompt, '--cwd', '/wt', '--model', 'main-model', '--effort', 'high', '--plugin-root', PLUGIN_ROOT]);
  const explicit = f.argv(f.run(['local', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--effort=medium', '--model', 'other']));
  assert.deepEqual(explicit.slice(4), ['--prompt-file', f.prompt, '--effort=medium', '--model', 'other', '--plugin-root', PLUGIN_ROOT]);
  mkdirSync(join(f.root, 'state'), { recursive: true });
  writeFileSync(join(f.root, 'state', 'w1.json'), JSON.stringify({ threadId: 'test', cwd: '/wt', loadedSkill: loadEvidence('test') }));
  const steer = f.argv(f.run(['local', 'session', 'steer', 'w1', '--prompt-file', f.prompt]));
  assert.deepEqual(steer.slice(4), ['--prompt-file', f.prompt, '--plugin-root', PLUGIN_ROOT]);
});

test('prompt preflight delegates stale turns to checked idle migration, admits reload-only steers and refuses deleted scripts', TIMEOUT, () => {
  const f = fixture('CODEX_MODEL=m\nCODEX_EFFORT=high\n');
  mkdirSync(join(f.orch, 'sessions'), { recursive: true });
  writeFileSync(join(f.orch, 'sessions', 'w1.json'), JSON.stringify({ threadId: 'same-chat', cwd: '/wt', loadedSkill: { ...loadEvidence('same-chat'), version: '1.0.85' } }));
  let result = f.run(['local', 'session', 'steer', 'w1', '--prompt-file', f.prompt]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /loaded 1\.0\.85/);
  writeFileSync(f.prompt, 'VIBE_SKILL_RELOAD v1\ncontinue');
  result = f.run(['local', 'session', 'steer', 'w1', '--prompt-file', f.prompt]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  writeFileSync(f.prompt, 'VIBE_SKILL_RELOAD v1');
  result = f.run(['local', 'session', 'steer', 'w1', '--prompt-file', f.prompt]);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(f.prompt, '$vibe ISS-1\n');
  result = f.run(['local', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--cwd', '/wt']);
  assert.equal(result.status, 0, result.stderr); // Idle migration replaces blanket stale-turn refusal.
  assert.ok(f.argv(result).includes('--plugin-root'));
  result = f.run(['local', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--plugin-root', '/old/release']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /bound to the target host installation/);
  writeFileSync(join(f.orch, 'sessions', 'w1.json'), JSON.stringify({ threadId: 'reloaded', cwd: '/wt', loadedSkill: loadEvidence('reloaded') }));
  writeFileSync(f.prompt, '$vibe ISS-1\nRun handoff/scripts/qa-merge-order.mjs.\n');
  result = f.run(['local', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--cwd', '/wt']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /qa-merge-order\.mjs: plugin script does not exist/);
  writeFileSync(f.prompt, '$vibe ISS-1\nRun handoff/scripts/handoff-gate.mjs.\n');
  result = f.run(['local', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--cwd', '/wt']);
  assert.equal(result.status, 0, result.stderr);
});

test('a remote session ships the scripts and prompt file and runs in the remote state dir', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'CODEX_EFFORT=high\n'));
  const result = f.run(['remote', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--cwd', '/remote wt']);
  assert.equal(result.status, 0, result.stderr);
  const shipped = join(f.root, 'remote', 'sessions', '.fleet-orchestrator');
  assert.deepEqual(f.argv(result), [
    join(shipped, 'skills/fleet-orchestrator/scripts/codex-session.mjs'), 'turn', join(f.root, 'remote', 'sessions'), 'w1',
    '--prompt-file', join(shipped, 'w1-01-start.md'), '--cwd', '/remote wt', '--effort', 'high',
      '--plugin-root', PLUGIN_ROOT,
  ]);
  for (const file of ['codex-fleet-monitor/scripts/liveness.mjs', 'fleet-orchestrator/scripts/codex-session.mjs', 'fleet-orchestrator/scripts/slot-lock.sh', 'fleet-orchestrator/scripts/load-check.sh', 'fleet-orchestrator/scripts/request-visual.mjs']) {
    assert.ok(existsSync(join(shipped, "skills", file)), file);
  }
  assert.equal(readFileSync(join(shipped, 'w1-01-start.md'), 'utf8'), '$vibe ISS-1\n');
  assert.match(readFileSync(join(f.root, 'ssh-args'), 'utf8'), /^-o\nConnectTimeout=10\n-o\nServerAliveInterval=15\nbox\n/);
});

test('remote cleanup ships the exact board and runs on the owning host with its session state', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  writeFileSync(join(f.orch, 'board.json'), JSON.stringify({ writers: { w1: { where: 'remote', pr: '42' } } }));
  const remoteRoot = join(f.root, 'remote-vibe-cleanup');
  const version = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'))).version;
  remotePlugin(remoteRoot, version, true);
  const result = f.run(['remote', 'cleanup'], { FAKE_REMOTE_PLUGIN_ROOT: remoteRoot });
  assert.equal(result.status, 0, result.stderr);
  const shipped = join(f.root, 'remote', 'sessions', '.fleet-orchestrator');
  assert.deepEqual(JSON.parse(readFileSync(join(shipped, 'board.json'), 'utf8')),
    { writers: { w1: { where: 'remote', pr: '42' } } });
  assert.deepEqual(f.argv(result), [join(remoteRoot, 'skills', 'vibe', 'scripts', 'e2e-lock.mjs'),
    'cleanup-sweep', 'sweep', '--orch-dir', shipped, '--where', 'remote', '--state-dir', join(f.root, 'remote', 'sessions')]);
});

test('remote preflight uses the target host plugin and target actor state', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'CODEX_EFFORT=high\n'));
  writeFileSync(f.prompt, '$vibe ISS-1\nRun handoff/scripts/handoff-gate.mjs.\n');
  const remoteRoot = join(f.root, 'remote-vibe');
  remotePlugin(remoteRoot, '1.0.85', true);
  let result = f.run(['remote', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--cwd', '/remote wt'], { FAKE_REMOTE_PLUGIN_ROOT: remoteRoot });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /target host has vibe 1\.0\.85/);
  writeFileSync(join(remoteRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'vibe', version: JSON.parse(readFileSync(join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'))).version }));
  rmSync(join(remoteRoot, 'skills', 'handoff', 'scripts', 'handoff-gate.mjs'));
  result = f.run(['remote', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--cwd', '/remote wt'], { FAKE_REMOTE_PLUGIN_ROOT: remoteRoot });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /handoff-gate\.mjs: plugin script does not exist/);
  writeFileSync(join(remoteRoot, 'skills', 'handoff', 'scripts', 'handoff-gate.mjs'), 'export {};\n');
  result = f.run(['remote', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--cwd', '/remote wt'], { FAKE_REMOTE_PLUGIN_ROOT: remoteRoot });
  assert.equal(result.status, 0, result.stderr);
});

// A writer thread saved before vibe 1.1.23 has no loadedSkill and nothing can add one; refusing it
// stranded every running fleet writer the moment vibe updated.
test('a writer thread saved before loaded-skill evidence keeps working, local and remote, with its scripts still checked', TIMEOUT, () => {
  const f = fixture('CODEX_MODEL=m\nCODEX_EFFORT=high\n');
  const legacy = { threadId: 'pre-1-1-23', cwd: '/wt', model: 'm', effort: 'high', turns: [{ turnId: 'U1', kind: 'turn', promptFile: f.prompt }], ticket: 'ISS-1' };
  mkdirSync(join(f.orch, 'sessions'), { recursive: true });
  writeFileSync(join(f.orch, 'sessions', 'w1.json'), JSON.stringify(legacy));
  writeFileSync(f.prompt, 'Continue with the review fixes.\n');
  for (const command of ['turn', 'steer']) {
    const result = f.run(['local', 'session', command, 'w1', '--prompt-file', f.prompt]);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /predates loaded-skill evidence \(vibe before 1\.1\.23\); its loaded skill is not checked/);
  }
  writeFileSync(f.prompt, 'Run handoff/scripts/qa-merge-order.mjs.\n');
  const removed = f.run(['local', 'session', 'steer', 'w1', '--prompt-file', f.prompt]);
  assert.equal(removed.status, 2, removed.stdout + removed.stderr);
  assert.match(removed.stderr, /qa-merge-order\.mjs: plugin script does not exist/);
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'CODEX_EFFORT=high\n'));
  mkdirSync(join(f.root, 'remote', 'sessions'), { recursive: true });
  writeFileSync(join(f.root, 'remote', 'sessions', 'w1.json'), JSON.stringify(legacy));
  writeFileSync(f.prompt, 'Continue with the review fixes.\n');
  const remote = f.run(['remote', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--cwd', '/remote wt']);
  assert.equal(remote.status, 0, remote.stderr);
  assert.match(remote.stderr, /predates loaded-skill evidence/);
});

// A module codex-session.mjs imports that fleet.sh does not ship fails every remote session at load time.
test('a remote session ships every module codex-session.mjs and skill-freshness.mjs import, transitively', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'CODEX_EFFORT=high\n'));
  const result = f.run(['remote', 'session', 'last', 'w1']);
  assert.equal(result.status, 0, result.stderr);
  const shipped = join(f.root, 'remote', 'sessions', '.fleet-orchestrator');
  const skills = join(SCRIPTS, '..', '..', '..');
  const pending = ['skills/fleet-orchestrator/scripts/codex-session.mjs', 'skills/fleet-orchestrator/scripts/skill-freshness.mjs'];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(existsSync(join(shipped, file)), `${file} is imported but not shipped`);
    for (const [, , spec] of readFileSync(join(skills, file), 'utf8').matchAll(RELATIVE_IMPORT)) {
      pending.push(relative(skills, join(skills, dirname(file), spec)));
    }
  }
  assert.ok(seen.has('skills/codex-fleet-monitor/scripts/thread-sidebar.mjs'));
});

test('remote without REMOTE_HOST fails and names the missing key', TIMEOUT, () => {
  const f = fixture('CODEX_EFFORT=high\n');
  const result = f.run(['remote', 'session', 'last', 'w1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /set REMOTE_HOST in .*config\.env/);
});

test('remote without the codex CLI names the missing prerequisite and target host', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  rmSync(join(f.root, 'bin', 'codex'));
  const result = f.run(['remote', 'session', 'last', 'w1'], { PATH: `${join(f.root, 'bin')}:/usr/bin:/bin` });
  assert.equal(result.status, 127, result.stdout + result.stderr);
  assert.match(result.stderr, /fleet: codex CLI is missing on remote host box/);
  assert.match(result.stderr, /install Codex CLI/);
  assert.doesNotMatch(result.stderr, /bash:.*codex: command not found/);
});

test('slot runs in the given dir with the machine\'s heavy slot count', TIMEOUT, () => {
  const f = fixture('HEAVY_SLOTS=3\n');
  const locks = join(f.root, 'locks');
  for (const n of [1, 2]) {
    mkdirSync(join(locks, `heavy-${n}.lock`), { recursive: true });
    writeFileSync(join(locks, `heavy-${n}.lock`, 'pid'), `${process.pid}\n`);
  }
  const result = f.run(['local', 'slot', 'heavy', 'w1 tests', f.root, 'bash', '-c', 'pwd; ls "$SLOT_LOCK_DIR"']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${f.root}\nheavy-1.lock\nheavy-2.lock\nheavy-3.lock\n`);
  const single = f.run(['local', 'slot', 'shared', 'w1 shared', f.root, 'ls', locks]);
  assert.equal(single.stdout, 'heavy-1.lock\nheavy-2.lock\nshared-1.lock\n');
});

test('a remote slot uses REMOTE_HEAVY_SLOTS and the remote dir', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'HEAVY_SLOTS=1\nREMOTE_HEAVY_SLOTS=2\n'));
  const locks = join(f.root, 'locks');
  mkdirSync(join(locks, 'heavy-1.lock'), { recursive: true });
  writeFileSync(join(locks, 'heavy-1.lock', 'pid'), `${process.pid}\n`);
  const dir = join(f.root, 'remote wt');
  mkdirSync(dir);
  const result = f.run(['remote', 'slot', 'heavy', 'w2', dir, 'bash', '-c', 'pwd; ls "$SLOT_LOCK_DIR"']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${dir}\nheavy-1.lock\nheavy-2.lock\n`);
});

test('typed local and remote E2E build slots route a post-acquisition disk preflight', TIMEOUT, () => {
  const f = fixture();
  const local = f.run(['local', 'slot', 'heavy', 'writer', f.root, '--containerized-e2e-build',
    'node', 'e2e/run-containerized.sh']);
  assert.equal(local.status, 0, local.stderr);
  assert.ok(f.argv(local).some((arg) => arg.endsWith('e2e-lock.mjs')), 'local slot has disk preflight');
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const remote = f.run(['remote', 'slot', 'heavy', 'writer', f.root, '--containerized-e2e-build',
    'node', 'e2e/run-containerized.sh']);
  assert.equal(remote.status, 0, remote.stderr);
  const installed = join(PLUGIN_ROOT, 'skills', 'vibe', 'scripts', 'e2e-lock.mjs');
  assert.ok(f.argv(remote).includes(installed), 'remote slot invokes the version-checked installed helper');
  const refused = f.run(['remote', 'slot', 'heavy', 'writer', f.root, '--containerized-e2e-build',
    'node', 'e2e/run-containerized.sh'], { FAKE_REMOTE_PLUGIN_ROOT: join(f.root, 'missing-vibe') });
  assert.equal(refused.status, 78);
  assert.match(refused.stderr, /remote vibe plugin is missing or not version/);
});

test('deterministic runner and Dagger e-2-e build shapes get preflight; --no-build skips it', TIMEOUT, () => {
  const f = fixture();
  const runner = f.run(['local', 'slot', 'heavy', 'writer', f.root, 'node', 'e2e/run-containerized.sh']);
  assert.equal(runner.status, 0, runner.stderr);
  assert.ok(f.argv(runner).some((arg) => arg.endsWith('e2e-lock.mjs')));
  const dagger = join(f.root, 'bin', 'dagger');
  writeFileSync(dagger, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const built = f.run(['local', 'slot', 'heavy', 'writer', f.root, 'dagger', 'call', 'e-2-e']);
  assert.equal(built.status, 0, built.stderr);
  assert.ok(f.argv(built).some((arg) => arg.endsWith('e2e-lock.mjs')));
  const reused = f.run(['local', 'slot', 'heavy', 'writer', f.root, 'node', 'e2e/run-containerized.sh', '--no-build']);
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(f.argv(reused).some((arg) => arg.endsWith('e2e-lock.mjs')), false);
});

test('ordinary heavy checks have no Docker admission preflight', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.root, 'bin', 'df'), "#!/bin/sh\nprintf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' '/dev/disk 100000000 1 62499999 1% /'\n", { mode: 0o755 });
  for (const command of ['lint', 'typecheck', 'test', 'storybook']) {
    const result = f.run(['local', 'slot', 'heavy', 'writer', f.root, 'node', command],
      { VIBE_E2E_DOCKER: join(f.root, 'missing-docker') });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.argv(result).some((arg) => arg.endsWith('e2e-lock.mjs')), false, command);
  }
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const remote = f.run(['remote', 'slot', 'heavy', 'writer', f.root, 'node', 'typecheck'],
    { VIBE_E2E_DOCKER: join(f.root, 'missing-docker') });
  assert.equal(remote.status, 0, remote.stderr);
  assert.equal(f.argv(remote).some((arg) => arg.endsWith('e2e-lock.mjs')), false);
});

test('rejects unknown machines and actions with usage', TIMEOUT, () => {
  const f = fixture();
  for (const args of [['elsewhere', 'session', 'last', 'w1'], ['local', 'deploy'], ['local', 'session', 'last'], ['local', 'slot', 'heavy', 'w1', '/']]) {
    const result = f.run(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /Usage: fleet\.sh/);
  }
});

test('a heavy slot refuses a machine whose load per core is over the limit and names the other machine', TIMEOUT, () => {
  const f = fixture('HEAVY_SLOTS=2\n');
  const evaluate = (load, cores, env = {}) => spawnSync('bash', [LOAD_CHECK, '--evaluate', String(load), String(cores)], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  const busy = evaluate(34, 18);
  assert.equal(busy.status, 4);
  assert.equal(busy.stdout, '');
  assert.match(busy.stderr, /load 34 on 18 cores is over 1\.5 per core.*run this heavy check on the other machine/);
  const localBusy = f.run(['local', 'slot', 'heavy', 'w1 tests', f.root, 'echo', 'must-not-run'],
    { FLEET_TEST_LOAD: '34', FLEET_TEST_CORES: '18' });
  assert.equal(localBusy.status, 4, localBusy.stdout + localBusy.stderr);
  assert.doesNotMatch(localBusy.stdout, /must-not-run/);
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const remoteBusy = f.run(['remote', 'slot', 'heavy', 'w2 tests', f.root, 'echo', 'must-not-run'],
    { FLEET_TEST_LOAD: '34', FLEET_TEST_CORES: '18' });
  assert.equal(remoteBusy.status, 4, remoteBusy.stdout + remoteBusy.stderr);
  assert.doesNotMatch(remoteBusy.stdout, /must-not-run/);
  assert.equal(evaluate(20, 18).status, 0);
  const missingReason = evaluate(34, 18, { FLEET_FORCE_HERE: '1' });
  assert.equal(missingReason.status, 4);
  assert.match(missingReason.stderr, /requires an operator-set reason/);
  const forced = f.run(['local', 'slot', 'heavy', 'w1 tests', f.root, 'cat', join(f.root, 'locks', 'heavy-1.lock', 'owner')],
    { MAX_LOAD_PER_CORE: '1000000', FLEET_FORCE_HERE: '1', FLEET_FORCE_REASON: 'operator kept the signed release lane local' });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /force reason: operator kept the signed release lane local/);
  const ceiling = evaluate(252, 18, { FLEET_FORCE_HERE: '1', FLEET_FORCE_REASON: 'operator requested local verification' });
  assert.equal(ceiling.status, 4);
  assert.match(ceiling.stderr, /hard ceiling of 4 per core/);
  const remoteForced = f.run(['remote', 'slot', 'heavy', 'w2 tests', f.root, 'cat', join(f.root, 'locks', 'heavy-1.lock', 'owner')],
    { MAX_LOAD_PER_CORE: '1000000', FLEET_FORCE_HERE: '1', FLEET_FORCE_REASON: 'operator kept the remote signing lane' });
  assert.equal(remoteForced.status, 0, remoteForced.stderr);
  assert.match(remoteForced.stdout, /force reason: operator kept the remote signing lane/);
  const emptyReason = f.run(['local', 'slot', 'shared', 'w3 tests', f.root, 'cat', join(f.root, 'locks', 'shared-1.lock', 'owner')],
    { FLEET_FORCE_HERE: '1', FLEET_FORCE_REASON: '' });
  assert.equal(emptyReason.status, 0, emptyReason.stderr);
  assert.doesNotMatch(emptyReason.stdout, /force reason:/, 'an empty reason is never recorded');
  assert.equal(f.run(['local', 'slot', 'shared', 'w1 shared', f.root, 'echo', 'ran']).stdout, 'ran\n', 'only heavy slots are load-checked');
  const skill = readFileSync(join(SCRIPTS, '..', 'SKILL.md'), 'utf8');
  assert.match(skill, /Writers never set `FLEET_FORCE_HERE`[\s\S]*or `FLEET_LOAD`/);
  assert.doesNotMatch(readFileSync(LOAD_CHECK, 'utf8'), /FLEET_LOAD/, 'production admission has no caller-supplied load override');
});
