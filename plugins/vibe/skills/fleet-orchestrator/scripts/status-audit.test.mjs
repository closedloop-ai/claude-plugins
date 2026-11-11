import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditStatuses, childFinding, skipsAudit, sweepFindings } from './status-audit.mjs';
import { bindProviderInProcess } from '../../vibe/scripts/test-fixtures.mjs';

// Tracker checks run only with a tracker bound, so these run bound to the provider this repository ships (spawned scripts inherit it).
bindProviderInProcess(after);

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

test('FLEET_TRIM_STATUS_AUDIT=1 skips only a report run; every other run audits as before', () => {
  assert.equal(skipsAudit('report', { FLEET_TRIM_STATUS_AUDIT: '1' }), true);
  for (const at of ['assignment', 'merge', undefined]) assert.equal(skipsAudit(at, { FLEET_TRIM_STATUS_AUDIT: '1' }), false, String(at));
  assert.equal(skipsAudit('report', {}), false, 'off by default');
  assert.throws(() => skipsAudit('weekly', {}), /--at must be/);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'audit-at-'));
  const file = path.join(dir, 'snapshot.json');
  writeFileSync(file, JSON.stringify({ prds: [{ slug: 'P', children: [{ slug: 'c', status: 'BACKLOG', writer: 'w', pullRequests: [] }] }] }));
  const run = (at, env) => spawnSync(process.execPath, [SCRIPT, '--snapshot', file, '--at', at], { encoding: 'utf8', env: { ...process.env, FLEET_TRIM_STATUS_AUDIT: '', ...env } });
  const skipped = run('report', { FLEET_TRIM_STATUS_AUDIT: '1' });
  assert.deepEqual([skipped.status, skipped.stdout], [0, 'status audit: skipped at report\n']);
  assert.equal(run('merge', { FLEET_TRIM_STATUS_AUDIT: '1' }).status, 1, 'a merge still audits and still fails on a mismatch');
  assert.equal(run('report', {}).status, 1, 'a report audits when the switch is off');
  rmSync(dir, { recursive: true });
});

test('the status sweep flags a recorded sequencing ruling whose BLOCKS link is missing', (t) => {
  const snapshot = {
    prds: [],
    programRulings: '- Ruling 2026-11-02 (ticket: ISS-3): ISS-3 waits until ISS-1 and #42 merge\n',
    pullRequestTickets: { 42: 'ISS-2' },
    artifactLinks: [{ source: 'ISS-1', target: 'ISS-3', linkType: 'BLOCKS' }],
  };
  assert.deepEqual(auditStatuses(snapshot).findings, [{
    kind: 'SEQUENCING-BLOCKS-MISSING',
    blocker: 'ISS-2',
    blocked: 'ISS-3',
  }]);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'status-audit-sequencing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'snapshot.json');
  writeFileSync(file, JSON.stringify(snapshot));
  const result = spawnSync(process.execPath, [SCRIPT, '--snapshot', file], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /SEQUENCING-BLOCKS-MISSING ISS-2 blocks ISS-3/);

  const unresolved = { ...snapshot,
    programRulings: '- Ruling 2026-11-04 (ticket: ISS-9): ISS-9 waits until the migrations ticket merges\n',
    pullRequestTickets: {}, artifactLinks: [] };
  assert.deepEqual(auditStatuses(unresolved).findings, [{
    kind: 'SEQUENCING-UNRESOLVED',
    reference: 'the migrations ticket merges',
    ruling: 'ISS-9 waits until the migrations ticket merges',
  }]);

  const ordinary = { ...snapshot,
    programRulings: [
      '- Ruling 2026-11-04 (ticket: ISS-9): the PLN status follows the work',
      '- Ruling 2026-11-04 (ticket: ISS-9): reviewers wait for CI before commenting',
    ].join('\n'), pullRequestTickets: {}, artifactLinks: [] };
  assert.deepEqual(auditStatuses(ordinary).findings, []);
});

