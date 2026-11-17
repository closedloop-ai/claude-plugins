import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bindProvider, PROVIDER_BINDING } from "./test-fixtures.mjs";
import { fleetLaneInvocation, lanePreflightProblem, NOT_RUN_NO_DESKTOP_HARNESS, NOT_RUN_NO_IDENTITY, stagingIdentity, hasStagingE2eIdentity, hasDisplaylessElectronHarness, isDesktopE2eLane, isWebE2eLane, missingLanes, notRunLanes, reportLanes } from "./pre-pr-lanes.mjs";
import { git, makeHome } from "./test-fixtures.mjs";
import { spawnSync } from "node:child_process";

// The ClosedLoop provider's staging identity key, as a session it is bound to reads it.
const STAGING_IDENTITY_KEY = stagingIdentity(PROVIDER_BINDING).key;

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
  writeFileSync(path.join(worktree, "README.md"), "base docs\n");
  git(worktree, ["add", "README.md"], home);
  git(worktree, ["commit", "--quiet", "-m", "base"], home);
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
  const rulings = path.join(root, "rulings.md");
  writeFileSync(rulings, "## R-TARGETED-TESTS (operator, 2026-10-23)\n- Run the diff-targeted tests and carry other test lanes to CI.\n");
  const targeted = run("check", "--worktree", worktree, "--report", report, "--targeted", "@repo/app",
    "--targeted-ruling-id", "R-TARGETED-TESTS", "--targeted-ruling-source", "rulings", "--rulings", rulings);
  assert.equal(targeted.status, 1);
  assert.match(targeted.stdout, /^MISSING-LANE pnpm --filter @repo\/app test:/m);
  assert.match(targeted.stdout, /^RULED-LANE pnpm test:desktop-renderer \(R-TARGETED-TESTS, rulings:/m);
  assert.doesNotMatch(targeted.stdout, /^MISSING-LANE pnpm test:desktop-renderer:/m);
  const ruledRecords = JSON.parse(readFileSync(path.join(worktree, ".git", "vibe-lane-results.json"), "utf8"));
  assert.ok(ruledRecords.some((row) => row.command === "pnpm test:desktop-renderer" && row.result === "not-run"
    && row.ruling === "R-TARGETED-TESTS" && row.rulingSource === "rulings"));
  writeFileSync(rulings, "## R-TARGETED-TESTS (orchestrator, 2026-10-23)\n- Run targeted tests.\n");
  const unruled = run("check", "--worktree", worktree, "--report", report, "--targeted", "@repo/app",
    "--targeted-ruling-id", "R-TARGETED-TESTS", "--targeted-ruling-source", "rulings", "--rulings", rulings);
  assert.equal(unruled.status, 2);
  assert.match(unruled.stderr, /orchestrator direction, not an operator ruling/);
  const head = git(worktree, ["rev-parse", "HEAD"], home).trim();
  for (const lane of reportLanes(REPORT)) assert.equal(run("record", "--worktree", worktree, "--head", head, "--command", lane, "--result", "pass", "--report", report).status, 0);
  assert.equal(run("check", "--worktree", worktree, "--report", report).status, 0);
  writeFileSync(path.join(worktree, "README.md"), "docs\n");
  git(worktree, ["add", "README.md"], home);
  git(worktree, ["commit", "--quiet", "-m", "docs"], home);
  const none = path.join(root, "impact-none.json");
  writeFileSync(none, JSON.stringify({ lastQa: { boundary: head }, evidence: { screens: [] }, graphImporters: { importers: {} },
    featureMap: { entries: [] }, laneSelections: { files: { "unchanged.test.ts": ["pnpm test:desktop-renderer"] } }, config: { docs: [] } }));
  assert.equal(run("check", "--worktree", worktree, "--impact", none).status, 0, "an unrelated commit selects no local lane");
  writeFileSync(none, JSON.stringify({ lastQa: { boundary: git(worktree, ["rev-parse", "HEAD"], home) }, evidence: { screens: [] },
    graphImporters: { importers: {} }, featureMap: { entries: [] }, laneSelections: { files: { "unchanged.test.ts": ["pnpm test"] } }, config: { docs: [] } }));
  assert.equal(run("check", "--worktree", worktree, "--impact", none).status, 2, "HEAD is not a recorded prior-QA boundary");
  const testFile = "changed.test.ts";
  writeFileSync(path.join(worktree, testFile), "export const changed = true;\n");
  git(worktree, ["add", testFile], home);
  git(worktree, ["commit", "--quiet", "-m", "test"], home);
  const selected = path.join(root, "impact-lanes.json");
  writeFileSync(selected, JSON.stringify({ outcome: "None", lanes: [], lastQa: { boundary: head }, evidence: { screens: [] }, graphImporters: { importers: {} },
    featureMap: { entries: [] }, laneSelections: { files: { [testFile]: ["pnpm test:desktop-renderer"] } }, config: { docs: [] } }));
  assert.equal(run("check", "--worktree", worktree, "--impact", selected).status, 1, "caller outcome is ignored and the selected lane still needs evidence");
  const later = git(worktree, ["rev-parse", "HEAD"], home).trim();
  assert.equal(run("record", "--worktree", worktree, "--head", later, "--command", "pnpm test:desktop-renderer", "--result", "pass", "--impact", selected).status, 0);
  git(worktree, ["commit", "--quiet", "--allow-empty", "-m", "docs only"], home);
  assert.equal(run("check", "--worktree", worktree, "--impact", selected).status, 0, "lane evidence follows changed-file scope, not a later head");
  writeFileSync(selected, JSON.stringify({ lastQa: { boundary: head }, evidence: { screens: [] }, graphImporters: { importers: {} },
    featureMap: { entries: [] }, laneSelections: { files: {} }, config: { docs: [] } }));
  assert.equal(run("check", "--worktree", worktree, "--impact", selected).status, 2, "empty lane selections are refused");
  writeFileSync(selected, JSON.stringify({ lastQa: { boundary: head }, evidence: { screens: [] }, graphImporters: { importers: {} },
    featureMap: { entries: [] }, laneSelections: { files: { "unchanged.test.ts": ["pnpm test"] } }, config: { docs: [] } }));
  assert.equal(run("check", "--worktree", worktree, "--impact", selected).status, 2, "a lane for only an unchanged file is refused");
  writeFileSync(selected, JSON.stringify({ lastQa: { boundary: head }, evidence: { screens: [] }, graphImporters: { importers: {} },
    featureMap: { entries: [] }, laneSelections: { files: { [testFile]: [] } }, config: { docs: [] } }));
  assert.equal(run("check", "--worktree", worktree, "--impact", selected).status, 2, "an empty lane list for the changed file is refused");
});

