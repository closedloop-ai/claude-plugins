import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NOT_RUN_NO_IDENTITY, STAGING_IDENTITY_KEY, isWebE2eLane, missingLanes, reportLanes } from "./pre-pr-lanes.mjs";
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
  const head = git(worktree, ["rev-parse", "HEAD"], home).trim();
  for (const lane of reportLanes(REPORT)) assert.equal(run("record", "--worktree", worktree, "--head", head, "--command", lane, "--result", "pass").status, 0);
  assert.equal(run("check", "--worktree", worktree, "--report", report).status, 0);
  git(worktree, ["commit", "--quiet", "--allow-empty", "-m", "more"], home);
  assert.equal(run("check", "--worktree", worktree, "--report", report).status, 1, "a new head needs the lanes run again");
});

test("a result names the commit it ran: a run refuses another HEAD or a modified tracked file (23/23 reported for an untested PR)", (t) => {
  const { root, home, cleanup } = makeHome("vibe-pre-pr-lanes-head-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  writeFileSync(path.join(worktree, "a.txt"), "one\n");
  git(worktree, ["add", "a.txt"], home);
  git(worktree, ["commit", "--quiet", "-m", "base"], home);
  const old = git(worktree, ["rev-parse", "HEAD"], home).trim();
  git(worktree, ["commit", "--quiet", "--allow-empty", "-m", "the PR head"], home);
  const intended = git(worktree, ["rev-parse", "HEAD"], home).trim();
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  git(worktree, ["checkout", "--quiet", old], home);
  const stale = run("run", "--worktree", worktree, "--head", intended, "--command", "true");
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /^HEAD-MISMATCH the worktree is at /);
  assert.equal(run("record", "--worktree", worktree, "--head", intended, "--command", "pnpm test", "--result", "pass").status, 2, "a result from another commit is never recorded");
  git(worktree, ["checkout", "--quiet", intended], home);
  writeFileSync(path.join(worktree, "a.txt"), "leftover\n");
  const dirty = run("run", "--worktree", worktree, "--head", intended.slice(0, 10), "--command", "true");
  assert.equal(dirty.status, 2);
  assert.match(dirty.stderr, /^DIRTY-WORKTREE .*a\.txt/);
  git(worktree, ["checkout", "--quiet", "--", "a.txt"], home);
  const clean = run("run", "--worktree", worktree, "--head", intended.slice(0, 10), "--command", "true");
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, new RegExp(`^recorded pass for true at ${intended}$`, "m"));
  const moved = run("run", "--worktree", worktree, "--head", intended, "--command", `git checkout --quiet ${old}`);
  assert.equal(moved.status, 1, "HEAD moving during the run fails it");
  assert.match(moved.stdout, /^HEAD-MOVED /m);
});

test("without the staging e2e identities the local web e2e lane is recorded not run and does not stop the PR (operator ruling, 2026-10-28, ISS-13291)", (t) => {
  const { root, home, cleanup } = makeHome("vibe-pre-pr-lanes-identity-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  git(worktree, ["commit", "--quiet", "--allow-empty", "-m", "base"], home);
  const head = git(worktree, ["rev-parse", "HEAD"], home).trim();
  const web = "pnpm test:e2e";
  const report = path.join(root, "lanes.txt");
  writeFileSync(report, ["OUTSIDE THE TURBO GRAPH: 2 lane(s).", `    ${web}      (2 changed path(s) under e2e/)`, `    ${DESKTOP_E2E} (1 changed path(s))`, ""].join("\n"));
  const env = { ...process.env, HOME: home };
  delete env[STAGING_IDENTITY_KEY];
  const run = (extra = {}) => spawnSync(process.execPath, [SCRIPT, "check", "--worktree", worktree, "--report", report], { encoding: "utf8", env: { ...env, ...extra } });
  assert.equal(run().status, 1, "the Desktop e2e lane is not a web lane and is still required");
  spawnSync(process.execPath, [SCRIPT, "record", "--worktree", worktree, "--head", head, "--command", DESKTOP_E2E, "--result", "pass"], { env });
  const skipped = run();
  assert.equal(skipped.status, 0, skipped.stdout);
  assert.match(skipped.stdout, /^NOT-RUN-LANE pnpm test:e2e \(no staging e2e identities on this machine; the containerized or CI run covers it\)$/m);
  assert.doesNotMatch(skipped.stdout, /MISSING-LANE/);
  const records = JSON.parse(readFileSync(path.join(worktree, ".git", "vibe-lane-results.json"), "utf8"));
  assert.deepEqual(records.filter((record) => record.command === web).map((record) => [record.head, record.result, record.reason]),
    [[head, "not-run", NOT_RUN_NO_IDENTITY]]);
  assert.equal(run({ [STAGING_IDENTITY_KEY]: "set" }).status, 1, "a machine with the identity in its environment runs the web lane");
  mkdirSync(path.join(worktree, "apps", "app"), { recursive: true });
  writeFileSync(path.join(worktree, "apps", "app", ".env.local"), `${STAGING_IDENTITY_KEY}=""\n`);
  assert.equal(run().status, 0, "a blank value is not an identity");
  writeFileSync(path.join(worktree, "apps", "app", ".env.local"), `OTHER=1\n${STAGING_IDENTITY_KEY}='secret'\n`);
  const required = run();
  assert.equal(required.status, 1);
  assert.match(required.stdout, /^MISSING-LANE pnpm test:e2e:/m);
});

test("only the web Playwright lanes count as local web e2e", () => {
  assert.equal(isWebE2eLane("pnpm test:e2e"), true);
  assert.equal(isWebE2eLane("E2E_PROJECTS='chromium' pnpm test:web-smoke"), true);
  assert.equal(isWebE2eLane(DESKTOP_E2E), false);
  assert.equal(isWebE2eLane("pnpm --dir apps/desktop test:e2e"), false);
  assert.equal(isWebE2eLane("pnpm --filter @repo/app test"), false);
});
