import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, loadEvidence, PLUGIN_ROOT, remoteConfig, successfulRemoteWriter, writeLoopbackSsh, writeRemoteCodexStub } from './fleet-test-support.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const FLEET = join(SCRIPTS, 'fleet.sh');
const LOAD_CHECK = join(SCRIPTS, 'load-check.sh');
const TIMEOUT = { timeout: 20_000 };
const RELATIVE_IMPORT = /^import [^;]*? from (['"])(\.{1,2}\/[^'"]+)\1;/gms;
const VIBE_CORE_LOAD = /\b(?:vibeCore|runVibeCoreMain)\("([^"]+)"\)/g;
/** Exercise the shipped remote launcher while keeping App Server calls inside a nonexistent test socket. */
function realRemoteSession(f) {
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'CODEX_EFFORT=high\n'));
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *ship-plugins.mjs|*work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs|*codex-session.mjs) exec ${JSON.stringify(process.execPath)} "$@";; esac\nprintf "arg:%s\\n" "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  writeFileSync(join(f.root, 'bin', 'codex'), `#!${process.execPath}\nif (process.argv.slice(2).join(' ') === 'app-server daemon start') console.log(JSON.stringify({ socketPath: ${JSON.stringify(join(f.root, 'missing.sock'))} }));\nelse console.log(JSON.stringify({ installed: [{ name: 'vibe', installed: true, enabled: true, source: { path: ${JSON.stringify(PLUGIN_ROOT)} } }] }));\n`);
  chmodSync(join(f.root, 'bin', 'codex'), 0o755);
  const worktree = join(f.root, 'pre-made-worktree');
  const created = spawnSync('git', ['init', '-q', '-b', 'vibe/example', worktree], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  return worktree;
}

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
  const remoteArgv = f.argv(result);
  assert.deepEqual(remoteArgv.slice(0, -2), [
    join(shipped, 'plugins/vibe/skills/fleet-orchestrator/scripts/codex-session.mjs'), 'turn', join(f.root, 'remote', 'sessions'), 'w1',
    '--prompt-file', join(shipped, 'w1-01-start.md'), '--cwd', '/remote wt', '--effort', 'high',
      '--plugin-root', PLUGIN_ROOT,
  ]);
  assert.equal(remoteArgv.at(-2), '--fleet-claim');
  assert.match(remoteArgv.at(-1), /\/w1\.preflight\.[^/]+\.json$/);
  for (const file of ['codex-fleet-monitor/scripts/liveness.mjs', 'fleet-orchestrator/scripts/codex-session.mjs', 'fleet-orchestrator/scripts/slot-lock.sh', 'fleet-orchestrator/scripts/load-check.sh', 'fleet-orchestrator/scripts/request-visual.mjs']) {
    assert.ok(existsSync(join(shipped, "plugins", "vibe", "skills", file)), file);
  }
  assert.equal(readFileSync(join(shipped, 'w1-01-start.md'), 'utf8'), '$vibe ISS-1\n');
  assert.match(readFileSync(join(f.root, 'ssh-args'), 'utf8'), /^-o\nConnectTimeout=10\n-o\nServerAliveInterval=15\nbox\n/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.orch, 'sessions', 'w1.remote.json'), 'utf8')),
    { host: 'box', stateDir: join(f.root, 'remote', 'sessions') });
});

test('a remote new writer refuses an existing worktree without a Vibe record on the target host', TIMEOUT, () => {
  const f = fixture();
  const worktree = realRemoteSession(f);
  const result = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /not-yet-existing path.*vibe new.*cloud-worker\.mjs.*pr-takeover/s);
  assert.equal(existsSync(join(f.root, 'remote', 'sessions', 'writer.json')), false);
  assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.json')), false);
  assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.pending.json')), false);
  const rejected = readdirSync(join(f.root, 'remote', 'sessions')).filter((name) => name === 'writer.preflight-rejected.json');
  assert.equal(rejected.length, 1, 'the refusal has a durable pre-start receipt');
  const receipt = JSON.parse(readFileSync(join(f.root, 'remote', 'sessions', rejected[0]), 'utf8'));
  assert.equal(receipt.stage, 'preflight-rejected');
  assert.match(receipt.attempt, /^\d+-\d+-\d+$/);
});

