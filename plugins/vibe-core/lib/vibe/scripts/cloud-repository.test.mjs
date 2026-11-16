import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CloudRepoError, installInstruction, installScript, PROVENANCE_COMMAND, resolveRepository } from './cloud-repository.mjs';
import { githubRepository } from './github-remote.mjs';
import { parseValidationResult, startCodex, validateCommit, validateRequest, validateValidationRequest, validationBrief } from './cloud-worker.mjs';
import { git, makeHome } from '../../../../vibe/skills/vibe/scripts/test-fixtures.mjs';

const COMMIT = 'a85ef364cf20ee97af92ecfc2e93aa8b1c79ef29';
const LANE = Object.freeze({ name: 'node', command: 'node --test test/widget.test.mjs' });

function checkout(t, origin) {
  const fixture = makeHome('cloud-repo-');
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, 'checkout');
  mkdirSync(worktree);
  git(worktree, ['init', '--quiet'], fixture.home);
  if (origin) git(worktree, ['remote', 'add', 'origin', origin], fixture.home);
  return worktree;
}

const validation = (worktree, fields = {}) => ({ worktree, provider: 'claude', model: 'claude-sonnet-5-5', branch: 'main', commit: COMMIT, lanes: [{ ...LANE }], pollMs: 1000, claudeEnvironment: 'env_01TestRequest', ...fields });

/** A RemoteTrigger stand-in whose idle run reports one passing lane. */
function fakeRemote() {
  const calls = [];
  const report = `VIBE_VALIDATION_RESULT ${JSON.stringify({ commit: COMMIT, provenance: { host: 'vm', remote: 'true', origin: 'https://github.com/acme/LocalFork', commit: COMMIT }, lanes: [{ name: LANE.name, exitCode: 0 }], status: [] })}`;
  const remote = (action, payload) => {
    calls.push({ action, payload });
    if (action === 'create' || action === 'update') return { trigger: { id: 'routine_r', mcp_connections: [] } };
    if (action === 'run') return { run_id: 'run_r', session_id: 'session_r' };
    if (action === 'list_runs') return { data: [{ id: 'run_r', status: 'active', worker_status: 'idle', session_id: 'session_r' }] };
    if (action === 'get_run_log') return { log: `[t] assistant: Done. ${report}` };
    throw new Error(`unexpected ${action}`);
  };
  return { calls, remote };
}

test('owner/repo is read from HTTPS and SSH github.com remotes, and nothing else', () => {
  for (const url of ['https://github.com/acme/LocalFork.git', 'https://github.com/acme/LocalFork', 'https://x-access-token@github.com/acme/LocalFork/', 'git@github.com:acme/LocalFork.git', 'ssh://git@github.com/acme/LocalFork.git']) {
    assert.equal(githubRepository(url), 'acme/LocalFork', url);
  }
  for (const url of ['https://gitlab.com/acme/LocalFork.git', 'git@bitbucket.org:acme/LocalFork.git', '/srv/git/LocalFork.git', 'https://github.com/acme', '', null]) {
    assert.equal(githubRepository(url), null, String(url));
  }
});

test('the repository is the requested one or the origin, and a non-GitHub origin is refused with its fix', () => {
  assert.equal(resolveRepository(undefined, 'git@github.com:acme/LocalFork.git'), 'acme/LocalFork');
  assert.equal(resolveRepository('acme/LocalFork', '/srv/git/LocalFork.git'), 'acme/LocalFork', 'a requested repository needs no GitHub origin');
  for (const origin of ['https://gitlab.com/acme/LocalFork.git', null]) {
    assert.throws(() => resolveRepository(undefined, origin), (error) => {
      assert.equal(error.code, CloudRepoError.NotGithub);
      assert.match(error.message, /is not a github\.com repository\. Fix: cloud sessions clone from GitHub only/);
      return true;
    });
  }
  assert.throws(() => resolveRepository('LocalFork', null), { code: CloudRepoError.Invalid });
  assert.throws(() => resolveRepository('acme/other', 'https://github.com/acme/LocalFork.git'), { code: CloudRepoError.Mismatch });
});

