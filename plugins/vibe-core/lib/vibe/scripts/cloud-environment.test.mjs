import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLAUDE_ENV_VAR, checkCloudSetup, CloudSetupError, resolveClaudeEnvironment } from './cloud-environment.mjs';
import { pollTask, remoteTrigger, startClaude } from './cloud-worker.mjs';
import { readLedger } from './cloud-routines.mjs';

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

/** A fixture home for the routine ledger and lock, never the real one. */
function ledgerHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'cloud-env-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

const dispatchRequest = (fields = {}) => ({ ticket: 'ISS-1', provider: 'claude', model: 'claude-sonnet-5-5', repository: 'acme/local-fork', connectorAllowlist: [], ...fields });

test('the environment comes from the request, then the variable, then the fleet config, and that id is the one sent', async (t) => {
  const home = fleetHome(t, CONFIG_ENV);
  const env = { FLEET_HOME: home, [CLAUDE_ENV_VAR]: VAR_ENV };
  assert.deepEqual(resolveClaudeEnvironment({ claudeEnvironment: REQUEST_ENV }, { env }), { id: REQUEST_ENV, source: 'request claudeEnvironment' });
  assert.deepEqual(resolveClaudeEnvironment({}, { env }), { id: VAR_ENV, source: CLAUDE_ENV_VAR });
  assert.deepEqual(resolveClaudeEnvironment({ claudeEnvironment: ' ' }, { env: { FLEET_HOME: home, [CLAUDE_ENV_VAR]: '' } }),
    { id: CONFIG_ENV, source: `CLOUD_CLAUDE_ENV in ${path.join(home, 'config.env')}` });

  for (const [request, expected] of [[dispatchRequest({ claudeEnvironment: REQUEST_ENV }), REQUEST_ENV], [dispatchRequest(), VAR_ENV]]) {
    const { calls, remote } = fakeRemote();
    const started = await startClaude(request, 'brief', { remote, env, home: ledgerHome(t) });
    assert.equal(calls[0].action, 'create');
    assert.equal(calls[0].payload.body.job_config.ccr.environment_id, expected);
    assert.equal(started.environment.id, expected, 'the receipt records the environment used');
  }
});

