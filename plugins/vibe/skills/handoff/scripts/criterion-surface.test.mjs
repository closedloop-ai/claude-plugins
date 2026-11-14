import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditProblems } from "./criteria-audit.mjs";
import { markLine, NAMES_DESKTOP, NEEDS_APP_RUN, NO_SURFACE_FIXTURES, PROOF_TEST, proofFolder, testRow } from "./criteria-test-fixture.mjs";
import { EvidenceAt, noSurfaceMarks } from "./criterion-surface.mjs";
import { gapLines, Origin, reviewGaps } from "./unit-review.mjs";

test("ISS-14136 AC-1: a no-surface mark with a reason and a named test that exists stands in for the app run", (t) => {
  const dir = proofFolder(t);
  const criteria = [{ id: "AC-1", text: NO_SURFACE_FIXTURES[0].text }];
  const audit = markLine("AC-1") + testRow("AC-1");
  const read = noSurfaceMarks(audit, criteria, { worktree: dir });
  assert.deepEqual(read.problems, []);
  assert.deepEqual([...read.marks], [["AC-1", { reason: "Desktop here is the client process, not a screen", test: { file: PROOF_TEST, name: "an older build ignores the new fields" } }]]);
  assert.deepEqual(auditProblems(audit, criteria, dir, EvidenceAt.Worktree, { marks: read.marks }), [], "no screenshot, e2e or control row is asked for");
  assert.deepEqual(auditProblems(testRow("AC-1"), criteria, dir, EvidenceAt.Worktree), [`AC-1: ${NEEDS_APP_RUN}`], "the same row without the mark is refused");
});

test("ISS-14136 AC-1: the named test must be a live test in that file, not a comment, a skipped or a todo one", (t) => {
  const dir = proofFolder(t);
  const criteria = [{ id: "AC-1", text: NO_SURFACE_FIXTURES[0].text }];
  for (const name of ["named only in a comment", "a skipped one", "a todo one", "an x one", "named after code in a comment", "no such test"]) {
    const audit = markLine("AC-1") + testRow("AC-1", name);
    const read = noSurfaceMarks(audit, criteria, { worktree: dir });
    assert.deepEqual(read.problems, [`AC-1: ${PROOF_TEST} has no test named "${name}"`], name);
    assert.equal(read.marks.size, 0, name);
    assert.deepEqual(auditProblems(audit, criteria, dir, EvidenceAt.Worktree, { marks: read.marks }), [`AC-1: ${NEEDS_APP_RUN}`], `${name}: the criterion stays unmarked`);
  }
  const missing = noSurfaceMarks(markLine("AC-1") + testRow("AC-1", "a planned one", "checks/planned.test.mjs"), criteria, { worktree: dir });
  assert.deepEqual(missing.problems, ["AC-1: the test checks/planned.test.mjs does not exist in the worktree; a planned test is not evidence"]);
  assert.equal(missing.marks.size, 0);
});

test("ISS-14136 AC-2: a mark with no reason, or with no named test row, is refused with what is missing", (t) => {
  const dir = proofFolder(t);
  const criteria = [{ id: "AC-1", text: NO_SURFACE_FIXTURES[0].text }];
  const refused = (audit) => {
    const read = noSurfaceMarks(audit, criteria, { worktree: dir });
    assert.equal(read.marks.size, 0, audit);
    assert.deepEqual(auditProblems(audit, criteria, dir, EvidenceAt.Worktree, { marks: read.marks }).filter((problem) => problem.endsWith(NEEDS_APP_RUN)), [`AC-1: ${NEEDS_APP_RUN}`], "a refused mark leaves today's rule in force");
    return read.problems;
  };
  assert.deepEqual(refused(markLine("AC-1", "") + testRow("AC-1")), ["AC-1: a no-surface mark needs its reason"]);
  assert.deepEqual(refused(markLine("AC-1", "   ") + testRow("AC-1")), ["AC-1: a no-surface mark needs its reason"]);
  const needsRow = "AC-1: a no-surface mark needs a MET test row that names the test: <file>::<test name>";
  assert.deepEqual(refused(`${markLine("AC-1")}| AC-1 | MET | script | pnpm test |\n`), [needsRow], "a script row is not a named test");
  assert.deepEqual(refused(`${markLine("AC-1")}| AC-1 | MET | source-trace | ${PROOF_TEST}:2 |\n`), [needsRow], "a source trace is not a named test");
  assert.deepEqual(refused(`${markLine("AC-1")}| AC-1 | MET | test | ${PROOF_TEST} |\n`), [needsRow], "a test row with no test name");
  assert.deepEqual(noSurfaceMarks(markLine("AC-7") + testRow("AC-1"), criteria, { worktree: dir }).problems, ["AC-7: no-surface mark for a criterion the ticket does not list"]);
});