test("ISS-14172 a lane can run through a fleet heavy slot and remote fleet binds exact HEAD", (t) => {
  const { root, home, cleanup } = makeHome("vibe-pre-pr-fleet-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  git(worktree, ["commit", "--quiet", "--allow-empty", "-m", "base"], home);
  const head = git(worktree, ["rev-parse", "HEAD"], home).trim();
  const command = "pnpm test:affected";
  const orch = path.join(root, "orch");
  mkdirSync(orch);
  const source = { head, diffSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
  const local = fleetLaneInvocation({ worktree, command, "fleet-where": "local", "fleet-orch": orch, "fleet-owner": "ISS-14172" }, source);
  assert.deepEqual(local.args.slice(1, 8), [orch, "local", "slot", "heavy", "ISS-14172", worktree, "sh"]);
  assert.equal(local.args.at(-1), command);
  assert.deepEqual(local.receipt, { where: "local", owner: "ISS-14172", head });
  const remote = fleetLaneInvocation({ worktree, command: "pnpm test", "fleet-where": "remote", "fleet-orch": orch, "fleet-owner": "ISS-14172" }, source);
  assert.equal(remote.args[2], "remote");
  assert.match(remote.args.at(-1), new RegExp(head));
  assert.throws(() => fleetLaneInvocation({ worktree, command: "pnpm test", "fleet-where": "remote", "fleet-orch": orch, "fleet-owner": "ISS-14172" },
    { head, diffSha256: "1".repeat(64) }), /clean worktree/);
});

test("ISS-14193 containerized web lane preflight names the missing login-shell identity", () => {
  const recipe = { sandboxOrgIdentityKey: "SEED_SANDBOX_CLERK_ORG_ID" };
  assert.match(lanePreflightProblem("e2e/run-containerized.sh", {}, recipe) ?? "", /SEED_SANDBOX_CLERK_ORG_ID.*login shell/);
  assert.equal(lanePreflightProblem("e2e/run-containerized.sh", { SEED_SANDBOX_CLERK_ORG_ID: "org_1" }, recipe), null);
});

test("ISS-14307: a repository-authorized targeted E2E receipt is scope-bound and includes changed specs", (t) => {
  const { root, home, cleanup } = makeHome("vibe-pre-pr-targeted-e2e-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  mkdirSync(path.join(worktree, "e2e"));
  writeFileSync(path.join(worktree, "AGENTS.md"), [
    "An e2e lane (`e2e`, `desktop-e2e`) is the exception: locally it is satisfied by the specs closedloop-graph selects for the diff (`code_tests_for_changes`), plus every spec the PR adds or edits.",
    "The full lane runs after merge.",
  ].join("\n"));
  writeFileSync(path.join(worktree, "e2e/existing.spec.ts"), "export const existing = true;\n");
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "base"], home);
  const base = git(worktree, ["rev-parse", "HEAD"], home);
  git(worktree, ["update-ref", "refs/remotes/origin/main", base], home);
  writeFileSync(path.join(worktree, "e2e/added.spec.ts"), "export const added = true;\n");
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "change"], home);
  const head = git(worktree, ["rev-parse", "HEAD"], home);
  const lane = "pnpm test:e2e";
  const report = path.join(root, "lanes.txt");
  writeFileSync(report, `    ${lane}\n`);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const graphResult = JSON.stringify({ mode: "RUN_ALL", startHere: ["e2e/existing.spec.ts"], directEvidence: [] });
  const record = (...specs) => run("record", "--worktree", worktree, "--head", head, "--command", lane, "--result", "pass",
    "--report", report, "--base", base, "--targeted-specs", JSON.stringify(specs), "--graph-query", "code_tests_for_changes repo=symphony-alpha",
    "--graph-result", graphResult);

  const missingChangedSpec = record("e2e/existing.spec.ts");
  assert.equal(missingChangedSpec.status, 2);
  assert.match(missingChangedSpec.stderr, /e2e\/added\.spec\.ts/);
  const emptyQuery = run("record", "--worktree", worktree, "--head", head, "--command", lane, "--result", "pass",
    "--report", report, "--base", base, "--targeted-specs", JSON.stringify(["e2e/existing.spec.ts", "e2e/added.spec.ts"]),
    "--graph-query", "   ", "--graph-result", graphResult);
  assert.equal(emptyQuery.status, 2);
  assert.match(emptyQuery.stderr, /--graph-query must record the non-empty graph query/);
  const recorded = record("e2e/existing.spec.ts", "e2e/added.spec.ts");
  assert.equal(recorded.status, 0, recorded.stderr);
  const checked = run("check", "--worktree", worktree, "--report", report, "--base", base);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /^TARGETED-LANE pnpm test:e2e \(2 specs\)$/m);

  const recordsPath = path.join(git(worktree, ["rev-parse", "--absolute-git-dir"], home), "vibe-lane-results.json");
  const records = JSON.parse(readFileSync(recordsPath, "utf8"));
  records[0].targeted.graphQuery = "";
  writeFileSync(recordsPath, `${JSON.stringify(records)}\n`);
  const emptyStoredQuery = run("check", "--worktree", worktree, "--report", report, "--base", base);
  assert.equal(emptyStoredQuery.status, 1);
  assert.doesNotMatch(emptyStoredQuery.stdout, /^TARGETED-LANE/m);
  assert.match(emptyStoredQuery.stdout, /^MISSING-LANE pnpm test:e2e:/m);
  records[0].targeted.graphQuery = "code_tests_for_changes repo=symphony-alpha";
  delete records[0].targeted.graphResult;
  writeFileSync(recordsPath, `${JSON.stringify(records)}\n`);
  const missingGraphResult = run("check", "--worktree", worktree, "--report", report, "--base", base);
  assert.equal(missingGraphResult.status, 1);
  assert.doesNotMatch(missingGraphResult.stdout, /^TARGETED-LANE/m);
  records[0].targeted.graphResult = JSON.parse(graphResult);
  writeFileSync(recordsPath, `${JSON.stringify(records)}\n`);

  writeFileSync(path.join(worktree, "README.md"), "scope moved\n");
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "moved"], home);
  const stale = run("check", "--worktree", worktree, "--report", report, "--base", base);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /^MISSING-LANE pnpm test:e2e:/m);

  writeFileSync(path.join(worktree, "AGENTS.md"), "Every lane runs in full locally.\n");
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "remove policy"], home);
  const unruled = run("check", "--worktree", worktree, "--report", report, "--base", base);
  assert.equal(unruled.status, 1);
  assert.doesNotMatch(unruled.stdout, /^TARGETED-LANE/m);
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
  assert.equal(dirty.status, 0, dirty.stderr);
  const evidence = JSON.parse(readFileSync(path.join(worktree, '.git/vibe-lane-results.json'), 'utf8')).find(row => row.command === pass);
  assert.equal(evidence.head, intended);
  assert.match(evidence.source.diffSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.source.treeSha256, /^[a-f0-9]{64}$/);
  const external = run('record', '--worktree', worktree, '--head', intended, '--command', pass, '--result', 'pass', '--report', report);
  assert.equal(external.status, 2, 'remote results cannot infer dirty input identity from the local worktree');
  assert.match(external.stderr, /--source/);
  assert.equal(run('record', '--worktree', worktree, '--head', intended, '--source', JSON.stringify(evidence.source), '--command', pass, '--result', 'pass', '--report', report).status, 0);
  git(worktree, ["checkout", "--quiet", "--", "a.txt"], home);
  const clean = run("run", "--worktree", worktree, "--head", intended.slice(0, 10), "--command", pass, "--report", report);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /^recorded pass for node -e /m);
  const moved = run("run", "--worktree", worktree, "--head", intended, "--command", movedCommand, "--report", report);
  assert.equal(moved.status, 1, "HEAD moving during the run fails it");
  assert.match(moved.stdout, /^HEAD-MOVED /m);
});

