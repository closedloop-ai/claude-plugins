import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, PLUGIN_ROOT, remoteConfig, successfulRemoteWriter, writeLoopbackSsh, writeRemoteCodexStub } from './fleet-test-support.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const FLEET = join(SCRIPTS, 'fleet.sh');
const TIMEOUT = { timeout: 20_000 };

test('a missing remote Codex CLI clears exact pre-dispatch ownership and permits retry', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  rmSync(join(f.root, 'bin', 'codex'));
  const args = ['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', join(f.root, 'future-worktree'),
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'];
  const missing = f.run(args, { PATH: `${join(f.root, 'bin')}:/usr/bin:/bin` });
  assert.equal(missing.status, 127, missing.stdout + missing.stderr);
  assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.pending.json')), false);
  writeRemoteCodexStub(join(f.root, 'bin'), PLUGIN_ROOT);
  const retry = f.run(args);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.ok(existsSync(join(f.orch, 'sessions', 'writer.remote.json')));
});

test('dead dispatch with only a prepared journal clears pending, later phases remain uncertain', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  const journal = join(f.root, 'remote', 'sessions', 'writer.launch.json');
  mkdirSync(dirname(pending), { recursive: true });
  mkdirSync(dirname(journal), { recursive: true });
  const owner = { pid: 999999, started: 'dead-dispatch', attempt: 'old-attempt' };
  writeFileSync(pending, JSON.stringify({ host: 'box', stateDir: dirname(journal), owner }));
  writeFileSync(journal, JSON.stringify({ phase: 'prepared', cwd: '/future', launcher: { pid: 999999, identity: 'dead' } }));
  const recovered = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(pending), false);
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).phase, 'prepared',
    'the no-start proof remains available if recovery is interrupted after clearing pending');
  const worktree = successfulRemoteWriter(f);
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *codex-session.mjs) [ ! -e "$3/$4.launch.json" ] || exit 1; printf '%s\\n' '{"threadId":"remote-thread","cwd":"/fixture"}' > "$3/$4.json"; exit 0;; esac\nprintf "arg:%s\\n" "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  const retry = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(existsSync(journal), false);
  rmSync(join(f.orch, 'sessions', 'writer.remote.json'));
  rmSync(join(dirname(journal), 'writer.json'));
  writeFileSync(pending, JSON.stringify({ host: 'box', stateDir: dirname(journal), owner }));
  writeFileSync(journal, JSON.stringify({ phase: 'may-have-started', cwd: '/future' }));
  const uncertain = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.notEqual(uncertain.status, 0);
  assert.ok(existsSync(pending));
});

