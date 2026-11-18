import assert from "node:assert/strict";
import test from "node:test";
import { checkboxStates, criteriaStates, ticketCriteria, unreadCriteriaProblems } from "./criteria-list.mjs";
import { C3A48F20_DROPS, fuzzTickets, oracleMisses, READER_ROWS, TICKET, UNREAD } from "./criteria-test-fixture.mjs";

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

// Each case holds exactly one box the reader does not read, so each assertion pins that one box. The ids are the ones
// main 0057c43a's reader gives the same text (checked against it when these cases were written).
const SECTION_CASES = [
  ["a + box under a sub-heading of the criteria heading", "### Acceptance criteria\n\n- [ ] a\n\n#### Web\n\n+ [ ] plus\n- [ ] b\n", ["a", "b"]],
  ["a 1. box under a sub-heading of the criteria heading", "### Acceptance criteria\n\n- [ ] a\n\n#### Web\n\n1. [ ] num\n- [ ] b\n", ["a", "b"]],
  ["a 1) box under a sub-heading of the criteria heading", "### Acceptance criteria\n\n- [ ] a\n\n#### Web\n\n1) [ ] num\n- [ ] b\n", ["a", "b"]],
  ["a + box under a list label in the criteria heading's section", "## Acceptance criteria\n\n- [ ] a\n- Notes:\n  + [ ] plus\n- [ ] b\n", ["a", "b"]],
  ["a 1. box under a list label in the criteria heading's section", "## Acceptance criteria\n\n- [ ] a\n- Notes:\n  1. [ ] num\n- [ ] b\n", ["a", "b"]],
  ["a - box under a sibling of a nested criteria heading", "## Acceptance criteria\n\n- [ ] a\n\n### Acceptance criteria for web\n\n- [ ] b\n\n### Desktop\n\n- [ ] c\n", ["a", "b"]],
  ["a + box under a sibling of a nested criteria heading", "## Acceptance criteria\n\n- [ ] a\n\n### Acceptance criteria for web\n\n- [ ] b\n\n### Desktop\n\n+ [ ] p2\n", ["a", "b"]],
  ["a 1) box under a sibling of a nested criteria heading", "## Acceptance criteria\n\n- [ ] a\n\n### Acceptance criteria for web\n\n- [ ] b\n\n### Desktop\n\n1) [ ] n\n", ["a", "b"]],
  ["a + box under a list label nested in the template list", "- Acceptance criteria:\n  - [ ] a\n    - Notes:\n      + [ ] plus\n  - [ ] b\n", ["a", "b"]],
  ["a 1. box under a list label nested in the template list", "- Acceptance criteria:\n  - [ ] a\n    - Notes:\n      1. [ ] num\n  - [ ] b\n", ["a", "b"]],
  ["a 1) box under a list label nested in the template list", "- Acceptance criteria:\n  - [ ] a\n    - Notes:\n      1) [ ] num\n  - [ ] b\n", ["a", "b"]],
  ["a - box after a list label at item level in the template list", "- Acceptance criteria:\n  - [ ] a\n  - Notes:\n  - [ ] b\n", ["a"]],
  ["a + box under a nested list label of an indented template list", "  - Acceptance criteria:\n  - [ ] a\n    - Notes:\n      + [ ] plus\n  - [ ] b\n", ["a", "b"]],
  ["a + box under a shallower continuation label the template list still reads through", "- Acceptance criteria:\n      - [ ] a\n    - Notes:\n      + [ ] plus\n      - [ ] b\n", ["a", "b"]],
  ["a 1. box under a nested list label of an indented template list", "  - Acceptance criteria:\n  - [ ] a\n    - Notes:\n      1. [ ] num\n  - [ ] b\n", ["a", "b"]],
];

for (const [what, ticket, read] of SECTION_CASES) {
  test(`ISS-14136 AC-4: inside a criteria section, ${what} is reported under the section, never read, and ids match main`, () => {
    assert.deepEqual(criteriaStates(ticket).map(({ id, text }) => [id, text]), read.map((text, index) => [`AC-${index + 1}`, text]));
    assert.deepEqual(unreadCriteriaProblems(ticket), [UNREAD("Acceptance criteria")]);
  });
}

test("ISS-14136 AC-4: once the template list or criteria section has ended, an unrelated checklist is not reported", () => {
  assert.deepEqual(unreadCriteriaProblems("- Acceptance criteria:\n  - [ ] a\n- Environment:\n  - [ ] run the app\n  1. [ ] check the logs\n"), [], "a sibling list label closes the template list");
  assert.deepEqual(unreadCriteriaProblems("## Acceptance criteria\n\n- [ ] a\n\n## Environment\n\n+ [ ] run the app\n1. [ ] check the logs\n"), [], "a heading at the section's level closes it");
});

for (const row of READER_ROWS) {
  test(`ISS-14136 AC-4: reader row "${row.name}": ids match main and every box in a criteria section is read or reported`, () => {
    assert.deepEqual(criteriaStates(row.ticket).map(({ id, text }) => [id, text]), row.read.map((text, index) => [`AC-${index + 1}`, text]));
    const states = checkboxStates(row.ticket);
    assert.deepEqual(states.filter((box) => !box.read && box.reportedUnder === null).map((box) => box.text), row.outside, "only boxes outside every criteria section go unreported");
    assert.deepEqual(oracleMisses(row.ticket, states, criteriaStates), []);
  });
}

for (const row of READER_ROWS.filter((candidate) => candidate.overReport.length)) {
  test(`ISS-14136 AC-4: accepted over-report (orchestrator decision 2026-11-18, AC-4 outranks the ADV-R5-2 half of Q-R5): "${row.name}" reports its sibling section's boxes under Acceptance criteria`, () => {
    const states = checkboxStates(row.ticket);
    for (const text of row.overReport) assert.equal(states.find((box) => box.text === text)?.reportedUnder, "Acceptance criteria", text);
  });
}

test("ISS-14136 AC-4: over a seeded corpus of 50000 tickets, the report oracle run with this reader's own criteriaStates finds no box in a criteria section that the reader neither reads nor reports", () => {
  // Reading equal to main is pinned by the literal ids of READER_ROWS, not here.
  const misses = fuzzTickets(14136, 50000).flatMap((ticket) => oracleMisses(ticket, checkboxStates(ticket), criteriaStates).map((text) => [ticket, text]));
  assert.deepEqual(misses.slice(0, 3), []);
});

test("ISS-14136 AC-4: the oracle finds every box c3a48f20 dropped, so it is not blind to that drop", () => {
  for (const row of C3A48F20_DROPS) {
    assert.ok(row.dropped.length > 0, row.name);
    assert.deepEqual(oracleMisses(row.ticket, row.states, criteriaStates), row.dropped, row.name);
  }
});