test('a lane detects uncommitted edits during a run and invalidates stale evidence at the same HEAD', (t) => {
  const { root, home, cleanup } = makeHome('vibe-dirty-lane-');
  t.after(cleanup);
  const wt = path.join(root, 'wt');
  git(root, ['init', '--quiet', wt], home);
  writeFileSync(path.join(wt, 'a.txt'), 'base');
  git(wt, ['add', '.'], home);
  git(wt, ['commit', '--quiet', '-m', 'base'], home);
  const head = git(wt, ['rev-parse', 'HEAD'], home).trim();
  const pass = 'node -e "0"';
  const mutation = `node -e "require('fs').writeFileSync('a.txt','changed')"`;
  const report = path.join(root, 'lanes.txt');
  writeFileSync(report, `    ${pass}\n    ${mutation}\n`);
  const run = (action, ...args) => spawnSync(process.execPath, [SCRIPT, action, '--worktree', wt, '--report', report, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(run('run', '--head', head, '--command', pass).status, 0);
  const changed = run('run', '--head', head, '--command', mutation);
  assert.equal(changed.status, 1, changed.stdout);
  assert.match(changed.stdout, /SOURCE-MOVED/);
  assert.match(run('check').stdout, /MISSING-LANE node -e "0"/);
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
  // The staging identity is the ClosedLoop provider's e2e recipe, so the run is bound to it.
  const env = { ...process.env, HOME: home, ...bindProvider(home) };
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
  assert.equal(entry.mainSource.head, mainSha);
  assert.match(entry.mainSource.treeSha256, /^[a-f0-9]{64}$/);
  const checked = run("check", "--worktree", worktree, "--report", report);
  assert.equal(checked.status, 0, checked.stdout);
  assert.match(checked.stdout, /^MAIN-PREEXISTING-LANE node -e /m);
  assert.ok(checked.stdout.includes(mainSha));
  const sessionCaused = run("run", "--worktree", worktree, "--head", head, "--command", sessionCommand, "--report", sessionReport, "--main-worktree", mainCheckout, "--main-sha", mainSha);
  assert.equal(sessionCaused.status, 1, "a lane that passes on main is the session's failure");
  assert.match(sessionCaused.stdout, /^recorded fail for node -e /m);
  writeFileSync(path.join(mainCheckout, 'red.txt'), 'uncommitted baseline drift');
  const dirtyMain = run('run', '--worktree', worktree, '--head', head, '--command', lane, '--report', report, '--main-worktree', mainCheckout, '--main-sha', mainSha);
  assert.equal(dirtyMain.status, 2, 'a dirty baseline cannot establish a failure on captured main');
  assert.match(dirtyMain.stderr, /captured main must be clean/);
});

test("lanes of one pool finishing together all keep their records", async (t) => {
  const { root, home, cleanup } = makeHome("vibe-pre-pr-lanes-pool-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  writeFileSync(path.join(worktree, "a.txt"), "one\n");
  git(worktree, ["add", "a.txt"], home);
  git(worktree, ["commit", "--quiet", "-m", "base"], home);
  const head = git(worktree, ["rev-parse", "HEAD"], home).trim();
  const lanes = ["a", "b", "c", "d", "e", "f"].map((name) => `node -e "process.exit(0)" ${name}`);
  const report = path.join(root, "lanes.txt");
  writeFileSync(report, `${lanes.map((lane) => `    ${lane}`).join("\n")}\n`);
  const { spawn } = await import("node:child_process");
  const runs = lanes.map((lane) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "run", "--worktree", worktree, "--head", head, "--command", lane, "--report", report], { env: { ...process.env, HOME: home }, stdio: "ignore" });
    child.on("close", resolve);
  }));
  assert.deepEqual(await Promise.all(runs), lanes.map(() => 0));
  const recorded = JSON.parse(readFileSync(path.join(worktree, ".git/vibe-lane-results.json"), "utf8")).map((row) => row.command).sort();
  assert.deepEqual(recorded, [...lanes].sort());
});