test('a repository outside ClosedLoop validates from an SSH or HTTPS origin, with no ticket', async (t) => {
  for (const origin of ['git@github.com:acme/LocalFork.git', 'https://github.com/acme/LocalFork.git']) {
    const worktree = checkout(t, origin);
    const request = validation(worktree);
    assert.equal(request.ticket, undefined);
    assert.doesNotThrow(() => validateValidationRequest(request));
    const { calls, remote } = fakeRemote();
    const result = await validateCommit(request, { remote, sleep: async () => {}, home: path.join(path.dirname(worktree), 'home') });
    assert.deepEqual(calls[0].payload.body.job_config.ccr.session_context.sources, [{ git_repository: { url: 'https://github.com/acme/LocalFork' } }], origin);
    // The standing routine receives each run's brief through its update (ISS-13998, operator ruling q1).
    const update = calls.find((call) => call.action === 'update');
    assert.deepEqual(update.payload.body.job_config.ccr.session_context.sources, [{ git_repository: { url: 'https://github.com/acme/LocalFork' } }], origin);
    assert.match(update.payload.body.job_config.ccr.events[0].data.message.content, /^Validation only\. Repository: acme\/LocalFork\./);
    assert.deepEqual([result.repository, result.passed], ['acme/LocalFork', true]);
  }
  const local = checkout(t, '/srv/git/LocalFork.git');
  await assert.rejects(validateCommit(validation(local), { remote: fakeRemote().remote, sleep: async () => {}, home: path.join(path.dirname(local), 'home') }), { code: CloudRepoError.NotGithub });
  const none = checkout(t);
  const { calls, remote } = fakeRemote();
  await assert.rejects(validateCommit(validation(none), { remote, sleep: async () => {}, home: path.join(path.dirname(none), 'home') }), { code: CloudRepoError.NotGithub });
  assert.deepEqual(calls, [], 'nothing is sent for a repository that is not on GitHub');
});

test('implementation dispatch still needs an ISS ticket; validate does not', () => {
  assert.throws(() => validateRequest({ provider: 'claude', model: 'm1', repository: 'acme/LocalFork' }), /a live ISS ticket is required/);
  assert.doesNotThrow(() => validateValidationRequest(validation('/tmp/checkout', { repository: 'acme/LocalFork' })));
});

