import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freeUnitName, groupLines, groupTickets, joinReasons, prNameProblems } from './ticket-units.mjs';

const SCRIPT = fileURLToPath(new URL('./ticket-units.mjs', import.meta.url));
const APP = 'acme/app';
const ticket = (slug, extra = {}) => ({ slug, repo: APP, files: [], historyFiles: [], surfaces: [], blockers: [], ...extra });

test('two tickets that change the same file become one unit, with the file as the evidence', () => {
  const grouping = groupTickets({ tickets: [
    ticket('ISS-1', { files: ['apps/app/board.tsx'] }),
    ticket('ISS-2', { files: ['apps/app/board.tsx', 'apps/app/other.tsx'] }),
  ] });
  assert.deepEqual(grouping.units.map((unit) => unit.tickets), [['ISS-1', 'ISS-2']]);
  assert.deepEqual(groupLines(grouping), ['UNIT ISS-1 ISS-1, ISS-2: ISS-1~ISS-2 shared file apps/app/board.tsx']);
});

test('a shared screen entry or a collision pair joins tickets too, and each reason is printed', () => {
  const grouping = groupTickets({
    tickets: [ticket('ISS-1', { surfaces: ['shell-route:agents'] }), ticket('ISS-2', { surfaces: ['shell-route:agents'] }), ticket('ISS-3')],
    collisions: [{ a: 'ISS-3', b: 'ISS-2', reason: 'same filter control' }],
  });
  assert.deepEqual(groupLines(grouping), ['UNIT ISS-1 ISS-1, ISS-2, ISS-3: ISS-1~ISS-2 shared screen shell-route:agents; ISS-2~ISS-3 collision: same filter control']);
});

test('two tickets in different repositories stay separate even when they share a path', () => {
  const grouping = groupTickets({ tickets: [
    ticket('ISS-1', { files: ['README.md'] }),
    ticket('ISS-2', { repo: 'acme/plugins', files: ['README.md'] }),
  ] });
  assert.deepEqual(grouping.units.map((unit) => unit.tickets), [['ISS-1'], ['ISS-2']]);
  assert.deepEqual(groupLines(grouping), [
    'UNIT ISS-1 ISS-1 alone: different repository from ISS-2',
    'UNIT ISS-2 ISS-2 alone: different repository from ISS-1',
  ]);
});

test('a ticket blocked on an unmerged dependency outside the unit stays separate and is named as blocked', () => {
  const grouping = groupTickets({ tickets: [
    ticket('ISS-1', { files: ['a.ts'] }),
    ticket('ISS-2', { files: ['a.ts'], blockers: [{ slug: 'ISS-9', met: false }] }),
    ticket('ISS-3', { files: ['a.ts'], blockers: [{ slug: 'ISS-8', met: true }] }),
  ] });
  assert.deepEqual(grouping.units.map((unit) => unit.tickets), [['ISS-1', 'ISS-3']]);
  assert.deepEqual(grouping.blocked, [{ slug: 'ISS-2', blocker: 'ISS-9' }]);
  assert.equal(groupLines(grouping).at(-1), 'BLOCKED ISS-2 by ISS-9: kept separate until ISS-9 merges');
});

test('a blocker inside the same unit is built in order on the same branch, not a reason to split', () => {
  const grouping = groupTickets({ tickets: [
    ticket('ISS-1', { files: ['a.ts'] }),
    ticket('ISS-2', { files: ['a.ts'], blockers: [{ slug: 'ISS-1', met: false }] }),
  ] });
  assert.deepEqual(grouping.units.map((unit) => unit.tickets), [['ISS-1', 'ISS-2']]);
  assert.deepEqual(grouping.blocked, []);
});

test('a related ticket arriving mid-flight folds into the running writer instead of starting a unit', () => {
  const units = { 'ISS-1': { tickets: ['ISS-1'], writer: 'w1', repo: APP } };
  const grouping = groupTickets({ tickets: [ticket('ISS-1', { files: ['a.ts'] }), ticket('ISS-5', { files: ['a.ts'] }), ticket('ISS-6', { files: ['b.ts'] })] }, units);
  assert.deepEqual(groupLines(grouping), [
    'FOLD ISS-5 into ISS-1 (w1): ISS-5~ISS-1 shared file a.ts',
    'UNIT ISS-1 ISS-1, ISS-5: in flight (w1)',
    'UNIT ISS-6 ISS-6 alone: no shared file, screen entry, collision or PRD with ISS-1, ISS-5',
  ]);
});

