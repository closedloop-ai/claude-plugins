import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyScreen, classifyThread, guiHooks, LaunchState, launchLine, watchLaunch } from './launch-check.mjs';
import { fixture, successfulRemoteWriter } from './fleet-test-support.mjs';

const CHECK = fileURLToPath(new URL('./launch-check.mjs', import.meta.url));
const TIMEOUT = { timeout: 30_000 };
const STUCK_SCREEN = '⏺ Bash(git status)\n  ⎿  Running PreToolUse hooks 3/4\n';

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'launch-check-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** The incident's shape: the settings run a script, and the script body is what calls osascript. */
function guiSettings(root, { guarded = false } = {}) {
  const script = join(root, 'cc-status.sh');
  writeFileSync(script, `#!/bin/sh\n${guarded ? '[ -n "$ITERM_SESSION_ID" ] || exit 0\n' : ''}osascript -e 'tell application "iTerm2" to get name'\n`);
  chmodSync(script, 0o755);
  const settings = join(root, 'settings.json');
  writeFileSync(settings, JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node lint-guard.mjs' }, { type: 'command', command: `${script} pre` }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
  } }));
  return { settings, script };
}

test('a screen still running a tool-use hook reads as hook-wait, even under an older tool result', () => {
  assert.deepEqual(classifyScreen(STUCK_SCREEN), { state: LaunchState.HookWait, event: 'PreToolUse', progress: '3/4' });
  assert.deepEqual(classifyScreen(`⏺ Read(a)\n  ⎿  Read 3 lines\n${STUCK_SCREEN}`).state, LaunchState.HookWait);
  assert.deepEqual(classifyScreen('running PostToolUse hooks 1/2').event, 'PostToolUse');
  assert.deepEqual(classifyScreen('  ⎿  Running PreToolUse hooks…\n'), { state: LaunchState.HookWait, event: 'PreToolUse', progress: '?' },
    'a hook wait without its counter is still a hook wait, not a finished call');
  assert.equal(classifyScreen('⏺ Bash(git status)\n  ⎿  On branch main\n').state, LaunchState.ToolDone);
  assert.equal(classifyScreen('> $vibe ISS-1\n').state, LaunchState.Waiting);
});

test('a Codex thread reads done only once a tool item finishes; messages and reasoning are not tool calls', () => {
  const turn = (status, items) => ({ turns: [{ status, items }] });
  assert.equal(classifyThread(turn('inProgress', [{ type: 'userMessage' }, { type: 'reasoning', status: 'completed' }])).state, LaunchState.Waiting);
  assert.deepEqual(classifyThread(turn('inProgress', [{ type: 'commandExecution', status: 'inProgress' }])),
    { state: LaunchState.ToolRunning, tool: 'commandExecution' });
  assert.equal(classifyThread(turn('inProgress', [{ type: 'mcpToolCall', status: 'failed' }])).state, LaunchState.ToolDone);
  assert.equal(classifyThread(turn('inProgress', [{ type: 'collabAgentToolCall', status: 'interrupted' }])).state, LaunchState.ToolDone);
  assert.equal(classifyThread(turn('inProgress', [{ type: 'hookPrompt', status: 'completed' }, { type: 'imageGeneration', status: 'completed' }])).state,
    LaunchState.Waiting, 'only the App Server tool items count as tool calls');
  assert.deepEqual(classifyThread(turn('completed', [{ type: 'agentMessage', text: 'hi' }])), { state: LaunchState.TurnEnded, status: 'completed' });
});

test('the watch stops at the window with the last reading, at once on a finished call, and reports a lost session', async () => {
  let clock = 0;
  const timing = { within: 60, interval: 5, now: () => clock * 1000, sleep: async (seconds) => { clock += seconds; } };
  const stuck = await watchLaunch(async () => classifyScreen(STUCK_SCREEN), timing);
  assert.deepEqual(stuck, { state: LaunchState.HookWait, event: 'PreToolUse', progress: '3/4', seconds: 60 });
  clock = 0;
  const reads = [classifyScreen('> $vibe ISS-1'), classifyScreen('  ⎿  ok')];
  assert.deepEqual(await watchLaunch(async () => reads.shift(), timing), { state: LaunchState.ToolDone, seconds: 5 });
  clock = 0;
  const gone = await watchLaunch(async () => { throw new Error("can't find session: w1"); }, timing);
  assert.deepEqual(gone, { state: LaunchState.Gone, reason: "can't find session: w1", seconds: 0 });
});

