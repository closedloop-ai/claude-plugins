import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planProblems, programRulingProblems, recordRulings, rulingProblems, sequencingRequirements, uncitedExclusions, criteriaChangeProblems } from "./rulings-check.mjs";

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

test("a sourced sequencing ruling yields blocker-to-blocked edges and reports unresolved PRs", (t) => {
  const program = '- Ruling 2026-11-02 (ticket: ISS-300): ISS-300 waits until ISS-100 and #42 merge\n';
  assert.deepEqual(sequencingRequirements(program, { 42: "ISS-200" }), {
    edges: [
      { blocker: "ISS-100", blocked: "ISS-300" },
      { blocker: "ISS-200", blocked: "ISS-300" },
    ],
    unresolved: [],
  });
  assert.deepEqual(sequencingRequirements(program, {}), {
    edges: [{ blocker: "ISS-100", blocked: "ISS-300" }],
    unresolved: [{ reference: "#42", ruling: "ISS-300 waits until ISS-100 and #42 merge" }],
  });
  assert.deepEqual(sequencingRequirements(
    '- Ruling 2026-11-04 (operator message: release order): #500 waits until #42 merges\n',
    { 500: "ISS-300", 42: "ISS-200" },
  ), {
    edges: [{ blocker: "ISS-200", blocked: "ISS-300" }],
    unresolved: [],
  }, "PR references resolve on both sides of a sequencing ruling");
  const named = '- Ruling 2026-11-04 (ticket: ISS-9): ISS-9 waits until the migrations ticket merges\n';
  assert.deepEqual(sequencingRequirements(named, {}), {
    edges: [],
    unresolved: [{ reference: "the migrations ticket merges", ruling: "ISS-9 waits until the migrations ticket merges" }],
  });
  const mixedNamed = '- Ruling 2026-11-04 (ticket: ISS-3): ISS-3 waits until ISS-1 and the migrations ticket merge\n';
  assert.deepEqual(sequencingRequirements(mixedNamed, {}), {
    edges: [{ blocker: "ISS-1", blocked: "ISS-3" }],
    unresolved: [{ reference: "the migrations ticket", ruling: "ISS-3 waits until ISS-1 and the migrations ticket merge" }],
  }, "a resolved blocker does not hide a named unresolved blocker");
  const mixedUnresolved = '- Ruling 2026-11-04 (ticket: ISS-3): ISS-3 waits until #42 and the migrations ticket merge\n';
  assert.deepEqual(sequencingRequirements(mixedUnresolved, {}), {
    edges: [],
    unresolved: [
      { reference: "#42", ruling: "ISS-3 waits until #42 and the migrations ticket merge" },
      { reference: "the migrations ticket", ruling: "ISS-3 waits until #42 and the migrations ticket merge" },
    ],
  }, "an unresolved PR does not hide an unresolved named blocker");
  assert.deepEqual(sequencingRequirements('- Ruling (orchestrator): ISS-300 waits until ISS-100 merges\n', {}), {
    edges: [],
    unresolved: [],
  }, "operational orchestrator directions are not human rulings");

  const realCase = '- Ruling 2026-11-02 (operator message: R-13164-PHASE1): phase 2 waits until ISS-13526, ISS-13557, ISS-13474, ISS-13465, ISS-13479, ISS-13527, #9366 and #9448 merge\n';
  assert.deepEqual(sequencingRequirements(realCase, { 9366: "ISS-9366", 9448: "ISS-9448" }).edges, [
    { blocker: "ISS-13526", blocked: "ISS-13164" },
    { blocker: "ISS-13557", blocked: "ISS-13164" },
    { blocker: "ISS-13474", blocked: "ISS-13164" },
    { blocker: "ISS-13465", blocked: "ISS-13164" },
    { blocker: "ISS-13479", blocked: "ISS-13164" },
    { blocker: "ISS-13527", blocked: "ISS-13164" },
    { blocker: "ISS-9366", blocked: "ISS-13164" },
    { blocker: "ISS-9448", blocked: "ISS-13164" },
  ]);

  const dir = mkdtempSync(path.join(os.tmpdir(), "rulings-sequencing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rulings = path.join(dir, "rulings.md");
  const prTickets = path.join(dir, "pr-tickets.json");
  writeFileSync(rulings, program);
  writeFileSync(prTickets, JSON.stringify({ 42: "ISS-200" }));
  const parsed = spawnSync(process.execPath, [SCRIPT, "--sequencing", rulings, "--pr-tickets", prTickets], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(JSON.parse(parsed.stdout).edges, [
    { blocker: "ISS-100", blocked: "ISS-300" },
    { blocker: "ISS-200", blocked: "ISS-300" },
  ]);

  const target = path.join(dir, "program-rulings.md");
  const links = path.join(dir, "links.json");
  writeFileSync(target, "- Ruling 2026-10-01 (ticket: ISS-1): keep the release lane\n");
  writeFileSync(links, JSON.stringify([{ source: "ISS-100", target: "ISS-300", linkType: "BLOCKS" }]));
  const refused = spawnSync(process.execPath, [SCRIPT, "--record-sequencing", rulings, "--program", target,
    "--pr-tickets", prTickets, "--links", links], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.equal(readFileSync(target, "utf8"), "- Ruling 2026-10-01 (ticket: ISS-1): keep the release lane\n");
  writeFileSync(links, JSON.stringify([
    { source: "ISS-100", target: "ISS-300", linkType: "BLOCKS" },
    { source: "ISS-200", target: "ISS-300", linkType: "BLOCKS" },
  ]));
  const recorded = spawnSync(process.execPath, [SCRIPT, "--record-sequencing", rulings, "--program", target,
    "--pr-tickets", prTickets, "--links", links], { encoding: "utf8" });
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(readFileSync(target, "utf8"), /ISS-300 waits until ISS-100 and #42 merge/);

  const skill = readFileSync(path.resolve(path.dirname(SCRIPT), "..", "..", "fleet-orchestrator", "SKILL.md"), "utf8");
  assert.match(skill, /create-artifact-link[\s\S]*--record-sequencing/);
  assert.match(skill, /only sequencing-ruling writer[\s\S]*refuses a missing link/);
});

// Shaped like PLN-2212 v2: APPROVED by vibe's own handoff with approverId null,
// whose uncited Out-of-scope line a writer used to skip ISS-9381 and ISS-9522
// after the orchestrator told it to build both.
const PLN_2212_SHAPED = [
  "# Implementation Plan: PRD-727 Responsive Narrow Gridview",
  "",
  "**Scope:**",
  "- In-scope: ISS-12683; ISS-9377, ISS-9380 and ISS-12631; the shared responsive branch.",
  "- Out-of-scope: ISS-9381 prototype recomposition, ISS-9522 responsive preference versioning, public documentation, and broad local suites assigned by the operator to automatic CI.",
  "",
  "## Acceptance Criteria",
  "",
  "| ID | Criterion | Source |",
  "|----|-----------|--------|",
  "| AC-001 | The ledger maps every approved behavior to a component, defect, or non-goal. | PRD-727 |",
  "| AC-004 | The preserved prototype imports the mastered implementation. | PRD-727; ISS-9381 is explicitly outside this build scope and remains untouched |",
  "",
  "## Implementation Notes",
  "",
  "- Child mapping at handoff: covered are ISS-9377 and ISS-9380. Not covered and unchanged are ISS-9381 and ISS-9522.",
  "- The card fallback tests are obsolete and deleted, as PRD-727 retires that fallback.",
  "",
  "## Gaps",
  "",
  "- [ ] **GAP-001**: ISS-9381 prototype recomposition is explicitly outside this build scope.",
  "- [ ] **GAP-002**: ISS-9522 responsive preference versioning is deferred per operator ruling 2026-10-19.",
].join("\n");
const planDoc = (extra = {}) => ({ slug: "PLN-2212", status: "APPROVED", approverId: null, version: { content: PLN_2212_SHAPED, contentTruncated: false }, ...extra });
const MARKER = "> Self-approved: vibe sets this plan's status and no human approved it.";

test("a plan no human approved cannot exclude work without citing a human source for each exclusion", () => {
  assert.deepEqual(uncitedExclusions(PLN_2212_SHAPED), [
    "- Child mapping at handoff: covered are ISS-9377 and ISS-9380. Not covered and unchanged are ISS-9381 and ISS-9522.",
    "ISS-9381 prototype recomposition is explicitly outside this build scope.",
  ]);
  const problems = planProblems(planDoc());
  assert.equal(problems.length, 3);
  assert.match(problems[0], /PLN-2212 is APPROVED with no human approver and is not marked self-approved/);
  assert.match(problems[1], /PLN-2212 is APPROVED with no human approver, so its exclusion "- Child mapping at handoff/);
  assert.equal(planProblems(planDoc(), `${MARKER}\n\n${PLN_2212_SHAPED}`).length, 2, "the marker says it is self-approved; its uncited lines still need sources");
  assert.deepEqual(planProblems(planDoc({ approverId: "user-1" })), [], "a plan a named human approved is a source");
  assert.equal(planProblems(planDoc({ status: "DRAFT" })).length, 2, "a draft is not a ruling either, and needs no marker");
  assert.deepEqual(uncitedExclusions("- Out-of-scope: none\n- Non-goals: ISS-9 per ISS-8 AC-3; offline sync (PRD-4)\n"), []);
  assert.deepEqual(uncitedExclusions("## Out of scope\n\n- the export menu\n- bulk delete, per operator ruling 2026-10-20\n"), ["the export menu"]);
  assert.deepEqual(uncitedExclusions("- Obsolete: the RTL criterion\n"), ["the RTL criterion"]);
  assert.match(planProblems(planDoc({ version: { content: "truncated", contentTruncated: true } })).join(), /--plan-body/);
});

test("a quoted test title from PLN-2253 is not parsed as a scope exclusion", () => {
  const task = '- [x] **T-1.1**: Replace the "does not flag DROP TABLE (out of scope)" test, which ISS-12820 Outcome 1 supersedes.';
  assert.deepEqual(uncitedExclusions(task), []);
  assert.deepEqual(uncitedExclusions('The plan says "offline editing is out of scope" and omits it.'), [
    'The plan says "offline editing is out of scope" and omits it.',
  ], "quoted operative scope prose is still an exclusion");
  assert.deepEqual(uncitedExclusions(
    "- Out-of-scope: local collector changes stay excluded per operator ruling 2026-11-04; the related retry path is deferred.",
  ), [], "one cited source covers every semicolon clause on the same line");
  assert.deepEqual(uncitedExclusions(
    '- Out-of-scope: offline sync; replace the "rejects without operator ruling" test.',
  ), ["offline sync"],
  "source words inside a quoted test title do not cite the exclusion line");
});

test("the command fails on a PLN-2212-shaped plan and passes once it is marked and each exclusion is cited", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rulings-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const doc = path.join(dir, "plan.json");
  writeFileSync(doc, JSON.stringify(planDoc()));
  const refused = spawnSync(process.execPath, [SCRIPT, "--plan", doc], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).problems.length, 3);
  const body = path.join(dir, "body.md");
  writeFileSync(body, `${MARKER}\n\n- Out-of-scope: ISS-9381 per ISS-9381 AC-2 (operator ruling 2026-10-21)\n`);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--plan", doc, "--plan-body", body], { encoding: "utf8" }).status, 0);
});

test("a reworded or dropped acceptance criterion needs a ticket ruling amending it by id (#8963, ISS-6560)", () => {
  const before = "- Acceptance criteria:\n  - [ ] Drag reorders rows\n  - [ ] Reject moves beyond four levels\n";
  const reworded = "- Acceptance criteria:\n  - [ ] Drag reorders rows\n  - [ ] Four levels is a display-only cap\n";
  assert.deepEqual(criteriaChangeProblems(before, before), []);
  assert.match(criteriaChangeProblems(before, reworded).join(), /^AC-2 "Reject moves beyond four levels" was reworded or dropped/);
  assert.equal(criteriaChangeProblems(before, reworded).length, 1, "the unchanged criterion passes");
  const ruled = `${reworded}- Ruling 2026-10-21 (Pat Example): "depth is display-only"; amends: AC-2\n`;
  assert.deepEqual(criteriaChangeProblems(before, ruled), []);
  assert.equal(criteriaChangeProblems(before, ruled.replace("amends: AC-2", "amends: AC-1")).length, 1, "a ruling amending another criterion does not cover it");
  assert.equal(criteriaChangeProblems(before, "- Acceptance criteria:\n  - [ ] Drag reorders rows\n").length, 1, "a dropped criterion is a change");
});