test('a refused remote new writer preserves an existing local remote marker byte for byte', TIMEOUT, () => {
  const f = fixture();
  const worktree = realRemoteSession(f);
  const marker = join(f.orch, 'sessions', 'writer.remote.json');
  mkdirSync(dirname(marker), { recursive: true });
  const previous = `{"host":"box", "stateDir":${JSON.stringify(join(f.root, 'remote', 'sessions'))}}\n`;
  writeFileSync(marker, previous);
  const result = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /not-yet-existing path.*vibe new.*cloud-worker\.mjs.*pr-takeover/s);
  assert.equal(readFileSync(marker, 'utf8'), previous);
  assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.pending.json')), false);
});

test('current pre-start refusal wins over an unrelated saved remote state', TIMEOUT, () => {
  const f = fixture();
  const worktree = realRemoteSession(f);
  const marker = join(f.orch, 'sessions', 'writer.remote.json');
  mkdirSync(dirname(marker), { recursive: true });
  const previous = `{"host":"box", "stateDir":${JSON.stringify(join(f.root, 'remote', 'sessions'))}}\n`;
  writeFileSync(marker, previous);
  const remoteStateDir = join(f.root, 'remote', 'sessions');
  mkdirSync(remoteStateDir, { recursive: true });
  const priorState = '{"threadId":"prior-thread","cwd":"/fixture","turns":[]}\n';
  writeFileSync(join(remoteStateDir, 'writer.json'), priorState);
  const result = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(readFileSync(marker, 'utf8'), previous);
  assert.equal(readFileSync(join(remoteStateDir, 'writer.json'), 'utf8'), priorState);
  assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.pending.json')), false);
});

test('a conflicting prior-host marker refuses a new remote start without losing ownership', TIMEOUT, () => {
  const f = fixture();
  const worktree = successfulRemoteWriter(f);
  const marker = join(f.orch, 'sessions', 'writer.remote.json');
  mkdirSync(dirname(marker), { recursive: true });
  const prior = '{"host":"prior-host","stateDir":"prior-state"}\n';
  writeFileSync(marker, prior);
  const result = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /existing remote marker.*different|conflicting remote marker/i);
  assert.equal(readFileSync(marker, 'utf8'), prior);
  assert.equal(existsSync(join(f.root, 'remote', 'sessions', 'writer.json')), false);
  assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.pending.json')), false);
});

test('remote turn establishes local marker readiness before starting the writer', TIMEOUT, () => {
  const f = fixture();
  const worktree = successfulRemoteWriter(f);
  writeFileSync(join(f.orch, 'sessions'), 'not a directory\n');
  const result = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(f.root, 'remote', 'sessions', 'writer.json')), false,
    'no remote thread may start when its local ownership marker cannot be prepared');
});

test('a legacy pending directory blocks another remote turn without overwriting its evidence', TIMEOUT, () => {
  const f = fixture();
  const worktree = successfulRemoteWriter(f);
  const legacy = join(f.orch, 'sessions', 'writer.remote.pending');
  mkdirSync(legacy, { recursive: true });
  const partial = '{"pid":';
  writeFileSync(join(legacy, 'owner.json'), partial);
  const result = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(legacy, 'owner.json'), 'utf8'), partial);
  assert.equal(existsSync(join(f.root, 'remote', 'sessions', 'writer.json')), false);
});

test('remote marker promotion failure retains a recoverable pending record', TIMEOUT, () => {
  const f = fixture();
  const worktree = successfulRemoteWriter(f);
  const failedOnce = join(f.root, 'marker-promotion-failed');
  writeFileSync(join(f.root, 'bin', 'mv'), `#!/usr/bin/env bash\nif [[ "$2" == *.remote.json && ! -e ${JSON.stringify(failedOnce)} ]]; then : > ${JSON.stringify(failedOnce)}; exit 1; fi\nexec /bin/mv "$@"\n`);
  chmodSync(join(f.root, 'bin', 'mv'), 0o755);
  const marker = join(f.orch, 'sessions', 'writer.remote.json');
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  const result = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(f.root, 'remote', 'sessions', 'writer.json')), 'the remote launcher succeeded');
  assert.equal(existsSync(marker), false);
  assert.ok(existsSync(pending), 'prepared marker survives for exact recovery');
  const recovered = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')),
    { host: 'box', stateDir: join(f.root, 'remote', 'sessions') });
  assert.equal(existsSync(pending), false);
});