test('two recoveries serialize before a newer turn can reuse the pending name', TIMEOUT, async () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  const remote = join(f.root, 'remote', 'sessions');
  mkdirSync(dirname(pending), { recursive: true });
  mkdirSync(remote, { recursive: true });
  writeFileSync(pending, JSON.stringify({ host: 'box', stateDir: remote,
    owner: { pid: 999999, started: 'dead-dispatch', attempt: 'old-attempt' } }));
  writeFileSync(join(remote, 'writer.preflight-rejected.json'), JSON.stringify({ attempt: 'old-attempt', stage: 'preflight-rejected' }));
  const entered = join(f.root, 'paused-recovery');
  const release = join(f.root, 'release-recovery');
  writeFileSync(join(f.root, 'bin', 'ssh'), `#!/usr/bin/env bash\nif [[ "\${@: -1}" == *preflight-rejected* ]] && mkdir ${JSON.stringify(join(f.root, 'pause-once'))} 2>/dev/null; then : > ${JSON.stringify(entered)}; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done; fi\nexec bash -c "\${@: -1}"\n`);
  chmodSync(join(f.root, 'bin', 'ssh'), 0o755);
  const child = spawn('bash', [FLEET, f.orch, 'remote', 'session', 'recover-marker', 'writer'], {
    env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}` },
  });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise((resolve) => child.on('close', resolve));
  try {
    for (let i = 0; i < 200 && !existsSync(entered); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(existsSync(entered));
    const second = f.run(['remote', 'session', 'recover-marker', 'writer']);
    assert.notEqual(second.status, 0, 'a second recovery must not decide from the same stale pending attempt');
    assert.ok(existsSync(pending));
    const worktree = successfulRemoteWriter(f);
    const competingTurn = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
      '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
    assert.notEqual(competingTurn.status, 0, 'a new turn cannot reuse the name during recovery');
    assert.equal(existsSync(join(remote, 'writer.json')), false);
  } finally {
    writeFileSync(release, 'go\n');
    await closed;
  }
  assert.equal(existsSync(pending), false);
  writeLoopbackSsh(join(f.root, 'bin'), join(f.root, 'ssh-args'));
  const worktree = join(f.root, 'future-worktree');
  const next = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.ok(existsSync(join(f.orch, 'sessions', 'writer.remote.json')));
});

test('a prepared journal remains pending while its exact remote launcher is alive after local owner death', TIMEOUT, async () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  const journal = join(f.root, 'remote', 'sessions', 'writer.launch.json');
  mkdirSync(dirname(pending), { recursive: true });
  mkdirSync(dirname(journal), { recursive: true });
  const launcher = spawn('sleep', ['20']);
  const closed = new Promise((resolve) => launcher.on('close', resolve));
  try {
    const identity = spawnSync('ps', ['-o', 'lstart=,command=', '-p', String(launcher.pid)], { encoding: 'utf8' }).stdout.trim();
    assert.ok(identity);
    writeFileSync(pending, JSON.stringify({ host: 'box', stateDir: dirname(journal),
      owner: { pid: 999999, started: 'dead-local-owner', attempt: 'old-attempt' } }));
    writeFileSync(journal, JSON.stringify({ phase: 'prepared', launcher: { pid: launcher.pid, identity } }));
    const live = f.run(['remote', 'session', 'recover-marker', 'writer']);
    assert.notEqual(live.status, 0, live.stdout + live.stderr);
    assert.ok(existsSync(pending));
  } finally {
    launcher.kill('SIGTERM');
    await closed;
  }
  const dead = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.equal(dead.status, 0, dead.stdout + dead.stderr);
  assert.equal(existsSync(pending), false);
});

test('macOS lockf retains the command on lock loss and orders same-name turns', TIMEOUT, () => {
  const real = spawnSync('sh', ['-c', 'command -v lockf'], { encoding: 'utf8' }).stdout.trim();
  if (!real) return; // Linux uses the flock fallback.
  const f = fixture();
  const worktree = successfulRemoteWriter(f);
  const receipt = join(f.root, 'lockf-args');
  writeFileSync(join(f.root, 'bin', 'lockf'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(receipt)}\nexec ${JSON.stringify(real)} "$@"\n`);
  chmodSync(join(f.root, 'bin', 'lockf'), 0o755);
  const turn = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.equal(turn.status, 0, turn.stdout + turn.stderr);
  assert.deepEqual(readFileSync(receipt, 'utf8').split('\n').slice(0, 3), ['-k', '-t', '0']);
});

test('partial rejection receipt publication preserves prior bytes and prepared proof permits retry', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const remote = join(f.root, 'remote', 'sessions');
  mkdirSync(remote, { recursive: true });
  const receipt = join(remote, 'writer.preflight-rejected.json');
  const prior = '{"attempt":"older","stage":"preflight-rejected"}\n';
  writeFileSync(receipt, prior);
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *codex-session.mjs) printf '%s\\n' '{"phase":"prepared","launcher":{"pid":999999,"identity":"dead"}}' > "$3/$4.launch.json"; exit 2;; esac\nprintf "arg:%s\\n" "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  const realJq = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(f.root, 'bin', 'jq'), `#!/usr/bin/env bash\nif [[ "$*" == *'--arg attempt'* && "$*" == *'preflight-rejected'* && "$*" == *'-nc'* ]]; then printf '{"attempt":'; exit 1; fi\nexec ${JSON.stringify(realJq)} "$@"\n`);
  chmodSync(join(f.root, 'bin', 'jq'), 0o755);
  const args = ['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', join(f.root, 'future-worktree'),
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'];
  const failed = f.run(args);
  assert.notEqual(failed.status, 0);
  assert.equal(readFileSync(receipt, 'utf8'), prior, 'an incomplete staged receipt must not replace the prior complete one');
  assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.pending.json')), false,
    'dead prepared proof permits exact pending cleanup even without the new receipt');
  rmSync(join(f.root, 'bin', 'jq'));
  const worktree = successfulRemoteWriter(f);
  const retry = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
});

