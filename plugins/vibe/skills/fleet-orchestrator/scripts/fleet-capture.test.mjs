import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { alive, fixture, HAS_MAC_BASH32, pinMacBash, remoteConfig, startFleet, TIMEOUT, waitFor } from './fleet-test-support.mjs';
import { bindProvider } from '../../vibe/scripts/test-fixtures.mjs';

/** A fleet fixture whose node runs capture-guard.mjs for real, with a capture worktree cloned from a bare origin. */
function captureFixture() {
  const f = fixture();
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *ship-plugins.mjs|*work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs|*capture-guard.mjs|*capture-command.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *e2e-lock.mjs) [[ "$2" == intent || "$2" == stack-intent ]] && exec ${JSON.stringify(process.execPath)} "$@"; if [ "$2" = run ]; then echo "fixture-stack-acquired $*"; while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done; [ "$#" -gt 1 ] || exit 64; shift; exec "$@"; fi;; esac\nprintf "arg:%s\\n" "$@"\n`);
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
  // A capture's ticket is a tracker ticket only with a tracker bound, so the lead runs bound to the provider this repository ships.
  const home = join(f.root, 'home');
  const bound = { HOME: home, ...bindProvider(home) };
  return { ...f, wt, spec, entries, git, bound, run: (args, env = {}) => f.run(args, { ...bound, ...env }) };
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

async function sigtermLocalCapture(macBash) {
  const f = captureFixture();
  const pidFile = join(f.root, 'command.pid');
  const versionFile = join(f.root, 'command.bash-version');
  if (macBash) pinMacBash(f);
  const versionPart = macBash ? `printf %s "$BASH_VERSION" > ${versionFile}; ` : '';
  const run = startFleet(f, ['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', `${versionPart}echo $$ > ${pidFile}; sleep 30`]);
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
  if (macBash) assert.match(readFileSync(versionFile, 'utf8'), /^3\./, 'the slot ran under macOS bash 3.2');
  const commandPid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(commandPid > 1 && run.child.pid > 1, 'only processes this test started are signalled');
  const signalled = Date.now();
  run.child.kill('SIGTERM');
  const { code } = await run.stopped;
  assert.equal(code, 143);
  assert.ok(Date.now() - signalled < 10_000, 'the slot stops promptly, not when the command would have finished');
  await waitFor(() => !alive(commandPid), 10_000);
  assert.equal(existsSync(join(f.root, 'locks', 'heavy-1.lock')), false, 'the slot is freed');
  assert.deepEqual(f.entries().map((entry) => entry.status), ['failed']);
}

test('a SIGTERM to a --capture slot stops its command, frees the slot and records the capture failed', { timeout: 40_000 },
  () => sigtermLocalCapture(false));

test('under macOS /bin/bash 3.2, a SIGTERM to a --capture slot stops its command, frees the slot and records the capture failed',
  { timeout: 40_000, skip: !HAS_MAC_BASH32 && 'needs macOS /bin/bash 3.2' }, () => sigtermLocalCapture(true));

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

async function sigtermRemoteCapture(macBash) {
  const f = captureFixture();
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
  const pidFile = join(f.root, 'remote-command.pid');
  const versionFile = join(f.root, 'remote-command.bash-version');
  if (macBash) pinMacBash(f);
  const versionPart = macBash ? `printf %s "$BASH_VERSION" > ${versionFile}; ` : '';
  const run = startFleet(f, ['remote', 'slot', 'heavy', 'w2 shots', f.wt, '--capture', f.spec({}), 'bash', '-c', `${versionPart}echo $$ > ${pidFile}; sleep 30`]);
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
  if (macBash) assert.match(readFileSync(versionFile, 'utf8'), /^3\./, 'the remote slot ran under macOS bash 3.2');
  const commandPid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(commandPid > 1 && run.child.pid > 1, 'only processes this test started are signalled');
  assert.deepEqual(f.entries().map((entry) => entry.status), ['running'], 'running while the remote command is alive');
  const signalled = Date.now();
  run.child.kill('SIGTERM');
  const { code } = await run.stopped;
  assert.ok(Date.now() - signalled < 15_000, 'the remote slot stops promptly, not when the command would have finished');
  assert.notEqual(code, 0);
  await waitFor(() => !alive(commandPid), 10_000);
  assert.equal(existsSync(join(f.root, 'locks', 'heavy-1.lock')), false, 'the remote slot is freed');
  assert.deepEqual(f.entries().map((entry) => entry.status), ['failed']);
}

test('a SIGTERM to a remote --capture slot stops the remote command, frees its slot and records the running capture failed', { timeout: 40_000 },
  () => sigtermRemoteCapture(false));

test('under macOS /bin/bash 3.2, a SIGTERM to a remote --capture slot stops the remote command, frees its slot and records the running capture failed',
  { timeout: 40_000, skip: !HAS_MAC_BASH32 && 'needs macOS /bin/bash 3.2' }, () => sigtermRemoteCapture(true));

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
  const remoteDir = join(f.root, 'remote', 'sessions', '.fleet-orchestrator-runtime');
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

test('a --capture spec that is missing or unreadable is a usage error before any slot or command', TIMEOUT, () => {
  const f = captureFixture();
  const ran = join(f.wt, 'spec-ran');
  // A load over the gate makes any slot path that runs first exit 4 with a load-check line instead of the usage error.
  const missing = f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', join(f.root, 'no-such-spec.json'), 'bash', '-c', `touch ${ran}`],
    { FLEET_TEST_LOAD: '1000' });
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /slot <lockName> <owner> <dir> \[--full-corpus\].*\[--capture <spec\.json>\].*<command\.\.\.>/);
  assert.doesNotMatch(missing.stderr, /load-check|slot-lock/, 'a missing spec is refused before the load check and the slot');
  const unreadable = f.spec({});
  chmodSync(unreadable, 0o000);
  const locked = f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, '--capture', unreadable, 'bash', '-c', `touch ${ran}`],
    { FLEET_TEST_LOAD: '1000' });
  chmodSync(unreadable, 0o600);
  assert.equal(locked.status, 2, locked.stderr);
  assert.match(locked.stderr, /^capture-guard: invalid spec$/m);
  assert.doesNotMatch(locked.stderr, /load-check|slot-lock/, 'an unreadable spec is refused before the load check and the slot');
  assert.equal(existsSync(ran), false, 'no command runs');
  assert.equal(existsSync(join(f.root, 'locks')), false, 'slot-lock never started: it creates the lock root on every start');
  assert.equal(existsSync(join(f.orch, 'captures', 'ISS-1.json')), false, 'nothing is recorded');
});

test('--capture and --containerized-e2e-build are accepted in either order', TIMEOUT, () => {
  for (const flags of [['--capture', null, '--containerized-e2e-build'], ['--containerized-e2e-build', '--capture', null]]) {
    const f = captureFixture();
    const spec = f.spec({});
    const args = flags.map((flag) => flag ?? spec);
    const ran = join(f.wt, 'ordered-ran');
    const result = f.run(['local', 'slot', 'heavy', 'w1 shots', f.wt, ...args, 'bash', '-c', `touch ${ran}`]);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.ok(existsSync(ran), `${args.join(' ')}: the command ran`);
    assert.ok(f.argv(result).some((arg) => arg.endsWith('e2e-lock.mjs')), `${args.join(' ')}: the disk preflight ran`);
    assert.deepEqual(f.entries().map((entry) => [entry.status, entry.main]), [['ok', true]], `${args.join(' ')}: the guard admitted and recorded it`);
  }
});

test("capture preserves a single explicit machine lease around its actual payload", TIMEOUT, () => {
  const f = captureFixture();
  const lock = fileURLToPath(new URL("../../vibe/scripts/", import.meta.url)) + "./e2e-lock.mjs";
  const ran = join(f.wt, "captured-once");
  const result = f.run(["local", "slot", "heavy", "guide", f.wt, "--capture", f.spec({}), "--containerized-e2e-build",
    "node", lock, "run", "--owner", "guide", "--", "touch", ran]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/fixture-stack-acquired/g)?.length, 1);
  assert.ok(existsSync(ran));
});

test("fleet routes the committed pnpm container entry through one shared lease", TIMEOUT, () => {
  const f = captureFixture();
  writeFileSync(join(f.wt,"package.json"), JSON.stringify({scripts:{"e2e:containerized":"bash e2e/run-containerized.sh"}}));
  assert.equal(spawnSync("git", ["add","package.json"], {cwd:f.wt}).status,0);
  assert.equal(spawnSync("git", ["-c","user.name=test","-c","user.email=fixture.invalid","commit","-qm","fixture"], {cwd:f.wt}).status,0);
  const fake = join(f.root, "bin", "pnpm");
  writeFileSync(fake, "#!/bin/sh\necho fixture-pnpm-payload\n", {mode:0o755});
  const result = f.run(["local","slot","heavy","guide",f.wt,"--capture",f.spec({}),"pnpm","--workspace-root","run","e2e:containerized","--","--list"]);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.match(/fixture-stack-acquired/g)?.length,1,result.stdout);
  assert.match(result.stdout,/--ticket ISS-1 --/);
  assert.match(result.stdout,/fixture-pnpm-payload/);
});

test("ordinary fleet slot refuses a provider stack harness when the machine holder is active", TIMEOUT, async t=>{
  const {mkdirSync,rmSync}=await import("node:fs");
  const f=captureFixture();t.after(()=>rmSync(f.root,{recursive:true,force:true}));
  const slot=join(f.root,"occupied"),marker=join(f.wt,"payload-ran");
  mkdirSync(slot);writeFileSync(join(slot,"owner"),"fixture-machine-holder");
  mkdirSync(join(f.wt,"e2e"));
  const runner="e2e/run-desktop-sync-harness.sh";
  writeFileSync(join(f.wt,runner),"#!/bin/sh\ntouch payload-ran\n",{mode:0o755});
  const entry=new URL("../../../../vibe-closedloop/lib/vibe/scripts/e2e-lock.mjs",import.meta.url).href;
  const adapter=join(f.root,"slot-fixture.mjs");
  writeFileSync(adapter,`import {e2eLockCli} from ${JSON.stringify(entry)};const [action,...args]=process.argv.slice(2);await e2eLockCli(action==="run"?[action,"--wait-seconds","0",...args]:[action,...args],${JSON.stringify(slot)});`);
  const node=join(f.root,"bin","node");
  writeFileSync(node,readFileSync(node,"utf8").replace("case \"$1\" in",`if [[ "$1" == *e2e-lock.mjs ]]; then shift; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(adapter)} "$@"; fi\ncase "$1" in`));
  const result=f.run(["local","slot","heavy","guide",f.wt,"--stack-ticket","QA-42",runner]);
  assert.notEqual(result.status,0);
  assert.match(result.stdout+result.stderr,/fixture-machine-holder/);
  assert.equal(existsSync(marker),false);
  const pnpm=join(f.root,"bin","pnpm");
  writeFileSync(pnpm,"#!/bin/sh\ntouch payload-ran\n",{mode:0o755});
  const control=(mode,explicit=false)=>f.run(["local","slot","heavy","guide",f.wt,"--stack-ticket","QA-42","pnpm",...(explicit?["run"]:[]),"control","up","web","--stack",mode]);
  const explicit=control("compose",true);
  assert.notEqual(explicit.status,0);
  assert.match(explicit.stdout+explicit.stderr,/fixture-machine-holder/);
  const compose=control("compose");
  assert.notEqual(compose.status,0);
  assert.match(compose.stdout+compose.stderr,/fixture-machine-holder/);
  assert.equal(existsSync(marker),false);
  assert.equal(control("host").status,0);
  assert.equal(existsSync(marker),true);
});