test('recover-marker uses the host and state directory saved in pending after config changes', TIMEOUT, () => {
  const f = fixture();
  const worktree = successfulRemoteWriter(f);
  const failedOnce = join(f.root, 'marker-promotion-failed');
  writeFileSync(join(f.root, 'bin', 'mv'), `#!/usr/bin/env bash\nif [[ "$2" == *.remote.json && ! -e ${JSON.stringify(failedOnce)} ]]; then : > ${JSON.stringify(failedOnce)}; exit 1; fi\nexec /bin/mv "$@"\n`);
  chmodSync(join(f.root, 'bin', 'mv'), 0o755);
  const marker = join(f.orch, 'sessions', 'writer.remote.json');
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  const first = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.notEqual(first.status, 0, first.stdout + first.stderr);
  assert.ok(existsSync(pending));
  writeFileSync(join(f.orch, 'config.env'), 'REMOTE_SHELL="bash -c"\n');
  const recovered = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')),
    { host: 'box', stateDir: join(f.root, 'remote', 'sessions') });
  assert.equal(existsSync(pending), false);
  assert.match(readFileSync(join(f.root, 'ssh-args'), 'utf8'), /\nbox\n/);
});

test('an ambiguous remote failure after state creation keeps a recoverable pending marker', TIMEOUT, () => {
  const f = fixture();
  const worktree = successfulRemoteWriter(f, 1);
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  const marker = join(f.orch, 'sessions', 'writer.remote.json');
  const result = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(f.root, 'remote', 'sessions', 'writer.json')));
  assert.ok(existsSync(pending));
  assert.equal(existsSync(marker), false);
  const recovered = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')),
    { host: 'box', stateDir: join(f.root, 'remote', 'sessions') });
  assert.equal(existsSync(pending), false);
});

test('thread acceptance before remote state save never clears pending ownership', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'CODEX_EFFORT=high\n'));
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *ship-plugins.mjs|*work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *codex-session.mjs) mkdir -p "$3"; printf '%s\\n' '{"phase":"thread-created","threadId":"accepted-thread"}' > "$3/$4.launch.json"; exit 1;; esac\nprintf "arg:%s\\n" "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  const result = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt,
    '--cwd', join(f.root, 'future-worktree'), '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.notEqual(result.status, 0);
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  assert.ok(existsSync(pending));
  assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.json')), false);
  const recovered = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.notEqual(recovered.status, 0, 'a journal naming an accepted thread cannot prove absence');
  assert.ok(existsSync(pending));
});

test('missing state without an attempt-bound refusal receipt keeps pending ownership', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'CODEX_EFFORT=high\n'));
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *ship-plugins.mjs|*work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *codex-session.mjs) mkdir -p "$3"; printf '%s\\n' '{"phase":"may-have-started"}' > "$3/$4.launch.json"; exit 1;; esac\nprintf "arg:%s\\n" "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  const result = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt,
    '--cwd', join(f.root, 'future-worktree'), '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.notEqual(result.status, 0);
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  assert.ok(existsSync(pending));
  const recovered = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.notEqual(recovered.status, 0);
  assert.ok(existsSync(pending));
  assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.json')), false);
});

test('concurrent recovery cannot clear an in-flight remote launch before state appears', TIMEOUT, async () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'CODEX_EFFORT=high\n'));
  const release = join(f.root, 'release-remote-launch');
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *ship-plugins.mjs|*work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *codex-session.mjs) mkdir -p "$3"; printf '%s\\n' '{"phase":"may-have-started"}' > "$3/$4.launch.json"; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done; printf '%s\\n' '{"threadId":"remote-thread","cwd":"/fixture"}' > "$3/$4.json"; exit 0;; esac\nprintf "arg:%s\\n" "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  const child = spawn('bash', [FLEET, f.orch, 'remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt,
    '--cwd', join(f.root, 'future-worktree'), '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'], {
    env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, SLOT_LOCK_DIR: join(f.root, 'locks') },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.resume();
  const stopped = new Promise((resolve) => child.on('close', (status) => resolve(status)));
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  try {
    for (let attempt = 0; attempt < 200 && (!existsSync(pending)
      || !existsSync(join(f.root, 'remote', 'sessions', 'writer.launch.json'))); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(existsSync(pending), stderr);
    assert.ok(existsSync(join(f.root, 'remote', 'sessions', 'writer.launch.json')), stderr);
    const recovered = f.run(['remote', 'session', 'recover-marker', 'writer']);
    assert.notEqual(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.match(recovered.stderr, /dispatch.*(?:active|in flight)/i);
    assert.ok(existsSync(pending));
  } finally {
    writeFileSync(release, 'continue\n');
    const status = await stopped;
    assert.equal(status, 0, stderr);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(f.orch, 'sessions', 'writer.remote.json'), 'utf8')),
    { host: 'box', stateDir: join(f.root, 'remote', 'sessions') });
  assert.equal(existsSync(pending), false);
});

