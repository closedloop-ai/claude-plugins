import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { askQuestion, asksLeaveForInScopeWork, waitsForPerson } from "./session-questions.mjs";
import { makeCheckout, makeHome, mainSyncRecipeFiles, runNode } from "./test-fixtures.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const QUESTIONS = path.join(DIR, "session-questions.mjs");
const SESSIONS = path.join(DIR, "vibe-sessions.mjs");
const OPERATOR_ARGS = ["--operator-id", "user-operator", "--operator-email", "operator@example.com"];
const WORDING = "What should the page say?";

function setup(t) {
  const fixture = makeHome("vibe-questions-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, "Source", "symphony-alpha");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout, files: mainSyncRecipeFiles() });
  const dir = path.join(fixture.home, ".codex", "vibe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), `${JSON.stringify({ repo: checkout })}\n`);
  return { ...fixture, checkout };
}

function questions(home, args) {
  return runNode(QUESTIONS, args, home);
}

test("a question already asked is never asked again, answered or still waiting", (t) => {
  const { home } = setup(t);
  const first = questions(home, ["ask", "--key", "page-wording", "--question", WORDING]);
  assert.equal(first.json.ask, true);
  const repeat = questions(home, ["ask", "--key", "page-wording", "--question", "Keep today's words, or new text?"]);
  assert.equal(repeat.json.ask, false);
  assert.equal(repeat.json.question, WORDING);
  assert.equal(repeat.json.answer, null);
  const answered = questions(home, ["answer", "--key", "page-wording", "--answer", "Use the words from the screenshot"]);
  assert.equal(answered.json.ok, true);
  const later = questions(home, ["ask", "--key", "page-wording", "--question", WORDING]);
  assert.equal(later.json.ask, false);
  assert.equal(later.json.answer, "Use the words from the screenshot");
  assert.equal(questions(home, ["list"]).json.questions.length, 1);
});

test("questions asked before the session exists move onto the new session and survive a relaunch", (t) => {
  const { home } = setup(t);
  questions(home, ["ask", "--key", "page-wording", "--question", WORDING]);
  questions(home, ["answer", "--key", "page-wording", "--answer", "Docker's words"]);
  const created = runNode(SESSIONS, ["new", "--slug", "handoff-page", "--summary", "Redesign the page", "--mode", "seeded",
    ...OPERATOR_ARGS], home);
  assert.equal(created.json.ok, true, created.json.error);
  const worktree = created.json.session.worktree;
  assert.equal(created.json.session.questions[0].answer, "Docker's words");
  assert.equal(existsSync(path.join(home, ".codex", "vibe", "startup-questions.json")), false);
  // A fresh process, as after a relaunch or a resumed conversation, still knows the answer.
  const again = questions(home, ["ask", "--worktree", worktree, "--key", "page-wording", "--question", WORDING]);
  assert.equal(again.json.ask, false);
  assert.equal(again.json.answer, "Docker's words");
  const shown = runNode(SESSIONS, ["show", "--worktree", worktree], home);
  assert.equal(shown.json.session.questions.length, 1);
  const newOne = questions(home, ["ask", "--worktree", worktree, "--key", "button-label", "--question", "What should the button say?"]);
  assert.equal(newOne.json.ask, true);
});

test("reset clears only the questions kept before a session exists", (t) => {
  const { home } = setup(t);
  const sample = ["ask", "--key", "sample-data", "--question", "Start with example data?", "--default", "start with example data", "--deadline-minutes", "30"];
  questions(home, sample);
  assert.equal(questions(home, ["reset"]).json.ok, true);
  assert.equal(questions(home, sample).json.ask, true);
  const refused = questions(home, ["reset", "--worktree", home]);
  assert.equal(refused.status, 1);
});

test("an answer needs a recorded question and keys stay plain identifiers", () => {
  assert.throws(() => askQuestion([], { key: "Page Wording", question: WORDING }), /--key/);
  assert.throws(() => askQuestion([], { key: "page-wording", question: " " }), /--question/);
  const { questions: recorded } = askQuestion([], { key: "page-wording", question: WORDING, now: "2026-10-15T00:00:00.000Z" });
  assert.deepEqual(recorded, [{ key: "page-wording", question: WORDING, waitsForPerson: true, askedAt: "2026-10-15T00:00:00.000Z",
    answer: null, answeredAt: null }]);
});

test("a product question is refused until it cites the code or data model checked first", () => {
  const fallback = { fallback: "allow it, as the schema does", deadlineMinutes: "30" };
  assert.throws(() => askQuestion([], { key: "bulk-owner", question: "Can owners change in bulk?", product: true, ...fallback }), /--code-evidence/);
  const { questions } = askQuestion([], {
    key: "bulk-owner", question: "Can owners change in bulk?", product: true, codeEvidence: "packages/branches/schema.ts:42", ...fallback,
  });
  assert.equal(questions[0].product, true);
  assert.equal(questions[0].codeEvidence, "packages/branches/schema.ts:42");
});

test("answering an unrecorded question is refused", (t) => {
  const { home } = setup(t);
  const result = questions(home, ["answer", "--key", "button-label", "--answer", "Proceed"]);
  assert.equal(result.status, 1);
  assert.match(result.json.error, /record it with ask first/);
});

test("permission to do in-scope engineering work is refused; flags, product calls, destruction and credentials still wait", () => {
  const goAhead = [
    "May I update the two other test files my change broke?",
    "Pending authorization to repair five stale Desktop tests; OK to proceed?",
    "Should I merge main now or hold the push for the other PR?",
    "Do I have approval to rerun the failing check?",
  ];
  for (const question of goAhead) {
    assert.equal(asksLeaveForInScopeWork(question), true, question);
    assert.throws(() => askQuestion([], { key: "go-ahead", question }), /in-scope work never waits for authorization/);
  }
  const waits = [
    "May I add the new feature flag key for this screen?",
    "Should I delete the old branch and discard its stash?",
    "Can owners change in bulk?",
    "Which wording should the empty state use?",
    "May I sign in to the preview with your account?",
    "Should I skip the tests for the two tickets the plan calls out of scope?",
  ];
  for (const question of waits) assert.equal(asksLeaveForInScopeWork(question), false, question);
  assert.equal(askQuestion([], { key: "flag-key", question: waits[0] }).result.ask, true);
});

test("a question carries a default and a deadline, except flag, copy, destructive, credential and scope questions (7 quiet hours)", (t) => {
  const sort = "Sort the board by rank or by updated time?";
  assert.equal(waitsForPerson(sort), false);
  assert.throws(() => askQuestion([], { key: "board-sort", question: sort }), /--default .* --deadline-minutes/);
  assert.throws(() => askQuestion([], { key: "board-sort", question: sort, fallback: "rank", deadlineMinutes: "0" }), /--deadline-minutes/);
  assert.throws(() => askQuestion([], { key: "board-sort", question: sort, fallback: "rank", deadlineMinutes: "31" }), /--deadline-minutes <1 to 30>/, "a default applies within 30 minutes");
  const { result } = askQuestion([], { key: "board-sort", question: sort, fallback: "sort by rank, as the shipped list does", deadlineMinutes: "30", now: "2026-10-22T05:45:00.000Z" });
  assert.equal(result.deadlineAt, "2026-10-22T06:15:00.000Z");
  assert.equal(result.ifNoAnswer, "If no answer by 2026-10-22T06:15:00.000Z: sort by rank, as the shipped list does");
  for (const question of ["May I add the new feature flag key for this screen?", "Add the new feature switch `branches-list-v2`?", "Which wording should the empty state use?", "Should I delete the old branch?", "Should I skip the two tickets?"]) {
    assert.equal(waitsForPerson(question), true, question);
    const waiting = askQuestion([], { key: "waits", question }).result;
    assert.equal(waiting.waitsForPerson, true);
    assert.equal(waiting.ifNoAnswer, undefined, "no default is applied without the person");
  }
  const { home } = setup(t);
  const cli = questions(home, ["ask", "--key", "board-sort", "--question", sort, "--default", "rank", "--deadline-minutes", "20"]);
  assert.equal(cli.json.ok, true);
  assert.match(cli.json.ifNoAnswer, /^If no answer by \S+Z: rank$/);
  assert.equal(questions(home, ["ask", "--key", "other", "--question", sort]).status, 1);
});

test("a question never holds a pull request (#9118)", () => {
  const fallback = { fallback: "rank", deadlineMinutes: "30" };
  for (const question of [
    "Sort by rank or updated? Holding auto-merge on #9118 pending your answer.",
    "Rank or updated? I'm keeping the PR on hold until you answer.",
    "Rank or updated? We should hold the PR until you pick the sort.",
  ]) {
    assert.throws(() => askQuestion([], { key: "board-sort", question, ...fallback }), /never holds a pull request/, question);
  }
  assert.equal(askQuestion([], { key: "board-sort", question: "Sort by rank or updated? The PR ships with rank; the other order is a follow-up.", ...fallback }).result.ask, true);
});
