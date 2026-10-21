import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkpoints, verdict } from './qa-plan-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const record = (sections) => sections.map(([id, routing]) => `### ${id}: title\n\n- Risk / requirement: AC-1\n${routing === null ? '' : `- Routing (\`AGENT_VERIFIED\` with its evidence, or the reason this checkpoint needs a human): ${routing}\n`}- Expected: x\n`).join('\n');

test('agent-verified and e2e-covered checkpoints are the agent\'s; a human one needs a reason no agent can cover', () => {
  const found = checkpoints(record([
    ['C1', 'AGENT_VERIFIED: DOM read on head abc'],
    ['C2', '`E2E_COVERED` by the move spec'],
    ['C3', 'needs a real device: trackpad scroll feel on the tree grid'],
    ['C4', 'screen reader announcement order (VoiceOver)'],
    ['C5', 'visual: whether the drag chip looks right'],
    ['C6', 'the operator should take a look'],
    ['C7', null],
    ['C8', 'the layout looks and feels right'],
  ]));
  assert.deepEqual(found.map((checkpoint) => [checkpoint.id, verdict(checkpoint).kind]), [
    ['C1', 'agent'],
    ['C2', 'agent'],
    ['C3', 'human'],
    ['C4', 'human'],
    ['C5', 'refused'],
    ['C6', 'refused'],
    ['C7', 'refused'],
    ['C8', 'refused'],
  ]);
  assert.match(verdict(found[4]).why, /compare its screenshot with the saved reference/);
});

test('the command exits 1 on a refused checkpoint and 0 for a plan with zero human checkpoints', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qa-plan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = path.join(dir, 'qa.md');
  writeFileSync(plan, record([['C1', 'AGENT_VERIFIED: capture compared with the reference'], ['C2', 'whether the spacing looks right']]));
  const refused = spawnSync(process.execPath, [path.join(HERE, 'qa-plan-check.mjs'), '--plan', plan], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /^REFUSED C2: a visual judgment is the agent's/m);
  assert.match(refused.stdout, /human checkpoints: 0, refused: 1/);
  writeFileSync(plan, record([['C1', 'AGENT_VERIFIED: capture compared with the reference']]));
  const clean = spawnSync(process.execPath, [path.join(HERE, 'qa-plan-check.mjs'), '--plan', plan], { encoding: 'utf8' });
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, 'human checkpoints: 0, refused: 0\n');
});