test('signal-stopped dispatch keeps uncertain thread-before-state ownership for recovery', TIMEOUT, async () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'CODEX_EFFORT=high\n'));
  const release = join(f.root, 'release-crashed-launch');
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *ship-plugins.mjs|*work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *codex-session.mjs) mkdir -p "$3"; printf '%s\\n' '{"phase":"may-have-started"}' > "$3/$4.launch.json"; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done; exit 1;; esac\nprintf "arg:%s\\n" "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  const child = spawn('bash', [FLEET, f.orch, 'remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt,
    '--cwd', join(f.root, 'future-worktree'), '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'], {
    env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, SLOT_LOCK_DIR: join(f.root, 'locks') },
  });
  child.stdout.resume(); child.stderr.resume();
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const closed = new Promise((resolve) => child.on('close', resolve));
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  try {
    for (let attempt = 0; attempt < 200 && (!existsSync(pending)
      || !existsSync(join(f.root, 'remote', 'sessions', 'writer.launch.json'))); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(existsSync(pending));
    assert.ok(existsSync(join(f.root, 'remote', 'sessions', 'writer.launch.json')));
    child.kill('SIGTERM');
    await exited;
    const recovered = f.run(['remote', 'session', 'recover-marker', 'writer']);
    assert.notEqual(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.ok(existsSync(pending));
    assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.json')), false);
  } finally {
    writeFileSync(release, 'stop\n');
    await closed;
  }
});

