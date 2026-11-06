import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NOT_RUN_NO_DESKTOP_HARNESS, NOT_RUN_NO_IDENTITY, STAGING_IDENTITY_KEY, hasDisplaylessElectronHarness, isDesktopE2eLane, isWebE2eLane, missingLanes, notRunLanes, readLaneSelectionReceipt, reportLanes } from "./pre-pr-lanes.mjs";
import { git, makeHome, mockLaneReporter } from "./test-fixtures.mjs";
import { sourceIdentity } from "./tested-head.mjs";
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
  assert.equal(reportLanes("    pnpm test:unit\n"), null, "a lane list without a declared count is incomplete");
  assert.equal(reportLanes("OUTSIDE THE TURBO GRAPH: 1 lane(s).\n    pnpm test:unit\n    pnpm test:lint\n"), null,
    "a count smaller than the commands is incomplete");
  assert.equal(reportLanes("OUTSIDE THE TURBO GRAPH: 2 lane(s).\n    pnpm test:unit\n"), null,
    "a count larger than the commands is incomplete");
  assert.deepEqual(reportLanes("OUTSIDE THE TURBO GRAPH: 3 lane(s).\n    uv run pytest\n    python3 -m pytest\n    node --test x.test.mjs\n"),
    ["uv run pytest", "python3 -m pytest", "node --test x.test.mjs"], "plugin CI commands remain reportable");
  assert.deepEqual(reportLanes("IN THE TURBO GRAPH — 1 package, dependents included:\n    pnpm --filter @repo/app test\nOUTSIDE THE TURBO GRAPH — 1 lane(s). `turbo test` cannot see\n    pnpm test:lint\nOUTSIDE THE TURBO GRAPH, BY REFERENCE — 1 lane(s) whose suites\n    pnpm test:lint\n"),
    ["pnpm --filter @repo/app test", "pnpm test:lint"], "the repository's em-dash sections count rows before deduplicating commands");
});

test("a selected lane needs a passing record at the source it exercises", () => {
  const lanes = ["pnpm test:desktop-renderer"];
  assert.deepEqual(missingLanes(lanes, [], { laneKey: "scope1" }), lanes);
  assert.deepEqual(missingLanes(lanes, [{ command: lanes[0], head: "h0", laneKey: "scope1", result: "pass" }], { laneKey: "scope1" }), [], "a later head preserves the same changed-file scope");
  assert.deepEqual(missingLanes(lanes, [{ command: lanes[0], head: "h1", laneKey: "scope0", result: "pass" }], { laneKey: "scope1" }), lanes, "a different changed-file scope");
  assert.deepEqual(missingLanes(lanes, [{ command: lanes[0], head: "h1", laneKey: "scope1", result: "fail" }], { laneKey: "scope1" }), lanes, "a failing run");
});

