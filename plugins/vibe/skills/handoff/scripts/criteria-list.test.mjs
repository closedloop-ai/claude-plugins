import assert from "node:assert/strict";
import test from "node:test";
import { criteriaStates, ticketCriteria, unreadCriteriaProblems } from "./criteria-list.mjs";
import { TICKET, UNREAD } from "./criteria-test-fixture.mjs";

test("ISS-14136 AC-4: checkboxes that read as criteria outside the section are reported, and other checklists are not", () => {
  assert.deepEqual(unreadCriteriaProblems(TICKET), [], "an Environment checklist is not a criterion");
  assert.deepEqual(unreadCriteriaProblems(`${TICKET}\n## Engineering checklist\n\n- [ ] Write the tests listed under Missing tests\n- [ ] Criterion waits on ISS-9: the count; not met until it ships\n`), []);
  assert.deepEqual(unreadCriteriaProblems(`${TICKET}\n## Added criteria\n\n- [ ] A third thing happens\n- [ ] And a fourth\n`), [UNREAD("Added criteria")]);
  assert.deepEqual(unreadCriteriaProblems(`${TICKET}\n## Notes from the review\n\n- [ ] AC-12: a late criterion\n`), [UNREAD("Notes from the review")], "a checkbox that leads with a criterion id");
  assert.deepEqual(unreadCriteriaProblems(`${TICKET}\n## Follow-up\n\n- More criteria:\n  - [ ] A fifth thing happens\n`), [UNREAD("More criteria")], "a list label that names criteria");
  assert.deepEqual(ticketCriteria(`${TICKET}\n## Added criteria\n\n- [ ] A third thing happens\n`).map(({ id }) => id), ["AC-1", "AC-2"], "they are refused, not read: the numbering does not move");
});

test("ISS-14136 AC-4: every checkbox form is read or reported: ordered and + boxes, and a list-level box right after the criteria list", () => {
  const listed = "- Acceptance criteria:\n  - [ ] one\n";
  assert.deepEqual(unreadCriteriaProblems(`${listed}- [ ] two at list level\n`), [UNREAD("Acceptance criteria")], "a box at list level right after the list");
  assert.deepEqual(unreadCriteriaProblems(`${listed}  1. [ ] two numbered\n`), [UNREAD("Acceptance criteria")], "an ordered box inside the list");
  assert.deepEqual(unreadCriteriaProblems(`${listed}\n## Other\n\n1. [ ] AC-2: numbered\n+ [ ] AC-3: plus\n`), [UNREAD("Other")], "ordered and + boxes that lead with a criterion id");
  assert.deepEqual(unreadCriteriaProblems(`${listed}\n## Criteria met\n\n1. [x] ordered\n`), [UNREAD("Criteria met")], "an ordered box under a heading that names criteria");
  assert.deepEqual(unreadCriteriaProblems(`${listed}\nPlain text after the list.\n- [ ] an unrelated todo\n`), [], "after other text the box belongs to that text, not the list");
});

test("ISS-14136 AC-4: under an Acceptance criteria heading only - and * boxes are read, so ids match main, and + and ordered boxes are reported", () => {
  const ticket = "## Acceptance criteria\n\n- [ ] first\n1. [ ] numbered\n+ [ ] plus\n- [ ] last\n";
  // The ids main gave this list: AC-1 first, AC-2 last.
  assert.deepEqual(criteriaStates(ticket).map(({ id, text }) => [id, text]), [["AC-1", "first"], ["AC-2", "last"]]);
  assert.deepEqual(unreadCriteriaProblems(ticket), [UNREAD("Acceptance criteria")], "the numbered and plus boxes are reported, never dropped");
});

test("ISS-14136 AC-4: inside the Acceptance criteria section, a + or ordered box under a sub-heading or a list label is reported under that heading, and ids match main", () => {
  for (const [ticket, why] of [
    ["### Acceptance criteria\n\n- [ ] a\n\n#### Web\n\n+ [ ] plus\n1. [ ] num\n- [ ] b\n", "under a deeper sub-heading"],
    ["## Acceptance criteria\n\n- [ ] a\n- Notes:\n  + [ ] plus\n- [ ] b\n", "under a list label"],
  ]) {
    assert.deepEqual(criteriaStates(ticket).map(({ id, text }) => [id, text]), [["AC-1", "a"], ["AC-2", "b"]], why);
    assert.deepEqual(unreadCriteriaProblems(ticket), [UNREAD("Acceptance criteria")], why);
  }
});
