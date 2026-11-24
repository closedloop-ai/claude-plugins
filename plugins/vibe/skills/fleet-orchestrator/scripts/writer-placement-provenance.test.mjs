import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";
import { CODE_ONLY, fixture } from "./writer-placement-test-fixture.mjs";

bindProviderInProcess(after);

test('prevention keep-local rejects orchestrator, unrelated, altered and stale ruling sources at assignment', (t) => {
  const { dir, run, evidence, keep } = fixture(t);
  assert.equal(run('placement', 'ISS-2', '--evidence', evidence('ISS-2', CODE_ONLY)).status, 0);
  assert.equal(run('placement', 'ISS-2', '--keep-local', 'cloud import task_01').status, 2, 'import copy cannot impersonate a ruling');
  for (const ticket of ['ISS-7', 'ISS-8']) assert.equal(run('placement', ticket, '--evidence', evidence(ticket, CODE_ONLY)).status, 0);
  const quote = 'keep this ticket local for the paired workspace';
  assert.equal(run('placement', 'ISS-7', '--keep-local', quote).status, 2, 'free-form reasons cannot override cloud placement');
  const file = path.join(dir, 'rulings.md');
  writeFileSync(file, `- Ruling 2026-11-19 (orchestrator: ISS-7 checked capacity): "${quote}"\n`);
  const claim = (ticket, words, source) => run('placement', ticket, '--keep-local', words, '--ruling-source', source);
  assert.match(claim('ISS-7', quote, '2026-11-19 (orchestrator: ISS-7 checked capacity)').stderr, /requires exact quoted operator words/);
  assert.equal(keep('ISS-8', quote).status, 0);
  const source = '2026-11-19 (AskUserQuestion: ISS-8 operator placement)';
  assert.equal(claim('ISS-7', quote, source).status, 2, 'a real ruling for another issue does not grant local placement');
  assert.equal(claim('ISS-8', quote.toUpperCase(), source).status, 2, 'source without exact words is insufficient');
  assert.equal(run('writer', 'valid', '--tickets', 'ISS-8').status, 0);
  writeFileSync(file, '- No active local exception for this item.\n');
  assert.equal(run('writer', 'new', '--tickets', 'ISS-8').status, 2, 'a removed ruling cannot authorize a new assignment');
});
