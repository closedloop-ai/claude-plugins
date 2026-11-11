import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";

// Tracker checks run only with a tracker bound, so these run bound to the ClosedLoop provider (spawned scripts inherit it).
bindProviderInProcess(after);

const BOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'board.mjs');
const CODE_ONLY = { codeOnly: true, needsRunningApp: false, localEvidence: [] };
const NEEDS_APP = { codeOnly: true, needsRunningApp: true, localEvidence: [] };

const fixture = (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'fleet-placement-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'programs', 'p1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(home, 'current'), 'p1\n');
  const evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'fleet-placement-evidence-'));
  t.after(() => rmSync(evidenceDir, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [BOARD, dir, ...args], { encoding: 'utf8' });
  const evidence = (name, body) => {
    const file = path.join(evidenceDir, `${name}.json`);
    writeFileSync(file, JSON.stringify(body));
    return file;
  };
  return { dir, run, evidence, page: () => readFileSync(path.join(dir, 'board.md'), 'utf8') };
};

test('a writer start is refused until each of its tickets has a placement decision from the check', (t) => {
  const { run, evidence } = fixture(t);
  const unnamed = run('writer', 'w1', '--runtime', 'claude');
  assert.equal(unnamed.status, 2);
  assert.match(unnamed.stderr, /writer w1 names no ticket: pass --tickets <slug,slug>/);
  const undecided = run('writer', 'w1', '--tickets', 'ISS-1', '--runtime', 'claude');
  assert.equal(undecided.status, 2);
  assert.match(undecided.stderr, /no placement decision for ISS-1: run board\.mjs <orchDir> placement ISS-1 --evidence <file>/);
  assert.equal(run('status').stdout.includes('PLACEMENT w1'), false, 'a refused start adds no row');

  const recorded = run('placement', 'ISS-1', '--evidence', evidence('app', NEEDS_APP));
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stdout, /^PLACEMENT ISS-1 local: ticket needs the running app or its status is unknown$/m);
  assert.equal(run('writer', 'w1', '--tickets', 'ISS-1', '--runtime', 'claude').status, 0);
  assert.equal(run('writer', 'w1', '--status', 'building').status, 0, 'an existing row keeps updating without naming its ticket again');

  const added = run('writer', 'w1', '--tickets', 'ISS-1,ISS-2');
  assert.equal(added.status, 2, 'a ticket added to a running writer is checked too');
  assert.match(added.stderr, /no placement decision for ISS-2/);
  assert.doesNotMatch(added.stderr, /ISS-1/);
});

test('a writer start takes its tickets from an open unit naming it', (t) => {
  const { run, evidence } = fixture(t);
  assert.equal(run('unit', 'ISS-1', '--tickets', 'ISS-1,ISS-2', '--writer', 'w1').status, 0);
  assert.equal(run('placement', 'ISS-1', '--evidence', evidence('app', NEEDS_APP)).status, 0);
  const partial = run('writer', 'w1');
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, /no placement decision for ISS-2/);
  assert.equal(run('placement', 'ISS-2', '--evidence', evidence('app2', NEEDS_APP)).status, 0);
  assert.equal(run('writer', 'w1').status, 0);
});