test("ISS-14136 AC-2: a criterion that is not marked keeps today's rule, also beside a marked one", (t) => {
  const dir = proofFolder(t);
  const criteria = [{ id: "AC-1", text: NO_SURFACE_FIXTURES[0].text }, { id: "AC-2", text: "Bulk Favorite works and is verified on web and Desktop" }];
  const audit = markLine("AC-1") + testRow("AC-1") + testRow("AC-2");
  const read = noSurfaceMarks(audit, criteria, { worktree: dir });
  assert.deepEqual([...read.marks.keys()], ["AC-1"]);
  assert.deepEqual(auditProblems(audit, criteria, dir, EvidenceAt.Worktree, { marks: read.marks }), [`AC-2: ${NEEDS_APP_RUN}`], "a named test alone marks nothing");
  const shown = audit.replace(testRow("AC-2"), "| AC-2 | MET | screenshot | bulk-favorite-desktop.png |\n");
  assert.deepEqual(auditProblems(shown, criteria, dir, EvidenceAt.Worktree, { marks: read.marks }), []);
});

test("ISS-14136 AC-3: each of the six real sentences passes when marked with a reason and a test row, and is refused when unmarked, in the audit and in the unit review", (t) => {
  const dir = proofFolder(t);
  assert.equal(NO_SURFACE_FIXTURES.length, 6);
  for (const { source, text } of NO_SURFACE_FIXTURES) {
    const criteria = [{ id: "AC-1", text }];
    const marked = markLine("AC-1") + testRow("AC-1");
    const read = noSurfaceMarks(marked, criteria, { worktree: dir });
    assert.deepEqual(read.problems, [], source);
    assert.deepEqual(auditProblems(marked, criteria, dir, EvidenceAt.Worktree, { marks: read.marks }), [], `${source}: marked, in the audit`);
    assert.deepEqual(auditProblems(testRow("AC-1"), criteria, dir, EvidenceAt.Worktree), [`AC-1: ${NEEDS_APP_RUN}`], `${source}: unmarked, in the audit`);
    const unit = [{ id: "ISS-1:AC-1", text, origin: Origin.Ticket }];
    const review = () => ({ pages: [], surfaces: [], listQueries: [], rows: [{ criterion: "ISS-1:AC-1", part: "code", verdict: "MET", ref: "src/a.ts:1" }] });
    const accepted = reviewGaps(unit, review(), { marks: new Map([["ISS-1:AC-1", read.marks.get("AC-1")]]) });
    assert.deepEqual(accepted.gaps, [], `${source}: marked, in the unit review`);
    assert.deepEqual(gapLines(accepted), ["NO-SURFACE ISS-1 AC-1: Desktop here is the client process, not a screen"], source);
    assert.deepEqual(reviewGaps(unit, review()).gaps, [{ ticket: "ISS-1", criterion: "AC-1", missing: [NAMES_DESKTOP] }], `${source}: unmarked, in the unit review`);
  }
});