test('with no environment configured, or a malformed one, nothing is sent and the named error carries the fix', async (t) => {
  const env = { FLEET_HOME: fleetHome(t) };
  const { calls, remote } = fakeRemote();
  const home = ledgerHome(t);
  await assert.rejects(startClaude(dispatchRequest(), 'brief', { remote, env, home }), (error) => {
    assert.equal(error.code, CloudSetupError.EnvMissing);
    assert.match(error.message, /^CLOUD_ENV_MISSING: no Claude cloud environment is configured, and none is sent by default\. Fix: set VIBE_CLOUD_CLAUDE_ENV=<env id>, or CLOUD_CLAUDE_ENV=<env id> in the fleet home's config\.env/);
    return true;
  });
  await assert.rejects(startClaude(dispatchRequest({ claudeEnvironment: 'default' }), 'brief', { remote, env, home }), (error) => {
    assert.equal(error.code, CloudSetupError.EnvInvalid);
    assert.match(error.message, /default \(request claudeEnvironment\) is not an environment id/);
    return true;
  });
  assert.deepEqual(calls, [], 'no RemoteTrigger call without a valid environment');
});

test('a refused create is named: an environment this account cannot use, or a refused sign-in', async (t) => {
  const env = { FLEET_HOME: fleetHome(t) };
  const home = ledgerHome(t);
  const request = dispatchRequest({ claudeEnvironment: REQUEST_ENV });
  const unknown = fakeRemote({ create: () => { throw httpError(401); } });
  await assert.rejects(startClaude(request, 'brief', { remote: unknown.remote, env, home }), (error) => {
    assert.equal(error.code, CloudSetupError.EnvUnknown);
    assert.match(error.message, /create was refused \(HTTP 401\) for Claude environment env_01FromRequest \(request claudeEnvironment\) while this account's routine list answers/);
    return true;
  });
  assert.deepEqual(unknown.calls.map((call) => call.action), ['create', 'list'], 'nothing is fired after a refused create');
  const missing = fakeRemote({ create: () => { throw httpError(404); } });
  await assert.rejects(startClaude(request, 'brief', { remote: missing.remote, env, home }), { code: CloudSetupError.EnvUnknown });
  const signedOut = fakeRemote({ create: () => { throw httpError(403); }, list: () => { throw httpError(403); } });
  await assert.rejects(startClaude(request, 'brief', { remote: signedOut.remote, env, home }), (error) => {
    assert.equal(error.code, CloudSetupError.AuthRefused);
    assert.match(error.message, /refused this account \(HTTP 403\)\. Fix: sign in to Claude Code again with \/login/);
    return true;
  });
  const other = fakeRemote({ create: () => { throw httpError(500); } });
  await assert.rejects(startClaude(request, 'brief', { remote: other.remote, env, home }), (error) => error.httpStatus === 500 && !error.code);
  assert.deepEqual(readLedger(home).intents.length, 1, 'only the 500, which may have created a routine, keeps its intent on record');
  const tooLarge = fakeRemote({ create: () => { throw httpError(401); }, list: () => { throw Object.assign(new Error('CLOUD_RESULT_TOO_LARGE: the routine service answered, but the reply was too large to read here'), { code: CloudSetupError.ResultTooLarge }); } });
  await assert.rejects(startClaude(request, 'brief', { remote: tooLarge.remote, env, home }), { code: CloudSetupError.EnvUnknown }, 'a list reply too large to read still shows the account answers');
});

test('a fired run that never appears is CLOUD_RUN_NOT_CREATED, naming GitHub, the environment and what the routine reports', async () => {
  const environment = { id: REQUEST_ENV, source: 'request claudeEnvironment' };
  const { remote } = fakeRemote({
    list_runs: () => ({ data: [] }),
    get: () => ({ trigger: { last_run: { status: 'ROUTINE_RUN_STATUS_FAILED', failure_reason: 'ROUTINE_RUN_FAILURE_REASON_EXAMPLE' } } }),
  });
  const receipt = { provider: 'claude', routineId: 'routine_e', runId: 'run_e', environment, startedAt: new Date().toISOString() };
  await assert.rejects(pollTask(receipt, { repository: 'acme/local-fork', maxWallMs: 60_000, pollMs: 1000 }, { remote, sleep: async () => {} }), (error) => {
    assert.equal(error.code, CloudSetupError.RunNotCreated);
    assert.match(error.message, /The routine reports last run ROUTINE_RUN_STATUS_FAILED, ROUTINE_RUN_FAILURE_REASON_EXAMPLE\./);
    assert.match(error.message, /Fix: give the Claude account access to acme\/local-fork by installing the Claude GitHub App on it, or by running \/web-setup in Claude Code; confirm env_01FromRequest \(request claudeEnvironment\)/);
    return true;
  });
});

test('the setup check reports each environment and API result with its fix, and what it cannot check', (t) => {
  // Operator rulings 2026-11-13 (ISS-14140; q6): the check reads this machine's one recorded routine with get, and with
  // none recorded it says so without asking for a list page; the list is read only for a recorded routine gone from the account.
  const used = { data: [{ id: 'trig_a', job_config: { ccr: { environment_id: REQUEST_ENV } } }, { id: 'trig_b', job_config: { ccr: { environment_id: 'env_01Other' } } }] };
  const standing = { id: 'trig_a' };
  const recorded = { get: () => ({ trigger: used.data[0] }) };
  const gone = { get: () => { throw httpError(404); }, list: () => used };
  const ok = checkCloudSetup({ claudeEnvironment: REQUEST_ENV }, { remote: fakeRemote(recorded).remote, standing, env: { FLEET_HOME: fleetHome(t) } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.checks.map(({ check, ok: passed }) => [check, passed]), [['environment', true], ['api', true], ['environment-use', true], ['github', null]]);
  assert.match(ok.checks[2].detail, /routine trig_a on this account runs in env_01FromRequest/);
  assert.match(ok.checks[3].detail, /no GitHub connection endpoint/);

  const unseen = checkCloudSetup({ claudeEnvironment: 'env_01Unseen' }, { remote: fakeRemote(gone).remote, standing, env: { FLEET_HOME: fleetHome(t) } });
  assert.equal(unseen.ok, true, 'an unverified environment is not a failure');
  assert.equal(unseen.checks[2].ok, null);
  assert.match(unseen.checks[2].detail, /no routine on this account uses env_01Unseen yet.*this account's routines use env_01FromRequest, env_01Other/);

  const missing = checkCloudSetup({}, { remote: fakeRemote(recorded).remote, standing, env: { FLEET_HOME: fleetHome(t) } });
  assert.equal(missing.ok, false);
  assert.deepEqual([missing.checks[0].ok, missing.checks[0].code], [false, CloudSetupError.EnvMissing]);
  assert.match(missing.checks[0].detail, /Fix: set VIBE_CLOUD_CLAUDE_ENV/);

  const refused = checkCloudSetup({ claudeEnvironment: REQUEST_ENV }, { remote: fakeRemote({ get: () => { throw httpError(401); } }).remote, standing, env: { FLEET_HOME: fleetHome(t) } });
  assert.equal(refused.ok, false);
  assert.deepEqual([refused.checks[1].ok, refused.checks[1].code], [false, CloudSetupError.AuthRefused]);
  assert.match(refused.checks[1].detail, /Fix: sign in to Claude Code again with \/login/);
  assert.equal(refused.checks.some((entry) => entry.check === 'environment-use'), false, 'use is not judged without the routine list');

  const down = checkCloudSetup({ claudeEnvironment: REQUEST_ENV }, { remote: fakeRemote({ get: () => { throw new Error('Claude RemoteTrigger get failed: not signed in'); } }).remote, standing, env: { FLEET_HOME: fleetHome(t) } });
  assert.deepEqual([down.ok, down.checks[1].code], [false, CloudSetupError.ApiError]);

  const none = fakeRemote();
  const fresh = checkCloudSetup({ claudeEnvironment: REQUEST_ENV }, { remote: none.remote, env: { FLEET_HOME: fleetHome(t) } });
  assert.equal(fresh.ok, true, 'nothing recorded yet is not a failure');
  assert.deepEqual(fresh.checks[1], { check: 'api', ok: null, detail: 'no vibe cloud worker routine is recorded on this machine yet; the first cloud run creates it' });
  assert.deepEqual(none.calls, [], 'no list page is read when nothing is recorded');
});

test('remoteTrigger carries the HTTP status of a refused call', (t) => {
  const stream = (body) => [
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'RemoteTrigger', id: 'tool_1', input: { action: 'create' } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: body }] } }),
  ].join('\n');
  const run = (body) => () => ({ status: 0, stdout: stream(body), stderr: '' });
  // A create needs an intent the routine ledger recorded first (ISS-13998).
  const home = ledgerHome(t);
  mkdirSync(path.join(home, '.codex', 'vibe', 'cloud'), { recursive: true });
  writeFileSync(path.join(home, '.codex', 'vibe', 'cloud', 'routines.json'), JSON.stringify({ schema: 'vibe.cloud-routines/1', intents: [{ token: 'intent_1' }] }));
  const recorded = { home, intent: 'intent_1' };
  assert.throws(() => remoteTrigger('create', {}, { ...recorded, run: run('HTTP 401\n{"error":"unauthorized"}') }), (error) => error.httpStatus === 401 && /create failed: HTTP 401/.test(error.message));
  assert.deepEqual(remoteTrigger('create', {}, { ...recorded, run: run('HTTP 200\n{"trigger":{"id":"t"}}') }), { trigger: { id: 't' } });
});