test('a local writer start is refused for a cloud-placed ticket until the operator records a reason, which the board shows', (t) => {
  const { run, evidence, page } = fixture(t);
  assert.match(run('placement', 'ISS-7', '--evidence', evidence('cloud', CODE_ONLY)).stdout, /^PLACEMENT ISS-7 cloud: code-only ticket needs neither running app nor local evidence$/m);
  for (const where of ['local', 'remote']) {
    const refused = run('writer', `w-${where}`, '--tickets', 'ISS-7', '--where', where);
    assert.equal(refused.status, 2, where);
    assert.match(refused.stderr, /ISS-7 is placed cloud \(code-only ticket needs neither running app nor local evidence\): dispatch it with \.\.\/vibe\/scripts\/cloud-worker\.mjs, or record the operator's reason with board\.mjs <orchDir> placement ISS-7 --keep-local <reason>/);
  }
  assert.equal(run('placement', 'ISS-7', '--keep-local', ' ').status, 2, 'a blank reason is no reason');
  const kept = run('placement', 'ISS-7', '--keep-local', 'cloud runner cannot reach the staging database');
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(run('writer', 'w1', '--tickets', 'ISS-7', '--where', 'local').status, 0);
  assert.match(page(), /^## Placement\n\n- ISS-7 cloud, kept local: cloud runner cannot reach the staging database \(check: code-only ticket needs neither running app nor local evidence\)$/m);

  assert.equal(run('placement', 'ISS-7', '--evidence', evidence('cloud-again', CODE_ONLY)).status, 0);
  assert.equal(run('writer', 'w2', '--tickets', 'ISS-7').status, 2, 'new evidence drops a reason given against the old decision');
});

test('the decision comes only from the check over readable evidence', (t) => {
  const { dir, run, evidence } = fixture(t);
  assert.equal(run('placement', 'ISS-3', '--keep-local', 'reason').status, 2, 'no decision yet');
  const unreadable = run('placement', 'ISS-3', '--evidence', path.join(dir, 'missing.json'));
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.stderr, /placement evidence .*missing\.json is not readable JSON/);
  assert.equal(run('placement', 'not-a-ticket', '--evidence', evidence('x', CODE_ONLY)).status, 2);
  const request = evidence('request', { ticket: 'ISS-3', placement: CODE_ONLY, criteria: [] });
  assert.match(run('placement', 'ISS-3', '--evidence', request).stdout, /^PLACEMENT ISS-3 cloud:/m, 'a cloud-worker request is read through its placement');
  assert.match(run('placement', 'ISS-4', '--evidence', evidence('local', { codeOnly: true, needsRunningApp: false, localEvidence: ['desktop capture'] })).stdout,
    /^PLACEMENT ISS-4 local: ticket needs local evidence: desktop capture$/m);
  const localKeep = run('placement', 'ISS-4', '--keep-local', 'reason');
  assert.equal(localKeep.status, 2);
  assert.match(localKeep.stderr, /ISS-4 is placed local .*a keep-local reason is only for a cloud decision/);
});

test('status lists each writer ticket with its placement and reason', (t) => {
  const { dir, run, evidence } = fixture(t);
  assert.equal(run('placement', 'ISS-1', '--evidence', evidence('app', NEEDS_APP)).status, 0);
  assert.equal(run('placement', 'ISS-2', '--evidence', evidence('cloud', CODE_ONLY)).status, 0);
  assert.equal(run('placement', 'ISS-2', '--keep-local', 'operator wants it beside ISS-1').status, 0);
  assert.equal(run('writer', 'w1', '--tickets', 'ISS-1,ISS-2').status, 0);
  assert.equal(run('placement', 'ISS-5', '--evidence', evidence('app5', NEEDS_APP)).status, 0);
  assert.equal(run('placement', 'ISS-6', '--evidence', evidence('app6', NEEDS_APP)).status, 0);
  assert.equal(run('writer', 'w2', '--tickets', 'ISS-5').status, 0);
  assert.equal(run('unit', 'ISS-5', '--tickets', 'ISS-5,ISS-6', '--writer', 'w2').status, 0, 'a fold after the start');
  const file = path.join(dir, 'board.json');
  const board = JSON.parse(readFileSync(file, 'utf8'));
  board.writers.legacy = { status: 'started before placements were recorded' };
  board.writers.old = { tickets: ['ISS-9'] };
  writeFileSync(file, JSON.stringify(board));
  const lines = run('status').stdout.split('\n').filter((line) => line.startsWith('PLACEMENT'));
  assert.deepEqual(lines, [
    'PLACEMENT w1 ISS-1 local: ticket needs the running app or its status is unknown',
    'PLACEMENT w1 ISS-2 cloud, kept local: operator wants it beside ISS-1 (check: code-only ticket needs neither running app nor local evidence)',
    'PLACEMENT w2 ISS-5 local: ticket needs the running app or its status is unknown',
    'PLACEMENT w2 ISS-6 local: ticket needs the running app or its status is unknown',
    'PLACEMENT legacy - none: no ticket recorded for this writer',
    'PLACEMENT old ISS-9 none: no placement decision recorded',
  ]);
});

test('folding a ticket into a writer on the board is assigning it: the same placement check and keep-local rule apply', (t) => {
  const { dir, run, evidence } = fixture(t);
  const units = () => JSON.parse(readFileSync(path.join(dir, 'board.json'), 'utf8')).units;
  assert.equal(run('placement', 'ISS-1', '--evidence', evidence('app', NEEDS_APP)).status, 0);
  assert.equal(run('writer', 'w1', '--tickets', 'ISS-1', '--where', 'local').status, 0);
  assert.equal(run('unit', 'ISS-1', '--tickets', 'ISS-1', '--writer', 'w1').status, 0);
  assert.equal(run('placement', 'ISS-2', '--evidence', evidence('cloud', CODE_ONLY)).status, 0);
  const cloud = run('unit', 'ISS-1', '--tickets', 'ISS-2');
  assert.equal(cloud.status, 2);
  assert.match(cloud.stderr, /ISS-2 is placed cloud \(code-only ticket needs neither running app nor local evidence\): dispatch it with \.\.\/vibe\/scripts\/cloud-worker\.mjs, or record the operator's reason with board\.mjs <orchDir> placement ISS-2 --keep-local <reason>/);
  assert.deepEqual(units()['ISS-1'].tickets, ['ISS-1'], 'a refused fold records nothing');
  const undecided = run('unit', 'ISS-1', '--tickets', 'ISS-3');
  assert.equal(undecided.status, 2);
  assert.match(undecided.stderr, /no placement decision for ISS-3/);
  assert.equal(run('placement', 'ISS-2', '--keep-local', 'cloud import task_01').status, 0);
  assert.equal(run('unit', 'ISS-1', '--tickets', 'ISS-2').status, 0);
  assert.deepEqual(units()['ISS-1'].tickets, ['ISS-1', 'ISS-2']);

  assert.equal(run('unit', 'ISS-5', '--tickets', 'ISS-5').status, 0, 'a unit with no writer yet waits for the writer start');
  const moved = run('unit', 'ISS-5', '--writer', 'w1', '--tickets', 'ISS-5');
  assert.equal(moved.status, 2, 'handing a unit to a running writer checks all its tickets');
  assert.match(moved.stderr, /no placement decision for ISS-5/);
  assert.equal(run('unit', 'ISS-7', '--tickets', 'ISS-7', '--writer', 'later').status, 0, 'a writer not on the board is checked at its start');
  assert.match(run('writer', 'later').stderr, /no placement decision for ISS-7/);
});
