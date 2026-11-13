import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { renderEvidenceComment } from "./pr-evidence-comment.mjs";
import { evidenceProblems, prEvidenceValidationProblems } from "./pr-facts.mjs";
import { targetedTestsRuling } from "./targeted-tests-ruling.mjs";
import { COMMIT, FILES, LANE, RULING_ID, RULINGS, SELECTED_ONLY, SOURCE, TARGET, TICKET, ruledEvidence } from "./targeted-tests-ruling-test-fixture.mjs";

const RECORDED = { rulingsText: RULINGS, ticketText: TICKET };

function gate(t, evidence, texts = RECORDED, extra = {}) {
  const receiptDir = mkdtempSync(path.join(tmpdir(), "ruling-receipts-"));
  t.after(() => rmSync(receiptDir, { recursive: true, force: true }));
  return prEvidenceValidationProblems(evidence, COMMIT, { candidateFiles: FILES, receiptDir, ...texts, ...extra });
}

test("AC-1: a recorded targeted-tests ruling accepts the targeted set with every other item on a row naming it", (t) => {
  assert.deepEqual(gate(t, ruledEvidence("rulings")), [], "cited from the program's rulings file");
  assert.deepEqual(gate(t, ruledEvidence("ticket")), [], "cited from the live ticket");
});

test("AC-1: without a ruling the same evidence is refused for every item the ruling leaves", (t) => {
  const { targetedTestsRuling: _, ...uncited } = ruledEvidence();
  const problems = gate(t, uncited).join("\n");
  assert.match(problems, /web-host: not-run; a pull request never opens/);
  assert.match(problems, /desktop-host: not-run; a pull request never opens/);
  assert.match(problems, new RegExp(`lane ${LANE.name}: no passing run`));
  assert.match(problems, new RegExp(`${SELECTED_ONLY}: selected but no passing or carried run`));
  assert.match(problems, new RegExp(`${SELECTED_ONLY}: selected test is absent from the targeted inventory`));
});