const TOO_LARGE = 'CLOUD_RESULT_TOO_LARGE: the routine service answered, but the reply was too large to read here';
const tooLargeError = () => Object.assign(new Error(TOO_LARGE), { code: CloudSetupError.ResultTooLarge });

test('AC-7 (ISS-14140): the check reads this machine\'s recorded routine with get and never asks for a list page', (t) => {
  const standing = { id: 'trig_standing', name: 'vibe cloud worker' };
  const { calls, remote } = fakeRemote({
    get: ({ trigger_id }) => ({ trigger: { id: trigger_id, job_config: { ccr: { environment_id: REQUEST_ENV } } } }),
    list: () => { throw tooLargeError(); },
  });
  const result = checkCloudSetup({ claudeEnvironment: REQUEST_ENV }, { remote, standing, env: { FLEET_HOME: fleetHome(t) } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.action), ['get']);
  assert.match(result.checks[1].detail, /answers for this account \(routine trig_standing\)/);
  assert.match(result.checks[2].detail, /routine trig_standing on this account runs in env_01FromRequest/);
  const gone = fakeRemote({ get: () => { throw httpError(404); }, list: () => ({ data: [] }) });
  const fallback = checkCloudSetup({ claudeEnvironment: REQUEST_ENV }, { remote: gone.remote, standing, env: { FLEET_HOME: fleetHome(t) } });
  assert.deepEqual(gone.calls.map((call) => call.action), ['get', 'list'], 'a recorded routine gone from the account falls back to the list');
  assert.equal(fallback.checks[1].ok, true);
});