test('the setup scan finds a GUI hook through the script its command runs, and counts an ITERM_SESSION_ID guard', (t) => {
  const root = scratch(t);
  const open = guiSettings(root);
  const hooks = guiHooks(JSON.parse(readFileSync(open.settings, 'utf8')), { file: open.settings });
  assert.deepEqual(hooks, [{ event: 'PreToolUse', file: open.settings, command: `${open.script} pre`, guarded: false }]);
  const guarded = guiSettings(scratch(t), { guarded: true });
  assert.equal(guiHooks(JSON.parse(readFileSync(guarded.settings, 'utf8')))[0].guarded, true);
  const inline = guiHooks({ hooks: { PostToolUse: [{ hooks: [{ command: '[ -n "$ITERM_SESSION_ID" ] && osascript -e beep' }] }] } });
  assert.equal(inline[0].guarded, true);
});

test('the setup scan opens a script named after its interpreter, not the interpreter, and needs a real guard test', (t) => {
  const root = scratch(t);
  const { script } = guiSettings(root);
  const benign = join(root, 'benign.mjs');
  writeFileSync(benign, 'console.log("ok");\n');
  const usesOnly = join(root, 'uses-only.sh');
  writeFileSync(usesOnly, 'echo "$ITERM_SESSION_ID"\nosascript -e beep\n');
  const hooks = guiHooks({ hooks: { PreToolUse: [{ hooks: [
    { command: `bash ${script} pre` },
    { command: `'${process.execPath}' '${benign}' --input -` },
    { command: `sh ${usesOnly}` },
  ] }] } });
  assert.deepEqual(hooks.map(({ command, guarded }) => [command, guarded]), [[`bash ${script} pre`, false], [`sh ${usesOnly}`, false]]);
});

test('a stuck launch line names the GUI hooks registered for the waiting event', (t) => {
  const { settings, script } = guiSettings(scratch(t));
  const hooks = guiHooks(JSON.parse(readFileSync(settings, 'utf8')), { file: settings });
  const line = launchLine({ state: LaunchState.HookWait, event: 'PreToolUse', progress: '3/4', seconds: 60 }, hooks);
  assert.match(line, /^LAUNCH STUCK running PreToolUse hooks 3\/4 after 60s; GUI-session hooks: PreToolUse /);
  assert.ok(line.includes(script), line);
  assert.match(launchLine({ state: LaunchState.ToolRunning, tool: 'commandExecution', seconds: 61 }, hooks), /still running after 61s.*cc-status\.sh/);
  assert.match(launchLine({ state: LaunchState.HookWait, event: 'PostToolUse', progress: '1/1', seconds: 60 }, hooks), /no GUI-session hook found/);
});

test('gui-hooks exits 1 naming an unguarded GUI hook, 0 once it is guarded, and never edits the settings', (t) => {
  const open = guiSettings(scratch(t));
  const before = readFileSync(open.settings, 'utf8');
  const flagged = spawnSync(process.execPath, [CHECK, 'gui-hooks', '--settings', open.settings], { encoding: 'utf8' });
  assert.equal(flagged.status, 1, flagged.stderr);
  assert.equal(flagged.stdout, `GUI-HOOK PreToolUse ${open.settings}: ${open.script} pre\n`);
  assert.equal(readFileSync(open.settings, 'utf8'), before);
  const guarded = guiSettings(scratch(t), { guarded: true });
  const ok = spawnSync(process.execPath, [CHECK, 'gui-hooks', '--settings', guarded.settings], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'gui-hooks ok (1 guarded)\n');
});

test('pane mode alerts on a hook wait past the window, passes a finished call and reports a gone session', TIMEOUT, (t) => {
  const { settings, script } = guiSettings(scratch(t));
  const pane = (capture) => spawnSync(process.execPath, [CHECK, 'pane', '--capture', capture, '--within', '1', '--interval', '1',
    '--settings', settings], { encoding: 'utf8' });
  const stuck = pane(`printf '%s' ${JSON.stringify(STUCK_SCREEN)}`);
  assert.equal(stuck.status, 1, stuck.stderr);
  assert.match(stuck.stdout, /^LAUNCH STUCK running PreToolUse hooks 3\/4 after \d+s; GUI-session hooks: PreToolUse /);
  assert.ok(stuck.stdout.includes(script));
  const done = pane(`printf '  ⎿  ok\\n'`);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^LAUNCH ok first tool call finished/);
  const gone = pane('echo "no server running" >&2; exit 1');
  assert.equal(gone.status, 1);
  assert.match(gone.stdout, /^LAUNCH GONE after \d+s: screen read failed \(exit 1\): no server running/);
});

