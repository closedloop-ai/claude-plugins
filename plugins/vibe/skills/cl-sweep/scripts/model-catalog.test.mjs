import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listModels, pageModels, readModelCatalog } from './model-catalog.mjs';
import { availableCodexModel, Complexity, laneModel } from './model-policy.mjs';
import {
  catalogServerCode, CODEX_SHIM, CODEX_SHIM_MESSAGE, fixtureSkillPath, LISTED_MODELS, withModelCatalog,
  withoutModelOverrides, writeCodexShim,
} from './core-client-fixture.mjs';

const realTmp = realpathSync(tmpdir());

// Operator rulings, 2026-11-17 (ISS-14112, "Codex model switch"): the default moves to gpt-6.2-sol, planning and
// review lanes take gpt-6.2-astra only when cl-analyze graded the ticket HIGH, and a Codex whose own model list lacks
// either model runs gpt-5.6-sol instead. Expected values are the rulings' literal model names.
withoutModelOverrides();
const policyScript = fileURLToPath(new URL('./model-policy.mjs', import.meta.url));
const workerModelScript = fileURLToPath(new URL('../../vibe/scripts/worker-model.mjs', import.meta.url));

/** A client whose `model/list` answers come from `pages` in order; a page that is an Error is thrown. */
function pagedClient(pages) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      const page = pages[calls.length - 1];
      if (page instanceof Error) throw page;
      return page;
    },
  };
}

const resolver = fileURLToPath(new URL('./resolve-core-skill.mjs', import.meta.url));

test('ISS-14112: the fake Codex that lists models also answers core discovery', () => {
  // Session tests put this fake first on PATH; core discovery (resolve-core-skill.mjs) asks that `codex` for its
  // plugin list and skills. A fake that refused them sent discovery to the real bundled Codex, which CI lacks.
  const codex = withModelCatalog(LISTED_MODELS);
  const home = mkdtempSync(join(tmpdir(), 'cl-sweep-no-home-'));
  const result = spawnSync(process.execPath, [resolver], {
    input: JSON.stringify({ runtime: 'codex', codex }), encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(codex)}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).skillDirectory, dirname(fixtureSkillPath()));
});

test('ISS-14112: a test that imports the cl-sweep fixture runs with an empty temporary HOME and a codex shim ahead of any real codex on PATH', () => {
  assert.ok(homedir().startsWith(realTmp) || homedir().startsWith(tmpdir()), homedir());
  assert.deepEqual(readdirSync(homedir()), []);
  const entries = process.env.PATH.split(':');
  const shim = entries.indexOf(dirname(CODEX_SHIM));
  assert.ok(shim >= 0, 'the shim is on PATH');
  const temporary = (entry) => entry.startsWith(tmpdir()) || entry.startsWith(realTmp);
  for (const entry of entries.slice(0, shim)) {
    if (existsSync(join(entry, 'codex'))) assert.ok(temporary(entry), `${entry} has a codex ahead of the shim and is not a fixture folder`);
  }
});

test('ISS-14112: a codex shim records each call in its log and fails with "real codex spawned in test"', () => {
  // A shim of its own, so this deliberate call does not reach the sandbox shim the file's `after` hook checks. That a
  // sandboxed file resolves `codex` to the sandbox shim is pinned in core-client-fixture.test.mjs.
  const { codex, log } = writeCodexShim();
  const result = spawnSync('codex', ['plugin', 'list', '--json'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dirname(codex)}:/usr/bin:/bin` },
  });
  assert.equal(result.status, 97);
  assert.match(result.stderr, new RegExp(CODEX_SHIM_MESSAGE));
  assert.deepEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean), ['plugin list --json']);
});

test('ISS-14112: with 9d3fe998\'s model-list fake in front (it refused plugin list), core discovery fails with that fake\'s own error', () => {
  // The fake as 9d3fe998 wrote it: it answered only the model list, so core discovery fell back to the bundled Codex
  // app, which on a machine with closedloop-core installed under the real HOME resolved and hid the bug. The sandbox
  // hides that app in every process (core-client-fixture.test.mjs pins it), so the error is the PATH fake's.
  const directory = mkdtempSync(join(tmpdir(), 'cl-sweep-9d3fe998-fake-'));
  writeFileSync(join(directory, 'codex'), `#!/usr/bin/env node
if (process.argv[2] === 'app-server' && process.argv.length === 3) ${catalogServerCode(LISTED_MODELS)}
else { process.stderr.write('fake codex: only app-server on stdio'); process.exitCode = 2; }
`);
  chmodSync(join(directory, 'codex'), 0o755);
  const result = spawnSync(process.execPath, [resolver], {
    input: JSON.stringify({ runtime: 'codex' }), encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
  });
  assert.notEqual(result.status, 0, `discovery resolved: ${result.stdout}`);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /fake codex: only app-server on stdio/);
});

test('ISS-14112 AC-6: a Codex whose model list names gpt-6.2-sol runs it, with no note', async () => {
  const listed = await readModelCatalog({ codex: withModelCatalog(['gpt-6.2-sol', 'gpt-6.2-astra']) });
  assert.deepEqual(listed, { models: ['gpt-6.2-sol', 'gpt-6.2-astra'] });
  assert.deepEqual(availableCodexModel('gpt-6.2-sol', listed), { model: 'gpt-6.2-sol', fallbackFrom: null, note: null });
  assert.deepEqual(availableCodexModel('gpt-6.2-astra', listed), { model: 'gpt-6.2-astra', fallbackFrom: null, note: null });
});

test('ISS-14112 AC-6: the list is read across pages and names each entry by model and id', async () => {
  const client = pagedClient([
    { data: [{ id: 'gpt-6.2-sol', model: 'gpt-6.2-sol' }], nextCursor: 'page-2' },
    { data: [{ id: 'alias', model: 'gpt-6.2-astra' }], nextCursor: null },
  ]);
  assert.deepEqual(await listModels(client), { models: ['gpt-6.2-sol', 'gpt-6.2-astra', 'alias'] });
  assert.deepEqual(client.calls.map((call) => call.params), [{}, { cursor: 'page-2' }]);
});

test('ISS-14112 AC-6: a Codex whose model list lacks the model falls back to gpt-5.6-sol and says so once', async () => {
  const older = await readModelCatalog({ codex: withModelCatalog(['gpt-6-sol', 'gpt-5.6-sol']) });
  for (const chosen of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
    const available = availableCodexModel(chosen, older);
    assert.equal(available.model, 'gpt-5.6-sol', chosen);
    assert.equal(available.fallbackFrom, chosen);
    assert.equal(available.note, `${chosen} is not in this Codex's model list, so this worker runs on gpt-5.6-sol.`);
  }
  // A model the policy gives no fallback is never checked against the list.
  assert.deepEqual(availableCodexModel('gpt-5.6-terra', older), { model: 'gpt-5.6-terra', fallbackFrom: null, note: null });
});

