import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditStatuses, childFinding, sweepFindings } from './status-audit.mjs';

const SCRIPT = fileURLToPath(new URL('./status-audit.mjs', import.meta.url));
const merged = { url: 'https://example.test/pull/1', state: 'MERGED' };
const open = { url: 'https://example.test/pull/2', state: 'OPEN' };
const body = '- Acceptance criteria:\n  - [x] Rows reorder\n  - [ ] Keyboard reorder; Follow-up: ABC-1\n';

test('a merged pull request means DONE, an open one or a writer means in progress or review, and neither means unowned', () => {
  assert.deepEqual(childFinding({ slug: 'a', status: 'IN_REVIEW', pullRequests: [merged], body }), { kind: 'MISMATCH', expected: 'DONE', evidence: 'https://example.test/pull/1 merged' });
  assert.equal(childFinding({ slug: 'a', status: 'DONE', pullRequests: [merged, open], body }), null);
  assert.deepEqual(childFinding({ slug: 'b', status: 'BACKLOG', pullRequests: [open] }), { kind: 'MISMATCH', expected: 'IN_PROGRESS or IN_REVIEW', evidence: 'https://example.test/pull/2 open' });
  assert.deepEqual(childFinding({ slug: 'c', status: 'BACKLOG', writer: 'w2', pullRequests: [] }), { kind: 'MISMATCH', expected: 'IN_PROGRESS or IN_REVIEW', evidence: 'writer w2 assigned' });
  assert.equal(childFinding({ slug: 'd', status: 'IN_PROGRESS', writer: 'w2' }), null);
  assert.deepEqual(childFinding({ slug: 'e', status: 'IN_PROGRESS', pullRequests: [{ state: 'CLOSED' }] }), { kind: 'UNOWNED' });
  assert.deepEqual(childFinding({ slug: 'f', status: 'BACKLOG' }), { kind: 'UNOWNED' });
  assert.equal(childFinding({ slug: 'g', status: 'CANCELED' }), null);
});

test('a mismatch ruled out of scope with a reason no longer fails; one without a reason still does', () => {
  const snapshot = {
    prds: [{ slug: 'P1', children: [{ slug: 'a', status: 'IN_REVIEW', pullRequests: [merged], body }, { slug: 'f', status: 'BACKLOG' }] }],
    outOfScope: [{ slug: 'f', reason: 'operator, 2026-10-21: P1 child parked for next sprint' }, { slug: 'a', reason: ' ' }],
  };
  const result = auditStatuses(snapshot);
  assert.deepEqual(result.findings.map((finding) => finding.slug), ['a']);
  assert.deepEqual(result.outOfScope, [{ slug: 'f', reason: 'operator, 2026-10-21: P1 child parked for next sprint' }]);
});

test('the command prints each finding and exits 1 until the statuses match', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'status-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'snapshot.json');
  writeFileSync(file, JSON.stringify({ prds: [{ slug: 'P1', children: [
    { slug: 'a', status: 'IN_REVIEW', pullRequests: [merged], body },
    { slug: 'c', status: 'BACKLOG', writer: 'w2' },
    { slug: 'd', status: 'DONE', pullRequests: [merged], body: body.replace('[x] Rows', '[ ] Rows') },
    { slug: 'e', status: 'DONE' },
    { slug: 'f', status: 'BACKLOG' },
  ] }] }));
  const failing = spawnSync(process.execPath, [SCRIPT, '--snapshot', file], { encoding: 'utf8' });
  assert.equal(failing.status, 1);
  assert.equal(failing.stdout, [
    'MISMATCH a IN_REVIEW, expected DONE (https://example.test/pull/1 merged)',
    'MISMATCH c BACKLOG, expected IN_PROGRESS or IN_REVIEW (writer w2 assigned)',
    'UNCHECKED d DONE: AC-1; check each against the merged code, or name its follow-up or human exclusion, before DONE (executed-check.mjs --kind ticket)',
    'UNREAD e DONE: no ticket body in the snapshot; read it so its acceptance criteria are checked',
    'UNOWNED f BACKLOG',
    'status audit: 5 children, 2 mismatched, 1 unowned, 2 unchecked, 0 unscoped, 0 open plans, 0 absorbed open',
    '',
  ].join('\n'));
  writeFileSync(file, JSON.stringify({ prds: [{ slug: 'P1', children: [{ slug: 'a', status: 'DONE', pullRequests: [merged], body }] }] }));
  const clean = spawnSync(process.execPath, [SCRIPT, '--snapshot', file], { encoding: 'utf8' });
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, 'status audit: 1 children, 0 mismatched, 0 unowned, 0 unchecked, 0 unscoped, 0 open plans, 0 absorbed open\n');
});