test('a unit moves with its writer\'s PR alone: each ticket follows it on its own, and a member or PR missing from the snapshot is unread', () => {
  const unitPull = (state) => ({ url: 'https://github.com/o/r/pull/10', state });
  const units = { 'ISS-1': { tickets: ['ISS-1', 'ISS-2', 'ISS-3'], writer: 'w1' } };
  const writers = (pr) => ({ w1: pr ? { pr: String(pr), repo: 'o/r' } : {} });
  const snapshot = (status2, pulls, ownPulls = []) => ({ prds: [
    { slug: 'P1', children: [{ slug: 'ISS-1', status: 'IN_REVIEW', pullRequests: pulls, body }] },
    { slug: null, children: [{ slug: 'ISS-2', status: status2, pullRequests: ownPulls, body }, { slug: 'ISS-3', status: 'DONE', body }] },
  ] });
  const findings = (snap, pr = 10) => auditStatuses(snap, units, writers(pr)).findings.map(({ slug, kind, expected }) => `${kind} ${slug} ${expected ?? ''}`.trim());
  assert.deepEqual(findings(snapshot('IN_PROGRESS', [unitPull('MERGED')])), ['MISMATCH ISS-1 DONE', 'MISMATCH ISS-2 DONE']);
  assert.deepEqual(findings(snapshot('IN_PROGRESS', [unitPull('OPEN')])), ['MISMATCH ISS-2 IN_REVIEW', 'MISMATCH ISS-3 IN_REVIEW']);
  assert.deepEqual(findings(snapshot('IN_REVIEW', []), null), ['MISMATCH ISS-1 IN_PROGRESS', 'MISMATCH ISS-2 IN_PROGRESS', 'MISMATCH ISS-3 IN_PROGRESS']);
  // A member's own earlier PR merged before it folded in; it is not the unit's PR.
  assert.deepEqual(findings(snapshot('IN_REVIEW', [unitPull('OPEN')], [{ url: 'https://github.com/o/r/pull/3', state: 'MERGED' }])), ['MISMATCH ISS-3 IN_REVIEW']);
  assert.deepEqual(findings(snapshot('IN_REVIEW', [{ url: 'https://github.com/x/y/pull/10', state: 'OPEN' }])), ['UNIT-PR-UNREAD ISS-1'], 'the same number in another repository is not the writer\'s PR, and no member is judged');
  // The writer row has no PR yet while the unit's PR is open or merged: judging would push members back to IN_PROGRESS.
  const unread = auditStatuses(snapshot('IN_REVIEW', [unitPull('OPEN')]), units, writers(null)).findings;
  assert.deepEqual(unread.map(({ kind, slug }) => `${kind} ${slug}`), ['UNIT-PR-UNREAD ISS-1']);
  assert.match(unread[0].why, /the writer row records no PR, but members list open https:\/\/github\.com\/o\/r\/pull\/10; record the unit's PR with board\.mjs writer w1 --pr <n>/);
  // Before the unit's PR exists, a member's own merged PR from before it folded in is not the unit's: the unit is judged as started.
  const prePr = auditStatuses(snapshot('IN_PROGRESS', [], [{ url: 'https://github.com/o/r/pull/3', state: 'MERGED' }]), units, writers(null)).findings;
  assert.deepEqual(prePr.map(({ kind, slug, expected }) => `${kind} ${slug} ${expected}`), ['MISMATCH ISS-1 IN_PROGRESS', 'MISMATCH ISS-3 IN_PROGRESS']);
  const missing = auditStatuses({ prds: [{ slug: 'P1', children: [{ slug: 'ISS-1', status: 'IN_PROGRESS' }] }] }, { 'ISS-1': { tickets: ['ISS-1', 'ISS-4'], writer: 'w1' } });
  assert.deepEqual(missing.findings, [{ slug: 'ISS-4', status: '?', kind: 'UNREAD-MEMBER', unit: 'ISS-1' }]);
  assert.deepEqual(auditStatuses(snapshot('IN_PROGRESS', [merged])).findings.map(({ slug, kind }) => `${kind} ${slug}`), ['MISMATCH ISS-1', 'UNOWNED ISS-2'], 'without the board each ticket is judged alone');
});

test('until the unit\'s review passes, its members stay IN_PROGRESS and one moved to IN_REVIEW or DONE is UNIT-UNREVIEWED', () => {
  const units = { 'ISS-1': { tickets: ['ISS-1', 'ISS-2'], writer: 'w1' } };
  const writers = { w1: { pr: '10', repo: 'o/r' } };
  const pull = (state) => [{ url: 'https://github.com/o/r/pull/10', state }];
  const snapshot = (first, second, state) => ({ prds: [{ slug: 'P1', children: [
    { slug: 'ISS-1', status: first, pullRequests: pull(state), body }, { slug: 'ISS-2', status: second, body },
  ] }] });
  const held = () => 'unit ISS-1\'s review has 2 gaps and 0 problems';
  const kinds = (snap, review) => auditStatuses(snap, units, writers, review).findings.map(({ kind, slug, expected }) => `${kind} ${slug}${expected ? ` ${expected}` : ''}`);
  assert.deepEqual(kinds(snapshot('IN_PROGRESS', 'IN_PROGRESS', 'OPEN'), held), [], 'an open PR is not In Review until the review passes');
  assert.deepEqual(kinds(snapshot('IN_REVIEW', 'IN_PROGRESS', 'OPEN'), held), ['UNIT-UNREVIEWED ISS-1']);
  assert.deepEqual(kinds(snapshot('DONE', 'IN_REVIEW', 'MERGED'), held), ['UNIT-UNREVIEWED ISS-1', 'UNIT-UNREVIEWED ISS-2']);
  assert.deepEqual(kinds(snapshot('IN_PROGRESS', 'IN_PROGRESS', 'OPEN'), () => null), ['MISMATCH ISS-1 IN_REVIEW', 'MISMATCH ISS-2 IN_REVIEW'], 'once it passes, the PR state rules as before');
});

test('--board reads the open units and writer rows, so a merged unit PR flags every ticket still behind it until the unit closes', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'status-audit-board-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, 'programs', 'p1'), { recursive: true });
  writeFileSync(path.join(home, 'current'), 'p1\n');
  const board = (closed) => writeFileSync(path.join(home, 'programs', 'p1', 'board.json'), JSON.stringify({
    writers: { w1: { pr: '10', repo: 'o/r' } },
    units: { 'ISS-1': { tickets: ['ISS-1', 'ISS-2', 'ISS-5'], writer: 'w1', ...(closed ? { closed: { pr: 'PR 10', at: 'now' } } : {}) } },
  }));
  const file = path.join(home, 'snapshot.json');
  writeFileSync(file, JSON.stringify({ prds: [{ slug: 'P1', children: [
    { slug: 'ISS-1', status: 'DONE', pullRequests: [{ url: 'https://github.com/o/r/pull/10', state: 'MERGED' }], body },
    { slug: 'ISS-2', status: 'IN_REVIEW', body },
  ] }] }));
  board(false);
  const unreviewed = spawnSync(process.execPath, [SCRIPT, '--snapshot', file, '--board', home], { encoding: 'utf8' });
  assert.match(unreviewed.stdout, /^UNIT-UNREVIEWED ISS-1 DONE: unit ISS-1 has no recorded review; .*stays IN_PROGRESS until every member and PRD criterion passes code review and visual QA$/m);
  assert.doesNotMatch(unreviewed.stdout, /^MISMATCH ISS-2/m, 'members are not pushed forward while the review is missing');
  mkdirSync(path.join(home, 'programs', 'p1', 'evidence'), { recursive: true });
  writeFileSync(path.join(home, 'programs', 'p1', 'evidence', 'unit-review-ISS-1.json'), JSON.stringify({ ok: true, tickets: ['ISS-1', 'ISS-2', 'ISS-5'] }));
  const result = spawnSync(process.execPath, [SCRIPT, '--snapshot', file, '--board', home], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^MISMATCH ISS-2 IN_REVIEW, expected DONE \(https:\/\/github\.com\/o\/r\/pull\/10 merged\)$/m);
  assert.match(result.stdout, /^UNREAD-MEMBER ISS-5:/m);
  assert.match(spawnSync(process.execPath, [SCRIPT, '--snapshot', file], { encoding: 'utf8' }).stdout, /^UNOWNED ISS-2 IN_REVIEW$/m, 'without the board the merged PR is not evidence for ISS-2');
  board(true);
  const closed = spawnSync(process.execPath, [SCRIPT, '--snapshot', file, '--board', home], { encoding: 'utf8' });
  assert.doesNotMatch(closed.stdout, /UNREAD-MEMBER/, 'a closed unit is no longer read');
});
