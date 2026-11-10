import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { launchWriter, loadState, parseCli, requireResumeSession, run, saveState } from './codex-session.mjs';
import { launchCwd, vibeHookTrustProblem } from './writer-launch.mjs';
import { VIBE_CORE_INSTALL } from '../../../shared/vibe-core.mjs';
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { readProcessIdentity } = await vibeCore("shared/process-identity.mjs");

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

const OPERATOR_EMAIL = ['operator', 'example.invalid'].join('@');

/** Builds the linked path and private record shape produced by `vibe new`, without starting a real Vibe session. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-vibe-worktree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README'), 'fixture\n');
  git(repo, 'add', 'README');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=fixture.invalid', 'commit', '-qm', 'initial');
  const worktree = join(repo, '.claude', 'worktrees', 'vibe-example');
  mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'vibe/example', worktree, 'HEAD');
  const promptFile = join(dir, 'prompt.md');
  writeFileSync(promptFile, '$vibe ISS-1\n');
  const stateDir = join(dir, 'state');
  const recordPath = join(git(worktree, 'rev-parse', '--absolute-git-dir'), 'vibe-session.json');
  const record = { slug: 'example', branch: 'vibe/example', summary: 'Example', status: 'active',
    ticket: 'ISS-1', liveTicket: 'ISS-1', liveTicketCreatedBySession: false,
    operator: { id: 'operator', email: OPERATOR_EMAIL, name: 'Operator' },
    baseCommit: git(worktree, 'rev-parse', 'HEAD'), createdAt: '2026-11-07T12:00:00Z' };
  const options = (ticket = 'ISS-1') => parseCli(['turn', stateDir, 'writer', '--prompt-file', promptFile,
    '--cwd', worktree, '--ticket', ticket, '--model', 'm', '--effort', 'high']);
  return { dir, repo, worktree, promptFile, stateDir, recordPath, record, options };
}

function client() {
  const calls = [];
  const replies = { 'thread/start': { thread: { id: 'T1' } }, 'thread/resume': {}, 'thread/name/set': {},
    'threadSection/list': { data: [], nextCursor: null }, 'threadSection/create': { section: { id: 'S1' } },
    'thread/section/move': {}, 'turn/start': { turn: { id: 'U1' } } };
  return { calls, request: async (method, params) => {
    calls.push({ method, params });
    if (!(method in replies)) throw new Error(`unexpected ${method}`);
    return replies[method];
  } };
}

test('AC-1 AC-4: new writer refuses a linked Vibe worktree without a record before thread start', async (t) => {
  const f = fixture(t);
  const app = client();
  await assert.rejects(run(app, f.options()), /not-yet-existing path.*vibe new.*cloud-worker\.mjs.*pr-takeover/s);
  assert.deepEqual(app.calls, []);
  assert.equal(loadState(f.stateDir, 'writer'), null);
});

test('AC-1 AC-4: new writer accepts a matching active record in a Vibe-shaped linked worktree', async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify(f.record));
  const app = client();
  assert.equal(await run(app, f.options()), 'writer turn T1 U1');
  assert.equal(app.calls[0].method, 'thread/start');
  assert.equal(existsSync(join(f.stateDir, 'writer.launch.json')), false);
});

test('AC-1: a durable launch journal precedes thread creation and survives a pre-save failure', async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify(f.record));
  const journal = join(f.stateDir, 'writer.launch.json');
  const app = { request: async (method) => {
    if (method === 'thread/start') {
      const saved = JSON.parse(readFileSync(journal, 'utf8'));
      assert.equal(saved.phase, 'may-have-started');
      assert.equal(saved.launcher.pid, process.pid);
      assert.match(saved.launcher.identity, /\S/);
      return { thread: { id: 'T1' } };
    }
    if (method === 'turn/start') {
      const saved = JSON.parse(readFileSync(journal, 'utf8'));
      assert.equal(saved.phase, 'thread-created');
      assert.equal(saved.threadId, 'T1');
      throw new Error('simulated failure before state save');
    }
    if (['thread/name/set', 'threadSection/list', 'threadSection/create', 'thread/section/move'].includes(method)) {
      return method === 'threadSection/list' ? { data: [], nextCursor: null }
        : method === 'threadSection/create' ? { section: { id: 'S1' } } : {};
    }
    throw new Error(`unexpected ${method}`);
  } };
  await assert.rejects(run(app, f.options()), /simulated failure before state save/);
  assert.equal(loadState(f.stateDir, 'writer'), null);
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).phase, 'thread-created');
});

test('AC-1: accepted turn journal keeps both thread and turn ids before state save', async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify(f.record));
  const journal = join(f.stateDir, 'writer.launch.json');
  const app = { request: async (method) => {
    if (method === 'thread/start') return { thread: { id: 'T1' } };
    if (method === 'turn/start') {
      mkdirSync(join(f.stateDir, 'writer.json'));
      return { turn: { id: 'U1' } };
    }
    if (['thread/name/set', 'threadSection/list', 'threadSection/create', 'thread/section/move'].includes(method)) {
      return method === 'threadSection/list' ? { data: [], nextCursor: null }
        : method === 'threadSection/create' ? { section: { id: 'S1' } } : {};
    }
    throw new Error(`unexpected ${method}`);
  } };
  await assert.rejects(run(app, f.options()));
  const saved = JSON.parse(readFileSync(journal, 'utf8'));
  assert.equal(saved.phase, 'turn-created');
  assert.equal(saved.threadId, 'T1');
  assert.equal(saved.turnId, 'U1');
});

function preparedJournal(f, launcher) {
  mkdirSync(f.stateDir, { recursive: true });
  const journal = join(f.stateDir, 'writer.launch.json');
  writeFileSync(journal, JSON.stringify({ phase: 'prepared', cwd: f.worktree, launcher }));
  return journal;
}

test('a local new writer retries after its exact prepared launcher has died', async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify(f.record));
  const journal = preparedJournal(f, { pid: 999999, identity: 'dead launcher' });
  const app = client();
  assert.equal(await run(app, f.options()), 'writer turn T1 U1');
  assert.equal(app.calls[0].method, 'thread/start');
  assert.equal(existsSync(journal), false);
});

test('a live or uncertain prepared launcher blocks a local new writer', async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify(f.record));
  const exact = readProcessIdentity(process.pid);
  assert.ok(exact);
  const journal = preparedJournal(f, { pid: process.pid, identity: exact });
  const app = client();
  await assert.rejects(run(app, f.options()), /launch|exists|busy/i);
  assert.deepEqual(app.calls, []);
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).launcher.identity, exact);
  writeFileSync(journal, JSON.stringify({ phase: 'prepared', launcher: { pid: process.pid } }));
  await assert.rejects(run(app, f.options()), /launch|exists|busy/i);
  assert.ok(existsSync(journal));
  writeFileSync(journal, JSON.stringify({ phase: 'may-have-started', launcher: { pid: 999999, identity: 'dead' } }));
  await assert.rejects(run(app, f.options()), /launch|exists|busy/i);
  assert.ok(existsSync(journal));
});

test('a reused PID with a different birth identity permits local prepared retry', async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify(f.record));
  const journal = preparedJournal(f, { pid: process.pid, identity: 'prior birth' });
  const app = client();
  assert.equal(await run(app, f.options()), 'writer turn T1 U1');
  assert.equal(app.calls[0].method, 'thread/start');
  assert.equal(existsSync(journal), false);
});

test('a saved local session coexists with an old prepared journal without replacing its thread', async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify(f.record));
  saveState(f.stateDir, 'writer', { threadId: 'T1', cwd: f.worktree, ticket: 'ISS-1', model: 'm', effort: 'high', turns: [] });
  const journal = preparedJournal(f, { pid: 999999, identity: 'dead launcher' });
  const app = client();
  assert.equal(await run(app, f.options()), 'writer turn T1 U1');
  assert.equal(app.calls[0].method, 'thread/resume');
  assert.ok(existsSync(journal));
});

test('AC-1: an active Vibe record with an optional operator name is admitted', async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify({ ...f.record, operator: { ...f.record.operator, name: null } }));
  const first = client();
  assert.equal(await run(first, f.options()), 'writer turn T1 U1');
  assert.equal(first.calls[0].method, 'thread/start');

  const operatorWithoutName = { ...f.record.operator };
  delete operatorWithoutName.name;
  writeFileSync(f.recordPath, JSON.stringify({ ...f.record, operator: operatorWithoutName }));
  const second = client();
  assert.equal(await run(second, { ...f.options(), stateDir: join(f.dir, 'second-state') }), 'writer turn T1 U1');
  assert.equal(second.calls[0].method, 'thread/start');
});

test('new writer refuses inactive and wrong-ticket records in a linked worktree', async (t) => {
  const f = fixture(t);
  const app = client();
  writeFileSync(f.recordPath, JSON.stringify({ ...f.record, status: 'stopped' }));
  await assert.rejects(run(app, f.options()), /not-yet-existing path.*vibe new.*cloud-worker\.mjs.*pr-takeover/s);
  assert.equal(existsSync(join(f.stateDir, 'writer.launch.json')), false, 'pre-thread refusal clears only its prepared journal');
  writeFileSync(f.recordPath, JSON.stringify({ ...f.record, ticket: 'ISS-2', liveTicket: 'ISS-2' }));
  await assert.rejects(run(app, f.options()), /ticket.*ISS-1/);
  assert.deepEqual(app.calls, []);
});

test('new writer binds the brief ticket and refuses a mismatched --ticket even with a valid record', async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify(f.record));
  const app = client();
  writeFileSync(f.promptFile, '$vibe ISS-2\n');
  await assert.rejects(run(app, f.options()), /brief.*ticket|ticket.*brief/i);
  writeFileSync(f.promptFile, '$vibe ISS-1\n');
  await assert.rejects(run(app, f.options('ISS-2')), /brief.*ticket|ticket.*brief/i);
  assert.deepEqual(app.calls, []);
});

test('new writer uses the brief ticket when --ticket is omitted and rejects an unnamed brief', async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify(f.record));
  const app = client();
  const withoutFlag = parseCli(['turn', f.stateDir, 'writer', '--prompt-file', f.promptFile,
    '--cwd', f.worktree, '--model', 'm', '--effort', 'high']);
  writeFileSync(f.promptFile, '$vibe resume this session\n');
  await assert.rejects(run(app, withoutFlag), /brief naming its ticket/);
  assert.equal(existsSync(join(f.stateDir, 'writer.launch.json')), false);
  assert.deepEqual(app.calls, []);
  writeFileSync(f.promptFile, '$vibe ISS-1\n');
  assert.equal(await run(app, withoutFlag), 'writer turn T1 U1');
});

test('new writer accepts a PRD-origin Vibe session after its live ISS becomes canonical', async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify({ ...f.record, ticket: 'PRD-9', liveTicket: 'ISS-1' }));
  const app = client();
  writeFileSync(f.promptFile, '$vibe PRD-9\n');
  await assert.rejects(run(app, f.options('PRD-9')), /different vibe session ticket/);
  assert.deepEqual(app.calls, []);
  writeFileSync(f.promptFile, '$vibe ISS-1\n');
  assert.equal(await run(app, f.options()), 'writer turn T1 U1');
  assert.equal(app.calls[0].method, 'thread/start');
});

test('new writer rejects git init plus a hand-written record outside Vibe creation topology', async (t) => {
  const f = fixture(t);
  const fake = join(f.dir, 'standalone');
  execFileSync('git', ['init', '-q', '-b', 'vibe/example', fake]);
  writeFileSync(join(git(fake, 'rev-parse', '--absolute-git-dir'), 'vibe-session.json'), JSON.stringify(f.record));
  const app = client();
  await assert.rejects(run(app, { ...f.options(), cwd: fake }), /Vibe-created linked worktree|not-yet-existing path/s);
  assert.deepEqual(app.calls, []);
});

test('new writer rejects a linked record without Vibe ticket provenance', async (t) => {
  const f = fixture(t);
  const record = { ...f.record };
  delete record.liveTicketCreatedBySession;
  writeFileSync(f.recordPath, JSON.stringify(record));
  const app = client();
  await assert.rejects(run(app, f.options()), /ticket ownership provenance/);
  assert.deepEqual(app.calls, []);
});

test('AC-2 AC-4: new writer still accepts a not-yet-existing worktree path', async (t) => {
  const f = fixture(t);
  const future = join(f.repo, '.claude', 'worktrees', 'vibe-future-worktree');
  const app = client();
  assert.equal(await run(app, { ...f.options(), cwd: future }), 'writer turn T1 U1');
  assert.equal(existsSync(future), false);
  assert.equal(app.calls[0].method, 'thread/start');
});

test('AC-3: saved writer with an active linked Vibe record resumes its existing thread', async (t) => {
  const f = fixture(t);
  writeFileSync(f.recordPath, JSON.stringify(f.record));
  saveState(f.stateDir, 'writer', { threadId: 'T1', cwd: f.worktree, ticket: 'ISS-1', model: 'm', effort: 'high', turns: [] });
  assert.equal(requireResumeSession(loadState(f.stateDir, 'writer'), f.worktree).branch, 'vibe/example');
  const app = client();
  const options = parseCli(['turn', f.stateDir, 'writer', '--prompt-file', f.promptFile]);
  assert.equal(await run(app, options), 'writer turn T1 U1');
  assert.equal(app.calls[0].method, 'thread/resume');
});

test('direct CLI refuses an unrecorded linked worktree before App Server connection', (t) => {
  const f = fixture(t);
  const bin = join(f.dir, 'bin');
  mkdirSync(bin);
  const codex = join(bin, 'codex');
  writeFileSync(codex, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ socketPath: join(f.dir, 'missing.sock') })}'\n`);
  chmodSync(codex, 0o755);
  const result = spawnSync(process.execPath, [new URL('./codex-session.mjs', import.meta.url).pathname,
    'turn', f.stateDir, 'writer', '--prompt-file', f.promptFile, '--cwd', f.worktree,
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'], { encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /not-yet-existing path.*vibe new.*cloud-worker\.mjs.*pr-takeover/s);
  assert.equal(loadState(f.stateDir, 'writer'), null);
});

// Codex runs hooks in the thread's cwd, and a not-yet-existing worktree path can run
// none, so a fleet writer's first $vibe turn recorded no load evidence for its own thread.
test('a new thread whose cwd does not exist yet starts in the checkout that owns the worktree path', async (t) => {
  const f = fixture(t);
  const future = join(f.repo, '.claude', 'worktrees', 'vibe-future');
  const app = client();
  assert.equal(await run(app, { ...f.options(), cwd: future }), 'writer turn T1 U1');
  assert.equal(app.calls.find((call) => call.method === 'thread/start').params.cwd, f.repo);
  assert.equal(app.calls.find((call) => call.method === 'turn/start').params.cwd, f.repo);
  assert.equal(loadState(f.stateDir, 'writer').cwd, future, 'the session stays bound to the worktree vibe new creates');
  assert.equal(existsSync(future), false);
});

test('a new writer whose missing cwd is not under a checkout is refused at launch with the fix', async (t) => {
  const f = fixture(t);
  assert.throws(() => launchCwd(join(f.dir, 'future-worktree')),
    /does not exist.*<checkout>\/\.claude\/worktrees\/<name>.*main checkout.*vibe new/s);
  assert.throws(() => launchCwd(join(f.dir, 'loose', '.claude', 'worktrees', 'vibe-x')), /does not exist/);
  assert.equal(launchCwd(f.worktree), f.worktree);
  const result = spawnSync(process.execPath, [new URL('./codex-session.mjs', import.meta.url).pathname,
    'turn', f.stateDir, 'writer', '--prompt-file', f.promptFile, '--cwd', join(f.dir, 'future-worktree'),
    '--ticket', 'ISS-1', '--model', 'm', '--effort', 'high'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /future-worktree does not exist.*vibe new creates it/s);
  assert.equal(loadState(f.stateDir, 'writer'), null);
});

// a first turn that ended before vibe new (a refused load check, a question, an early
// stop) left a thread fleet.sh refused every later turn on.
test('a thread whose first turn created no session accepts a $vibe recovery turn for the same ticket and worktree', async (t) => {
  const f = fixture(t);
  const future = join(f.repo, '.claude', 'worktrees', 'vibe-future');
  saveState(f.stateDir, 'writer', { threadId: 'T1', cwd: future, ticket: 'ISS-1', model: 'm', effort: 'high', turns: [{ turnId: 'U0', kind: 'turn' }] });
  const saved = loadState(f.stateDir, 'writer');
  assert.equal(requireResumeSession(saved, future, '$vibe ISS-1 continue\n'), null);
  const app = client();
  const options = parseCli(['turn', f.stateDir, 'writer', '--prompt-file', f.promptFile]);
  assert.equal(await run(app, options), 'writer turn T1 U1');
  assert.deepEqual(app.calls.map((call) => call.method), ['thread/resume', 'turn/start']);
  assert.equal(app.calls[0].params.cwd, f.repo);
  assert.equal(loadState(f.stateDir, 'writer').turns.length, 2);
});

test('a thread with no session refuses an ordinary turn and a $vibe turn for another ticket or worktree', async (t) => {
  const f = fixture(t);
  const future = join(f.repo, '.claude', 'worktrees', 'vibe-future');
  saveState(f.stateDir, 'writer', { threadId: 'T1', cwd: future, ticket: 'ISS-1', model: 'm', effort: 'high', turns: [] });
  const saved = loadState(f.stateDir, 'writer');
  assert.throws(() => requireResumeSession(saved, future, 'keep going\n'), /no vibe session record.*\$vibe ISS-1/s);
  assert.throws(() => requireResumeSession(saved, future, '$vibe ISS-2\n'), /ticket ISS-2.*ISS-1/s);
  assert.throws(() => requireResumeSession(saved, f.worktree, '$vibe ISS-1\n'), /bound to/);
  assert.throws(() => requireResumeSession({ ...saved, cwd: f.worktree }, f.worktree, '$vibe ISS-1\n'), /no vibe session record/);
  writeFileSync(f.promptFile, 'keep going\n');
  const result = spawnSync(process.execPath, [new URL('./codex-session.mjs', import.meta.url).pathname,
    'turn', f.stateDir, 'writer', '--prompt-file', f.promptFile], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /no vibe session record .* yet; a thread whose first turn created no session takes only a \$vibe ISS-1 recovery turn/);
  assert.equal(loadState(f.stateDir, 'writer').turns.length, 0);
});

// Codex pins plugin hook approval to the whole bundle, so every vibe-core release leaves
// its hooks "modified" and failing until they are approved again.
test('a writer launch is refused while any vibe-core Codex hook is not trusted, naming the fix', async (t) => {
  const f = fixture(t);
  const listing = (trustStatus) => ({ data: [{ cwd: f.repo, hooks: [
    { key: 'vibe-core@fixture-market:hooks/hooks.json:user_prompt_submit:0:0', pluginId: 'vibe-core@fixture-market', trustStatus, enabled: true },
    { key: 'vibe-core@fixture-market:hooks/hooks.json:pre_tool_use:0:0', pluginId: 'vibe-core@fixture-market', trustStatus: 'trusted', enabled: true },
    { key: 'vibe@fixture-market:hooks/hooks.json:pre_tool_use:0:0', pluginId: 'vibe@fixture-market', trustStatus: 'modified', enabled: true },
    { key: '/fixture/.codex/hooks.json:user_prompt_submit:0:0', pluginId: null, trustStatus: 'untrusted', enabled: true },
  ] }] });
  const future = join(f.repo, '.claude', 'worktrees', 'vibe-future');
  const modified = client();
  modified.request = async (method, params) => {
    modified.calls.push({ method, params });
    if (method === 'hooks/list') return listing('modified');
    throw new Error(`unexpected ${method}`);
  };
  await assert.rejects(launchWriter(modified, { ...f.options(), cwd: future }),
    /vibe-core@fixture-market:hooks\/hooks.json:user_prompt_submit:0:0 is modified\); open Codex once and approve vibe-core's hooks in \/hooks/s);
  assert.deepEqual(modified.calls.map((call) => call.method), ['hooks/list']);
  assert.deepEqual(modified.calls[0].params, { cwds: [f.repo] });
  assert.equal(loadState(f.stateDir, 'writer'), null);

  const trusted = client();
  const request = trusted.request;
  trusted.request = async (method, params) => (method === 'hooks/list' ? listing('trusted') : request(method, params));
  assert.equal(await launchWriter(trusted, { ...f.options(), cwd: future }), 'writer turn T1 U1');
});

test('an App Server without hooks/list keeps launching; other listing failures refuse', async () => {
  const old = { request: async () => { throw new Error('unknown variant `hooks/list`'); } };
  assert.equal(await vibeHookTrustProblem(old, '/x'), null);
  const broken = { request: async () => { throw new Error('socket closed'); } };
  assert.match(await vibeHookTrustProblem(broken, '/x'), /could not list Codex hooks: socket closed/);
  const disabled = { request: async () => ({ data: [{ hooks: [{ key: 'vibe-core@fixture-market:k', pluginId: 'vibe-core@fixture-market', trustStatus: 'trusted', enabled: false }] }] }) };
  assert.match(await vibeHookTrustProblem(disabled, '/x'), /vibe-core@fixture-market:k is disabled/);
});

// vibe 1.1.69 ships no hooks of its own, and Codex installs no plugin dependency, so a vibe
// update without vibe-core leaves every guard off; the launch says how to add it.
test('a writer launch is refused when vibe-core lists no hooks, naming the add command and /hooks', async () => {
  const listing = (hooks) => ({ request: async () => ({ data: [{ cwd: '/x', hooks }] }) });
  const userHook = { key: '/fixture/.codex/hooks.json:user_prompt_submit:0:0', pluginId: null, trustStatus: 'trusted', enabled: true };
  const oldVibe = { key: 'vibe@fixture-market:hooks/hooks.json:pre_tool_use:0:0', pluginId: 'vibe@fixture-market', trustStatus: 'trusted', enabled: true };
  for (const hooks of [[], [userHook], [userHook, oldVibe]]) {
    assert.equal(await vibeHookTrustProblem(listing(hooks), '/x'),
      `vibe-core's Codex hooks are not installed, so vibe's guards cannot run; run \`${VIBE_CORE_INSTALL.codex}\`, then open Codex once and approve vibe-core's hooks in /hooks, then launch again`);
  }
  const core = { key: 'vibe-core@fixture-market:hooks/hooks.json:pre_tool_use:0:0', pluginId: 'vibe-core@fixture-market', trustStatus: 'trusted', enabled: true };
  assert.equal(await vibeHookTrustProblem(listing([userHook, core]), '/x'), null);
});
