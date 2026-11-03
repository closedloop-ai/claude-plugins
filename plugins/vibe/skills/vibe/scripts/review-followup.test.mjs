import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { followupTitle, planFollowup } from "./review-followup.mjs";
import { git, makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "review-followup.mjs");
const ROUND_TWO = [{ thread: "https://example.test/o/r/pull/9118#discussion_r1", finding: "Sort ties by id" }];
const ROUND_THREE = [{ thread: "https://example.test/o/r/pull/9118#discussion_r7", finding: "Keep focus after a move" }];

test("later rounds append to the pull request's one follow-up ticket, found by title or recorded", () => {
  const title = followupTitle("ISS-1", 9118);
  assert.equal(title, "ISS-1: follow-ups from #9118 review");
  assert.deepEqual(planFollowup({ pr: 9118, prTicket: "ISS-1", findings: ROUND_TWO }), {
    action: "create", title, criteria: ["- [ ] Sort ties by id (review thread: https://example.test/o/r/pull/9118#discussion_r1)"],
  });
  assert.equal(planFollowup({ recorded: "ISS-2", pr: 9118, prTicket: "ISS-1", findings: ROUND_THREE }).action, "append");
  assert.deepEqual(planFollowup({ found: [{ slug: "ISS-2", title }, { slug: "ISS-3", title: "other" }], pr: 9118, prTicket: "ISS-1", findings: ROUND_THREE }).slug, "ISS-2");
  assert.throws(() => planFollowup({ found: [{ slug: "ISS-2", title }, { slug: "ISS-4", title }], pr: 9118, prTicket: "ISS-1", findings: ROUND_THREE }), /keep one/);
  assert.throws(() => planFollowup({ pr: 9118, prTicket: "ISS-1", findings: [] }), /no valid findings/);
});

test("a second later round reuses the recorded ticket and a second ticket is refused", (t) => {
  const { root, home, cleanup } = makeHome("vibe-review-followup-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  const findings = path.join(root, "findings.json");
  writeFileSync(findings, JSON.stringify(ROUND_TWO));
  const base = ["plan", "--worktree", worktree, "--pr", "9118", "--pr-ticket", "ISS-1", "--findings", findings];
  const retired = runNode(SCRIPT, base, home);
  assert.equal(retired.status, 1, "after core work the single round is retired: no follow-up ticket without the ruling in force");
  assert.match(retired.json.error, /--single-review-ruling/);
  const plan = (...extra) => runNode(SCRIPT, [...base, "--single-review-ruling", "operator, 2026-10-22, program rulings", ...extra], home);
  assert.equal(plan().json.action, "create");
  assert.equal(runNode(SCRIPT, ["record", "--worktree", worktree, "--pr", "9118", "--slug", "ISS-2"], home).status, 0);
  writeFileSync(findings, JSON.stringify(ROUND_THREE));
  const third = plan();
  assert.equal(third.json.action, "append");
  assert.equal(third.json.slug, "ISS-2");
  const second = runNode(SCRIPT, ["record", "--worktree", worktree, "--pr", "9118", "--slug", "ISS-5"], home);
  assert.equal(second.status, 1);
  assert.match(second.json.error, /already has its follow-up ticket ISS-2; append to it/);
  assert.equal(runNode(SCRIPT, ["record", "--worktree", worktree, "--pr", "9118", "--slug", "ISS-2"], home).status, 0, "recording the same ticket again is harmless");
});
