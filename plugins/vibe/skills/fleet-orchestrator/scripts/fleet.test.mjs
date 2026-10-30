import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LoadBasis, loadedSkillEvidence } from '../../vibe/scripts/loaded-skill.mjs';
import { writeRemoteCodexStub } from './fleet-test-support.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const FLEET = join(SCRIPTS, 'fleet.sh');
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
  // work-dir.mjs resolves the orchestration dir with the real node; every other node call is recorded.
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash\ncase "$1" in *work-dir.mjs|*skill-freshness.mjs) exec ${JSON.stringify(process.execPath)} "$@";; esac\nprintf "arg:%s\\n" "$@"\n`);
  writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${root}/ssh-args\nexec bash -c "\${@: -1}"\n`);
  writeRemoteCodexStub(bin, PLUGIN_ROOT);
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'ssh'), 0o755);
  const prompt = join(root, 'prompts', 'w1-01-start.md');
  mkdirSync(join(root, 'prompts'));
  writeFileSync(prompt, '$vibe ISS-1\n');
  const run = (args, env = {}) => spawnSync('bash', [FLEET, orch, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SLOT_LOCK_DIR: join(root, 'locks'), FLEET_LOAD: '0 8', ...env },
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
  assert.deepEqual(steer.slice(4), ['--prompt-file', f.prompt]);
});

test('prompt preflight refuses a stale loaded skill and a deleted plugin script', TIMEOUT, () => {
  const f = fixture('CODEX_MODEL=m\nCODEX_EFFORT=high\n');
  mkdirSync(join(f.orch, 'sessions'), { recursive: true });
  writeFileSync(join(f.orch, 'sessions', 'w1.json'), JSON.stringify({ threadId: 'same-chat', cwd: '/wt', loadedSkill: { ...loadEvidence('same-chat'), version: '1.0.85' } }));
  let result = f.run(['local', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--cwd', '/wt']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /loaded 1\.0\.85/);
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
    join(shipped, 'fleet-orchestrator/scripts/codex-session.mjs'), 'turn', join(f.root, 'remote', 'sessions'), 'w1',
    '--prompt-file', join(shipped, 'w1-01-start.md'), '--cwd', '/remote wt', '--effort', 'high',
      '--plugin-root', PLUGIN_ROOT,
  ]);
  for (const file of ['codex-fleet-monitor/scripts/liveness.mjs', 'fleet-orchestrator/scripts/codex-session.mjs', 'fleet-orchestrator/scripts/slot-lock.sh', 'fleet-orchestrator/scripts/load-check.sh', 'fleet-orchestrator/scripts/request-visual.mjs']) {
    assert.ok(existsSync(join(shipped, file)), file);
  }
  assert.equal(readFileSync(join(shipped, 'w1-01-start.md'), 'utf8'), '$vibe ISS-1\n');
  assert.match(readFileSync(join(f.root, 'ssh-args'), 'utf8'), /^-o\nConnectTimeout=10\n-o\nServerAliveInterval=15\nbox\n/);
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

// A module codex-session.mjs imports that fleet.sh does not ship fails every remote session at load time.
test('a remote session ships every module codex-session.mjs and skill-freshness.mjs import, transitively', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'CODEX_EFFORT=high\n'));
  const result = f.run(['remote', 'session', 'last', 'w1']);
  assert.equal(result.status, 0, result.stderr);
  const shipped = join(f.root, 'remote', 'sessions', '.fleet-orchestrator');
  const skills = join(SCRIPTS, '..', '..');
  const pending = ['fleet-orchestrator/scripts/codex-session.mjs', 'fleet-orchestrator/scripts/skill-freshness.mjs'];
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
  assert.ok(seen.has('codex-fleet-monitor/scripts/thread-sidebar.mjs'));
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
  const busy = f.run(['local', 'slot', 'heavy', 'w1 tests', f.root, 'echo', 'ran'], { FLEET_LOAD: '34 18' });
  assert.equal(busy.status, 4);
  assert.equal(busy.stdout, '');
  assert.match(busy.stderr, /load 34 on 18 cores is over 1\.5 per core.*run this heavy check on the other machine/);
  assert.equal(f.run(['local', 'slot', 'heavy', 'w1 tests', f.root, 'echo', 'ran'], { FLEET_LOAD: '20 18' }).stdout, 'ran\n');
  assert.equal(f.run(['local', 'slot', 'heavy', 'w1 tests', f.root, 'echo', 'ran'], { FLEET_LOAD: '34 18', FLEET_FORCE_HERE: '1' }).stdout, 'ran\n');
  assert.equal(f.run(['local', 'slot', 'shared', 'w1 shared', f.root, 'echo', 'ran'], { FLEET_LOAD: '34 18' }).stdout, 'ran\n', 'only heavy slots are load-checked');
});
