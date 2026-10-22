import assert from "node:assert/strict";
import test from "node:test";
import { programRulingProblems, recordRulings, rulingProblems } from "./rulings-check.mjs";

const RESUME_LOG = `## 2026-10-21 14:05
- Ruling (operator): offline editing is descoped; edits are online only
- Merge order: #101 then #102
`;
const QA_RECORD = "### C3: board\n- Ruling 2026-10-21 (operator): the board keeps the old column order\n";

test("rulings are read from a resume log and a QA record", () => {
  assert.deepEqual(recordRulings(RESUME_LOG), ["offline editing is descoped; edits are online only"]);
  assert.deepEqual(recordRulings(QA_RECORD), ["the board keeps the old column order"]);
});

test("a ruling missing from the ticket, or a ticket ruling with no amended criteria, is refused", () => {
  const ticket = `## Scope and acceptance criteria
- Ruling 2026-10-21 (operator): "Offline editing is descoped; edits are online only"; amends: AC-3
- Ruling 2026-10-21 (operator): "Sessions is ungated"
`;
  assert.deepEqual(rulingProblems(ticket, [RESUME_LOG, QA_RECORD]), [
    'ticket ruling ""Sessions is ungated"" names no amended criteria; end it with "; amends: <criteria, or none>"',
    'ruling "the board keeps the old column order" is not on the ticket; add it under Scope and acceptance criteria as - Ruling <date> (<who>): "<decision>"; amends: <criteria>',
  ]);
  const complete = `${ticket.replace('"Sessions is ungated"', '"Sessions is ungated"; amends: none')}- Ruling 2026-10-21 (operator): "The board keeps the old column order"; amends: AC-1\n`;
  assert.deepEqual(rulingProblems(complete, [RESUME_LOG, QA_RECORD]), []);
});

test("the program index requires dated sources and contains every reconciled ruling", () => {
  const incomplete = '- Ruling (operator): offline editing is descoped; edits are online only\n';
  assert.match(programRulingProblems(incomplete, [RESUME_LOG])[0], /Ruling YYYY-MM-DD/);
  const program = '- Ruling 2026-10-21 (operator message: "deadline thread"): Offline editing is descoped; edits are online only\n';
  assert.deepEqual(programRulingProblems(program, [RESUME_LOG]), []);
  assert.match(programRulingProblems(program, [QA_RECORD])[0], /not in the program rulings index/);
});