for (const stage of ['marker', 'owner']) {
  test(`a signal during ${stage} preparation leaves no published pending owner and permits retry`, TIMEOUT, async () => {
    const f = fixture();
    const worktree = successfulRemoteWriter(f);
    const entered = join(f.root, 'entered-preparation');
    const release = join(f.root, 'release-preparation');
    const realJq = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
    const match = stage === 'marker' ? '--arg host' : '--argjson pid';
    writeFileSync(join(f.root, 'bin', 'jq'), `#!/usr/bin/env bash\nif [[ "$*" == *${JSON.stringify(match)}* ]]; then ${stage === 'owner' ? "printf '{'" : ':'}; : > ${JSON.stringify(entered)}; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done; exit 1; fi\nexec ${JSON.stringify(realJq)} "$@"\n`);
    chmodSync(join(f.root, 'bin', 'jq'), 0o755);
    const child = spawn('bash', [FLEET, f.orch, 'remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt,
      '--cwd', worktree, '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'], {
      env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, SLOT_LOCK_DIR: join(f.root, 'locks') },
    });
    child.stdout.resume(); child.stderr.resume();
    const closed = new Promise((resolve) => child.on('close', resolve));
    try {
      for (let attempt = 0; attempt < 200 && !existsSync(entered); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(existsSync(entered), `${stage} preparation was not reached`);
      child.kill('SIGTERM');
    } finally {
      writeFileSync(release, 'stop\n');
      await closed;
    }
    assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.pending.json')), false,
      'an incomplete staging area must not publish or block the pending owner name');
    rmSync(join(f.root, 'bin', 'jq'));
    const retried = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
      '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
    assert.equal(retried.status, 0, retried.stdout + retried.stderr);
    assert.ok(existsSync(join(f.orch, 'sessions', 'writer.remote.json')));
  });
}

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
  assert.equal(existsSync(join(f.orch, 'sessions', 'w1.remote.pending.json')), false,
    'pre-dispatch skill refusal clears the exact pending attempt');
  writeFileSync(join(remoteRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'vibe', version: JSON.parse(readFileSync(join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'))).version }));
  rmSync(join(remoteRoot, 'skills', 'handoff', 'scripts', 'handoff-gate.mjs'));
  result = f.run(['remote', 'session', 'turn', 'w1', '--prompt-file', f.prompt, '--cwd', '/remote wt'], { FAKE_REMOTE_PLUGIN_ROOT: remoteRoot });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /handoff-gate\.mjs: plugin script does not exist/);
  assert.equal(existsSync(join(f.orch, 'sessions', 'w1.remote.pending.json')), false);
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
  // The shipped tree is the two plugins laid out as a checkout; vibe's scripts reach vibe-core's modules through vibeCore().
  const plugins = join(SCRIPTS, '..', '..', '..', '..');
  const pending = ['vibe/skills/fleet-orchestrator/scripts/codex-session.mjs', 'vibe/skills/fleet-orchestrator/scripts/skill-freshness.mjs'];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(existsSync(join(shipped, 'plugins', file)), `${file} is imported but not shipped`);
    const source = readFileSync(join(plugins, file), 'utf8');
    for (const [, , spec] of source.matchAll(RELATIVE_IMPORT)) pending.push(relative(plugins, join(plugins, dirname(file), spec)));
    for (const [, spec] of source.matchAll(VIBE_CORE_LOAD)) pending.push(join('vibe-core', spec));
  }
  assert.ok(seen.has('vibe/skills/codex-fleet-monitor/scripts/thread-sidebar.mjs'));
  assert.ok(seen.has('vibe-core/lib/vibe/scripts/session-record.mjs'));
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

/** A fleet fixture whose node runs capture-guard.mjs for real, with a capture worktree cloned from a bare origin. */
function captureFixture() {
  const f = fixture();
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *ship-plugins.mjs|*work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs|*capture-guard.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *e2e-lock.mjs) [ "$2" = intent ] && exec ${JSON.stringify(process.execPath)} "$@";; esac\nprintf "arg:%s\\n" "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(f.root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(f.root, 'clone', '-q', join(f.root, 'origin.git'), 'wt');
  const wt = join(f.root, 'wt');
  writeFileSync(join(wt, 'file.txt'), 'one\n');
  git(wt, 'add', 'file.txt');
  git(wt, '-c', 'user.name=t', '-c', 'user.email=fixture.invalid', 'commit', '-q', '-m', 'one');
  git(wt, 'push', '-q', 'origin', 'main');
  let n = 0;
  const spec = (fields) => {
    const file = join(f.root, `spec-${n += 1}.json`);
    writeFileSync(file, JSON.stringify({ ticket: 'ISS-1', ref: 'origin/main', pages: 2, states: 2, ...fields }));
    return file;
  };
  const entries = () => JSON.parse(readFileSync(join(f.orch, 'captures', 'ISS-1.json'), 'utf8')).captures;
  return { ...f, wt, spec, entries, git };
}

test('AC-3 a local --capture slot refuses a main ref already captured for the ticket before any slot or command', TIMEOUT, () => {
  const f = captureFixture();
  const first = f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', 'touch first-ran']);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(f.wt, 'first-ran')), 'the admitted capture ran in its worktree');
  assert.deepEqual(f.entries().map((entry) => [entry.status, entry.main, entry.owner]), [['ok', true, 'w1 shots']]);
  const again = f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', 'touch second-ran'],
    { FLEET_TEST_LOAD: '1000' });
  assert.equal(again.status, 79, again.stderr);
  assert.doesNotMatch(again.stderr, /load-check/, 'the guard refuses before the load check runs');
  assert.match(again.stderr, /^capture-guard: refused: [0-9a-f]{40} is a main commit already captured for ISS-1; reuse that baseline\./);
  assert.equal(existsSync(join(f.wt, 'second-ran')), false, 'a refused capture never runs');
  assert.equal(f.entries().length, 1, 'a refused capture records nothing');
  const undeclared = f.run(['local', 'slot', 'heavy', 'w1 tests', f.wt, 'bash', '-c', 'touch undeclared-ran']);
  assert.equal(undeclared.status, 0, undeclared.stderr);
  assert.ok(existsSync(join(f.wt, 'undeclared-ran')), 'a slot without --capture is unchanged');
});

test('a failed --capture command is recorded failed and never blocks the retry', TIMEOUT, () => {
  const f = captureFixture();
  const failed = f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', 'exit 3']);
  assert.equal(failed.status, 3, failed.stderr);
  assert.deepEqual(f.entries().map((entry) => entry.status), ['failed']);
  const retry = f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', 'true']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(f.entries().map((entry) => entry.status), ['failed', 'ok']);
});

