import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkChildEvidence, parseAddedLines, readFacts } from "./live-ticket-check.mjs";
import { git, makeCheckout, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "live-ticket-check.mjs");
const PULL = "https://github.com/closedloop-ai/symphony-alpha/pull/8947";
const MET = { id: "AC-1", text: "Cards regroup by drag", result: "met", evidence: [{ kind: "diff", path: "apps/app/board.tsx", line: 2 }] };

function fixture(t) {
  const home = makeHome("vibe-live-ticket-children-");
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
  const facts = readFacts(checkout, base, { now: Date.parse("2026-10-20T12:00:00Z"), liveTicket: "ISS-12000", livePlan: "PLN-900", operator: "op@example.com" });
  const check = (children, reviewer = "vibe-ticket-worker", pullRequest = PULL) => checkChildEvidence({ reviewer, pullRequest, children }, facts);
  const delivered = (...evidence) => check([{ slug: "ISS-9393", classification: "delivered", items: [{ ...MET, evidence }] }]);
  return { home, checkout, base, facts, check, delivered };
}

test("a delivered child moves only when every item is met with verifiable evidence", (t) => {
  const { check, delivered, facts, base } = fixture(t);
  assert.deepEqual(delivered(MET.evidence[0]).inReview, ["ISS-9393"]);
  assert.equal(check([{ slug: "ISS-9393", classification: "delivered", items: [MET] }], "vibe-change-worker").ok, false);
  const pending = { id: "WI-2", text: "Design review signed off", result: "not met yet", evidence: [] };
  assert.deepEqual(check([{ slug: "ISS-9393", classification: "delivered", items: [MET, pending] }]).inReview, []);
  const named = check([{ slug: "ISS-9393", classification: "delivered", items: [MET], namedEvidencePaths: ["docs/ledger.md"] }]);
  assert.match(named.problems[0].problem, /docs\/ledger\.md/);
  const passes = [
    { kind: "diff", path: "apps/app/board.tsx", line: 4 },
    { kind: "tracked", path: "docs/ledger.md" },
    { kind: "merged-pr", url: PULL, commit: base },
    { kind: "report", url: "https://example.invalid/design", commit: facts.head },
  ];
  for (const evidence of passes) assert.equal(delivered(evidence).ok, true, JSON.stringify(evidence));
  const fails = [
    { kind: "diff", path: "apps/app/board.tsx", line: 1 },
    { kind: "diff", path: "README.md", line: 1 },
    { kind: "tracked", path: "ledger.local.md" },
    { kind: "merged-pr", url: PULL, commit: "a".repeat(40) },
    { kind: "report", url: "https://example.invalid/design", commit: base },
    { kind: "report", url: "https://example.invalid/run", commit: facts.head, status: "running" },
  ];
  for (const evidence of fails) assert.equal(delivered(evidence).ok, false, JSON.stringify(evidence));
});

test("a delivered child moves to IN_REVIEW only with the pull request that delivers it (PRD-729)", (t) => {
  const { check } = fixture(t);
  const children = [{ slug: "ISS-9393", classification: "delivered", items: [MET] }];
  for (const pullRequest of [null, "", "https://example.invalid/pull/1"]) {
    const result = check(children, "vibe-ticket-worker", pullRequest);
    assert.equal(result.ok, true);
    assert.deepEqual([result.inReview, result.awaitingPullRequest], [[], ["ISS-9393"]], String(pullRequest));
  }
  assert.deepEqual(check(children).inReview, ["ISS-9393"]);
});

test("active elsewhere needs real activity and a supersession needs a human ruling outside the session", (t) => {
  const { check } = fixture(t);
  const active = (activity) => check([{ slug: "ISS-9500", classification: "active-elsewhere", activity }]).ok;
  assert.equal(active({ pr: PULL, prState: "OPEN" }), true);
  assert.equal(active({ branchCommitAt: "2026-10-18T00:00:00Z" }), true);
  assert.equal(active({ ownerStatus: "IN_PROGRESS", owner: "someone@example.com" }), true);
  for (const activity of [{ pr: PULL, prState: "CLOSED" }, { branchCommitAt: "2026-10-01T00:00:00Z" }, { ownerStatus: "IN_PROGRESS", owner: "op@example.com" }, undefined]) {
    assert.equal(active(activity), false, JSON.stringify(activity));
  }
  const superseded = (ruling) => check([{ slug: "ISS-9600", classification: "superseded", ruling }]).ok;
  assert.equal(superseded({ by: "Product lead", where: "ISS-9600 comment", quote: "Drop this." }), true);
  for (const where of ["ISS-12000 What this is", "PLN-900", "session decision table"]) {
    assert.equal(superseded({ by: "agent", where, quote: "not reused" }), false, where);
  }
  assert.deepEqual(check([{ slug: "ISS-9700", classification: "uncovered" }]).uncovered, ["ISS-9700"]);
});

test("parseAddedLines reads new-side ranges and skips deleted files", () => {
  const lines = parseAddedLines(["+++ b/x.ts", "@@ -1 +1,2 @@", "@@ -9,2 +10 @@", "@@ -20,3 +21,0 @@", "+++ /dev/null", "@@ -1,2 +0,0 @@"].join("\n"));
  assert.deepEqual([...lines.get("x.ts")], [1, 2, 10]);
  assert.equal(lines.size, 1);
});

test("the CLI reports the children gate beside the ticket check", (t) => {
  const { home, checkout, base } = fixture(t);
  const ticket = path.join(home.root, "ticket.md");
  writeFileSync(ticket, "## What this is\nFixture.\n");
  const map = (reviewer) => {
    const file = path.join(home.root, `${reviewer}.json`);
    writeFileSync(file, JSON.stringify({ reviewer, pullRequest: PULL, children: [{ slug: "ISS-9393", classification: "delivered", items: [MET] }] }));
    return ["--file", ticket, "--worktree", checkout, "--base-commit", base, "--child-evidence", file];
  };
  assert.deepEqual(runNode(SCRIPT, map("vibe-ticket-worker"), home.home).json.children.inReview, ["ISS-9393"]);
  const failed = runNode(SCRIPT, map("vibe-change-worker"), home.home);
  assert.equal(failed.status, 1);
  assert.equal(failed.json.children.ok, false);
});