test('an interrupted preflight receipt without a launch journal clears its exact pending attempt', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const realJq = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(f.root, 'bin', 'jq'), `#!/usr/bin/env bash\nif [[ "$*" == *'--arg attempt'* && "$*" == *'preflight-rejected'* && "$*" == *'-nc'* ]]; then printf '{"attempt":'; exit 1; fi\nexec ${JSON.stringify(realJq)} "$@"\n`);
  chmodSync(join(f.root, 'bin', 'jq'), 0o755);
  rmSync(join(f.root, 'bin', 'codex'));
  const args = ['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', join(f.root, 'future-worktree'),
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'];
  const failed = f.run(args, { PATH: `${join(f.root, 'bin')}:/usr/bin:/bin` });
  assert.notEqual(failed.status, 0);
  assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.pending.json')), false,
    'a dead preflight with no receipt or journal must not strand the pending name');
  rmSync(join(f.root, 'bin', 'jq'));
  writeRemoteCodexStub(join(f.root, 'bin'), PLUGIN_ROOT);
  const retry = f.run(args);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
});

test('recovery keeps a live preflight witness, then clears it after exact process death', TIMEOUT, async () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  const remote = join(f.root, 'remote', 'sessions');
  mkdirSync(dirname(pending), { recursive: true }); mkdirSync(remote, { recursive: true });
  writeFileSync(pending, JSON.stringify({ host: 'box', stateDir: remote,
    owner: { pid: 999999, started: 'dead-local-owner', attempt: 'preflight-one' } }));
  const child = spawn('sleep', ['20']);
  const closed = new Promise((resolve) => child.on('close', resolve));
  const started = spawnSync('ps', ['-o', 'lstart=', '-p', String(child.pid)], { encoding: 'utf8' }).stdout.trim();
  assert.ok(started);
  writeFileSync(join(remote, 'writer.preflight.preflight-one.json'), JSON.stringify({ attempt: 'preflight-one', phase: 'preflight',
    launcher: { pid: child.pid, started } }));
  try {
    const live = f.run(['remote', 'session', 'recover-marker', 'writer']);
    assert.notEqual(live.status, 0);
    assert.ok(existsSync(pending));
  } finally { child.kill('SIGTERM'); await closed; }
  const dead = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.equal(dead.status, 0, dead.stdout + dead.stderr);
  assert.equal(existsSync(pending), false);
});

test('preflight witness rejects a different attempt and recognizes a reused PID', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  const remote = join(f.root, 'remote', 'sessions');
  mkdirSync(dirname(pending), { recursive: true }); mkdirSync(remote, { recursive: true });
  writeFileSync(pending, JSON.stringify({ host: 'box', stateDir: remote,
    owner: { pid: 999999, started: 'dead-local-owner', attempt: 'preflight-one' } }));
  const witness = join(remote, 'writer.preflight.preflight-one.json');
  writeFileSync(witness, JSON.stringify({ attempt: 'other-attempt', phase: 'preflight',
    launcher: { pid: process.pid, started: 'old birth' } }));
  const mismatch = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.notEqual(mismatch.status, 0);
  assert.ok(existsSync(pending));
  const liveStarted = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(witness, JSON.stringify({ attempt: 'preflight-one', phase: 'launching',
    launcher: { pid: process.pid, started: liveStarted } }));
  const launching = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.notEqual(launching.status, 0, 'a launcher boundary without journal is uncertain');
  assert.ok(existsSync(pending));
  writeFileSync(witness, JSON.stringify({ attempt: 'preflight-one', phase: 'preflight',
    launcher: { pid: process.pid, started: 'old birth' } }));
  const reused = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.equal(reused.status, 0, reused.stdout + reused.stderr);
  assert.equal(existsSync(pending), false);
});

