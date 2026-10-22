import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { missingLanes, reportLanes } from "./pre-pr-lanes.mjs";
import { git, makeHome } from "./test-fixtures.mjs";
import { spawnSync } from "node:child_process";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-pr-lanes.mjs");
const REPORT = [
  "IN THE TURBO GRAPH: 1 packages, dependents included:",
  "    pnpm --filter @repo/app test",
  "",
  "OUTSIDE THE TURBO GRAPH: 2 lane(s).",
  "    pnpm test:desktop-renderer      (3 changed path(s) under apps/desktop/src/renderer)",
  "    DESKTOP_E2E_SPECS='e2e/branches-grid.spec.ts e2e/it'\\''s.spec.ts' DESKTOP_E2E_PROJECTS='desktop' pnpm --filter desktop test:e2e (1 changed path(s) in e2e-test.yml's desktop_e2e filter)",
  "      CI runs it whole, the selector widened.",
  "",
].join("\n");
const DESKTOP_E2E = "DESKTOP_E2E_SPECS='e2e/branches-grid.spec.ts e2e/it'\\''s.spec.ts' DESKTOP_E2E_PROJECTS='desktop' pnpm --filter desktop test:e2e";

test("every lane the report names is required, e2e lanes and lanes with the step's variables included (#9116 merged with Desktop E2E reds)", () => {
  assert.deepEqual(reportLanes(REPORT), ["pnpm --filter @repo/app test", "pnpm test:desktop-renderer", DESKTOP_E2E]);
  assert.deepEqual(reportLanes("No paths changed against origin/main; there is nothing to cover.\n"), []);
  assert.equal(reportLanes("something went wrong\n"), null, "an unreadable report is never read as no lanes");
});

test("a lane needs a passing record at the current head", () => {
  const lanes = ["pnpm test:desktop-renderer"];
  assert.deepEqual(missingLanes(lanes, [], "h1"), lanes);
  assert.deepEqual(missingLanes(lanes, [{ command: lanes[0], head: "h0", result: "pass" }], "h1"), lanes, "a run at an older head");
  assert.deepEqual(missingLanes(lanes, [{ command: lanes[0], head: "h1", result: "fail" }], "h1"), lanes, "a failing run");
  assert.deepEqual(missingLanes(lanes, [{ command: lanes[0], head: "h1", result: "pass" }], "h1"), []);
});

test("the PR-open check refuses a diff naming desktop-renderer with no recorded run (pre-PR Vitest lanes ruling)", (t) => {
  const { root, home, cleanup } = makeHome("vibe-pre-pr-lanes-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  git(worktree, ["commit", "--quiet", "--allow-empty", "-m", "base"], home);
  const report = path.join(root, "lanes.txt");
  writeFileSync(report, REPORT);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const refused = run("check", "--worktree", worktree, "--report", report);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /^MISSING-LANE pnpm test:desktop-renderer:/m);
  assert.match(refused.stdout, /^MISSING-LANE DESKTOP_E2E_SPECS=.* pnpm --filter desktop test:e2e:/m);
  assert.equal(run("check", "--worktree", worktree, "--report", report, "--skip", "e2e").status, 2, "a skip needs the operator ruling that waives it");
  const waived = run("check", "--worktree", worktree, "--report", report, "--skip", "test:e2e", "--skip-ruling", "deadline mode, operator, 2026-10-22, rulings.md");
  assert.match(waived.stdout, /^SKIPPED-LANE DESKTOP_E2E_SPECS=.* \(deadline mode, operator, 2026-10-22, rulings.md\)$/m);
  for (const lane of reportLanes(REPORT)) assert.equal(run("record", "--worktree", worktree, "--command", lane, "--result", "pass").status, 0);
  assert.equal(run("check", "--worktree", worktree, "--report", report).status, 0);
  git(worktree, ["commit", "--quiet", "--allow-empty", "-m", "more"], home);
  assert.equal(run("check", "--worktree", worktree, "--report", report).status, 1, "a new head needs the lanes run again");
});