test('a merged or DONE child needs its body read and every criterion checked before DONE (bulk DONE sweep)', () => {
  const unchecked = body.replace('[x] Rows', '[ ] Rows');
  assert.deepEqual(childFinding({ slug: 'a', status: 'IN_REVIEW', pullRequests: [merged] }), { kind: 'UNREAD' });
  assert.deepEqual(childFinding({ slug: 'a', status: 'IN_REVIEW', pullRequests: [merged], body: unchecked }), { kind: 'UNCHECKED', criteria: 'AC-1' });
  assert.deepEqual(childFinding({ slug: 'a', status: 'DONE', body: unchecked }), { kind: 'UNCHECKED', criteria: 'AC-1' });
  assert.equal(childFinding({ slug: 'a', status: 'DONE', body }), null);
  assert.equal(childFinding({ slug: 'g', status: 'CANCELED' }), null);
});

test('a child ruled out of scope by a ruling about another surface is UNSCOPED (a skipped PRD rollout gate)', () => {
  const snapshot = {
    prds: [{ slug: 'PRD-7', children: [{ slug: 'ISS-8', status: 'BACKLOG' }, { slug: 'ISS-9', status: 'BACKLOG' }] }],
    outOfScope: [
      { slug: 'ISS-8', reason: 'operator, 2026-10-21: the Desktop Labs toggle is retired' },
      { slug: 'ISS-9', reason: 'operator, 2026-10-22: PRD-7 ships ungated, extending the Sessions ruling' },
    ],
  };
  const result = auditStatuses(snapshot);
  assert.deepEqual(result.findings.map((finding) => [finding.slug, finding.kind]), [['ISS-8', 'UNSCOPED']]);
  assert.deepEqual(result.outOfScope.map((entry) => entry.slug), ['ISS-9']);
});

test('the status sweep flags plans left open behind DONE tickets and absorbed children left open (a PRD whose plans stayed open)', () => {
  const body = '- Acceptance criteria:\n  - [x] Rows reorder\n';
  const snapshot = { prds: [{ slug: 'PRD-8', children: [
    { slug: 'ISS-1', status: 'DONE', body, pullRequests: [merged], plans: [{ slug: 'PLN-1', status: 'APPROVED' }, { slug: 'PLN-2', status: 'EXECUTED' }] },
    { slug: 'ISS-2', status: 'DONE', body, pullRequests: [merged], plans: [{ slug: 'PLN-3', status: 'EXECUTED' }] },
    { slug: 'ISS-3', status: 'IN_PROGRESS', writer: 'w1', absorbedBy: { slug: 'ISS-2', status: 'DONE' } },
    { slug: 'ISS-4', status: 'DONE', body: '- Acceptance criteria:\n  - [ ] Keyboard reorder\n', pullRequests: [merged] },
  ] }] };
  const { findings } = auditStatuses(snapshot);
  assert.deepEqual(findings.map((finding) => [finding.slug, finding.kind]), [
    ['ISS-1', 'PLAN-OPEN'],
    ['ISS-3', 'ABSORBED-OPEN'],
    ['ISS-4', 'UNCHECKED'],
  ]);
  assert.deepEqual(sweepFindings({ status: 'IN_PROGRESS', plans: [{ slug: 'PLN-1', status: 'DRAFT' }] }), [], 'a plan may stay open while its ticket is');
});
