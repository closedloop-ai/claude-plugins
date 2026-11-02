import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assumptionsText, budgetReport, cardProblems, checkpointEnabled, evidenceSkeleton, lockedChangeProblems } from "./spec-card.mjs";

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
  assert.deepEqual(cardProblems(noQuestion).problems, ["A-2: an unverified product-impacting assumption needs an open question with options and a recommendation"]);
  const wrongTarget = card({ openQuestions: [{ ...card().openQuestions[0], assumption: "A-3" }] });
  assert.ok(cardProblems(wrongTarget).problems.some((problem) => problem.includes("only an unverified product-impacting assumption is a question")));
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

test("the evidence skeleton has one row per criterion with unknown values left null", () => {
  assert.deepEqual(evidenceSkeleton(card()), { rows: [{ criterion: "AC-1", type: "test", ref: null, verdict: null }, { criterion: "AC-2", type: "screenshot", ref: null, verdict: null }] });
});

test("a locked card changes only through a superseded entry that names a source", () => {
  const before = card();
  const edited = card({ criteria: [{ ...before.criteria[0], text: "reworded to agree with the code" }, before.criteria[1]] });
  assert.deepEqual(lockedChangeProblems(before, edited), ["AC-1: the locked criterion was changed with no superseded entry naming a source"]);
  assert.deepEqual(lockedChangeProblems(before, { ...edited, superseded: [{ id: "AC-1", source: "Dana, 2026-10-28" }] }), []);
  assert.deepEqual(lockedChangeProblems(before, { ...edited, superseded: [{ id: "AC-1" }] }).length, 1);
  assert.deepEqual(lockedChangeProblems(before, card({ criteria: [before.criteria[0]] })), ["AC-2: the locked criterion was removed with no superseded entry naming a source"]);
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
    assert.match(refused.stdout, /no superseded entry/);
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
