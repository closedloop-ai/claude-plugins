import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { assumptionsText, budgetReport, cardProblems, checkpointEnabled, auditSkeleton, lockedChangeProblems } from "./spec-card.mjs";
import { bindProviderInProcess } from "./test-fixtures.mjs";

// Tracker checks run only with a tracker bound, so these run bound to the provider this repository ships (spawned scripts inherit it).
bindProviderInProcess(after);

const SCRIPT = fileURLToPath(new URL("./spec-card.mjs", import.meta.url));
const OPTIONS = [{ label: "A", summary: "one end-to-end way" }, { label: "B", summary: "another end-to-end way" }];

function card(overrides = {}) {
  return {
    version: 1,
    criteria: [
      { id: "AC-1", text: "a row can be dragged", source: "ISS-1", evidence: "test" },
      { id: "AC-2", text: "a refused drop shows nothing", source: "ISS-1", evidence: "screenshot" },
    ],
    assumptions: [
      { id: "A-1", text: "the list owner is the grid", tag: "grounded", basis: "apps/app/grid.tsx read in this checkout", falsifiedBy: "another owner renders the rows" },
      { id: "A-2", text: "drops outside a group are refused", tag: "unverified", productImpacting: true, falsifiedBy: "the ticket's design shows a move" },
      { id: "A-3", text: "the helper is pure", tag: "unverified", productImpacting: false, falsifiedBy: "it reads the clock" },
    ],
    openQuestions: [{ id: "Q-1", kind: "assumption", assumption: "A-2", question: "refuse or move?", options: OPTIONS, recommendation: "A" }],
    plan: { summary: "smallest change", ownerFiles: ["apps/app/grid.tsx", "packages/app/lists/"], notTouched: [{ path: "apps/app/legacy.tsx", reason: "out of scope" }], justifications: [] },
    ...overrides,
  };
}

test("a valid locked card has no problems, and an unanswered product question would block", () => {
  const result = cardProblems(card(), "locked");
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.wouldBlock, ["Q-1"]);
});

test("an answered question no longer would block, and a technical fork is an engineering decision", () => {
  const answered = card({ openQuestions: [{ ...card().openQuestions[0], answer: { text: "refuse", source: "Dana, in chat" } }, { id: "Q-2", kind: "technical-fork", question: "poller or event?", options: OPTIONS, recommendation: "B" }] });
  const result = cardProblems(answered, "locked");
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.wouldBlock, []);
  assert.deepEqual(result.engineeringDecisions, ["Q-2"]);
});

test("the shape rules: tags, falsifiers, 2 to 3 options, a recommendation among them, evidence types", () => {
  const bad = card({
    criteria: [{ id: "x", text: "t", source: "s", evidence: "vibes" }],
    assumptions: [{ id: "A-1", text: "t", tag: "grounded", falsifiedBy: "" }, { id: "A-2", text: "t", tag: "unverified", falsifiedBy: "f" }],
    openQuestions: [{ id: "Q-1", kind: "product-fork", question: "q", options: [OPTIONS[0]], recommendation: "Z" }],
  });
  const text = cardProblems(bad).problems.join("\n");
  for (const expected of ["id must look like AC-1", "evidence must be one of", "A-1: name what would falsify it", "A-1: a grounded assumption needs a basis", "A-2: an unverified assumption needs productImpacting", "Q-1: needs 2 to 3 options", "Q-1: recommendation must name one of the options"]) {
    assert.ok(text.includes(expected), expected);
  }
});

test("an unverified product-impacting assumption needs a question; a non-product one never does", () => {
  const noQuestion = card({ openQuestions: [] });
  const unquestioned = cardProblems(noQuestion);
  assert.deepEqual(unquestioned.problems, []);
  assert.deepEqual(unquestioned.wouldBlock, ["A-2"]);
  const wrongTarget = card({ openQuestions: [{ ...card().openQuestions[0], assumption: "A-3" }] });
  assert.ok(cardProblems(wrongTarget).problems.some((problem) => problem.includes("only an unverified product-impacting assumption is a question")));
});

test("a card with no criteria is valid at draft and locked: nothing is invented to fill the list", () => {
  assert.deepEqual(cardProblems(card({ criteria: [] }), "draft").problems, []);
  assert.deepEqual(cardProblems(card({ criteria: [] }), "locked").problems, []);
  assert.deepEqual(cardProblems({ version: 1 }, "draft").problems, []);
});

