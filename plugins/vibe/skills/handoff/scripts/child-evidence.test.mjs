import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkChildEvidence, parseAddedLines, readFacts } from "./child-evidence.mjs";
import { git, makeCheckout, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "child-evidence.mjs");
const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const PULL = "https://github.com/closedloop-ai/symphony-alpha/pull/8947";

function fixture(t) {
  const home = makeHome("vibe-child-evidence-");
  t.after(home.cleanup);
  const checkout = path.join(home.root, "wt");
  makeCheckout({ ...home, checkout, files: { "apps/app/board.tsx": "one\ntwo\nthree\n", ".gitignore": "ledger.local.md\n" } });
  const base = git(checkout, ["rev-parse", "HEAD"], home.home);
  writeFileSync(path.join(checkout, "apps/app/board.tsx"), "one\ntwo changed\nthree\nfour\n");
  mkdirSync(path.join(checkout, "docs"), { recursive: true });
  writeFileSync(path.join(checkout, "docs/ledger.md"), "row\n");
  writeFileSync(path.join(checkout, "ledger.local.md"), "row\n");
  git(checkout, ["add", "-A"], home.home);
  git(checkout, ["commit", "--quiet", "-m", "feature"], home.home);
  const head = git(checkout, ["rev-parse", "HEAD"], home.home);
  return { home, checkout, base, head, facts: readFacts(checkout, base, { now: NOW, liveTicket: "ISS-12000", livePlan: "PLN-900", operator: "op@example.com" }) };
}

function delivered(items, extra = {}) {
  return { slug: "ISS-9393", classification: "delivered", items, ...extra };
}

const MET_DIFF = { id: "AC-1", text: "Cards regroup by drag", result: "met", evidence: [{ kind: "diff", path: "apps/app/board.tsx", line: 2 }] };

test("a delivered child with every item evidenced on changed lines may move to IN_REVIEW", (t) => {
  const { facts } = fixture(t);
  const result = checkChildEvidence({ reviewer: "vibe-adversarial-reviewer", children: [delivered([MET_DIFF])] }, facts);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.inReview, ["ISS-9393"]);
});

test("the writer's own audit never moves a child", (t) => {
  const { facts } = fixture(t);
  for (const reviewer of ["vibe-change-worker", "", undefined]) {
    const result = checkChildEvidence({ reviewer, children: [delivered([MET_DIFF])] }, facts);
    assert.equal(result.ok, false, String(reviewer));
  }
});

test("a pending design review or device run blocks the claim even when other items are met", (t) => {
  const { facts } = fixture(t);
  const pending = { id: "WI-2", text: "Design review signed off", result: "not met yet", evidence: [] };
  const result = checkChildEvidence({ reviewer: "vibe-adversarial-reviewer", children: [delivered([MET_DIFF, pending])] }, facts);
  assert.equal(result.ok, false);
  assert.deepEqual(result.inReview, []);
  assert.ok(result.problems.some((problem) => problem.item === "WI-2"));
  const running = { ...MET_DIFF, id: "AC-3", evidence: [{ kind: "report", url: "https://example.invalid/run", commit: facts.head, status: "running" }] };
  assert.equal(checkChildEvidence({ reviewer: "r", children: [delivered([running])] }, facts).ok, false);
});

test("diff evidence must cite an added or changed line of a file this branch changed", (t) => {
  const { facts } = fixture(t);
  const cases = [
    { kind: "diff", path: "apps/app/board.tsx", line: 1 },
    { kind: "diff", path: "README.md", line: 1 },
    { kind: "diff", path: "apps/app/board.tsx" },
  ];
  for (const evidence of cases) {
    const result = checkChildEvidence({ reviewer: "r", children: [delivered([{ ...MET_DIFF, evidence: [evidence] }])] }, facts);
    assert.equal(result.ok, false, JSON.stringify(evidence));
  }
  const added = checkChildEvidence({ reviewer: "r", children: [delivered([{ ...MET_DIFF, evidence: [{ kind: "diff", path: "apps/app/board.tsx", line: 4 }] }])] }, facts);
  assert.equal(added.ok, true);
});

test("a ledger or artifact must be a tracked path in the diff, never a gitignored local file", (t) => {
  const { facts } = fixture(t);
  const tracked = { ...MET_DIFF, evidence: [{ kind: "tracked", path: "docs/ledger.md" }] };
  assert.equal(checkChildEvidence({ reviewer: "r", children: [delivered([tracked])] }, facts).ok, true);
  for (const file of ["ledger.local.md", "README.md"]) {
    const item = { ...MET_DIFF, evidence: [{ kind: "tracked", path: file }] };
    assert.equal(checkChildEvidence({ reviewer: "r", children: [delivered([item])] }, facts).ok, false, file);
  }
});

test("every evidence path the child names must carry an item's evidence", (t) => {
  const { facts } = fixture(t);
  const result = checkChildEvidence({ reviewer: "r", children: [delivered([MET_DIFF], { namedEvidencePaths: ["docs/ledger.md"] })] }, facts);
  assert.equal(result.ok, false);
  assert.match(result.problems[0].problem, /docs\/ledger\.md/);
});