test('AC-4 a remote --capture slot refuses an over-budget capture before the remote slot runs', TIMEOUT, () => {
  const f = captureFixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const over = f.run(['remote', 'slot', 'heavy', 'w2 shots', f.wt, '--capture', f.spec({ pages: 25, states: 10 }), 'bash', '-c', 'touch remote-ran']);
  assert.equal(over.status, 79, over.stderr);
  assert.match(over.stderr, /capture-guard: refused: 25 pages x 10 states is 250 shots, over the 240 shot budget for one capture/);
  assert.equal(existsSync(join(f.wt, 'remote-ran')), false, 'a refused capture never reaches the remote slot');
  const lastRemoteCall = readFileSync(join(f.root, 'ssh-args'), 'utf8');
  assert.match(lastRemoteCall, /capture-guard\.mjs(?:\\)? facts/);
  assert.doesNotMatch(lastRemoteCall, /slot-lock\.sh/);
  const admitted = f.run(['remote', 'slot', 'heavy', 'w2 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', 'touch remote-ran']);
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.ok(existsSync(join(f.wt, 'remote-ran')));
  assert.deepEqual(f.entries().map((entry) => [entry.status, entry.main]), [['ok', true]], 'the program ledger on the orchestrator host records the remote capture');
  assert.ok(Number.isInteger(f.entries()[0].seconds), 'the remote command time comes back');
  const rebaseline = f.run(['remote', 'slot', 'heavy', 'w2 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', 'true']);
  assert.equal(rebaseline.status, 79, rebaseline.stderr);
});

test('AC-4 a fleet capture records the seconds its command ran, and the measured rate refuses a later one over 20 minutes', { timeout: 40_000 }, () => {
  const f = captureFixture();
  f.git(f.wt, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(f.wt, 'branch.txt'), 'branch\n');
  f.git(f.wt, 'add', 'branch.txt');
  f.git(f.wt, '-c', 'user.name=t', '-c', 'user.email=fixture.invalid', 'commit', '-q', '-m', 'branch');
  const slow = f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', f.spec({ ref: 'HEAD', pages: 1, states: 1 }), 'bash', '-c', 'sleep 6']);
  assert.equal(slow.status, 0, slow.stderr);
  const [entry] = f.entries();
  assert.equal(entry.status, 'ok');
  assert.ok(Number.isInteger(entry.seconds) && entry.seconds >= 6, `seconds recorded: ${entry.seconds}`);
  const longer = f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', f.spec({ ref: 'HEAD', pages: 21, states: 10 }), 'bash', '-c', 'touch longer-ran']);
  assert.equal(longer.status, 79, longer.stderr);
  assert.match(longer.stderr, /capture-guard: refused: 210 shots at \d+ s each is about \d+ minutes, over the 20 minute budget for one capture/);
  assert.equal(existsSync(join(f.wt, 'longer-ran')), false);
});

/** Starts `fleet.sh <args>` like fixture's run, but asynchronously, with its exit as a promise. */
function startFleet(f, args, env = {}) {
  const child = spawn('bash', [FLEET, f.orch, ...args], {
    env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, SLOT_LOCK_DIR: join(f.root, 'locks'), ...env },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stderr })));
  return { child, exited };
}