test('AC-8 (ISS-14140): a reply too large to read is named as such in the check, with no sign-in or CLI advice', (t) => {
  for (const overrides of [{ get: () => { throw httpError(404); }, list: () => { throw tooLargeError(); } }, { get: () => { throw tooLargeError(); } }]) {
    const standing = { id: 'trig_standing' };
    const result = checkCloudSetup({ claudeEnvironment: REQUEST_ENV }, { remote: fakeRemote(overrides).remote, standing, env: { FLEET_HOME: fleetHome(t) } });
    assert.equal(result.ok, false);
    assert.deepEqual([result.checks[1].check, result.checks[1].ok, result.checks[1].code], ['api', false, 'CLOUD_RESULT_TOO_LARGE']);
    assert.equal(result.checks[1].detail, TOO_LARGE);
    assert.doesNotMatch(result.checks[1].detail, /sign in|\/login|signed in|Fix:/i);
  }
});

test('the check lists the routine-removal line when routines vibe created are still recorded for removal', (t) => {
  const line = 'CLOUD_ROUTINE_REMOVAL_PENDING: 2 routine(s) vibe created are still recorded for removal; vibe retries on the next cloud run';
  const result = checkCloudSetup({ claudeEnvironment: REQUEST_ENV }, { remote: fakeRemote().remote, pending: line, env: { FLEET_HOME: fleetHome(t) } });
  assert.equal(result.ok, true, 'a pending removal never fails the check');
  assert.deepEqual(result.checks.at(-1), { check: 'routine-removal', ok: null, detail: line });
});

test('G9: a routine ledger that cannot be read is its own failed check, never "nothing recorded"', (t) => {
  const problem = '/home/x/.codex/vibe/cloud/routines.json is not a vibe.cloud-routines/1 ledger';
  const { calls, remote } = fakeRemote();
  const result = checkCloudSetup({ claudeEnvironment: REQUEST_ENV }, { remote, ledgerProblem: problem, env: { FLEET_HOME: fleetHome(t) } });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((entry) => entry.check === 'ledger' && entry.ok === false && entry.detail === problem));
  assert.equal(result.checks.some((entry) => /no vibe cloud worker routine is recorded/.test(entry.detail)), false);
  assert.deepEqual(calls, []);
});