test("delivered on main needs a merged pull request whose merge commit is in history", (t) => {
  const { facts, base } = fixture(t);
  const onMain = { ...MET_DIFF, evidence: [{ kind: "merged-pr", url: PULL, commit: base }] };
  assert.equal(checkChildEvidence({ reviewer: "r", children: [delivered([onMain])] }, facts).ok, true);
  const unknown = { ...MET_DIFF, evidence: [{ kind: "merged-pr", url: PULL, commit: "a".repeat(40) }] };
  assert.equal(checkChildEvidence({ reviewer: "r", children: [delivered([unknown])] }, facts).ok, false);
  const bare = { ...MET_DIFF, evidence: [{ kind: "merged-pr", commit: base }] };
  assert.equal(checkChildEvidence({ reviewer: "r", children: [delivered([bare])] }, facts).ok, false);
});

test("a report counts only when it was produced on the final commit", (t) => {
  const { facts, base } = fixture(t);
  const current = { ...MET_DIFF, evidence: [{ kind: "report", url: "https://example.invalid/design", commit: facts.head }] };
  assert.equal(checkChildEvidence({ reviewer: "r", children: [delivered([current])] }, facts).ok, true);
  const stale = { ...MET_DIFF, evidence: [{ kind: "report", url: "https://example.invalid/design", commit: base }] };
  assert.equal(checkChildEvidence({ reviewer: "r", children: [delivered([stale])] }, facts).ok, false);
});

test("active elsewhere needs an open pull request, a recent branch commit or another owner's IN_PROGRESS", (t) => {
  const { facts } = fixture(t);
  const check = (activity) => checkChildEvidence({ reviewer: "r", children: [{ slug: "ISS-9500", classification: "active-elsewhere", activity }] }, facts);
  assert.equal(check({ pr: PULL, prState: "OPEN" }).ok, true);
  assert.equal(check({ branchCommitAt: "2026-10-18T00:00:00.000Z" }).ok, true);
  assert.equal(check({ ownerStatus: "IN_PROGRESS", owner: "someone@example.com" }).ok, true);
  assert.equal(check({ pr: PULL, prState: "CLOSED" }).ok, false);
  assert.equal(check({ branchCommitAt: "2026-10-01T00:00:00.000Z" }).ok, false);
  assert.equal(check({ ownerStatus: "TODO", owner: "someone@example.com" }).ok, false);
  assert.equal(check({ ownerStatus: "IN_PROGRESS", owner: "op@example.com" }).ok, false);
  assert.equal(check(undefined).ok, false);
});

test("a supersession needs a human ruling that is not the session's own ticket or plan", (t) => {
  const { facts } = fixture(t);
  const check = (ruling) => checkChildEvidence({ reviewer: "r", children: [{ slug: "ISS-9600", classification: "superseded", ruling }] }, facts);
  assert.equal(check({ by: "Product lead", where: "ISS-9600 comment 2026-10-12", quote: "Drop this, PRD-725 covers it." }).ok, true);
  assert.equal(check({ by: "agent", where: "ISS-12000 What this is", quote: "not reused" }).ok, false);
  assert.equal(check({ by: "agent", where: "PLN-900", quote: "superseded" }).ok, false);
  assert.equal(check({ by: "agent", where: "session decision table", quote: "superseded" }).ok, false);
  assert.equal(check({ by: "Product lead", where: "ISS-9600 comment" }).ok, false);
});

test("uncovered children are listed and never block", (t) => {
  const { facts } = fixture(t);
  const result = checkChildEvidence({ reviewer: "r", children: [{ slug: "ISS-9700", classification: "uncovered" }, { slug: "nope", classification: "uncovered" }] }, facts);
  assert.deepEqual(result.uncovered, ["ISS-9700"]);
  assert.equal(result.ok, false);
});

test("parseAddedLines reads new-side ranges, including single-line and pure-deletion hunks", () => {
  const lines = parseAddedLines([
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1 +1,2 @@",
    "@@ -9,2 +10 @@",
    "@@ -20,3 +21,0 @@",
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
  ].join("\n"));
  assert.deepEqual([...lines.get("x.ts")], [1, 2, 10]);
  assert.equal(lines.has("gone.ts"), false);
});

test("the CLI exits 1 with the problems and 0 with the slugs allowed to move", (t) => {
  const { home, checkout, base } = fixture(t);
  const good = path.join(home.root, "good.json");
  writeFileSync(good, JSON.stringify({ reviewer: "vibe-adversarial-reviewer", children: [delivered([MET_DIFF])] }));
  const passed = runNode(SCRIPT, ["--worktree", checkout, "--base", base, "--map", good], home.home);
  assert.equal(passed.status, 0);
  assert.deepEqual(passed.json.inReview, ["ISS-9393"]);
  const bad = path.join(home.root, "bad.json");
  writeFileSync(bad, JSON.stringify({ reviewer: "vibe-change-worker", children: [delivered([MET_DIFF])] }));
  const failed = runNode(SCRIPT, ["--worktree", checkout, "--base", base, "--map", bad], home.home);
  assert.equal(failed.status, 1);
  assert.equal(failed.json.ok, false);
});