test('recovery cancellation wins a missing-witness race before remote preflight can launch', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  const remote = join(f.root, 'remote', 'sessions');
  mkdirSync(dirname(pending), { recursive: true }); mkdirSync(remote, { recursive: true });
  writeFileSync(pending, JSON.stringify({ host: 'box', stateDir: remote,
    owner: { pid: 999999, started: 'dead-local-owner', attempt: 'preflight-one' } }));
  const recovered = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  const claim = join(remote, 'writer.preflight.preflight-one.json');
  assert.equal(JSON.parse(readFileSync(claim, 'utf8')).phase, 'canceled');
  const late = spawnSync(process.execPath, [join(SCRIPTS, 'fleet-remote-evidence.mjs'), 'preflight-begin', claim,
    'preflight-one', String(process.pid)], { encoding: 'utf8' });
  assert.notEqual(late.status, 0, 'a delayed remote preflight cannot pass a recovery cancellation claim');
});

test('a dead exact launching process with no journal or state permits recovery and retry', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  const remote = join(f.root, 'remote', 'sessions');
  mkdirSync(dirname(pending), { recursive: true }); mkdirSync(remote, { recursive: true });
  writeFileSync(pending, JSON.stringify({ host: 'box', stateDir: remote,
    owner: { pid: 999999, started: 'dead-local-owner', attempt: 'launch-gap' } }));
  writeFileSync(join(remote, 'writer.preflight.launch-gap.json'), JSON.stringify({ attempt: 'launch-gap', phase: 'launching',
    launcher: { pid: 999999, started: 'old birth' } }));
  const recovered = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(pending), false);
  const worktree = successfulRemoteWriter(f);
  const retry = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
});

test('a live exact launching process retains pending until that process ends', TIMEOUT, async () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  const remote = join(f.root, 'remote', 'sessions');
  mkdirSync(dirname(pending), { recursive: true }); mkdirSync(remote, { recursive: true });
  writeFileSync(pending, JSON.stringify({ host: 'box', stateDir: remote,
    owner: { pid: 999999, started: 'dead-local-owner', attempt: 'launch-live' } }));
  const child = spawn('sleep', ['20']);
  const closed = new Promise((resolve) => child.on('close', resolve));
  const started = spawnSync('ps', ['-o', 'lstart=', '-p', String(child.pid)], { encoding: 'utf8' }).stdout.trim();
  assert.ok(started);
  writeFileSync(join(remote, 'writer.preflight.launch-live.json'), JSON.stringify({ attempt: 'launch-live', phase: 'launching',
    launcher: { pid: child.pid, started } }));
  try {
    const live = f.run(['remote', 'session', 'recover-marker', 'writer']);
    assert.notEqual(live.status, 0);
    assert.ok(existsSync(pending));
  } finally { child.kill('SIGTERM'); await closed; }
  const dead = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.equal(dead.status, 0, dead.stdout + dead.stderr);
  assert.equal(existsSync(pending), false);
});