async function waitFor(check, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

test('a SIGTERM to a --capture slot stops its command, frees the slot and records the capture failed', { timeout: 40_000 }, async () => {
  const f = captureFixture();
  const pidFile = join(f.root, 'command.pid');
  const run = startFleet(f, ['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', `echo $$ > ${pidFile}; sleep 30`]);
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
  const commandPid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(commandPid > 1 && run.child.pid > 1, 'only processes this test started are signalled');
  const signalled = Date.now();
  run.child.kill('SIGTERM');
  const { code } = await run.exited;
  assert.equal(code, 143);
  assert.ok(Date.now() - signalled < 10_000, 'the slot stops promptly, not when the command would have finished');
  await waitFor(() => !alive(commandPid), 10_000);
  assert.equal(existsSync(join(f.root, 'locks', 'heavy-1.lock')), false, 'the slot is freed');
  assert.deepEqual(f.entries().map((entry) => entry.status), ['failed']);
});

test('AC-3 AC-4 a fleet capture is overridden only by a ruling in the program rulings.md', { timeout: 30_000 }, () => {
  const f = captureFixture();
  assert.equal(f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', 'true']).status, 0);
  const repeat = f.spec({ override: { quote: 'retake the baseline capture' } });
  const refusedRun = f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', repeat, 'bash', '-c', 'true']);
  assert.equal(refusedRun.status, 79, 'no rulings.md line yet');
  writeFileSync(join(f.orch, 'rulings.md'), '- Ruling 2026-11-13 (operator): "retake the baseline capture" ISS-1 capture-guard override: baseline\n');
  const allowed = f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', repeat, 'bash', '-c', 'true']);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(f.entries().at(-1).override.rulings, 'rulings.md');
});

test('AC-4 the recorded seconds exclude the time the capture waited for the slot', { timeout: 40_000 }, async () => {
  const f = captureFixture();
  const holder = startFleet(f, ['local', 'slot', 'heavy', 'w0 holder', f.root, 'sleep', '8'], { SLOT_LOCK_POLL_SECONDS: '0.2' });
  await waitFor(() => existsSync(join(f.root, 'locks', 'heavy-1.lock', 'owner')));
  const started = Date.now();
  const queued = f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', 'true'], { SLOT_LOCK_POLL_SECONDS: '0.2' });
  assert.equal(queued.status, 0, queued.stderr);
  const waited = (Date.now() - started) / 1000;
  await holder.exited;
  const [entry] = f.entries();
  assert.ok(waited >= 4, `the capture queued behind the holder (${waited} s)`);
  assert.ok(Number.isInteger(entry.seconds) && entry.seconds < waited - 2, `recorded ${entry.seconds} s against a ${waited} s wait`);
});

test('a SIGTERM to a remote --capture slot stops the remote command, frees its slot and records the running capture failed', { timeout: 40_000 }, async () => {
  const f = captureFixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const pidFile = join(f.root, 'remote-command.pid');
  const run = startFleet(f, ['remote', 'slot', 'heavy', 'w2 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', `echo $$ > ${pidFile}; sleep 30`]);
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
  const commandPid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(commandPid > 1 && run.child.pid > 1, 'only processes this test started are signalled');
  assert.deepEqual(f.entries().map((entry) => entry.status), ['running'], 'running while the remote command is alive');
  const signalled = Date.now();
  run.child.kill('SIGTERM');
  const { code } = await run.exited;
  assert.ok(Date.now() - signalled < 15_000, 'the remote slot stops promptly, not when the command would have finished');
  assert.notEqual(code, 0);
  await waitFor(() => !alive(commandPid), 10_000);
  assert.equal(existsSync(join(f.root, 'locks', 'heavy-1.lock')), false, 'the remote slot is freed');
  assert.deepEqual(f.entries().map((entry) => entry.status), ['failed']);
});

test('a SIGTERM before the remote slot starts keeps it from starting and records the capture failed', { timeout: 40_000 }, async () => {
  const f = captureFixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  writeFileSync(join(f.root, 'bin', 'ssh'), `#!/usr/bin/env bash\ncase "\${@: -1}" in *slot-lock.sh*) sleep 3 ;; esac\nexec bash -c "\${@: -1}"\n`);
  chmodSync(join(f.root, 'bin', 'ssh'), 0o755);
  const ran = join(f.root, 'remote-ran');
  const run = startFleet(f, ['remote', 'slot', 'heavy', 'w2 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', `touch ${ran}; sleep 30`]);
  await waitFor(() => existsSync(join(f.orch, 'captures', 'ISS-1.json')) && f.entries().length === 1);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(run.child.pid > 1);
  const signalled = Date.now();
  run.child.kill('SIGTERM');
  const { code } = await run.exited;
  assert.notEqual(code, 0);
  assert.ok(Date.now() - signalled < 15_000, 'no wait for a capture that never started');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(existsSync(ran), false, 'the remote command never started');
  assert.deepEqual(f.entries().map((entry) => entry.status), ['failed']);
  const remoteDir = join(f.root, 'remote', 'sessions', '.fleet-orchestrator');
  assert.deepEqual(readdirSync(remoteDir).filter((name) => name.startsWith('capture-')), [], 'stop marker, pid and timing files are cleaned');
});

test('a remote capture whose command ignores the stop and exits 0 is recorded ok', { timeout: 40_000 }, async () => {
  const f = captureFixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const pidFile = join(f.root, 'stubborn.pid');
  const run = startFleet(f, ['remote', 'slot', 'heavy', 'w2 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', `trap '' TERM; echo $$ > ${pidFile}; sleep 2; exit 0`]);
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
  assert.ok(run.child.pid > 1);
  run.child.kill('SIGTERM');
  const { code } = await run.exited;
  assert.equal(code, 0, 'the real remote exit is recorded, not an assumed failure');
  assert.deepEqual(f.entries().map((entry) => entry.status), ['ok']);
});