test('two in-flight units that turn out related are reported as an overlap', () => {
  const units = { 'ISS-1': { tickets: ['ISS-1'], writer: 'w1', repo: APP }, 'ISS-2': { tickets: ['ISS-2'], writer: 'w2', repo: APP } };
  const lines = groupLines(groupTickets({ tickets: [ticket('ISS-1', { files: ['a.ts'] }), ticket('ISS-2', { files: ['a.ts'] })] }, units));
  assert.equal(lines[0], 'OVERLAP ISS-1 ISS-2: two in-flight units are related; give one owner or a merge order');
});

test('a file shared only through past changes is labelled history and only such a pair may be kept apart', () => {
  const a = ticket('ISS-1', { files: ['a.ts'], historyFiles: ['old.ts'] });
  const b = ticket('ISS-2', { files: ['b.ts'], historyFiles: ['old.ts'] });
  assert.deepEqual(joinReasons(a, b), ['shared file old.ts (history)']);
  assert.deepEqual(groupLines(groupTickets({ tickets: [a, b] })), ['UNIT ISS-1 ISS-1, ISS-2: ISS-1~ISS-2 shared file old.ts (history)']);
  const apart = groupTickets({ tickets: [a, b], apart: [{ a: 'ISS-1', b: 'ISS-2', reason: 'old.ts was a rename in 2025' }] });
  assert.deepEqual(apart.units.map((unit) => unit.tickets), [['ISS-1'], ['ISS-2']]);
  assert.match(groupLines(apart)[0], /alone: .*kept apart: ISS-1~ISS-2 shared file old\.ts \(history\): old\.ts was a rename in 2025/);
  const strong = ticket('ISS-2', { files: ['a.ts'] });
  assert.throws(() => groupTickets({ tickets: [a, strong], apart: [{ a: 'ISS-1', b: 'ISS-2', reason: 'not wanted' }] }), /share shared file a\.ts; only a pair related by history alone/);
});

test('pr-check fails until the PR title and body name every ticket in the unit', (t) => {
  assert.deepEqual(prNameProblems({ tickets: ['ISS-1', 'I-2'] }, 'ISS-1: Fix the board', 'Fixes ISS-1 and I-23'), [
    'the PR title does not name I-2',
    'the PR body does not name I-2',
  ]);
  const home = mkdtempSync(path.join(os.tmpdir(), 'ticket-units-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, 'programs', 'p1'), { recursive: true });
  writeFileSync(path.join(home, 'current'), 'p1\n');
  writeFileSync(path.join(home, 'programs', 'p1', 'board.json'), JSON.stringify({ units: { 'ISS-1': { tickets: ['ISS-1', 'ISS-2'] } } }));
  const body = path.join(home, 'body.md');
  writeFileSync(body, 'Delivers ISS-1 and ISS-2.\n');
  const run = (title) => spawnSync(process.execPath, [SCRIPT, 'pr-check', '--board', home, '--unit', 'ISS-1', '--title', title, '--body-file', body], { encoding: 'utf8' });
  assert.equal(run('ISS-1: Fix the board').status, 1);
  const passing = run('ISS-1, ISS-2: Fix the board');
  assert.equal(passing.status, 0);
  assert.equal(passing.stdout, 'pr-check: ISS-1 names ISS-1, ISS-2\n');
});

test('group reads the in-flight units from the board and refuses malformed candidates', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ticket-units-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, 'programs', 'p1'), { recursive: true });
  writeFileSync(path.join(home, 'current'), 'p1\n');
  writeFileSync(path.join(home, 'programs', 'p1', 'board.json'), JSON.stringify({ units: { 'ISS-1': { tickets: ['ISS-1'], writer: 'w1', repo: APP } } }));
  const file = path.join(home, 'candidates.json');
  writeFileSync(file, JSON.stringify({ tickets: [ticket('ISS-1', { files: ['a.ts'] }), ticket('ISS-5', { files: ['a.ts'] })] }));
  const result = spawnSync(process.execPath, [SCRIPT, 'group', '--candidates', file, '--board', home], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'FOLD ISS-5 into ISS-1 (w1): ISS-5~ISS-1 shared file a.ts\nUNIT ISS-1 ISS-1, ISS-5: in flight (w1)\n');
  writeFileSync(file, JSON.stringify({ tickets: [{ slug: 'ISS-1' }] }));
  const bad = spawnSync(process.execPath, [SCRIPT, 'group', '--candidates', file], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /ISS-1 needs its repo/);
});

