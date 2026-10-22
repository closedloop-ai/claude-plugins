import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planProblems, programRulingProblems, recordRulings, rulingProblems, uncitedExclusions } from "./rulings-check.mjs";

const SCRIPT = fileURLToPath(new URL("./rulings-check.mjs", import.meta.url));

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

// Shaped like the plan vibe set to APPROVED with no approver, whose uncited
// Out-of-scope line a writer used to skip two tickets it was told to build.
const SELF_APPROVED_PLAN = [
  "# Implementation Plan: PRD-7 Responsive Narrow List",
  "",
  "**Scope:**",
  "- In-scope: ISS-1; ISS-2, ISS-3 and the shared responsive branch.",
  "- Out-of-scope: ISS-4 prototype recomposition, ISS-5 responsive preference versioning, public documentation, and broad local suites assigned by the operator to automatic CI.",
  "",
  "## Acceptance Criteria",
  "",
  "| ID | Criterion | Source |",
  "|----|-----------|--------|",
  "| AC-001 | The ledger maps every approved behavior to a component, defect, or non-goal. | PRD-7 |",
  "| AC-004 | The preserved prototype imports the mastered implementation. | PRD-7; ISS-4 is explicitly outside this build scope and remains untouched |",
  "",
  "## Implementation Notes",
  "",
  "- Child mapping at handoff: covered are ISS-2 and ISS-3. Not covered and unchanged are ISS-4 and ISS-5.",
  "",
  "## Gaps",
  "",
  "- [ ] **GAP-001**: ISS-4 prototype recomposition is explicitly outside this build scope.",
  "- [ ] **GAP-002**: ISS-5 responsive preference versioning is deferred per operator ruling 2026-10-19.",
].join("\n");
const planDoc = (extra = {}) => ({ slug: "PLN-1", status: "APPROVED", approverId: null, version: { content: SELF_APPROVED_PLAN, contentTruncated: false }, ...extra });

test("a plan no human approved cannot exclude work without citing a human source for each exclusion", () => {
  assert.deepEqual(uncitedExclusions(SELF_APPROVED_PLAN), [
    "ISS-4 prototype recomposition",
    "ISS-5 responsive preference versioning",
    "public documentation",
    "ISS-4 is explicitly outside this build scope and remains untouched",
    "- Child mapping at handoff: covered are ISS-2 and ISS-3. Not covered and unchanged are ISS-4 and ISS-5.",
    "ISS-4 prototype recomposition is explicitly outside this build scope.",
  ]);
  const problems = planProblems(planDoc());
  assert.equal(problems.length, 6);
  assert.match(problems[0], /PLN-1 is APPROVED with no human approver, so its exclusion "ISS-4 prototype recomposition" is not a ruling/);
  assert.deepEqual(planProblems(planDoc({ approverId: "user-1" })), [], "a plan a named human approved is a source");
  assert.deepEqual(uncitedExclusions("- Out-of-scope: none\n- Non-goals: ISS-9 per ISS-8 AC-3; offline sync (PRD-4)\n"), []);
  assert.deepEqual(uncitedExclusions("## Out of scope\n\n- the export menu\n- bulk delete, per operator ruling 2026-10-20\n"), ["the export menu"]);
  assert.match(planProblems(planDoc({ version: { content: "truncated", contentTruncated: true } })).join(), /--plan-body/);
});

test("the command fails on a self-approved plan with an uncited exclusion and passes once each one is cited", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rulings-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const doc = path.join(dir, "plan.json");
  writeFileSync(doc, JSON.stringify(planDoc()));
  const refused = spawnSync(process.execPath, [SCRIPT, "--plan", doc], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).problems.length, 6);
  const body = path.join(dir, "body.md");
  writeFileSync(body, "- Out-of-scope: ISS-4 per ISS-4 AC-2 (operator ruling 2026-10-21)\n");
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--plan", doc, "--plan-body", body], { encoding: "utf8" }).status, 0);
});