test("save accepts an empty criteria list and an unquestioned product-impacting assumption with the checkpoint off", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spec-card-empty-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    const file = path.join(dir, "card.json");
    writeFileSync(file, JSON.stringify(card({ criteria: [], openQuestions: [] })));
    const env = { ...process.env };
    delete env.VIBE_FORK_CHECKPOINT;
    const saved = spawnSync("node", [SCRIPT, "save", "--worktree", dir, "--stage", "draft", file], { encoding: "utf8", env });
    assert.equal(saved.status, 0, saved.stdout + saved.stderr);
    const checked = spawnSync("node", [SCRIPT, "check", file], { encoding: "utf8", env });
    assert.equal(checked.status, 0, checked.stdout);
    assert.deepEqual(JSON.parse(checked.stdout).wouldBlock, ["A-2"]);
    const on = spawnSync("node", [SCRIPT, "check", file, "--checkpoint"], { encoding: "utf8", env });
    assert.equal(on.status, 1);
    assert.deepEqual(JSON.parse(on.stdout).blocking, ["A-2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fork checkpoint is off unless the flag or the environment switch turns it on", () => {
  assert.equal(checkpointEnabled(undefined, {}), false);
  assert.equal(checkpointEnabled(false, { VIBE_FORK_CHECKPOINT: "0" }), false);
  assert.equal(checkpointEnabled(true, {}), true);
  assert.equal(checkpointEnabled(undefined, { VIBE_FORK_CHECKPOINT: "1" }), true);
});

test("check exits 0 with the checkpoint off and 1 when it is on and a question is open", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spec-card-"));
  try {
    const file = path.join(dir, "card.json");
    writeFileSync(file, JSON.stringify(card()));
    const env = { ...process.env };
    delete env.VIBE_FORK_CHECKPOINT;
    const off = spawnSync("node", [SCRIPT, "check", file, "--stage", "locked"], { encoding: "utf8", env });
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(JSON.parse(off.stdout).blocking, []);
    assert.deepEqual(JSON.parse(off.stdout).wouldBlock, ["Q-1"]);
    const flag = spawnSync("node", [SCRIPT, "check", file, "--stage", "locked", "--checkpoint"], { encoding: "utf8", env });
    assert.equal(flag.status, 1);
    assert.deepEqual(JSON.parse(flag.stdout).blocking, ["Q-1"]);
    const viaEnv = spawnSync("node", [SCRIPT, "check", file, "--stage", "locked"], { encoding: "utf8", env: { ...env, VIBE_FORK_CHECKPOINT: "1" } });
    assert.equal(viaEnv.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the budget reports files outside the plan and never blocks, whatever their number", () => {
  const many = Array.from({ length: 40 }, (_, index) => `extra/file-${index}.ts`);
  const report = budgetReport(card(), ["apps/app/grid.tsx", "packages/app/lists/row.tsx", ".closedloop-ai/plan.md", ...many]);
  assert.equal(report.blocks, false);
  assert.equal(report.outsidePlan, 40);
  assert.equal(report.uncited.length, 40);
  assert.deepEqual(report.cited, []);
});

test("a file that cites a card criterion or a sourced requirement is cited; a citation of nothing is not", () => {
  const justified = card({ plan: { ...card().plan, justifications: [
    { path: "extra/a.ts", cites: "AC-2" },
    { path: "extra/b.ts", requirement: "rollback must be one flag", source: "PRD-9" },
    { path: "extra/c.ts", cites: "AC-99" },
    { path: "extra/d.ts", requirement: "no source" },
  ] } });
  const report = budgetReport(justified, ["extra/a.ts", "extra/b.ts", "extra/c.ts", "extra/d.ts"]);
  assert.deepEqual(report.cited.map((entry) => [entry.path, entry.cites]), [["extra/a.ts", "AC-2"], ["extra/b.ts", "PRD-9"]]);
  assert.deepEqual(report.uncited, ["extra/c.ts", "extra/d.ts"]);
  assert.equal(report.blocks, false);
  assert.ok(cardProblems(justified, "locked").problems.some((problem) => problem.includes("extra/c.ts cites neither")));
});

test("the handoff assumptions text is generated from the card and lists uncited extras", () => {
  const withAnswer = card({ openQuestions: [{ ...card().openQuestions[0], answer: { text: "refuse", source: "Dana, in chat" } }] });
  const text = assumptionsText(withAnswer, budgetReport(withAnswer, ["extra/a.ts"]));
  assert.match(text, /Grounded:\n- A-1: the list owner is the grid; basis: apps\/app\/grid\.tsx read in this checkout; falsified by: another owner renders the rows/);
  assert.match(text, /Unverified:\n- A-2: drops outside a group are refused; product-impacting; falsified by: /);
  assert.match(text, /Answered before code:\n- Q-1: refuse or move\? -> refuse \(Dana, in chat\)/);
  assert.match(text, /Deliberately not changed:\n- apps\/app\/legacy\.tsx: out of scope/);
  assert.match(text, /nothing cited:\n- extra\/a\.ts/);
  assert.match(assumptionsText(card()), /Answered before code:\n- None/);
});

test("the handoff text lists unanswered product questions, including a product fork with no assumption behind it", () => {
  const fork = { id: "Q-2", kind: "product-fork", question: "inline or modal?", options: OPTIONS, recommendation: "B" };
  const text = assumptionsText(card({ openQuestions: [card().openQuestions[0], fork, { ...fork, id: "Q-3", kind: "technical-fork" }] }));
  assert.match(text, /Not answered before code:\n- Q-1: refuse or move\?; recommended: A\n- Q-2: inline or modal\?; recommended: B\n/);
  assert.ok(!text.includes("Q-3"));
  assert.match(assumptionsText(card({ openQuestions: [] })), /Not answered before code:\n- None/);
});

test("the audit skeleton has one row per criterion in the audit's row format, numbered by position", () => {
  assert.equal(auditSkeleton(card()), "| Criterion | Verdict | Type | Ref |\n|---|---|---|---|\n| AC-1 | VERDICT | test | REF |\n| AC-2 | VERDICT | screenshot | REF |\n");
  const reordered = card({ criteria: [card().criteria[0], { id: "AC-3", text: "a third thing", source: "ISS-1", evidence: "api-read" }] });
  assert.match(auditSkeleton(reordered), /\| AC-2 \| VERDICT \| api-read \| REF \|/);
});

test("a locked card is not edited after it seeds the decision table; an identical save is not an edit", () => {
  const before = card();
  const edited = card({ criteria: [{ ...before.criteria[0], text: "reworded to agree with the code" }, before.criteria[1]] });
  assert.deepEqual(lockedChangeProblems(before, edited), ["a locked card is not edited after it seeds the decision table; change criteria in the decision table"]);
  assert.equal(lockedChangeProblems(before, card({ criteria: [before.criteria[0]] })).length, 1);
  assert.equal(lockedChangeProblems(before, { ...card(), assumptions: [] }).length, 1);
  assert.deepEqual(lockedChangeProblems({ ...before, stage: "locked" }, card()), []);
});

test("a card carrying a superseded list is a problem: criteria change in the decision table", () => {
  assert.match(cardProblems(card({ superseded: [{ id: "AC-1", source: "Dana, in chat" }] })).problems.join(), /superseded is not part of the card/);
});

test("save writes the card into the git dir and refuses to edit a locked one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spec-card-wt-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    const file = path.join(dir, "card.json");
    const run = (stage, value) => {
      writeFileSync(file, JSON.stringify(value));
      return spawnSync("node", [SCRIPT, "save", "--worktree", dir, "--stage", stage, file], { encoding: "utf8" });
    };
    const locked = run("locked", card());
    assert.equal(locked.status, 0, locked.stdout + locked.stderr);
    const saved = JSON.parse(readFileSync(JSON.parse(locked.stdout).path, "utf8"));
    assert.equal(saved.stage, "locked");
    const reworded = card({ criteria: [{ ...card().criteria[0], text: "changed" }, card().criteria[1]] });
    const refused = run("locked", reworded);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /not edited after it seeds the decision table/);
    assert.equal(run("locked", card()).status, 0, "an identical save is accepted");
    assert.equal(run("draft", card()).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("budget over a real diff reports the uncited files and exits 0", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spec-card-diff-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.email=a@b.c", "-c", "user.name=t", ...args], { encoding: "utf8" });
    git("init", "-q");
    writeFileSync(path.join(dir, "a.txt"), "1");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(path.join(dir, "a.txt"), "2");
    writeFileSync(path.join(dir, "new.txt"), "x");
    const cardFile = path.join(dir, "..", `card-${path.basename(dir)}.json`);
    writeFileSync(cardFile, JSON.stringify(card({ plan: { ...card().plan, ownerFiles: ["a.txt"] } })));
    const result = spawnSync("node", [SCRIPT, "budget", "--card", cardFile, "--worktree", dir, "--base", base], { encoding: "utf8" });
    rmSync(cardFile, { force: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).uncited, ["new.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