test('the operator\'s open tickets under one PRD become one unit with nothing shared, as same PRD', () => {
  const prd = (slug, extra = {}) => ticket(slug, { prd: 'PRD-7', operatorAssigned: true, ...extra });
  const grouping = groupTickets({ tickets: [prd('ISS-1', { files: ['a.ts'] }), prd('ISS-2', { files: ['b.ts'] }), prd('ISS-3', { blockers: [{ slug: 'ISS-1', met: false }] })] });
  assert.deepEqual(grouping.units.map((unit) => unit.tickets), [['ISS-1', 'ISS-2', 'ISS-3']]);
  assert.deepEqual(grouping.blocked, [], 'a blocker in the same PRD stays inside the unit');
  assert.deepEqual(groupLines(grouping), ['UNIT ISS-1 ISS-1, ISS-2, ISS-3: ISS-1~ISS-2 same PRD PRD-7; ISS-1~ISS-3 same PRD PRD-7; ISS-2~ISS-3 same PRD PRD-7']);
});

test('a ticket assigned to someone else never joins a unit, not even on a shared file, and is printed as related for the operator', () => {
  const grouping = groupTickets({ tickets: [
    ticket('ISS-1', { prd: 'PRD-7', operatorAssigned: true, files: ['a.ts'] }),
    ticket('ISS-2', { prd: 'PRD-7', operatorAssigned: true }),
    ticket('ISS-3', { prd: 'PRD-7', operatorAssigned: false, files: ['a.ts'] }),
    ticket('ISS-4', { operatorAssigned: false, files: ['z.ts'] }),
  ] });
  assert.deepEqual(grouping.units.map((unit) => unit.tickets), [['ISS-1', 'ISS-2']]);
  assert.deepEqual(groupLines(grouping), [
    'UNIT ISS-1 ISS-1, ISS-2: ISS-1~ISS-2 same PRD PRD-7',
    'RELATED ISS-3 to unit ISS-1: ISS-3~ISS-1 shared file a.ts; it has another owner, so it stays out of the unit unless the operator decides otherwise',
  ]);
});

test('a PRD ticket in another repository is that repository\'s own unit for the PRD, and both lines say why', () => {
  const grouping = groupTickets({ tickets: [
    ticket('ISS-1', { prd: 'PRD-7', operatorAssigned: true }),
    ticket('ISS-2', { prd: 'PRD-7', operatorAssigned: true }),
    ticket('ISS-3', { prd: 'PRD-7', operatorAssigned: true, repo: 'acme/plugins' }),
  ] });
  assert.deepEqual(grouping.units.map((unit) => unit.tickets), [['ISS-1', 'ISS-2'], ['ISS-3']]);
  assert.deepEqual(groupLines(grouping), [
    'UNIT ISS-1 ISS-1, ISS-2: ISS-1~ISS-2 same PRD PRD-7; PRD-7 also has ISS-3 in acme/plugins, a unit of its own: a PR cannot span repositories',
    `UNIT ISS-3 ISS-3 alone: different repository from ISS-1, ISS-2; PRD-7 also has ISS-1, ISS-2 in ${APP}, a unit of its own: a PR cannot span repositories`,
  ]);
  assert.throws(() => groupTickets({ tickets: [ticket('ISS-1', { prd: 'prd seven' })] }), /not a PRD slug/);
});