test('ISS-14112 AC-6: a model list that cannot be read falls back to gpt-5.6-sol instead of failing', async () => {
  const unreadable = [
    await readModelCatalog({ codex: '/nonexistent/codex-cli' }),
    await readModelCatalog({ codex: withModelCatalog(null) }),
    await readModelCatalog({ connect: () => ({ initialize: async () => { throw new Error('refused'); }, close() {} }) }),
    await listModels(pagedClient([new Error('connection closed')])),
    await listModels(pagedClient([{ models: 'not a list' }])),
  ];
  for (const catalog of unreadable) {
    assert.equal(typeof catalog.error, 'string', JSON.stringify(catalog));
    assert.equal(catalog.models, undefined);
    const available = availableCodexModel('gpt-6.2-sol', catalog);
    assert.equal(available.model, 'gpt-5.6-sol');
    assert.equal(available.fallbackFrom, 'gpt-6.2-sol');
    assert.equal(available.note, `This Codex's model list could not be read (${catalog.error}), so this worker runs on gpt-5.6-sol instead of gpt-6.2-sol.`);
  }
  assert.equal(pageModels({ data: 'x' }), null);
});

test('ISS-14112 AC-7: a planning or review lane takes gpt-6.2-astra only when cl-analyze graded the ticket HIGH', () => {
  assert.deepEqual(laneModel('reviewer', { complexity: Complexity.High }), { model: 'gpt-6.2-astra', reasoningEffort: 'high' });
  for (const complexity of [Complexity.Medium, Complexity.Low, undefined]) {
    assert.deepEqual(laneModel('reviewer', { complexity }), { model: 'gpt-6.2-sol', reasoningEffort: 'high' }, String(complexity));
  }
  // HIGH changes only the planning and review lane; every other role keeps its model.
  assert.equal(laneModel('writer', { complexity: Complexity.High }).model, 'gpt-6.2-sol');
  assert.equal(laneModel('verifier', { complexity: Complexity.High }).model, 'gpt-6.2-sol');
  assert.equal(laneModel('explorer', { complexity: Complexity.High }).model, 'gpt-5.6-terra');
  assert.equal(laneModel('mechanical', { complexity: Complexity.High }).model, 'gpt-6-luna');
  assert.throws(() => laneModel('reviewer', { complexity: 'high' }), /--complexity must be one of LOW, MEDIUM, HIGH/);
});

test('ISS-14112 AC-7: the lane command prints the HIGH lane model after checking the running Codex', () => {
  const run = (codex, ...args) => spawnSync(process.execPath, [policyScript, 'lane', 'reviewer', '--codex', codex, ...args], { encoding: 'utf8' });
  const current = withModelCatalog(LISTED_MODELS);
  const high = run(current, '--complexity', 'HIGH');
  assert.equal(high.status, 0, high.stderr);
  assert.deepEqual(JSON.parse(high.stdout), { role: 'reviewer', model: 'gpt-6.2-astra', reasoning_effort: 'high' });
  assert.deepEqual(JSON.parse(run(current, '--complexity', 'MEDIUM').stdout), { role: 'reviewer', model: 'gpt-6.2-sol', reasoning_effort: 'high' });
  const older = JSON.parse(run(withModelCatalog(['gpt-5.6-sol']), '--complexity', 'HIGH').stdout);
  assert.deepEqual(older, {
    role: 'reviewer', model: 'gpt-5.6-sol', reasoning_effort: 'high', fallback_from: 'gpt-6.2-astra',
    note: "gpt-6.2-astra is not in this Codex's model list, so this worker runs on gpt-5.6-sol.",
  });
});

test('ISS-14112 AC-6: a vibe worker binding checks the running Codex and names its fallback', () => {
  const run = (codex) => spawnSync(process.execPath, [workerModelScript, 'codex', 'vibe-change-worker', '--codex', codex], { encoding: 'utf8' });
  const listed = run(withModelCatalog(LISTED_MODELS));
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), { agent: 'vibe-change-worker', role: 'writer', model: 'gpt-6.2-sol', reasoning_effort: 'high' });
  const unreadable = JSON.parse(run(withModelCatalog(null)).stdout);
  assert.equal(unreadable.model, 'gpt-5.6-sol');
  assert.equal(unreadable.fallback_from, 'gpt-6.2-sol');
  assert.match(unreadable.note, /^This Codex's model list could not be read \(.+\), so this worker runs on gpt-5\.6-sol instead of gpt-6\.2-sol\.$/);
});
