import assert from "node:assert/strict";
import test from "node:test";
import { reviewPageProblems } from "./review-page-check.mjs";

test("operator review IDs encode kind, have at least three digits and never repeat", () => {
  const valid = `| ID | status | PR | finding | resolution |\n|---|---|---|---|---|\n| D001 | decision needed | #1 | choose; checked in code: src/owner.ts:42 | A |\n| X002 | fixing | #2 | bug | patch |\n`;
  assert.deepEqual(reviewPageProblems(valid), []);
  assert.deepEqual(reviewPageProblems(`${valid}| F1 | open | #3 | ambiguous | none |\n| D001 | decision needed | #4 | reused | none |\n`), [
    "F1: ID must be D###, X###, N###, S### or R###",
    "D001: duplicate ID; review IDs are never reused",
  ]);
  assert.deepEqual(reviewPageProblems('| R003 | open | #1 | ruling | none |\n'), ['R003: status must be ruling']);
});

test('a decision row names where the code was checked, so a question the code answers never reaches the operator', () => {
  const head = '| ID | status | PR | finding | resolution |\n|---|---|---|---|---|\n';
  assert.deepEqual(reviewPageProblems(`${head}| D004 | decision needed | #5 | can branches get a bulk owner? | ask |\n`), [
    'D004: a decision names where the code was checked first (checked in code: <file>:<line>); drop it if the code already answers it',
  ]);
  assert.deepEqual(reviewPageProblems(`${head}| D004 | decision needed | #5 | bulk owner? checked in code: schema.prisma | ask |\n`).length, 1, 'a file without a line is not evidence');
  assert.deepEqual(reviewPageProblems(`${head}| D004 | decision needed | #5 | bulk owner? Checked in code: prisma/schema.prisma:120 | ask |\n`), []);
  assert.deepEqual(reviewPageProblems(`${head}| X005 | fixing | #5 | bug | patch |\n`), [], 'only decisions need it');
});
