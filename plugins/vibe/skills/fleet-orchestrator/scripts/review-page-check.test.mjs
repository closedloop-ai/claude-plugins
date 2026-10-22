import assert from "node:assert/strict";
import test from "node:test";
import { reviewPageProblems } from "./review-page-check.mjs";

test("operator review IDs encode kind, have at least three digits and never repeat", () => {
  const valid = `| ID | status | PR | finding | resolution |\n|---|---|---|---|---|\n| D001 | decision needed | #1 | choose | A |\n| X002 | fixing | #2 | bug | patch |\n`;
  assert.deepEqual(reviewPageProblems(valid), []);
  assert.deepEqual(reviewPageProblems(`${valid}| F1 | open | #3 | ambiguous | none |\n| D001 | decision needed | #4 | reused | none |\n`), [
    "F1: ID must be D###, X###, N###, S### or R###",
    "D001: duplicate ID; review IDs are never reused",
  ]);
  assert.deepEqual(reviewPageProblems('| R003 | open | #1 | ruling | none |\n'), ['R003: status must be ruling']);
});
