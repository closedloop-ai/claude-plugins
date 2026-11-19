import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_SHIM_MESSAGE } from './core-client-fixture.mjs';
import { HIDDEN_BUNDLED_CODEX, hidingExistsSync } from './bundled-codex-test-fixture.mjs';
import { BUNDLED_CODEX } from '../../vibe/scripts/plugin-cli.mjs';

// ISS-14116 item 32: each claim the fixture's comment and the 1.1.101 CHANGELOG make about the sandbox is run here in
// a child process that imports the fixture the way a test file does.
const fixture = new URL('./core-client-fixture.mjs', import.meta.url).href;
const pluginCli = new URL('../../vibe/scripts/plugin-cli.mjs', import.meta.url).href;
const HARNESS_VARIABLES = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'];

function childFile(name, source) {
  const file = join(mkdtempSync(join(tmpdir(), 'cl-sweep-fixture-child-')), name);
  writeFileSync(file, source);
  return file;
}

// A child of a `node --test` run inherits NODE_TEST_CONTEXT, which makes its own runner report to this one instead of
// printing and setting its exit code; each probe runs as a standalone process.
const standalone = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));

function runModule(source, env = process.env) {
  const result = spawnSync(process.execPath, [childFile('probe.mjs', source)], { encoding: 'utf8', env: standalone(env) });
  assert.equal(result.status, 0, result.stderr);
  // Importing the fixture loads node:test, whose reporter prints after the probe's one JSON line.
  return JSON.parse(result.stdout.split('\n')[0]);
}

test('ISS-14116 item 32: in a file that imports the fixture, the codex found first on PATH is the sandbox shim', () => {
  const probe = runModule(`import { CODEX_SHIM } from ${JSON.stringify(fixture)};
import { findCli } from ${JSON.stringify(pluginCli)};
process.stdout.write(JSON.stringify({ found: findCli('codex', process.env), shim: CODEX_SHIM }) + '\\n');
`);
  assert.equal(probe.found, probe.shim);
});

test('ISS-14116 item 32: importing the fixture unsets the harness variables and gives an empty temporary HOME', () => {
  const seeded = Object.fromEntries(HARNESS_VARIABLES.map((name) => [name, `seeded-${name}`]));
  const probe = runModule(`import ${JSON.stringify(fixture)};
import { readdirSync } from 'node:fs';
process.stdout.write(JSON.stringify({ env: Object.fromEntries(${JSON.stringify(HARNESS_VARIABLES)}.map((name) => [name, process.env[name] ?? null])), home: process.env.HOME, entries: readdirSync(process.env.HOME) }) + '\\n');
`, { ...process.env, ...seeded, HOME: tmpdir() });
  assert.deepEqual(probe.env, Object.fromEntries(HARNESS_VARIABLES.map((name) => [name, null])));
  assert.notEqual(probe.home, tmpdir());
  assert.deepEqual(probe.entries, []);
});

test('ISS-14116 item 32: under node --test, the root after hook fails a file whose test reached the shim, and only that file', () => {
  const source = (reach) => `import test from 'node:test';
import { spawnSync } from 'node:child_process';
import ${JSON.stringify(fixture)};
test('probe', () => { ${reach ? "spawnSync('codex', ['plugin', 'list', '--json']);" : ''} });
`;
  const reached = spawnSync(process.execPath, ['--test', childFile('reached.test.mjs', source(true))], { encoding: 'utf8', env: standalone(process.env) });
  assert.equal(reached.status, 1, reached.stdout);
  assert.match(reached.stdout, new RegExp(CODEX_SHIM_MESSAGE));
  const quiet = spawnSync(process.execPath, ['--test', childFile('quiet.test.mjs', source(false))], { encoding: 'utf8', env: standalone(process.env) });
  assert.equal(quiet.status, 0, quiet.stdout);
});

test('ISS-14116 item 32: every Node process a fixture test starts hides the bundled Codex app from existsSync', () => {
  const probe = runModule(`import fs, { existsSync } from 'node:fs';
process.stdout.write(JSON.stringify({ hidden: fs.existsSync[Symbol.for('cl-sweep.hiddenBundledCodex')] ?? null, named: existsSync[Symbol.for('cl-sweep.hiddenBundledCodex')] ?? null }) + '\\n');
`);
  assert.deepEqual(probe, { hidden: BUNDLED_CODEX, named: BUNDLED_CODEX });
});

test('ISS-14116 item 32: the hiding existsSync reports only the hidden path missing', () => {
  const here = fileURLToPath(import.meta.url);
  const wrapped = hidingExistsSync(existsSync, here);
  assert.equal(wrapped(here), false);
  assert.equal(wrapped(fileURLToPath(fixture)), true);
  assert.equal(wrapped(join(tmpdir(), 'cl-sweep-no-such-file')), false);
  assert.equal(wrapped[HIDDEN_BUNDLED_CODEX], here);
});
