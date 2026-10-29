import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NOT_RUN_NO_DESKTOP_HARNESS, NOT_RUN_NO_IDENTITY, STAGING_IDENTITY_KEY, hasDisplaylessElectronHarness, isDesktopE2eLane, isWebE2eLane, missingLanes, notRunLanes, reportLanes } from "./pre-pr-lanes.mjs";
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
// The Desktop lane is required only where the displayless Linux harness exists (ISS-13321).
const HARNESS = hasDisplaylessElectronHarness();

test("every lane the report names is required, e2e lanes and lanes with the step's variables included (#9116 merged with Desktop E2E reds)", () => {
  assert.deepEqual(reportLanes(REPORT), ["pnpm --filter @repo/app test", "pnpm test:desktop-renderer", DESKTOP_E2E]);
  assert.deepEqual(reportLanes("No paths changed against origin/main; there is nothing to cover.\n"), []);
  assert.equal(reportLanes("something went wrong\n"), null, "an unreadable report is never read as no lanes");
});

test("a selected lane needs a passing record at the source it exercises", () => {
  const lanes = ["pnpm test:desktop-renderer"];
  assert.deepEqual(missingLanes(lanes, [], { laneKey: "scope1" }), lanes);
  assert.deepEqual(missingLanes(lanes, [{ command: lanes[0], head: "h0", laneKey: "scope1", result: "pass" }], { laneKey: "scope1" }), [], "a later head preserves the same changed-file scope");
  assert.deepEqual(missingLanes(lanes, [{ command: lanes[0], head: "h1", laneKey: "scope0", result: "pass" }], { laneKey: "scope1" }), lanes, "a different changed-file scope");
  assert.deepEqual(missingLanes(lanes, [{ command: lanes[0], head: "h1", laneKey: "scope1", result: "fail" }], { laneKey: "scope1" }), lanes, "a failing run");
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
  assert.match(refused.stdout, HARNESS ? /^MISSING-LANE DESKTOP_E2E_SPECS=.* pnpm --filter desktop test:e2e:/m : /^NOT-RUN-LANE DESKTOP_E2E_SPECS=.* pnpm --filter desktop test:e2e \(no displayless Linux Electron harness/m);
  assert.equal(run("check", "--worktree", worktree, "--report", report, "--skip", "e2e").status, 2, "a skip needs the operator ruling that waives it");
  const waived = run("check", "--worktree", worktree, "--report", report, "--skip", "test:e2e", "--skip-ruling", "deadline mode, operator, 2026-10-22, rulings.md");
  assert.match(waived.stdout, /^SKIPPED-LANE DESKTOP_E2E_SPECS=.* \(deadline mode, operator, 2026-10-22, rulings.md\)$/m);
  const head = git(worktree, ["rev-parse", "HEAD"], home).trim();
  for (const lane of reportLanes(REPORT)) assert.equal(run("record", "--worktree", worktree, "--head", head, "--command", lane, "--result", "pass", "--report", report).status, 0);
  assert.equal(run("check", "--worktree", worktree, "--report", report).status, 0);
  git(worktree, ["commit", "--quiet", "--allow-empty", "-m", "more"], home);
  const none = path.join(root, "impact-none.json");
  writeFileSync(none, JSON.stringify({ outcome: "None", lanes: [], screens: [] }));
  assert.equal(run("check", "--worktree", worktree, "--impact", none).status, 0, "an unrelated commit selects no local lane");
  const selected = path.join(root, "impact-lanes.json");
  writeFileSync(selected, JSON.stringify({ outcome: "Lanes only", lanes: ["pnpm test:desktop-renderer"], screens: [], laneKey: "0123456789abcdef" }));
  assert.equal(run("check", "--worktree", worktree, "--impact", selected).status, 1, "a selected lane still needs current evidence");
  const later = git(worktree, ["rev-parse", "HEAD"], home).trim();
  assert.equal(run("record", "--worktree", worktree, "--head", later, "--command", "pnpm test:desktop-renderer", "--result", "pass", "--impact", selected).status, 0);
  git(worktree, ["commit", "--quiet", "--allow-empty", "-m", "docs only"], home);
  assert.equal(run("check", "--worktree", worktree, "--impact", selected).status, 0, "lane evidence follows changed-file scope, not a later head");
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
  const pass = 'node -e "process.exit(0)"';
  const movedCommand = `node -e "require('node:child_process').execFileSync('git',['checkout','--quiet','${old}'])"`;
  const report = path.join(root, "lanes.txt");
  writeFileSync(report, `    ${pass}\n    ${movedCommand}\n    pnpm test\n`);
  git(worktree, ["checkout", "--quiet", old], home);
  const stale = run("run", "--worktree", worktree, "--head", intended, "--command", pass, "--report", report);
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /^HEAD-MISMATCH the worktree is at /);
  assert.equal(run("record", "--worktree", worktree, "--head", intended, "--command", "pnpm test", "--result", "pass", "--report", report).status, 2, "a result from another commit is never recorded");
  git(worktree, ["checkout", "--quiet", intended], home);
  writeFileSync(path.join(worktree, "a.txt"), "leftover\n");
  const dirty = run("run", "--worktree", worktree, "--head", intended.slice(0, 10), "--command", pass, "--report", report);
  assert.equal(dirty.status, 2);
  assert.match(dirty.stderr, /^DIRTY-WORKTREE .*a\.txt/);
  git(worktree, ["checkout", "--quiet", "--", "a.txt"], home);
  const clean = run("run", "--worktree", worktree, "--head", intended.slice(0, 10), "--command", pass, "--report", report);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /^recorded pass for node -e /m);
  const moved = run("run", "--worktree", worktree, "--head", intended, "--command", movedCommand, "--report", report);
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
  assert.equal(run().status, HARNESS ? 1 : 0, "the Desktop e2e lane is required only where the displayless harness exists");
  spawnSync(process.execPath, [SCRIPT, "record", "--worktree", worktree, "--head", head, "--command", DESKTOP_E2E, "--result", "pass", "--report", report], { env });
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

test("the Desktop e2e lane is left for CI on a machine without the displayless Linux harness (ISS-13321)", () => {
  const lanes = ["pnpm test:e2e", DESKTOP_E2E, "pnpm test:desktop-renderer"];
  assert.equal(isDesktopE2eLane(DESKTOP_E2E), true);
  assert.equal(isDesktopE2eLane("DESKTOP_E2E_SMOKE_TAG='@smoke' DESKTOP_E2E_CHANGED_SPECS='' pnpm --dir apps/desktop test:e2e"), true);
  assert.equal(isDesktopE2eLane("pnpm test:e2e"), false);
  assert.equal(isDesktopE2eLane("pnpm test:desktop-renderer"), false);
  assert.deepEqual(notRunLanes(lanes, [], { laneKey: "scope1" }, { identity: true, harness: false }), [{ lane: DESKTOP_E2E, reason: NOT_RUN_NO_DESKTOP_HARNESS }]);
  assert.deepEqual(notRunLanes(lanes, [], { laneKey: "scope1" }, { identity: true, harness: true }), [], "a Linux machine with the harness runs it");
  assert.deepEqual(notRunLanes(lanes, [{ command: DESKTOP_E2E, head: "h1", laneKey: "scope1", result: "pass" }], { laneKey: "scope1" }, { identity: true, harness: false }), [],
    "a run recorded from a remote runner counts");
  assert.equal(hasDisplaylessElectronHarness("darwin", () => true), false, "a Mac never launches Electron for vibe");
  assert.equal(hasDisplaylessElectronHarness("linux", (tool) => tool !== "xvfb-run"), false);
  assert.equal(hasDisplaylessElectronHarness("linux", () => true), true);
});

test("a lane that also fails on captured main is recorded main-preexisting and does not stop the PR (ISS-13321)", (t) => {
  const { root, home, cleanup } = makeHome("vibe-pre-pr-lanes-main-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  writeFileSync(path.join(worktree, "red.txt"), "main is red\n");
  git(worktree, ["add", "red.txt"], home);
  git(worktree, ["commit", "--quiet", "-m", "main"], home);
  const mainSha = git(worktree, ["rev-parse", "HEAD"], home).trim();
  const mainCheckout = path.join(root, "main");
  git(worktree, ["worktree", "add", "--quiet", "--detach", mainCheckout, mainSha], home);
  git(worktree, ["rm", "--quiet", "red.txt"], home);
  git(worktree, ["commit", "--quiet", "-m", "session"], home);
  const head = git(worktree, ["rev-parse", "HEAD"], home).trim();
  const lane = 'node -e "process.exit(1)"';
  const sessionCommand = 'node -e "process.exit(require(\'node:fs\').existsSync(\'red.txt\') ? 0 : 1)"';
  const report = path.join(root, "lanes.txt");
  writeFileSync(report, `OUTSIDE THE TURBO GRAPH: 1 lane(s).\n    ${lane}      (1 changed path(s))\n`);
  const sessionReport = path.join(root, "session-lane.txt");
  writeFileSync(sessionReport, `OUTSIDE THE TURBO GRAPH: 1 lane(s).\n    ${sessionCommand}\n`);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.deepEqual(missingLanes([lane], [{ command: lane, head, laneKey: "scope1", result: "main-preexisting", mainSha }], { laneKey: "scope1" }), []);
  assert.deepEqual(missingLanes([lane], [{ command: lane, head, laneKey: "scope1", result: "main-preexisting" }], { laneKey: "scope1" }), [lane], "it names the main it failed on");
  const records = path.join(worktree, ".git", "vibe-lane-results.json");
  const recorded = run("run", "--worktree", worktree, "--head", head, "--command", lane, "--report", report, "--main-worktree", mainCheckout, "--main-sha", mainSha);
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  const [entry] = JSON.parse(readFileSync(records, "utf8"));
  assert.deepEqual([entry.result, entry.mainSha], ["main-preexisting", mainSha]);
  const checked = run("check", "--worktree", worktree, "--report", report);
  assert.equal(checked.status, 0, checked.stdout);
  assert.match(checked.stdout, /^MAIN-PREEXISTING-LANE node -e /m);
  assert.ok(checked.stdout.includes(mainSha));
  const sessionCaused = run("run", "--worktree", worktree, "--head", head, "--command", sessionCommand, "--report", sessionReport, "--main-worktree", mainCheckout, "--main-sha", mainSha);
  assert.equal(sessionCaused.status, 1, "a lane that passes on main is the session's failure");
  assert.match(sessionCaused.stdout, /^recorded fail for node -e /m);
});