test("AC-1: the ruling counts only when its text records it, by id, with a date, about targeted tests", () => {
  const cite = (source, id = RULING_ID) => ({ targetedTestsRuling: { id, source } });
  assert.deepEqual(targetedTestsRuling(cite("rulings"), RECORDED), { id: RULING_ID, problems: [] });
  assert.deepEqual(targetedTestsRuling(cite("ticket"), RECORDED), { id: RULING_ID, problems: [] });
  assert.deepEqual(targetedTestsRuling({}, RECORDED), { id: null, problems: [] }, "no citation leaves the gate unchanged");
  assert.match(targetedTestsRuling(cite("rulings"), { ticketText: TICKET }).problems.join(), /pass the rulings file with --rulings/);
  assert.match(targetedTestsRuling(cite("ticket"), { rulingsText: RULINGS }).problems.join(), /pass the ticket body with --ticket/);
  assert.match(targetedTestsRuling(cite("rulings", "R-NEVER-RULED"), RECORDED).problems.join(), /R-NEVER-RULED is not recorded with a date in the rulings/);
  assert.match(targetedTestsRuling(cite("rulings", "R-NEVER-RULED"), RECORDED).problems.join(), /dated heading `## R-<WORDS> \(<who>, <YYYY-MM-DD>\)`.*needs its R-<WORDS> label added/,
    "the refusal names the shape to record in a rulings file, so an existing ruling can be given an id");
  assert.match(targetedTestsRuling(cite("ticket", "R-NEVER-RULED"), RECORDED).problems.join(), /list line `- Ruling R-<WORDS> <YYYY-MM-DD> \(<who>\)/,
    "a ticket gets the ticket's ruling line shape");
  assert.match(targetedTestsRuling(cite("rulings", "R-REVERT-SORT"), RECORDED).problems.join(), /R-REVERT-SORT in the rulings is not about targeted tests/);
  const undated = RULINGS.replace(" (operator, 2026-10-23 ~03:58Z)", "");
  assert.match(targetedTestsRuling(cite("rulings"), { rulingsText: undated }).problems.join(), /is not recorded with a date/);
  const mentioned = `${RULINGS}\nThe orchestrator said ${RULING_ID} on 2026-11-12 targeted tests.\n`.replace(`## ${RULING_ID}`, "## R-RENAMED");
  assert.match(targetedTestsRuling(cite("rulings"), { rulingsText: mentioned }).problems.join(), /is not recorded/, "prose naming the id is not a recorded ruling");
  assert.match(targetedTestsRuling({ targetedTestsRuling: { id: RULING_ID, source: "chat" } }, RECORDED).problems.join(), /needs an id and a source/);
});

test("AC-1: only an entry labeled with the id counts, once, not withdrawn, not an orchestrator direction, about targeted tests apart from the id", () => {
  const verify = (text, id = RULING_ID) => targetedTestsRuling({ targetedTestsRuling: { id, source: "ticket" } }, { ticketText: text });
  assert.match(verify("- 2026-11-10: ran the targeted suite locally, all green\n", "targeted").problems.join(), /needs an id and a source/,
    "a bare word is not a ruling id");
  assert.match(verify("- 2026-11-10: ran the targeted suite under R-SUITE locally\n", "R-SUITE").problems.join(), /is not recorded/,
    "an entry that only mentions the id is not that ruling");
  assert.match(verify("- R-2.1 2026-11-10 (operator): run targeted tests\n", "R-2").problems.join(), /is not recorded/, "R-2 is not R-2.1");
  assert.match(verify(`- (orchestrator) ${RULING_ID} 2026-11-12 run targeted tests\n`).problems.join(), /is not recorded/,
    "an orchestrator direction is not labeled with the id");
  assert.match(verify(`- ${RULING_ID} 2026-11-12 (orchestrator): run targeted tests\n`).problems.join(), /orchestrator direction, not an operator ruling/);
  assert.match(verify(`## ${RULING_ID} (operator, 2026-10-23) withdrawn\n- Run targeted tests.\n`).problems.join(), /withdrawn or superseded/);
  assert.match(verify(`## ${RULING_ID} (operator, 2026-10-23)\n- Revert the default sort.\n`).problems.join(), /is not about targeted tests/,
    "the id's own words do not make the entry about targeted tests");
  assert.match(verify("## R-TARGETED tests (operator, 2026-10-23)\n- Revert the default sort.\n", "R-TARGETED").problems.join(), /is not about targeted tests/,
    "a word after the id does not make the id a topic phrase");
  assert.match(verify(`${TICKET}${TICKET}`).problems.join(), /is recorded 2 times/);
  const subsection = `## R-REVERT-SORT (operator, 2026-10-23)\n- Revert the sort.\n### Notes\n- targeted tests ran\n`;
  assert.match(verify(subsection, "R-REVERT-SORT").problems.join(), /is not about targeted tests/, "a sub-heading is not part of the entry");
  assert.match(verify(`- Ruling R-REVERT-SORT 2026-10-23 (operator): revert the sort\n- Ruling ${RULING_ID} 2026-11-12 (operator): run targeted tests\n`, "R-REVERT-SORT").problems.join(), /is not about targeted tests/,
    "the next list item is another entry");
  const ruled = `## ${RULING_ID} (operator, 2026-10-23)\n- Run targeted tests.\n`;
  const withdrawn = [
    [`${ruled}### Status\n- Withdrawn 2026-11-05\n`, "a withdrawal under its own sub-heading"],
    [`## ${RULING_ID} (operator, 2026-10-23)\n- Run targeted tests. No longer in effect.\n`, "no longer in effect"],
    [`${ruled}\nThe operator withdrew it on 2026-11-05.\n`, "a withdrawal in its own section"],
    [`# Withdrawn rulings\n\n${ruled}`, "a ruling filed under a withdrawn parent heading"],
    [`## Superseded\n- Ruling ${RULING_ID} 2026-10-23 (operator): run targeted tests\n`, "a list ruling under a Superseded heading"],
  ];
  for (const [text, shape] of withdrawn) assert.match(verify(text).problems.join(), /withdrawn or superseded/, shape);
  const namedLater = [
    [`${ruled}\n## R-FULL-SUITE (operator, 2026-11-01)\n- Supersedes ${RULING_ID}: run full suites.\n`, "a later ruling that supersedes it by id"],
    [`${ruled}\n## R-FULL-SUITE (operator, 2026-11-01)\n- Supersedes ${RULING_ID}.\n`, "the id ending a sentence"],
    [`${ruled}\n## Notes\nThe operator withdrew the\n${RULING_ID} rule on 2026-11-05.\n`, "a withdrawal wrapped over two lines"],
    [`${ruled}\n## Superseded\n- ${RULING_ID}\n`, "a Superseded section listing it"],
  ];
  for (const [text, shape] of namedLater) assert.match(verify(text).problems.join(), /is also named outside its own entry/, shape);
  assert.deepEqual(verify(`${ruled}\n## R-2 (operator, 2026-11-01)\n- Revert R-2.1 only.\n`).problems, [], "another id that merely starts the same is not a mention");
  for (const who of [`## ${RULING_ID} (orchestrator, 2026-11-12)\n- Run targeted tests.\n`, `- Ruling ${RULING_ID} 2026-11-12 (orchestrator relay): run targeted tests\n`]) {
    assert.match(verify(who).problems.join(), /orchestrator direction, not an operator ruling/, who);
  }
  assert.deepEqual(verify(ruled.replaceAll("\n", "\r\n")).problems, [], "a CRLF file reads like any other");
  assert.match(verify("## R-FLAGS (operator, 2026-10-23)\n- Flags are targeted per organization.\n", "R-FLAGS").problems.join(), /is not about targeted tests/,
    "the word targeted alone is not a targeted-tests ruling");
});

test("AC-1: under a ruling the targeted inventory must hold at least one test", (t) => {
  const evidence = ruledEvidence();
  const empty = { ...evidence, targetedInventory: { ...evidence.targetedInventory, entries: [], noTestsReason: "nothing to run" },
    testRuns: evidence.testRuns.map((row) => (row.path === TARGET ? { path: TARGET, command: row.command, status: "not-run", ruling: RULING_ID, reason: "ruled", commit: COMMIT } : row)) };
  assert.match(gate(t, empty).join("\n"), new RegExp(`ruling ${RULING_ID} needs at least one targeted inventory test`));
});

test("AC-1: related and e2e-reference selections may be left on a ruling row too; the E2E probe is still demanded", (t) => {
  const evidence = ruledEvidence();
  const related = "packages/app/related.test.ts";
  const spec = "e2e/list.spec.ts";
  const ruled = (file) => ({ path: file, command: `run ${file}`, status: "not-run", ruling: RULING_ID, reason: "ruled", commit: COMMIT });
  const wider = { ...evidence, testSelection: [...evidence.testSelection, { file: SOURCE, selector: "related", tests: [related] },
    { file: SOURCE, selector: "e2e-reference", tests: [spec] }], testRuns: [...evidence.testRuns, ruled(related), ruled(spec)] };
  const problems = gate(t, wider).join("\n");
  assert.doesNotMatch(problems, new RegExp(`${related}|${spec}: selected`));
  assert.match(problems, /E2E capability probe is not bound/, "a spec left not run still needs the capability probe on the commit");
});

test("AC-1: an unverified citation leaves nothing not run", (t) => {
  const problems = gate(t, ruledEvidence(), { ticketText: TICKET }).join("\n");
  assert.match(problems, /pass the rulings file with --rulings/);
  assert.match(problems, /web-host: not-run; a pull request never opens/, "the rows are judged as if no ruling were cited");
  assert.match(problems, new RegExp(`${SELECTED_ONLY}: selected but no passing`));
});

test("AC-1: a row counts only when it names this ruling and gives a reason", (t) => {
  const evidence = ruledEvidence();
  const other = (row) => (row.ruling ? { ...row, ruling: "R-OTHER" } : row);
  const problems = gate(t, { ...evidence, runs: evidence.runs.map(other), testRuns: evidence.testRuns.map(other) }).join("\n");
  assert.match(problems, /web-host: not-run/);
  assert.match(problems, new RegExp(`lane ${LANE.name}: no passing run`));
  assert.match(problems, new RegExp(`${SELECTED_ONLY}: selected but no passing`));
  const unreasoned = { ...evidence, testRuns: evidence.testRuns.map((row) => (row.ruling ? { ...row, reason: " " } : row)) };
  assert.match(gate(t, unreasoned).join("\n"), new RegExp(`${SELECTED_ONLY}: selected but no passing`));
  const older = (row) => (row.path === SELECTED_ONLY ? { ...row, commit: "d".repeat(40) } : row);
  assert.match(gate(t, { ...evidence, testRuns: evidence.testRuns.map(older) }).join("\n"), new RegExp(`${SELECTED_ONLY}: selected but no passing`),
    "a row from an earlier commit does not speak for the published one");
});

test("AC-1: the targeted inventory still needs its passing verifier run on the published commit", (t) => {
  const evidence = ruledEvidence();
  const unrun = { ...evidence, testRuns: evidence.testRuns.map((row) => (row.path === TARGET
    ? { path: TARGET, command: row.command, status: "not-run", ruling: RULING_ID, reason: "skipped", commit: COMMIT } : row)) };
  assert.match(gate(t, unrun).join("\n"), new RegExp(`${TARGET}: no passing targeted run`));
  assert.match(gate(t, unrun).join("\n"), new RegExp(`ruling ${RULING_ID} needs at least one targeted inventory test that passed on the published commit`),
    "an inventory whose only entry did not pass leaves nothing run under the ruling");
  const failingOnMain = { ...evidence, testRuns: evidence.testRuns.map((row) => (row.path === TARGET ? { ...row, status: "main-preexisting", mainSha: "f".repeat(40) } : row)) };
  assert.match(gate(t, failingOnMain).join("\n"), new RegExp(`ruling ${RULING_ID} needs at least one targeted inventory test that passed`),
    "a test that also fails on main is not a passing run under the ruling");
});

test("AC-1: a diff-rule required test or a spec the branch edits is never left on a ruling row", (t) => {
  const evidence = ruledEvidence();
  assert.match(gate(t, evidence, RECORDED, { requiredTests: [{ path: SELECTED_ONLY, reason: "diff rule" }] }).join("\n"),
    new RegExp(`${SELECTED_ONLY}: selected but no passing`));
  const passedToo = { ...evidence, testRuns: [...evidence.testRuns, { path: SELECTED_ONLY, command: "vitest run other", status: "passed", commit: COMMIT }] };
  assert.match(gate(t, passedToo, RECORDED, { requiredTests: [{ path: SELECTED_ONLY, reason: "diff rule" }] }).join("\n"),
    new RegExp(`${SELECTED_ONLY}: selected test is absent from the targeted inventory`),
    "a required test with a passed row is still held to the inventory");
  const spec = "e2e/list.spec.ts";
  const edited = { ...evidence, testSelection: [...evidence.testSelection, { file: SOURCE, selector: "e2e-reference", tests: [spec] }],
    testRuns: [...evidence.testRuns, { path: spec, command: "pnpm e2e list", status: "not-run", ruling: RULING_ID, reason: "ruled", commit: COMMIT }] };
  const files = [...FILES, { path: spec, status: "M", hunks: [] }];
  assert.match(gate(t, edited, RECORDED, { candidateFiles: files }).join("\n"), new RegExp(`${spec}: selected but no passing`));
});

test("AC-1: only the web and Desktop host lanes may be left; touch-flow, Storybook and e2e lanes still run", () => {
  const evidence = ruledEvidence();
  const ruled = { status: "not-run", ruling: RULING_ID, reason: "ruled", commit: COMMIT, command: "run" };
  const touched = { ...evidence, touchFlows: ["card select"],
    runs: [...evidence.runs, { lane: "webkit-iphone", ...ruled }, { lane: "chromium-pixel", ...ruled }] };
  const problems = evidenceProblems(touched, [SOURCE], COMMIT, undefined, RULING_ID).join("\n");
  assert.match(problems, /webkit-iphone: not-run/);
  assert.match(problems, /chromium-pixel: not-run/);
  assert.doesNotMatch(problems, /web-host|desktop-host/);
  const story = "packages/app/list.stories.tsx";
  const spec = "e2e/list.spec.ts";
  const lanes = { ...evidence, runs: [...evidence.runs, { lane: "storybook-plays", ...ruled }, { lane: "e2e", ...ruled }] };
  const others = evidenceProblems(lanes, [SOURCE, story, spec], COMMIT, undefined, RULING_ID).join("\n");
  assert.match(others, /storybook-plays: not-run/);
  assert.match(others, /e2e: not-run/);
  assert.deepEqual(evidenceProblems(evidence, [SOURCE], COMMIT, undefined, RULING_ID), []);
});

test("AC-1: the PR evidence comment names the ruling and what it left not run", (t) => {
  const receiptDir = mkdtempSync(path.join(tmpdir(), "ruling-comment-"));
  t.after(() => rmSync(receiptDir, { recursive: true, force: true }));
  const comment = renderEvidenceComment(ruledEvidence(), undefined, { candidateFiles: FILES, receiptDir, rulingsText: RULINGS });
  const line = comment.split("\n").find((text) => text.startsWith(`Not run under targeted-tests ruling ${RULING_ID} (rulings):`));
  assert.ok(line, comment);
  for (const item of [SELECTED_ONLY, LANE.name, "web-host", "desktop-host"]) assert.ok(line.includes(`\`${item}\``), item);
  assert.ok(comment.includes(`\`${TARGET}\``) && comment.includes(`passed at \`${COMMIT}\``), "the targeted run is still listed as passed");
  assert.throws(() => renderEvidenceComment(ruledEvidence(), undefined, { candidateFiles: FILES, receiptDir }), /pass the rulings file with --rulings/);
});
