import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { askQuestion } from "./session-questions.mjs";
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
  questions(home, ["ask", "--key", "sample-data", "--question", "Start with example data?"]);
  assert.equal(questions(home, ["reset"]).json.ok, true);
  assert.equal(questions(home, ["ask", "--key", "sample-data", "--question", "Start with example data?"]).json.ask, true);
  const refused = questions(home, ["reset", "--worktree", home]);
  assert.equal(refused.status, 1);
});

test("an answer needs a recorded question and keys stay plain identifiers", () => {
  assert.throws(() => askQuestion([], { key: "Page Wording", question: WORDING }), /--key/);
  assert.throws(() => askQuestion([], { key: "page-wording", question: " " }), /--question/);
  const { questions: recorded } = askQuestion([], { key: "page-wording", question: WORDING, now: "2026-10-15T00:00:00.000Z" });
  assert.deepEqual(recorded, [{ key: "page-wording", question: WORDING, askedAt: "2026-10-15T00:00:00.000Z",
    answer: null, answeredAt: null }]);
});

test("a product question is refused until it cites the code or data model checked first", () => {
  assert.throws(() => askQuestion([], { key: "bulk-owner", question: "Can owners change in bulk?", product: true }), /--code-evidence/);
  const { questions } = askQuestion([], {
    key: "bulk-owner", question: "Can owners change in bulk?", product: true, codeEvidence: "packages/branches/schema.ts:42",
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
