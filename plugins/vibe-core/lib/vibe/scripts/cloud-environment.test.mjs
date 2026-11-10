import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLAUDE_ENV_VAR, checkCloudSetup, CloudSetupError, resolveClaudeEnvironment } from './cloud-environment.mjs';
import { pollTask, remoteTrigger, startClaude } from './cloud-worker.mjs';

const REQUEST_ENV = 'env_01FromRequest';
const VAR_ENV = 'env_01FromVariable';
const CONFIG_ENV = 'env_01FromConfig';

/** A fleet home with no config.env, or one setting CLOUD_CLAUDE_ENV. */
function fleetHome(t, configured) {
  const home = mkdtempSync(path.join(tmpdir(), 'cloud-env-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (configured) writeFileSync(path.join(home, 'config.env'), `CODEX_MODEL=x\nCLOUD_CLAUDE_ENV="${configured}"\n`);
  return home;
}

const httpError = (status) => Object.assign(new Error(`RemoteTrigger failed: HTTP ${status}`), { httpStatus: status });

/** A RemoteTrigger stand-in recording calls; `overrides[action]` returns a value or throws. */
function fakeRemote(overrides = {}) {
  const calls = [];
  const remote = (action, payload) => {
    calls.push({ action, payload });
    if (overrides[action]) return overrides[action](payload);
    if (action === 'create') return { trigger: { id: 'routine_e', mcp_connections: [] } };
    if (action === 'update') return { trigger: { id: 'routine_e', mcp_connections: [] } };
    if (action === 'run') return { run_id: 'run_e', session_id: 'session_e' };
    if (action === 'list') return { data: [] };
    throw new Error(`unexpected ${action}`);
  };
  return { calls, remote };
}

const dispatchRequest = (fields = {}) => ({ ticket: 'ISS-1', provider: 'claude', model: 'claude-sonnet-5-5', connectorAllowlist: [], ...fields });

test('the environment comes from the request, then the variable, then the fleet config, and that id is the one sent', (t) => {
  const home = fleetHome(t, CONFIG_ENV);
  const env = { FLEET_HOME: home, [CLAUDE_ENV_VAR]: VAR_ENV };
  assert.deepEqual(resolveClaudeEnvironment({ claudeEnvironment: REQUEST_ENV }, { env }), { id: REQUEST_ENV, source: 'request claudeEnvironment' });
  assert.deepEqual(resolveClaudeEnvironment({}, { env }), { id: VAR_ENV, source: CLAUDE_ENV_VAR });
  assert.deepEqual(resolveClaudeEnvironment({ claudeEnvironment: ' ' }, { env: { FLEET_HOME: home, [CLAUDE_ENV_VAR]: '' } }),
    { id: CONFIG_ENV, source: `CLOUD_CLAUDE_ENV in ${path.join(home, 'config.env')}` });

  for (const [request, expected] of [[dispatchRequest({ claudeEnvironment: REQUEST_ENV }), REQUEST_ENV], [dispatchRequest(), VAR_ENV]]) {
    const { calls, remote } = fakeRemote();
    const started = startClaude(request, 'brief', { remote, env });
    assert.equal(calls[0].action, 'create');
    assert.equal(calls[0].payload.body.job_config.ccr.environment_id, expected);
    assert.equal(started.environment.id, expected, 'the receipt records the environment used');
  }
});

test('with no environment configured, or a malformed one, nothing is sent and the named error carries the fix', (t) => {
  const env = { FLEET_HOME: fleetHome(t) };
  const { calls, remote } = fakeRemote();
  assert.throws(() => startClaude(dispatchRequest(), 'brief', { remote, env }), (error) => {
    assert.equal(error.code, CloudSetupError.EnvMissing);
    assert.match(error.message, /^CLOUD_ENV_MISSING: no Claude cloud environment is configured, and none is sent by default\. Fix: set VIBE_CLOUD_CLAUDE_ENV=<env id>, or CLOUD_CLAUDE_ENV=<env id> in the fleet home's config\.env/);
    return true;
  });
  assert.throws(() => startClaude(dispatchRequest({ claudeEnvironment: 'default' }), 'brief', { remote, env }), (error) => {
    assert.equal(error.code, CloudSetupError.EnvInvalid);
    assert.match(error.message, /default \(request claudeEnvironment\) is not an environment id/);
    return true;
  });
  assert.deepEqual(calls, [], 'no RemoteTrigger call without a valid environment');
});

test('a refused create is named: an environment this account cannot use, or a refused sign-in', (t) => {
  const env = { FLEET_HOME: fleetHome(t) };
  const request = dispatchRequest({ claudeEnvironment: REQUEST_ENV });
  const unknown = fakeRemote({ create: () => { throw httpError(401); } });
  assert.throws(() => startClaude(request, 'brief', { remote: unknown.remote, env }), (error) => {
    assert.equal(error.code, CloudSetupError.EnvUnknown);
    assert.match(error.message, /create was refused \(HTTP 401\) for Claude environment env_01FromRequest \(request claudeEnvironment\) while this account's routine list answers/);
    return true;
  });
  assert.deepEqual(unknown.calls.map((call) => call.action), ['create', 'list'], 'nothing is fired after a refused create');
  const missing = fakeRemote({ create: () => { throw httpError(404); } });
  assert.throws(() => startClaude(request, 'brief', { remote: missing.remote, env }), { code: CloudSetupError.EnvUnknown });
  const signedOut = fakeRemote({ create: () => { throw httpError(403); }, list: () => { throw httpError(403); } });
  assert.throws(() => startClaude(request, 'brief', { remote: signedOut.remote, env }), (error) => {
    assert.equal(error.code, CloudSetupError.AuthRefused);
    assert.match(error.message, /refused this account \(HTTP 403\)\. Fix: sign in to Claude Code again with \/login/);
    return true;
  });
  const other = fakeRemote({ create: () => { throw httpError(500); } });
  assert.throws(() => startClaude(request, 'brief', { remote: other.remote, env }), (error) => error.httpStatus === 500 && !error.code);
});

test('a fired run that never appears is CLOUD_RUN_NOT_CREATED, naming GitHub, the environment and what the routine reports', async () => {
  const environment = { id: REQUEST_ENV, source: 'request claudeEnvironment' };
  const { remote } = fakeRemote({
    list_runs: () => ({ data: [] }),
    get: () => ({ trigger: { last_run: { status: 'ROUTINE_RUN_STATUS_FAILED', failure_reason: 'ROUTINE_RUN_FAILURE_REASON_EXAMPLE' } } }),
  });
  const receipt = { provider: 'claude', routineId: 'routine_e', runId: 'run_e', environment, startedAt: new Date().toISOString() };
  await assert.rejects(pollTask(receipt, { repository: 'closedloop-ai/claude-plugins', maxWallMs: 60_000, pollMs: 1000 }, { remote, sleep: async () => {} }), (error) => {
    assert.equal(error.code, CloudSetupError.RunNotCreated);
    assert.match(error.message, /The routine reports last run ROUTINE_RUN_STATUS_FAILED, ROUTINE_RUN_FAILURE_REASON_EXAMPLE\./);
    assert.match(error.message, /Fix: connect GitHub to the Claude account with access to closedloop-ai\/claude-plugins \(the Claude GitHub App\), confirm env_01FromRequest \(request claudeEnvironment\)/);
    return true;
  });
});

test('the setup check reports each environment and API result with its fix, and what it cannot check', (t) => {
  const used = { data: [{ id: 'trig_a', job_config: { ccr: { environment_id: REQUEST_ENV } } }, { id: 'trig_b', job_config: { ccr: { environment_id: 'env_01Other' } } }] };
  const ok = checkCloudSetup({ claudeEnvironment: REQUEST_ENV }, { remote: fakeRemote({ list: () => used }).remote, env: { FLEET_HOME: fleetHome(t) } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.checks.map(({ check, ok: passed }) => [check, passed]), [['environment', true], ['api', true], ['environment-use', true], ['github', null]]);
  assert.match(ok.checks[2].detail, /routine trig_a on this account runs in env_01FromRequest/);
  assert.match(ok.checks[3].detail, /no GitHub connection endpoint/);

  const unseen = checkCloudSetup({ claudeEnvironment: 'env_01Unseen' }, { remote: fakeRemote({ list: () => used }).remote, env: { FLEET_HOME: fleetHome(t) } });
  assert.equal(unseen.ok, true, 'an unverified environment is not a failure');
  assert.equal(unseen.checks[2].ok, null);
  assert.match(unseen.checks[2].detail, /no routine on this account uses env_01Unseen yet.*this account's routines use env_01FromRequest, env_01Other/);

  const missing = checkCloudSetup({}, { remote: fakeRemote().remote, env: { FLEET_HOME: fleetHome(t) } });
  assert.equal(missing.ok, false);
  assert.deepEqual([missing.checks[0].ok, missing.checks[0].code], [false, CloudSetupError.EnvMissing]);
  assert.match(missing.checks[0].detail, /Fix: set VIBE_CLOUD_CLAUDE_ENV/);

  const refused = checkCloudSetup({ claudeEnvironment: REQUEST_ENV }, { remote: fakeRemote({ list: () => { throw httpError(401); } }).remote, env: { FLEET_HOME: fleetHome(t) } });
  assert.equal(refused.ok, false);
  assert.deepEqual([refused.checks[1].ok, refused.checks[1].code], [false, CloudSetupError.AuthRefused]);
  assert.match(refused.checks[1].detail, /Fix: sign in to Claude Code again with \/login/);
  assert.equal(refused.checks.some((entry) => entry.check === 'environment-use'), false, 'use is not judged without the routine list');

  const down = checkCloudSetup({ claudeEnvironment: REQUEST_ENV }, { remote: fakeRemote({ list: () => { throw new Error('Claude RemoteTrigger list failed: not signed in'); } }).remote, env: { FLEET_HOME: fleetHome(t) } });
  assert.deepEqual([down.ok, down.checks[1].code], [false, CloudSetupError.ApiError]);
});

test('remoteTrigger carries the HTTP status of a refused call', () => {
  const stream = (body) => [
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'RemoteTrigger', id: 'tool_1', input: { action: 'create' } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: body }] } }),
  ].join('\n');
  const run = (body) => () => ({ status: 0, stdout: stream(body), stderr: '' });
  assert.throws(() => remoteTrigger('create', {}, { run: run('HTTP 401\n{"error":"unauthorized"}') }), (error) => error.httpStatus === 401 && /create failed: HTTP 401/.test(error.message));
  assert.deepEqual(remoteTrigger('create', {}, { run: run('HTTP 200\n{"trigger":{"id":"t"}}') }), { trigger: { id: 't' } });
});