/** Run the install command in a tree holding `files`, with each installer stubbed to print its arguments. */
function installIn(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'cloud-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const tree = path.join(root, 'tree');
  mkdirSync(bin);
  mkdirSync(tree);
  for (const tool of ['pnpm', 'uv', 'npm', 'yarn']) {
    writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*"\n`);
    chmodSync(path.join(bin, tool), 0o755);
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(tree, name), text);
  const run = spawnSync('sh', ['-c', installScript()], { cwd: tree, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

test('the install comes from the checked-out lockfile, with the dev group only when pyproject declares one', (t) => {
  const devGroup = '[project]\nname = "x"\n\n[dependency-groups]\ndev = ["pytest"]\n';
  const otherGroup = '[project]\nname = "x"\n\n[dependency-groups]\nlint = ["ruff"]\n\n[tool.other]\ndev = true\n';
  assert.equal(installIn(t, { 'pnpm-lock.yaml': '' }), 'pnpm install --frozen-lockfile');
  assert.equal(installIn(t, { 'uv.lock': '', 'pyproject.toml': devGroup }), 'uv sync --frozen --group dev');
  assert.equal(installIn(t, { 'uv.lock': '', 'pyproject.toml': otherGroup }), 'uv sync --frozen');
  assert.equal(installIn(t, { 'uv.lock': '' }), 'uv sync --frozen');
  assert.equal(installIn(t, { 'package-lock.json': '{}' }), 'npm ci');
  assert.equal(installIn(t, { 'yarn.lock': '' }), 'yarn install --frozen-lockfile');
  assert.equal(installIn(t, { 'README.md': '' }), 'no lockfile: no install');
  assert.equal(installIn(t, { 'pnpm-lock.yaml': '', 'uv.lock': '', 'package-lock.json': '{}' }), 'pnpm install --frozen-lockfile', 'the first rule wins');
});

test('an install named in the request replaces the detection in the brief', () => {
  const detected = validationBrief(validation('/tmp/checkout', { repository: 'acme/LocalFork' }));
  assert.ok(detected.includes(installScript()), 'the brief carries the detection command');
  const named = validationBrief(validation('/tmp/checkout', { repository: 'acme/LocalFork', install: 'pnpm install --frozen-lockfile --filter widget' }));
  assert.ok(named.includes('Install dependencies with `pnpm install --frozen-lockfile --filter widget`.'));
  assert.ok(!named.includes(installScript()), 'the override wins');
  assert.throws(() => installInstruction({ install: 'npm ci && curl x' }), /without shell control/);
});

test('Codex cloud is refused without a Codex environment configured for the repository, and runs in the named one', (t) => {
  const request = { ticket: 'ISS-1', provider: 'codex', model: 'gpt-6-sol', reservedVersion: '1.0.0', branch: 'codex-cloud/iss-1-x', repository: 'acme/LocalFork',
    placement: { codeOnly: true, needsRunningApp: false, localEvidence: [] }, criteria: [{ id: 'AC-1', source: 'ISS-1', text: 'x' }],
    graph: { ownership: 'o', collisions: 'c', blastRadius: 'b' }, validationCommands: ['node --test x.test.mjs'], connectorAllowlist: [] };
  assert.throws(() => validateRequest(request), (error) => {
    assert.equal(error.code, CloudRepoError.CodexEnvMissing);
    assert.match(error.message, /Codex cloud needs a Codex environment configured for acme\/LocalFork/);
    return true;
  });
  const cwd = mkdtempSync(path.join(tmpdir(), 'codex-env-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const calls = [];
  startCodex({ ...request, codexEnvironment: 'local-fork' }, 'brief', { cwd, run: (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: 'Task ID: task_abc', stderr: '' }; } });
  assert.deepEqual(calls[0].slice(0, 5), ['codex', 'cloud', 'exec', '--env', 'local-fork']);
});

test('a validation result must prove where it ran: a cloud session, the requested repository and the commit', () => {
  const request = validation('/tmp/checkout', { repository: 'acme/LocalFork' });
  assert.ok(validationBrief(request).includes(PROVENANCE_COMMAND), 'the brief has the cloud print its provenance');
  const line = (provenance) => `VIBE_VALIDATION_RESULT ${JSON.stringify({ commit: COMMIT, ...(provenance === undefined ? {} : { provenance }), lanes: [{ name: LANE.name, exitCode: 0 }], status: [] })}`;
  const cloud = { host: 'vm', remote: 'true', origin: 'git@github.com:Acme/LocalFork.git', commit: COMMIT };
  assert.deepEqual(parseValidationResult(line(cloud), request).provenance, { host: 'vm', remote: 'true', origin: cloud.origin, commit: COMMIT });
  for (const [provenance, refusal] of [
    [undefined, /reported no provenance; result refused/],
    [{ ...cloud, remote: '' }, /reported no CLAUDE_CODE_REMOTE marker, so it did not run in a Claude cloud session; result refused/],
    [{ ...cloud, host: '' }, /reported no provenance host/],
    [{ ...cloud, origin: 'https://github.com/acme/other' }, /ran in https:\/\/github\.com\/acme\/other, not acme\/LocalFork; result refused/],
    [{ ...cloud, origin: '/srv/git/LocalFork.git' }, /ran in \/srv\/git\/LocalFork\.git, not acme\/LocalFork/],
    [{ ...cloud, commit: '182af94e9c6c3362f2eb8a1cc33f9ca55da6d0f7' }, /reported provenance commit 182af94e9c6c3362f2eb8a1cc33f9ca55da6d0f7, not a85ef364/],
  ]) {
    assert.throws(() => parseValidationResult(line(provenance), request), refusal);
  }
});