test('remote turn execs the claimed preflight process into the launcher', TIMEOUT, () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *codex-session.mjs) claim=$(echo "$3/$4".preflight.*.json); jq -e --argjson pid "$$" '.phase == "launching" and .launcher.pid == $pid' "$claim" >/dev/null || exit 9; mkdir -p "$3"; printf '%s\\n' '{"threadId":"remote-thread","cwd":"/fixture"}' > "$3/$4.json"; exit 0;; esac\nprintf "arg:%s\\n" "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  const result = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', join(f.root, 'future-worktree'),
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('killing the remote shell after launching transition leaves no phantom writer and permits retry', TIMEOUT, async () => {
  const f = fixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const entered = join(f.root, 'launch-transition-done');
  const release = join(f.root, 'release-launch-helper');
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *fleet-remote-evidence.mjs) ${JSON.stringify(process.execPath)} "$@" || exit $?; if [ "$2" = preflight-launch ]; then : > ${JSON.stringify(entered)}; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done; fi; exit 0;; *codex-session.mjs) exit 9;; esac\nprintf "arg:%s\\n" "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  const child = spawn('bash', [FLEET, f.orch, 'remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt,
    '--cwd', join(f.root, 'future-worktree'), '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'], {
    env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}` },
  });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise((resolve) => child.on('close', resolve));
  const remote = join(f.root, 'remote', 'sessions');
  try {
    for (let i = 0; i < 200 && !existsSync(entered); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(existsSync(entered));
    const claimFile = readdirSync(remote).find((name) => name.startsWith('writer.preflight.') && name.endsWith('.json'));
    assert.ok(claimFile);
    const claim = JSON.parse(readFileSync(join(remote, claimFile), 'utf8'));
    assert.equal(claim.phase, 'launching');
    assert.ok(claim.launcher.pid > 1 && claim.launcher.pid !== process.pid);
    process.kill(claim.launcher.pid, 'SIGKILL');
  } finally {
    writeFileSync(release, 'go\n');
    await closed;
  }
  assert.equal(existsSync(join(remote, 'writer.json')), false);
  assert.equal(existsSync(join(remote, 'writer.launch.json')), false);
  assert.equal(existsSync(join(f.orch, 'sessions', 'writer.remote.pending.json')), false);
  const worktree = successfulRemoteWriter(f);
  const retry = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
});

function pendingRaceFixture(f, attempt) {
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const remote = join(f.root, 'remote', 'sessions');
  const pending = join(f.orch, 'sessions', 'writer.remote.pending.json');
  mkdirSync(remote, { recursive: true }); mkdirSync(dirname(pending), { recursive: true });
  writeFileSync(pending, JSON.stringify({ host: 'box', stateDir: remote,
    owner: { pid: 999999, started: 'dead-local-owner', attempt } }));
  return { remote, pending, claim: join(remote, `writer.preflight.${attempt}.json`), journal: join(remote, 'writer.launch.json') };
}

test('post-death reread retains a prepared journal that advanced during identity check', TIMEOUT, () => {
  const f = fixture();
  const { pending, journal } = pendingRaceFixture(f, 'journal-race');
  writeFileSync(journal, JSON.stringify({ phase: 'prepared', launcher: { pid: process.pid, identity: 'old birth' } }));
  const realPs = spawnSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(f.root, 'bin', 'ps'), `#!/usr/bin/env bash\nif [[ "$*" == *'lstart=,command='* ]]; then printf '%s\\n' '{"phase":"may-have-started","launcher":{"pid":${process.pid},"identity":"old birth"}}' > ${JSON.stringify(journal)}; printf 'new birth\\n'; exit 0; fi\nexec ${JSON.stringify(realPs)} "$@"\n`);
  chmodSync(join(f.root, 'bin', 'ps'), 0o755);
  const result = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).phase, 'may-have-started');
  assert.ok(existsSync(pending));
});

for (const change of ['claim', 'state']) {
  test(`post-death reread retains a ${change} written during preflight identity check`, TIMEOUT, () => {
    const f = fixture();
    const { remote, pending, claim } = pendingRaceFixture(f, `${change}-race`);
    writeFileSync(claim, JSON.stringify({ attempt: `${change}-race`, phase: 'preflight',
      launcher: { pid: process.pid, started: 'old birth' } }));
    const realPs = spawnSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout.trim();
    const target = change === 'claim' ? claim : join(remote, 'writer.json');
    const payload = change === 'claim' ? { attempt: `${change}-race`, phase: 'launching',
      launcher: { pid: process.pid, started: 'old birth' } } : { threadId: 'possible-thread', cwd: '/fixture' };
    writeFileSync(join(f.root, 'bin', 'ps'), `#!/usr/bin/env bash\nif [[ "$*" == *'lstart='* && "$*" == *'${process.pid}'* ]]; then printf '%s\\n' ${JSON.stringify(JSON.stringify(payload))} > ${JSON.stringify(target)}; printf 'new birth\\n'; exit 0; fi\nexec ${JSON.stringify(realPs)} "$@"\n`);
    chmodSync(join(f.root, 'bin', 'ps'), 0o755);
    const result = f.run(['remote', 'session', 'recover-marker', 'writer']);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(pending));
    assert.ok(existsSync(target));
  });
}

test('post-death reread catches a journal appearing after the shell absence check', TIMEOUT, () => {
  const f = fixture();
  const { pending, claim, journal } = pendingRaceFixture(f, 'absence-race');
  writeFileSync(claim, JSON.stringify({ attempt: 'absence-race', phase: 'preflight',
    launcher: { pid: 999999, started: 'dead birth' } }));
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *fleet-remote-evidence.mjs) if [ "$2" = preflight-probe ]; then printf '%s\\n' '{"phase":"may-have-started"}' > ${JSON.stringify(journal)}; fi; exec ${JSON.stringify(process.execPath)} "$@";; esac\nprintf 'arg:%s\\n' "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  const result = f.run(['remote', 'session', 'recover-marker', 'writer']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(pending));
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).phase, 'may-have-started');
});