/** A remote launcher that writes the writer's state, plus a launch check that records its argv and exits as told. */
function remoteWriterWithLaunchCheck(f, launchExit) {
  const worktree = successfulRemoteWriter(f);
  const receipt = join(f.root, 'launch-check-args');
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash
case "$1" in
  *ship-plugins.mjs|*work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs|*/vibe/scripts/provider.mjs) exec ${JSON.stringify(process.execPath)} "$@";;
  *codex-session.mjs) mkdir -p "$3"; printf '%s\\n' '{"threadId":"remote-thread","cwd":"/fixture"}' > "$3/$4.json"; exit 0;;
  *launch-check.mjs) printf '%s\\n' "$@" >> ${JSON.stringify(receipt)}; echo "LAUNCH STUCK running PreToolUse hooks 3/4 after 60s"; exit ${launchExit};;
esac
printf "arg:%s\\n" "$@"
`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  return { worktree, receipt };
}

test('a new remote writer gets a launch check on its host, and a failed check fails the start after its marker is kept', TIMEOUT, (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const { worktree, receipt } = remoteWriterWithLaunchCheck(f, 1);
  const args = ['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree, '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'];
  const started = f.run(args);
  assert.equal(started.status, 3, started.stdout + started.stderr);
  assert.match(started.stdout, /LAUNCH STUCK running PreToolUse hooks 3\/4/);
  assert.match(started.stderr, /writer started on box but failed its launch check/);
  const [entry, ...rest] = readFileSync(receipt, 'utf8').trim().split('\n');
  assert.match(entry, /\/plugins\/vibe\/skills\/fleet-orchestrator\/scripts\/launch-check\.mjs$/);
  assert.deepEqual(rest, ['codex', join(f.root, 'remote', 'sessions'), 'writer']);
  assert.ok(existsSync(join(f.orch, 'sessions', 'writer.remote.json')), 'the started writer stays owned, so a retry resumes it');

  rmSync(receipt);
  const resumed = f.run(args);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(existsSync(receipt), false, 'a resumed writer is not a launch');
});

test('a launch check that cannot run warns without failing the started writer', TIMEOUT, (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const { worktree, receipt } = remoteWriterWithLaunchCheck(f, 2);
  const started = f.run(['remote', 'session', 'turn', 'writer', '--prompt-file', f.prompt, '--cwd', worktree, '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high']);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.ok(existsSync(receipt));
  assert.match(started.stderr, /launch check could not run \(exit 2\); read it with session last writer/);
});

test('pane mode reads one exact tmux pane by id and refuses any other pane form', TIMEOUT, (t) => {
  const { settings } = guiSettings(scratch(t));
  const dir = scratch(t), bin = join(dir, 'bin'), calls = join(dir, 'tmux-calls');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho "$*" >> '${calls}'\nprintf '  ⎿  ok\\n'\n`);
  chmodSync(join(bin, 'tmux'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const run = (...args) => spawnSync(process.execPath, [CHECK, 'pane', ...args, '--within', '1', '--interval', '1', '--settings', settings], { encoding: 'utf8', env });
  const done = run('--tmux-pane', '%3');
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^LAUNCH ok first tool call finished/);
  assert.equal(readFileSync(calls, 'utf8'), 'capture-pane -p -t %3\n');
  for (const bad of [['--tmux-pane', 'main:0'], ['--tmux-pane', '%3;x'], ['--tmux-pane', '%3', '--capture', 'true']]) {
    const refused = run(...bad);
    assert.notEqual(refused.status, 0, bad.join(' '));
    assert.match(refused.stderr, /--tmux-pane needs one exact pane id/);
  }
});

test('fleet.sh local launch-check passes only one exact tmux pane id to pane mode', TIMEOUT, (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const checked = f.run(['local', 'launch-check', '%3']);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.deepEqual(f.argv(checked), [CHECK, 'pane', '--tmux-pane', '%3']);
  for (const bad of [['main:0'], ['%3;x'], ['%3', '%4']]) {
    const refused = f.run(['local', 'launch-check', ...bad]);
    assert.equal(refused.status, 2, bad.join(' '));
    assert.deepEqual(f.argv(refused), [], `${bad.join(' ')} never reaches launch-check.mjs`);
  }
});
