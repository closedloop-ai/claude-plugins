import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { rolloutProblems, rolloutRequirements } from "./rollout-gate.mjs";
import { criteriaChangeProblems, rulingNamesScope } from "./rulings-check.mjs";
import { git, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "rollout-gate.mjs");
// Shaped like PRD-729: a closed-by-default flag, the legacy list kept as a rollback path, and a staged rollout.
const TICKET = [
  "- Acceptance criteria:",
  "  - [ ] Branches v2 renders behind the closed-by-default flag branches-v2",
  "  - [ ] The legacy Branches list stays as the rollback path until parity",
  "  - [ ] Rows sort by updated time",
  "",
].join("\n");
const PRD = ["# PRD", "", "## Rollout", "", "- Staged cohort rollout with stop conditions", "", "## Problem", "", "- Slow lists", ""].join("\n");

test("rollout, flag and rollback requirements come from the ticket criteria and the PRD's rollout section", () => {
  assert.deepEqual(rolloutRequirements(TICKET, PRD).map(({ id }) => id), ["AC-1", "AC-2", "PRD-1"]);
  assert.deepEqual(rolloutRequirements("- Acceptance criteria:\n  - [ ] Rows sort by updated time\n"), []);
});

test("each rollout requirement needs code at HEAD that does it, or a human ruling naming this ticket or PRD (PRD-729)", () => {
  const head = { "packages/app/branches/list.tsx": ["export const List = () => {", "  const on = useFeatureFlag(BRANCHES_V2);", "  return on ? <V2 /> : <Legacy />;", "};"] };
  const lineAt = (file, line) => head[file]?.[line - 1] ?? null;
  const requirements = rolloutRequirements(TICKET, PRD);
  const scope = ["ISS-9394", "PRD-729"];
  const problems = (log) => rolloutProblems(requirements, log, { lineAt }, scope);
  assert.equal(problems("").length, 3, "the shipped-ungated diff: nothing recorded");
  const done = [
    "Rollout: AC-1: packages/app/branches/list.tsx:2",
    "Rollout: AC-2: packages/app/branches/list.tsx:3",
    "Rollout: PRD-1: ruling Pat Example, 2026-10-22, PRD-729 thread: ship to everyone at once",
  ].join("\n");
  assert.deepEqual(problems(done), []);
  assert.match(problems(done.replace("list.tsx:2", "list.tsx:4")).join(), /reads no flag/, "a flag requirement cites a flag read");
  assert.match(problems(done.replace("AC-2: packages/app/branches/list.tsx:3", "AC-2: packages/app/branches/legacy-list.tsx:1")).join(), /not a line at HEAD/, "a deleted legacy list keeps nothing");
  assert.match(problems(done.replace("PRD-729 thread", "Desktop Labs toggle thread")).join(), /names neither ISS-9394 nor PRD-729/, "a ruling about another surface");
  assert.match(problems(done.replace("Pat Example", "the plan")).join(), /human name or operator ruling/);
});

test("a cited ruling covers a ticket only when it names the ticket or its PRD", () => {
  assert.equal(rulingNamesScope("Ruling (operator): PRD-729 ships ungated", ["ISS-9538", "PRD-729"]), true);
  assert.equal(rulingNamesScope("Ruling (operator): the Desktop Labs toggle is gone", ["ISS-9538", "PRD-729"]), false);
  assert.equal(rulingNamesScope("ISS-95380 only", ["ISS-9538"]), false);
  assert.deepEqual(criteriaChangeProblems(TICKET, TICKET), []);
});

test("the command reads the session change log and fails a diff that shipped ungated", (t) => {
  const { root, home, cleanup } = makeHome("vibe-rollout-gate-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  mkdirSync(path.join(worktree, "packages/app/branches"), { recursive: true });
  writeFileSync(path.join(worktree, "packages/app/branches/list.tsx"), "export const List = () => {\n  const on = useFeatureFlag(BRANCHES_V2);\n  return on ? <V2 /> : <Legacy />;\n};\n");
  const ticket = path.join(root, "ticket.md");
  const prd = path.join(root, "prd.md");
  writeFileSync(ticket, TICKET);
  writeFileSync(prd, PRD);
  const args = ["--worktree", worktree, "--ticket", ticket, "--slug", "ISS-9394", "--prd", prd, "--prd-slug", "PRD-729"];
  const refused = runNode(SCRIPT, args, home);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.problems.length, 3);
  writeFileSync(path.join(git(worktree, ["rev-parse", "--absolute-git-dir"], home), "vibe-changes.md"), "Rollout: AC-1: packages/app/branches/list.tsx:2\nRollout: AC-2: packages/app/branches/list.tsx:3\nRollout: PRD-1: ruling operator ruling, 2026-10-22, PRD-729 thread\n");
  assert.equal(runNode(SCRIPT, args, home).status, 0);
  const usage = spawnSync(process.execPath, [SCRIPT, "--worktree", worktree, "--ticket", ticket], { encoding: "utf8" });
  assert.equal(usage.status, 2, "the ticket slug is required, so a ruling can be scoped");
});