test("phase receipts refuse full followups and incomplete first candidates, then bind scoped reasons to source", (t) => {
  const { root, home, cleanup } = makeHome("vibe-lane-phase-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  writeFileSync(path.join(worktree, "a.txt"), "base\n");
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "base"], home);
  const first = 'node -e "0"';
  const second = 'node -e "process.exit(0)"';
  const report = path.join(root, "report.txt");
  writeFileSync(report, `OUTSIDE THE TURBO GRAPH: 2 lane(s).\n    ${first}\n    ${second}\n`);
  const reporter = mockLaneReporter(root, readFileSync(report, "utf8"));
  const incomplete = path.join(root, "incomplete.txt");
  writeFileSync(incomplete, `OUTSIDE THE TURBO GRAPH: 2 lane(s).\n    ${first}\n`);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8", env: { ...process.env, HOME: home, PATH: reporter.path },
  });
  assert.equal(run("check", "--worktree", worktree, "--report", report).status, 2, "phase is explicit");
  const broadFollowup = run("check", "--worktree", worktree, "--phase", "followup", "--report", report);
  assert.equal(broadFollowup.status, 2, "a followup cannot rerun the full report without selection provenance");
  assert.match(broadFollowup.stderr, /unreasoned full report is refused/);
  const incompleteFirst = run("check", "--worktree", worktree, "--phase", "first-candidate", "--report", incomplete);
  assert.equal(incompleteFirst.status, 2, "the first candidate cannot omit a declared CI-equivalent lane");
  assert.match(incompleteFirst.stderr, /--report must name this lane or explicitly say nothing changed/);
  const forged = path.join(root, "forged.txt");
  writeFileSync(forged, `OUTSIDE THE TURBO GRAPH: 1 lane(s).\n    ${first}\n`);
  const forgedFirst = run("check", "--worktree", worktree, "--phase", "first-candidate", "--report", forged);
  assert.equal(forgedFirst.status, 2, "a self-consistent short report cannot omit a canonical lane");
  assert.match(forgedFirst.stderr, /does not match current pnpm test:lanes selection/);
  const premature = path.join(root, "premature-code-tests.json");
  writeFileSync(premature, JSON.stringify({ schemaVersion: 1, source: sourceIdentity(worktree),
    lanes: [{ command: first, reason: "changed unit maps to this lane" }] }));
  const prematureFollowup = run("check", "--worktree", worktree, "--phase", "followup", "--code-tests", premature);
  assert.equal(prematureFollowup.status, 2, "followup cannot bypass the full first-candidate lane set");
  assert.match(prematureFollowup.stderr, /successful first-candidate receipt/);
  const head = git(worktree, ["rev-parse", "HEAD"], home).trim();
  for (const command of [first, second]) {
    assert.equal(run("record", "--worktree", worktree, "--head", head, "--phase", "first-candidate",
      "--command", command, "--result", "pass", "--report", report).status, 0);
  }
  assert.equal(run("check", "--worktree", worktree, "--phase", "first-candidate", "--report", report).status, 0);
  const initial = readLaneSelectionReceipt(worktree);
  assert.equal(initial.phase, "first-candidate");
  assert.deepEqual(initial.lanes.map((lane) => lane.command), [first, second]);
  assert.ok(initial.lanes.every((lane) => /CI-equivalent report/.test(lane.reason)));
  assert.equal(run("check", "--worktree", worktree, "--phase", "first-candidate", "--report", report).status, 2,
    "a successful first candidate is declared once");

  writeFileSync(path.join(worktree, "a.txt"), "followup\n");
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "followup"], home);
  const followHead = git(worktree, ["rev-parse", "HEAD"], home).trim();
  const selected = path.join(root, "code-tests.json");
  const selectedBytes = JSON.stringify({ schemaVersion: 1, source: sourceIdentity(worktree),
    producer: "code_tests_for_changes", boundary: head,
    fileCoverage: [{ file: "a.txt", status: "tests_found", tests: ["a.test.mjs"], commands: [first] }],
    lanes: [{ command: first, reason: "changed unit maps to this lane" }] });
  const selectedKey = createHash("sha256").update(selectedBytes).digest("hex");
  writeFileSync(selected, selectedBytes);
  const absentProducer = path.join(root, "code-tests-absent-producer.json");
  writeFileSync(absentProducer, JSON.stringify({ ...JSON.parse(selectedBytes), producer: undefined }));
  assert.match(run("check", "--worktree", worktree, "--phase", "followup", "--code-tests", absentProducer).stderr,
    /normalized code_tests_for_changes/);
  const incompleteCoverage = path.join(root, "code-tests-incomplete.json");
  writeFileSync(incompleteCoverage, JSON.stringify({ ...JSON.parse(selectedBytes), fileCoverage: [] }));
  assert.match(run("check", "--worktree", worktree, "--phase", "followup", "--code-tests", incompleteCoverage).stderr,
    /complete changed-file coverage/);
  const extra = run("record", "--worktree", worktree, "--head", followHead, "--phase", "followup", "--code-tests", selected,
    "--command", second, "--result", "pass");
  assert.equal(extra.status, 2, "an unselected extra lane is refused");
  assert.match(extra.stderr, /--code-tests must select this lane exactly once/);
  assert.equal(run("record", "--worktree", worktree, "--head", followHead, "--phase", "followup", "--code-tests", selected,
    "--command", first, "--result", "pass").status, 0);
  const laneRows = JSON.parse(readFileSync(path.join(worktree, ".git", "vibe-lane-results.json"), "utf8"));
  const selectedRow = laneRows.find((row) => row.command === first && row.laneKey === selectedKey);
  assert.deepEqual(selectedRow.selection, { kind: "code-tests", key: selectedKey, reason: "changed unit maps to this lane" });
  writeFileSync(selected, selectedBytes.replace("changed unit", "tampered unit"));
  assert.equal(run("check", "--worktree", worktree, "--phase", "followup", "--code-tests", selected).status, 1,
    "changing the evidence bytes changes the selection key and invalidates its run");
  writeFileSync(selected, selectedBytes);
  assert.equal(run("check", "--worktree", worktree, "--phase", "followup", "--code-tests", selected).status, 0);
  const followup = readLaneSelectionReceipt(worktree);
  assert.deepEqual(followup.selection, { kind: "code-tests", key: selectedKey });
  assert.equal(followup.lanes[0].reason, "changed unit maps to this lane");
  assert.equal(run("check", "--worktree", worktree, "--phase", "first-candidate", "--report", report).status, 2,
    "followup receipts retain that the first candidate already ran");

  const none = path.join(root, "code-tests-none.json");
  writeFileSync(none, JSON.stringify({ schemaVersion: 1, source: sourceIdentity(worktree), producer: "code_tests_for_changes", boundary: head,
    fileCoverage: [{ file: "a.txt", status: "confirmed_none", reason: "graph confirms no affected test", tests: [], commands: [] }], lanes: [] }));
  const unsupportedNone = path.join(root, "code-tests-unsupported-none.json");
  writeFileSync(unsupportedNone, JSON.stringify({ schemaVersion: 1, source: sourceIdentity(worktree), producer: "code_tests_for_changes", boundary: head,
    fileCoverage: [{ file: "a.txt", status: "tests_found", tests: ["a.test.mjs"], commands: [] }], lanes: [] }));
  assert.match(run("check", "--worktree", worktree, "--phase", "followup", "--code-tests", unsupportedNone).stderr,
    /selected commands/);
  const noneRun = run("record", "--worktree", worktree, "--head", followHead, "--phase", "followup", "--code-tests", none,
    "--command", first, "--result", "pass");
  assert.equal(noneRun.status, 2, "None selection permits no heavy run");
  assert.match(noneRun.stderr, /--code-tests must select this lane exactly once/);
  assert.equal(run("check", "--worktree", worktree, "--phase", "followup", "--code-tests", none).status, 0);
  assert.deepEqual(readLaneSelectionReceipt(worktree).lanes, []);
  const stale = path.join(root, "code-tests-stale.json");
  writeFileSync(stale, JSON.stringify({ schemaVersion: 1,
    source: { ...sourceIdentity(worktree), head: "0".repeat(40) }, producer: "code_tests_for_changes", boundary: head,
    fileCoverage: [{ file: "a.txt", status: "confirmed_none", reason: "graph confirms no affected test" }], lanes: [] }));
  assert.equal(run("check", "--worktree", worktree, "--phase", "followup", "--code-tests", stale).status, 2,
    "stale source-bound code-test evidence is refused");
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
  const reporter = mockLaneReporter(root, REPORT);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, "--phase", args.includes("--impact") ? "followup" : "first-candidate"], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: reporter.path } });
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
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, "--phase", "first-candidate"], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: reporter.path } });
  const pass = 'node -e "process.exit(0)"';
  const movedCommand = `node -e "require('node:child_process').execFileSync('git',['checkout','--quiet','${old}'])"`;
  const report = path.join(root, "lanes.txt");
  writeFileSync(report, `OUTSIDE THE TURBO GRAPH: 3 lane(s).\n    ${pass}\n    ${movedCommand}\n    pnpm test\n`);
  const reporter = mockLaneReporter(root, readFileSync(report, "utf8"));
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
  writeFileSync(report, `OUTSIDE THE TURBO GRAPH: 2 lane(s).\n    ${pass}\n    ${mutation}\n`);
  const reporter = mockLaneReporter(root, readFileSync(report, "utf8"));
  const run = (action, ...args) => spawnSync(process.execPath, [SCRIPT, action, '--worktree', wt, '--report', report, '--phase', 'first-candidate', ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, PATH: reporter.path } });
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
  const reporter = mockLaneReporter(root, readFileSync(report, "utf8"));
  const env = { ...process.env, HOME: home, PATH: reporter.path };
  delete env[STAGING_IDENTITY_KEY];
  const run = (extra = {}) => spawnSync(process.execPath, [SCRIPT, "check", "--worktree", worktree, "--report", report, "--phase", "first-candidate"], { encoding: "utf8", env: { ...env, ...extra } });
  assert.equal(run().status, HARNESS ? 1 : 0, "the Desktop e2e lane is required only where the displayless harness exists");
  const receipt = path.join(worktree, ".git", "vibe-lane-selection.json");
  rmSync(receipt, { force: true });
  spawnSync(process.execPath, [SCRIPT, "record", "--worktree", worktree, "--head", head, "--command", DESKTOP_E2E, "--result", "pass", "--report", report, "--phase", "first-candidate"], { env });
  const skipped = run();
  assert.equal(skipped.status, 0, skipped.stdout);
  assert.match(skipped.stdout, /^NOT-RUN-LANE pnpm test:e2e \(no staging e2e identities on this machine; the containerized or CI run covers it\)$/m);
  assert.doesNotMatch(skipped.stdout, /MISSING-LANE/);
  const records = JSON.parse(readFileSync(path.join(worktree, ".git", "vibe-lane-results.json"), "utf8"));
  assert.deepEqual(records.filter((record) => record.command === web).map((record) => [record.head, record.result, record.reason]),
    [[head, "not-run", NOT_RUN_NO_IDENTITY]]);
  rmSync(receipt, { force: true });
  assert.equal(run({ [STAGING_IDENTITY_KEY]: "set" }).status, 1, "a machine with the identity in its environment runs the web lane");
  mkdirSync(path.join(worktree, "apps", "app"), { recursive: true });
  writeFileSync(path.join(worktree, "apps", "app", ".env.local"), `${STAGING_IDENTITY_KEY}=""\n`);
  assert.equal(run().status, 0, "a blank value is not an identity");
  rmSync(receipt, { force: true });
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
  const reporter = mockLaneReporter(root, readFileSync(report, "utf8"));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, "--phase", "first-candidate"], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: reporter.path } });
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
  rmSync(path.join(worktree, ".git", "vibe-lane-selection.json"), { force: true });
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
  writeFileSync(report, `OUTSIDE THE TURBO GRAPH: ${lanes.length} lane(s).\n${lanes.map((lane) => `    ${lane}`).join("\n")}\n`);
  const { spawn } = await import("node:child_process");
  const runs = lanes.map((lane) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "run", "--phase", "first-candidate", "--worktree", worktree, "--head", head, "--command", lane, "--report", report], { env: { ...process.env, HOME: home }, stdio: "ignore" });
    child.on("close", resolve);
  }));
  assert.deepEqual(await Promise.all(runs), lanes.map(() => 0));
  const recorded = JSON.parse(readFileSync(path.join(worktree, ".git/vibe-lane-results.json"), "utf8")).map((row) => row.command).sort();
  assert.deepEqual(recorded, [...lanes].sort());
});