test('a closed unit is finished: a new related ticket starts a new unit instead of folding into its writer', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ticket-units-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, 'programs', 'p1'), { recursive: true });
  writeFileSync(path.join(home, 'current'), 'p1\n');
  const units = { 'ISS-1': { tickets: ['ISS-1'], writer: 'w1', repo: APP } };
  const board = (closed) => writeFileSync(path.join(home, 'programs', 'p1', 'board.json'), JSON.stringify({ units: { 'ISS-1': { ...units['ISS-1'], ...(closed ? { closed: { pr: '#7', at: 'now' } } : {}) } } }));
  const file = path.join(home, 'candidates.json');
  writeFileSync(file, JSON.stringify({ tickets: [ticket('ISS-7', { files: ['a.ts'] }), ticket('ISS-1', { files: ['a.ts'] })] }));
  const group = () => spawnSync(process.execPath, [SCRIPT, 'group', '--candidates', file, '--board', home], { encoding: 'utf8' }).stdout;
  board(false);
  assert.match(group(), /^FOLD ISS-7 into ISS-1 \(w1\)/);
  board(true);
  assert.equal(group(), 'UNIT ISS-7 ISS-7, ISS-1: ISS-7~ISS-1 shared file a.ts\n');
  writeFileSync(file, JSON.stringify({ tickets: [ticket('ISS-1', { files: ['a.ts'] }), ticket('ISS-7', { files: ['a.ts'] })] }));
  assert.equal(group(), 'UNIT ISS-1#2 ISS-1, ISS-7: ISS-1~ISS-7 shared file a.ts\n', 'a closed unit\'s name goes to the next free suffix');
  assert.equal(freeUnitName('ISS-1', ['ISS-1', 'ISS-1#2']), 'ISS-1#3');
});

test('a prd without operatorAssigned, and malformed fields, are refused rather than guessed at', () => {
  const refuses = (extra, pattern) => assert.throws(() => groupTickets({ tickets: [ticket('ISS-1', extra)] }), pattern, JSON.stringify(extra));
  refuses({ prd: 'PRD-7' }, /names a prd, so it needs operatorAssigned/);
  refuses({ prd: 'ISS-9', operatorAssigned: true }, /not a PRD slug/);
  refuses({ files: 'a.ts' }, /files as an array of strings/);
  refuses({ surfaces: [3] }, /surfaces as an array of strings/);
  refuses({ blockers: [{ met: false }] }, /blockers as an array/);
  refuses({ blockers: { slug: 'ISS-9', met: false } }, /blockers as an array/);
  assert.throws(() => groupTickets({ tickets: [ticket('ISS-1')], collisions: [{ a: 'ISS-1' }] }), /collisions must be an array/);
});

test('a ticket whose related neighbour is blocked says so instead of claiming nothing is shared', () => {
  const lines = groupLines(groupTickets({ tickets: [
    ticket('ISS-1', { files: ['a.ts'] }),
    ticket('ISS-2', { files: ['a.ts'], blockers: [{ slug: 'ISS-9', met: false }] }),
  ] }));
  assert.deepEqual(lines, [
    'UNIT ISS-1 ISS-1 alone: its only related tickets are kept separate; related to ISS-2, which is BLOCKED by ISS-9',
    'BLOCKED ISS-2 by ISS-9: kept separate until ISS-9 merges',
  ]);
});

test('an apart pair that still joins through another ticket says so, and an unrelated apart pair is refused', () => {
  const tickets = [
    ticket('ISS-1', { files: ['a.ts'], historyFiles: ['h.ts'] }),
    ticket('ISS-2', { files: ['b.ts'], historyFiles: ['h.ts'] }),
    ticket('ISS-3', { files: ['a.ts', 'b.ts'] }),
  ];
  const [line] = groupLines(groupTickets({ tickets, apart: [{ a: 'ISS-1', b: 'ISS-2', reason: 'a rename' }] }));
  assert.equal(line, 'UNIT ISS-1 ISS-1, ISS-2, ISS-3: ISS-1~ISS-3 shared file a.ts; ISS-2~ISS-3 shared file b.ts; asked to keep ISS-1 and ISS-2 apart (a rename), but they are joined through ISS-1~ISS-3~ISS-2');
  assert.doesNotMatch(line, /kept apart:/);
  assert.throws(() => groupTickets({ tickets: [ticket('ISS-1', { files: ['a.ts'] }), ticket('ISS-2', { files: ['b.ts'] })], apart: [{ a: 'ISS-1', b: 'ISS-2', reason: 'x' }] }), /are not related; there is nothing to keep apart/);
});