test("ISS-14136 AC-6: the mark line and the test row that spec-card.md tells a reviewer to write are the ones the audit accepts", (t) => {
  const dir = proofFolder(t);
  const rule = readFileSync(fileURLToPath(new URL("../../vibe/references/spec-card.md", import.meta.url)), "utf8");
  const quoted = (form) => {
    assert.ok(rule.includes(`\`${form}\``), `spec-card.md no longer quotes ${form}`);
    return form;
  };
  const line = quoted("No surface: AC-n: <reason>").replace("AC-n", "AC-1").replace("<reason>", "a command, not a screen");
  const ref = quoted("<file>::<test name>").replace("<file>", PROOF_TEST).replace("<test name>", "an older build ignores the new fields");
  const row = quoted("| AC-n | MET | <type> | <ref> |").replace("AC-n", "AC-1").replace("<type>", "test").replace("<ref>", ref);
  const read = noSurfaceMarks(`${line}\n${row}\n`, [{ id: "AC-1", text: NO_SURFACE_FIXTURES[5].text }], { worktree: dir });
  assert.deepEqual([read.problems, [...read.marks.keys()], read.marks.get("AC-1")?.reason], [[], ["AC-1"], "a command, not a screen"]);
});

// Lines that start like a mark but are not one in its exact form (ISS-14136 PC-9).
const MALFORMED_MARKS = ["No surface:", "No surface: : r", "- No surface: AC-1: r", "No Surface: AC-1: r", "No-surface: AC-1: r"];
for (const line of MALFORMED_MARKS) {
  test(`ISS-14136 AC-2: the malformed mark line ${JSON.stringify(line)} is reported, never dropped`, (t) => {
    const dir = proofFolder(t);
    const criteria = [{ id: "AC-1", text: NO_SURFACE_FIXTURES[0].text }];
    const audit = `${line}\n${testRow("AC-1")}`;
    const read = noSurfaceMarks(audit, criteria, { worktree: dir });
    assert.deepEqual(read.problems, [`${JSON.stringify(line)}: a no-surface mark reads "No surface: <id>: <reason>"`]);
    assert.equal(read.marks.size, 0);
    assert.deepEqual(auditProblems(audit, criteria, dir, EvidenceAt.Worktree, { marks: read.marks }), [`AC-1: ${NEEDS_APP_RUN}`], "the criterion stays unmarked");
  });
}

test("ISS-14136 AC-2: a mark with no space after its id colon is read as that id and its reason", (t) => {
  const dir = proofFolder(t);
  const read = noSurfaceMarks(`No surface: AC-1:a command, not a screen\n${testRow("AC-1")}`, [{ id: "AC-1", text: NO_SURFACE_FIXTURES[5].text }], { worktree: dir });
  assert.deepEqual([read.problems, [...read.marks.keys()], read.marks.get("AC-1")?.reason], [[], ["AC-1"], "a command, not a screen"]);
});

test("ISS-14136 AC-2: prose that mentions no surface without starting like a mark is not read as one", () => {
  assert.deepEqual(noSurfaceMarks("The reviewer found no surface to run.\n", [{ id: "AC-1", text: "x" }]), { marks: new Map(), problems: [] });
});

test("ISS-14136 AC-2: a line that starts with the words no surface but has no colon after them is prose, not a mark", () => {
  const criteria = [{ id: "AC-1", text: "x" }];
  assert.deepEqual(noSurfaceMarks("No surface changes were made to the CLI\n- no surface was touched\n", criteria), { marks: new Map(), problems: [] });
  assert.deepEqual(noSurfaceMarks("- No surface: AC-1: r\n", criteria).problems, ['"- No surface: AC-1: r": a no-surface mark reads "No surface: <id>: <reason>"'], "a list-marked mark line is still reported");
});

test("ISS-14136 AC-2: a well-formed mark for an id the ticket does not list is refused as not listed", () => {
  const read = noSurfaceMarks("No surface: AC-9: the client process\n", [{ id: "AC-1", text: NO_SURFACE_FIXTURES[0].text }]);
  assert.deepEqual([read.problems, read.marks.size], [["AC-9: no-surface mark for a criterion the ticket does not list"], 0]);
});