test("a changed story in a package with no typecheck script adds the story typecheck lane (ISS-13947, PR #9732)", (t) => {
  const { root, home, cleanup } = makeHome("vibe-pre-pr-story-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  mkdirSync(path.join(worktree, "apps/storybook/stories"), { recursive: true });
  writeFileSync(path.join(worktree, "apps/storybook/package.json"), JSON.stringify({ name: "storybook", scripts: { test: "vitest run" } }));
  writeFileSync(path.join(worktree, "apps/storybook/tsconfig.json"), "{}\n");
  writeFileSync(path.join(worktree, "apps/storybook/stories/a.stories.tsx"), "export const A = 1;\n");
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "base"], home);
  const base = git(worktree, ["rev-parse", "HEAD"], home).trim();
  git(worktree, ["update-ref", "refs/remotes/origin/main", base], home);
  writeFileSync(path.join(worktree, "apps/storybook/stories/a.stories.tsx"), "export const A = 1;\nexport const B = olderVersionOf(content);\n");
  git(worktree, ["commit", "--quiet", "-am", "story"], home);
  const report = path.join(root, "lanes.txt");
  writeFileSync(report, "IN THE TURBO GRAPH: 1 packages, dependents included:\n    pnpm --filter storybook test\n");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\ncat "${bin}/output"\nexit "$(cat "${bin}/status")"\n`, { mode: 0o755 });
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: worktree, env: { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  const lane = `node ${JSON.stringify(path.join(path.dirname(SCRIPT), "story-typecheck.mjs"))} --worktree . --base ${base}`;
  const refused = run("check", "--worktree", worktree, "--report", report);
  assert.equal(refused.status, 1);
  assert.ok(refused.stdout.includes(`MISSING-LANE ${lane}:`), refused.stdout);
  const head = git(worktree, ["rev-parse", "HEAD"], home).trim();
  writeFileSync(path.join(bin, "output"), "stories/a.stories.tsx(2,18): error TS2345: Argument of type 'string | null' is not assignable.\n");
  writeFileSync(path.join(bin, "status"), "2");
  const failed = run("run", "--worktree", worktree, "--head", head, "--command", lane, "--report", report);
  assert.equal(failed.status, 1, "the new error on an added story line fails the lane");
  assert.match(failed.stdout, /STORY-TYPE-ERROR apps\/storybook\/stories\/a\.stories\.tsx:2:18 TS2345/);
  writeFileSync(path.join(bin, "output"), "");
  writeFileSync(path.join(bin, "status"), "0");
  for (const command of ["pnpm --filter storybook test", lane]) assert.equal(run("run", "--worktree", worktree, "--head", head, "--command", command, "--report", report).status, 0);
  assert.equal(run("check", "--worktree", worktree, "--report", report).status, 0);
});


test("a repository with no e2e recipe needs no staging identity", (t) => {
  const { root, cleanup } = makeHome("vibe-pre-pr-lanes-no-identity-");
  t.after(cleanup);
  assert.equal(hasStagingE2eIdentity(root, {}, null), true);
  assert.equal(hasStagingE2eIdentity(root, {}, stagingIdentity(PROVIDER_BINDING)), false);
});

test("ISS-14225: record binds a lane that ran on another host to the head by Git tree, never by a proof commit this clone lacks", (t) => {
  const { root, home, cleanup } = makeHome("vibe-pre-pr-lanes-ran-on-");
  t.after(cleanup);
  const wt = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", wt], home);
  writeFileSync(path.join(wt, "a.txt"), "one\n");
  git(wt, ["add", "a.txt"], home);
  git(wt, ["commit", "--quiet", "-m", "base"], home);
  git(wt, ["commit", "--quiet", "--allow-empty", "-m", "published head"], home);
  const head = git(wt, ["rev-parse", "HEAD"], home);
  const tree = git(wt, ["rev-parse", "HEAD^{tree}"], home);
  const slot = path.join(root, "slot");
  git(root, ["clone", "--quiet", wt, slot], home);
  const proof = git(slot, ["commit-tree", tree, "-p", "HEAD~1", "-m", "proof made on the heavy slot"], home);
  assert.throws(() => git(wt, ["cat-file", "-e", `${proof}^{commit}`], home), undefined, "the proof commit exists only on the slot");
  const pass = 'node -e "process.exit(0)"';
  const report = path.join(root, "lanes.txt");
  writeFileSync(report, `    ${pass}\n`);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const record = (...extra) => run("record", "--worktree", wt, "--head", head, "--command", pass, "--result", "pass", "--report", report, ...extra);
  const ranOn = ["--ran-on", "heavy-slot", "--proof-commit", proof, "--git-tree", tree];
  assert.equal(run("check", "--worktree", wt, "--report", report).status, 1);
  const recorded = record(...ranOn);
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(run("check", "--worktree", wt, "--report", report).status, 0, "check keys on the lane scope and the source tree");
  const row = JSON.parse(readFileSync(path.join(wt, ".git", "vibe-lane-results.json"), "utf8")).find((item) => item.command === pass);
  assert.deepEqual(row.ranOn, { host: "heavy-slot", proofCommit: proof, gitTree: tree, command: pass });
  assert.equal(row.source.head, head, "the row's source is this clean head, whose content the proof shares");
  const otherTree = git(wt, ["mktree"], home);
  git(wt, ["commit", "--quiet", "--allow-empty", "-m", "same tree, other commit"], home);
  const moved = git(wt, ["rev-parse", "HEAD"], home);
  const refused = (args, pattern, why) => {
    const result = run("record", "--worktree", wt, "--head", moved, "--command", pass, "--result", "pass", "--report", report, ...args);
    assert.equal(result.status, 2, why);
    assert.match(result.stderr, pattern, why);
  };
  refused(["--ran-on", "heavy-slot", "--proof-commit", proof, "--git-tree", otherTree], /Git tree/, "a proof tree that is not HEAD's tree");
  refused(["--ran-on", "heavy-slot", "--proof-commit", proof], /--git-tree/, "a host without the proof tree");
  refused(["--proof-commit", proof, "--git-tree", tree], /--ran-on/, "a proof without its host");
  refused(["--ran-on", "heavy slot;", "--proof-commit", proof, "--git-tree", tree], /host/, "a host that is not a plain name");
  refused([...ranOn, "--source", JSON.stringify(row.source)], /--source/, "a remote record never carries a local dirty identity");
  writeFileSync(path.join(wt, "a.txt"), "uncommitted\n");
  refused(ranOn, /clean/, "uncommitted inputs are not the proof tree");
});
