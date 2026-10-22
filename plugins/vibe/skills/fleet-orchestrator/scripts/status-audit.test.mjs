import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditStatuses, childFinding } from './status-audit.mjs';

const SCRIPT = fileURLToPath(new URL('./status-audit.mjs', import.meta.url));
const merged = { url: 'https://example.test/pull/1', state: 'MERGED' };
const open = { url: 'https://example.test/pull/2', state: 'OPEN' };

test('a merged pull request means DONE, an open one or a writer means in progress or review, and neither means unowned', () => {
  assert.deepEqual(childFinding({ slug: 'a', status: 'IN_REVIEW', pullRequests: [merged] }), { kind: 'MISMATCH', expected: 'DONE', evidence: 'https://example.test/pull/1 merged' });
  assert.equal(childFinding({ slug: 'a', status: 'DONE', pullRequests: [merged, open] }), null);
  assert.deepEqual(childFinding({ slug: 'b', status: 'BACKLOG', pullRequests: [open] }), { kind: 'MISMATCH', expected: 'IN_PROGRESS or IN_REVIEW', evidence: 'https://example.test/pull/2 open' });
  assert.deepEqual(childFinding({ slug: 'c', status: 'BACKLOG', writer: 'w2', pullRequests: [] }), { kind: 'MISMATCH', expected: 'IN_PROGRESS or IN_REVIEW', evidence: 'writer w2 assigned' });
  assert.equal(childFinding({ slug: 'd', status: 'IN_PROGRESS', writer: 'w2' }), null);
  assert.deepEqual(childFinding({ slug: 'e', status: 'IN_PROGRESS', pullRequests: [{ state: 'CLOSED' }] }), { kind: 'UNOWNED' });
  assert.deepEqual(childFinding({ slug: 'f', status: 'BACKLOG' }), { kind: 'UNOWNED' });
  assert.equal(childFinding({ slug: 'g', status: 'CANCELED' }), null);
});

test('a mismatch ruled out of scope with a reason no longer fails; one without a reason still does', () => {
  const snapshot = {
    prds: [{ slug: 'P1', children: [{ slug: 'a', status: 'IN_REVIEW', pullRequests: [merged] }, { slug: 'f', status: 'BACKLOG' }] }],
    outOfScope: [{ slug: 'f', reason: 'operator, 2026-10-21: parked for next sprint' }, { slug: 'a', reason: ' ' }],
  };
  const result = auditStatuses(snapshot);
  assert.deepEqual(result.findings.map((finding) => finding.slug), ['a']);
  assert.deepEqual(result.outOfScope, [{ slug: 'f', reason: 'operator, 2026-10-21: parked for next sprint' }]);
});

test('the command prints each finding and exits 1 until the statuses match', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'status-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'snapshot.json');
  writeFileSync(file, JSON.stringify({ prds: [{ slug: 'P1', children: [
    { slug: 'a', status: 'IN_REVIEW', pullRequests: [merged] },
    { slug: 'c', status: 'BACKLOG', writer: 'w2' },
    { slug: 'f', status: 'BACKLOG' },
  ] }] }));
  const failing = spawnSync(process.execPath, [SCRIPT, '--snapshot', file], { encoding: 'utf8' });
  assert.equal(failing.status, 1);
  assert.equal(failing.stdout, [
    'MISMATCH a IN_REVIEW, expected DONE (https://example.test/pull/1 merged)',
    'MISMATCH c BACKLOG, expected IN_PROGRESS or IN_REVIEW (writer w2 assigned)',
    'UNOWNED f BACKLOG',
    'status audit: 3 children, 2 mismatched, 1 unowned',
    '',
  ].join('\n'));
  writeFileSync(file, JSON.stringify({ prds: [{ slug: 'P1', children: [{ slug: 'a', status: 'DONE', pullRequests: [merged] }] }] }));
  const clean = spawnSync(process.execPath, [SCRIPT, '--snapshot', file], { encoding: 'utf8' });
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, 'status audit: 1 children, 0 mismatched, 0 unowned\n');
});
