import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { ciCheckProblems, evidenceProblems, pullRequestFacts, requiredLanes, selectionProblems, targetedEvidenceProblems } from "./pr-facts.mjs";
import { NOT_RUN_NO_DESKTOP_HARNESS, NOT_RUN_NO_IDENTITY } from "../../vibe/scripts/pre-pr-lanes.mjs";
import { git, makeHome, PROVIDER_BINDING, bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";
import { repositoryAreas } from "../../vibe/scripts/area-paths.mjs";
import { workflowLaneDefinitions } from "./ci-job-shape.mjs";
import { renderEvidenceComment } from "./pr-evidence-comment.mjs";
import { qaImpactRequest } from "./qa-impact.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { PLAYS, PLAYS_WORKFLOW, ROUTE, TEST, SELECTED, selectionProblemsBound, siblingCarry, pairedMainFailure } from "./pr-facts-test-fixtures.mjs";

const AREAS = repositoryAreas(PROVIDER_BINDING);
const { sourceIdentity, committedSourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const sessionRecords = await vibeCore("lib/vibe/scripts/session-record.mjs");
bindProviderInProcess(after);

test('dirty precommit evidence cannot bind unchanged HEAD and binds only after the candidate is committed', t => {
  const { root, home, cleanup } = makeHome('precommit-evidence-binding-');
  t.after(cleanup);
  const wt = path.join(root, 'repo');
  mkdirSync(wt);
  writeFileSync(path.join(wt, 'notes.md'), 'base');
  git(wt, ['init', '--quiet'], home);
  git(wt, ['add', '.'], home);
  git(wt, ['commit', '--quiet', '-m', 'base'], home);
  const base = git(wt, ['rev-parse', 'HEAD'], home);
  writeFileSync(path.join(wt, 'notes.md'), 'checked candidate');
  const source = sourceIdentity(wt);
  const evidence = { source, touchFlows: [], touchFlowsReason: 'docs only', runs: [], testSelection: [], testRuns: [], rerunCycles: [],
    e2eCapability: structuredClone(SELECTED.e2eCapability),
    targetedInventory: { actor: 'read-only', source: 'working-tree', commit: base,
      laneReport: { command: 'pnpm test:lanes', matches: [] }, entries: [], noTestsReason: 'docs only' } };
  const gate = () => pullRequestFacts({ worktree: wt, base, include: new Set(['notes.md']), ownBranch: 'main', runs: evidence,
    commit: git(wt, ['rev-parse', 'HEAD'], home) }).prEvidenceProblems;
  assert.match(gate().join('\n'), /commit.*(?:omit|content)|uncommitted|untracked/i,
    'dirty evidence cannot bind to the unchanged commit that contains none of its edits');
  git(wt, ['add', '.'], home);
  git(wt, ['commit', '--quiet', '-m', 'one push-ready commit'], home);
  assert.deepEqual(gate(), [], 'only identical content can carry the accepted source evidence');
  assert.equal(evidence.targetedInventory.commit, base);
  assert.equal(evidence.source.head, base);
  writeFileSync(path.join(wt, 'notes.md'), 'unchecked post-verification change');
  assert.match(gate().join('\n'), /source.*(?:changed|match|identity)/i);
});

test('ISS-14394 a pull_request workflow whose path filter the diff matches needs a run of its command at the gate', t => {
  const { root, home, cleanup } = makeHome('path-workflow-gate-');
  t.after(cleanup);
  const wt = path.join(root, 'repo');
  mkdirSync(wt);
  writeFileSync(path.join(wt, 'notes.md'), 'base');
  mkdirSync(path.join(wt, '.github', 'workflows'), { recursive: true });
  writeFileSync(path.join(wt, '.github', 'workflows', 'plays.yml'), PLAYS_WORKFLOW);
  git(wt, ['init', '--quiet'], home);
  git(wt, ['add', '.'], home);
  git(wt, ['commit', '--quiet', '-m', 'base'], home);
  const base = git(wt, ['rev-parse', 'HEAD'], home);
  writeFileSync(path.join(wt, 'notes.md'), 'checked candidate');
  const source = sourceIdentity(wt);
  const evidence = { source, touchFlows: [], touchFlowsReason: 'docs only', runs: [], testSelection: [], testRuns: [], rerunCycles: [],
    e2eCapability: structuredClone(SELECTED.e2eCapability),
    targetedInventory: { actor: 'read-only', source: 'working-tree', commit: base,
      laneReport: { command: 'pnpm test:lanes', matches: [] }, entries: [], noTestsReason: 'docs only' } };
  git(wt, ['add', '.'], home);
  git(wt, ['commit', '--quiet', '-m', 'one push-ready commit'], home);
  const problems = pullRequestFacts({ worktree: wt, base, include: new Set(['notes.md']), ownBranch: 'main', runs: evidence,
    commit: git(wt, ['rev-parse', 'HEAD'], home) }).prEvidenceProblems;
  assert.ok(problems.some((problem) => problem.startsWith('.github/workflows/plays.yml job plays runs on this pull request') && problem.includes(PLAYS)), problems.join('\n'));
});

test('precommit evidence cannot bind to a commit that omitted an untracked input', t => {
  const { root, home, cleanup } = makeHome('precommit-omitted-input-');
  t.after(cleanup);
  const wt = path.join(root, 'repo');
  mkdirSync(wt);
  writeFileSync(path.join(wt, 'a.txt'), 'base\n');
  git(wt, ['init', '--quiet'], home);
  git(wt, ['add', 'a.txt'], home);
  git(wt, ['commit', '--quiet', '-m', 'base'], home);
  const base = git(wt, ['rev-parse', 'HEAD'], home);
  writeFileSync(path.join(wt, 'a.txt'), 'candidate\n');
  writeFileSync(path.join(wt, 'helper.js'), 'export default 1;\n');
  const source = sourceIdentity(wt);
  const evidence = { source, touchFlows: [], touchFlowsReason: 'fixture', runs: [], testSelection: [], testRuns: [], rerunCycles: [],
    e2eCapability: structuredClone(SELECTED.e2eCapability), targetedInventory: { actor: 'read-only', source: 'working-tree', commit: base,
      laneReport: { command: 'pnpm test:lanes', matches: [] }, entries: [], noTestsReason: 'fixture' } };
  const gate = () => pullRequestFacts({ worktree: wt, base, include: new Set(['a.txt']), ownBranch: 'main', runs: evidence,
    commit: git(wt, ['rev-parse', 'HEAD'], home) }).prEvidenceProblems;
  git(wt, ['add', 'a.txt'], home);
  git(wt, ['commit', '--quiet', '-m', 'commit only a'], home);
  assert.match(gate().join('\n'), /commit.*(?:omit|content)|uncommitted|untracked/i);
  git(wt, ['add', 'helper.js'], home);
  git(wt, ['commit', '--quiet', '-m', 'commit helper'], home);
  assert.deepEqual(gate(), []);
});

test("evidence: lanes follow the diff, and unfinished, missing or stale runs block", () => {
  const changed = ["packages/app/list.tsx", "packages/app/list.stories.tsx"];
  assert.deepEqual(requiredLanes([ROUTE], [], AREAS), []);
  assert.deepEqual(["e2e/a.spec.ts", "e2e-web-smoke/b.spec.ts", "apps/desktop/test/e2e/c.spec.ts"].map((file) => requiredLanes([file], [], AREAS)), [["e2e"], ["e2e"], ["e2e"]]);
  assert.deepEqual(requiredLanes(changed, ["card select"], AREAS), ["web-host", "desktop-host", "webkit-iphone", "chromium-pixel", "storybook-plays"]);
  const commit = "a".repeat(40);
  const laneKey = "1".repeat(16);
  const runs = requiredLanes(changed, ["card select"], AREAS).map((lane) => ({ lane, status: "passed", command: "run", commit, laneKey, outcome: "selected",
    ...(lane === "storybook-plays" ? { playVerdicts: [{ storyId: "cards--select", verdict: "PASS" }] } : {}) }));
  const file = { touchFlows: ["card select"], runs, qaImpact: { laneKey } };
  assert.deepEqual(evidenceProblems(file, changed, commit), []);
  assert.match(evidenceProblems({ ...file, runs: runs.map((run, i) => (i === 2 ? { ...run, status: "running" } : run)) }, changed, commit).join(), /webkit-iphone: running/);
  assert.match(evidenceProblems({ ...file, runs: runs.slice(1) }, changed, commit).join(), /web-host: no run recorded/);
  assert.match(evidenceProblems(file, changed, "b".repeat(40)).join(), /recomputed/);
  assert.deepEqual(evidenceProblems({ ...file, qaImpact: { laneKey: "2".repeat(16) } }, changed, commit), [], "a trusted-only stored key is ignored at the current head");
  assert.match(evidenceProblems({ runs }, changed, commit).join(), /touchFlows/);
  const unjudged = runs.map((run) => (run.lane === "storybook-plays" ? { ...run, playVerdicts: undefined } : run));
  assert.match(evidenceProblems({ ...file, runs: unjudged }, changed, commit).join(), /storybook-plays: no playVerdicts/);
});

test("older lane and inventory evidence requires a recomputed impact key", (t) => {
  const fixture = makeHome("pr-facts-impact-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "wt");
  git(fixture.root, ["init", "--quiet", "--initial-branch=main", worktree], fixture.home);
  mkdirSync(path.join(worktree, "e2e"), { recursive: true });
  const spec = "e2e/changed.spec.ts";
  writeFileSync(path.join(worktree, spec), "export const value = 1;\n");
  git(worktree, ["add", "-A"], fixture.home);
  git(worktree, ["commit", "--quiet", "-m", "base"], fixture.home);
  const boundary = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  writeFileSync(path.join(worktree, spec), "export const value = 2;\n");
  git(worktree, ["commit", "--quiet", "-am", "change spec"], fixture.home);
  const final = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  const command = "pnpm test:e2e";
  const request = { lastQa: { boundary }, evidence: { screens: [] }, graphImporters: { importers: {} },
    featureMap: { entries: [] }, laneSelections: { files: { [spec]: [command] } }, config: { docs: [] } };
  const laneKey = qaImpactRequest(worktree, request).laneKey;
  const old = "0".repeat(40);
  const run = { lane: "e2e", command, outcome: "passed", status: "passed", commit: old };
  const lanes = { touchFlows: [], touchFlowsReason: "spec only", runs: [run] };
  assert.match(evidenceProblems(lanes, [spec], final, worktree).join(), /recomputed/);
  assert.match(evidenceProblems({ ...lanes, qaImpactRequest: request }, [spec], final, worktree).join(), /scope missing/);
  assert.deepEqual(evidenceProblems({ ...lanes, qaImpactRequest: request, runs: [{ ...run, laneKey }] }, [spec], final, worktree), []);

  const targeted = { testSelection: [], qaImpactRequest: request,
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit: old, impactKey: laneKey,
      laneReport: { command: "pnpm test:lanes", matches: [{ name: "e2e", command }] }, entries: [], noTestsReason: "lane only" },
    testRuns: [{ ...run, laneKey }], rerunCycles: [] };
  assert.deepEqual(targetedEvidenceProblems(targeted, final, worktree), []);
  const trustedOnly = { ...targeted, qaImpactRequest: undefined };
  assert.match(targetedEvidenceProblems(trustedOnly, final, worktree).join(), /recomputed/);
});

test("a pull request inventory and lane runs follow qa-impact scope instead of the final commit", () => {
  const commit = "d".repeat(40);
  const laneKey = "4".repeat(16);
  const entry = { kind: "vitest", path: TEST, cases: ["limits"], command: `pnpm --filter api exec vitest run ${TEST} -t limits` };
  const complete = {
    targetedInventory: {
      actor: "read-only",
      source: "final-committed-diff",
      commit,
      impactKey: laneKey,
      laneReport: { command: "pnpm test:lanes", matches: [] },
      entries: [entry],
    },
    testSelection: [{ file: ROUTE, selector: "change-tests", tests: [TEST] }],
    testRuns: [{ path: TEST, cases: ["limits"], command: entry.command, status: "passed", commit }],
    rerunCycles: [],
  };
  assert.deepEqual(targetedEvidenceProblems(complete, commit), []);
  assert.match(targetedEvidenceProblems({}, commit).join(), /targeted inventory.*missing/);
  assert.match(targetedEvidenceProblems({ ...complete, targetedInventory: { ...complete.targetedInventory, actor: "writer" } }, commit).join(), /read-only/);
  assert.match(targetedEvidenceProblems({ ...complete, testRuns: [] }, commit).join(), /no passing targeted run/);
});

test("selection evidence never silently drops a nonarray or malformed test list", () => {
  const commit = "d".repeat(40);
  assert.match(selectionProblemsBound({ testSelection: { codeTestsFor: { [ROUTE]: [TEST] } } }, [], [], commit).join(), /testSelection must be an array/);
  assert.match(selectionProblemsBound({ testSelection: [{ file: ROUTE, selector: "code_tests_for", tests: { path: TEST } }] }, [], [], commit).join(), /tests must be an array/);
});

test("edited web and Desktop e2e specs can be carried only by exact not-run CI evidence", () => {
  const commit = "f".repeat(40);
  const web = "e2e/org-issues-list.spec.ts";
  const desktop = "apps/desktop/test/e2e/issues-list.spec.ts";
  const lane = { name: "desktop-e2e", command: "DESKTOP_E2E_SMOKE_TAG='' pnpm --dir apps/desktop test:e2e" };
  const ciOwner = { [web]: "e2e-test.yml:e2e", [desktop]: "desktop-e2e-validation.yml:desktop-e2e/validated" };
  const records = [
    { path: web, status: "not-run", commit, reason: NOT_RUN_NO_IDENTITY,
      ciOwner: ciOwner[web], selectionSource: "e2e-reference", laneReportSource: "pnpm test:lanes" },
    { path: desktop, status: "not-run", commit, reason: NOT_RUN_NO_DESKTOP_HARNESS,
      ciOwner: ciOwner[desktop], selectionSource: "e2e-reference", laneReportSource: "pnpm test:lanes" },
  ];
  const evidence = {
    testSelection: [{ file: ROUTE, selector: "e2e-reference", tests: [web, desktop] }],
    testRuns: [...records, { lane: lane.name, command: lane.command, status: "not-run", commit, reason: NOT_RUN_NO_DESKTOP_HARNESS }],
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit,
      laneReport: { command: "pnpm test:lanes", matches: [lane] },
      entries: [web, desktop].map((spec) => ({ kind: "e2e", path: spec, cases: ["changed name"], command: "not run locally" })) },
    e2eCapability: { selectedTier: null, container: { dockerPresent: false, dockerReachable: false,
      memoryGiB: 0, diskGiB: 0, minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "repo probe" },
      native: { available: false }, remote: { available: false }, unavailableSpecs: [web, desktop], ciCoverage: Object.values(ciOwner) },
  };
  const changed = [web, desktop].map((path) => ({ path, status: "M" }));
  const check = (candidate) => selectionProblemsBound(candidate, changed, [], commit);
  assert.deepEqual(check(evidence), []);
  assert.equal(selectionProblems(evidence, changed, [], commit).length, 2,
    "with no provider's E2E CI owners neither spec is left for CI; each must pass locally");
  assert.deepEqual(targetedEvidenceProblems({ ...evidence, rerunCycles: [] }, commit), []);
  const typedCommand = structuredClone(evidence);
  typedCommand.targetedInventory.laneReport.source = { kind: "command", command: "pnpm test:lanes" };
  delete typedCommand.targetedInventory.laneReport.command;
  assert.deepEqual(targetedEvidenceProblems({ ...typedCommand, rerunCycles: [] }, commit), []);
  const workflowLabel = structuredClone(evidence);
  workflowLabel.targetedInventory.laneReport.source = { kind: "github-workflow", path: ".github/workflows/ci.yml", commit, sha256: "a".repeat(64) };
  delete workflowLabel.targetedInventory.laneReport.command;
  for (const run of workflowLabel.testRuns.filter(run => run.path)) run.laneReportSource = ".github/workflows/ci.yml";
  assert.deepEqual(check(workflowLabel), []);
  const foreignCommand = structuredClone(workflowLabel);
  foreignCommand.targetedInventory.laneReport.source = { kind: "command", command: "node other-lanes.mjs" };
  for (const run of foreignCommand.testRuns.filter(run => run.path)) run.laneReportSource = "node other-lanes.mjs";
  assert.notDeepEqual(check(foreignCommand), [], "command-based E2E provider semantics remain unchanged");


  assert.match(targetedEvidenceProblems({ ...evidence, rerunCycles: [], testRuns: evidence.testRuns.filter((run) => run.path !== web) }, commit).join(),
    /unavailable E2E needs an exact not-run spec record/);
  for (const changedEvidence of [
    { ...evidence, testRuns: evidence.testRuns.filter((run) => run.path !== web) },
    { ...evidence, testRuns: evidence.testRuns.map((run) => run.path === web ? { ...run, commit: "a".repeat(40) } : run) },
    { ...evidence, testRuns: evidence.testRuns.map((run) => run.path === web ? { ...run, ciOwner: "unknown" } : run) },
    { ...evidence, testRuns: evidence.testRuns.map((run) => run.path === desktop ? { ...run, reason: "machine busy" } : run) },
    { ...evidence, testRuns: evidence.testRuns.filter((run) => run.lane !== lane.name) },
    { ...evidence, e2eCapability: { ...evidence.e2eCapability, unavailableSpecs: [desktop] } },
  ]) assert.match(check(changedEvidence).join(), /selected but no passing or carried run/);
});

test("after a fix only failed and newly reached targets may be rerun", () => {
  const before = "1".repeat(40);
  const after = "2".repeat(40);
  const sameHash = "a".repeat(64);
  const entry = (path, extra = {}) => ({ kind: "vitest", path, cases: [path], command: `vitest ${path}`, ...extra });
  const evidence = {
    testSelection: [],
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit: after,
      fileHashes: { "src/passed.ts": sameHash },
      laneReport: { command: "pnpm test:lanes", matches: [] }, entries: [
        entry("passed.test.ts", { resultCommit: before, carriedTo: after, carryReason: "the isolated fix cannot reach this module",
          coveredFiles: [{ path: "src/passed.ts", sha256: sameHash }] }),
        entry("failed.test.ts"),
      ] },
    testRuns: [
      { path: "passed.test.ts", cases: ["passed.test.ts"], command: "vitest passed.test.ts", status: "passed", commit: before },
      { path: "failed.test.ts", cases: ["failed.test.ts"], command: "vitest failed.test.ts", status: "passed", commit: after },
    ],
    rerunCycles: [{ fromCommit: before, toCommit: after, failed: ["failed.test.ts"], newlyReached: [], rerun: ["failed.test.ts"] }],
  };
  assert.deepEqual(targetedEvidenceProblems(evidence, after), []);
  const broad = { ...evidence, rerunCycles: [{ ...evidence.rerunCycles[0], rerun: ["failed.test.ts", "passed.test.ts"] }] };
  assert.match(targetedEvidenceProblems(broad, after).join(), /only its failed cases/);
  const changed = { ...evidence, targetedInventory: { ...evidence.targetedInventory, fileHashes: { "src/passed.ts": "b".repeat(64) } } };
  assert.match(targetedEvidenceProblems(changed, after).join(), /src\/passed\.ts.*hash changed/);
});

test("every lane pnpm test:lanes names needs a passing run of its own command, not a hand-picked subset (#9238)", () => {
  const commit = "f".repeat(40);
  const laneKey = "7".repeat(16);
  const entry = { kind: "vitest", path: TEST, cases: ["limits"], command: "vitest run" };
  const lane = { name: "app", command: "pnpm --filter app test packages/design-system" };
  const evidence = (matches, testRuns) => ({
    testSelection: [],
    qaImpact: { laneKey },
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit, impactKey: laneKey, laneReport: { command: "pnpm test:lanes", matches }, entries: [entry] },
    testRuns: [{ path: TEST, cases: ["limits"], command: "vitest run", status: "passed", commit }, ...testRuns], rerunCycles: [],
  });
  assert.match(targetedEvidenceProblems(evidence([lane], []), commit).join(), /lane app: no passing run/);
  assert.match(targetedEvidenceProblems(evidence([lane], []), commit).join(), /record --result main-preexisting; only a dated human targeted-tests ruling leaves it not run/,
    "the refusal names the supported records for a lane red on main or trimmed by a ruling (ISS-14387)");
  assert.match(targetedEvidenceProblems(evidence([lane], [{ lane: "app", command: "vitest run capability-parity", status: "passed", commit }]), commit).join(), /hand-picked/);
  assert.deepEqual(targetedEvidenceProblems(evidence([lane], [{ lane: "app", command: lane.command, status: "passed", commit, laneKey: "8".repeat(16) }]), commit), [], "current-head provenance needs no carry key");
  assert.deepEqual(targetedEvidenceProblems(evidence([{ ...lane, mentionOnly: true, notRunReason: "only its AGENTS.md mentions the path" }], []), commit), []);
});

test("a changed check or CI script needs a run in its CI job's checkout shape (#9230)", () => {
  const commit = "c".repeat(40);
  const repro = { job: "pr-test.yml:storybook-build", tier: "batch-only", checkout: "fetch-depth 1, no CI_DIFF_BASE_REF", command: "GITHUB_ACTIONS=true pnpm --filter storybook validate:catalog", status: "passed", commit };
  assert.deepEqual(ciCheckProblems({}, ["apps/app/page.tsx"], commit), []);
  for (const file of ["scripts/lint/rules/story-rules.ts", "apps/storybook/package.json", ".github/workflows/pr-test.yml", "packages/design-system/checks/catalog.ts"]) {
    assert.match(ciCheckProblems({}, [file], commit).join(), /ciCheckRepros/, file);
  }
  assert.match(ciCheckProblems({ ciCheckRepros: [] }, ["scripts/a.ts"], commit).join(), /noCiCheckReason/);
  assert.deepEqual(ciCheckProblems({ ciCheckRepros: [], noCiCheckReason: "dependency version only" }, ["package.json"], commit), []);
  assert.match(ciCheckProblems({ ciCheckRepros: [{ ...repro, status: "failed" }] }, ["scripts/a.ts"], commit).join(), /storybook-build: no passing run/);
  assert.match(ciCheckProblems({ ciCheckRepros: [{ ...repro, checkout: "" }] }, ["scripts/a.ts"], commit).join(), /needs job, tier, checkout/);
  assert.deepEqual(ciCheckProblems({ ciCheckRepros: [repro] }, ["scripts/a.ts"], commit), []);
});

test("the Desktop e2e lane left for CI by pre-pr-lanes is not a missing lane run (ISS-13321)", () => {
  const commit = "f".repeat(40);
  const laneKey = "9".repeat(16);
  const lane = { name: "desktop-e2e", command: "DESKTOP_E2E_SMOKE_TAG='@smoke' DESKTOP_E2E_CHANGED_SPECS='' pnpm --dir apps/desktop test:e2e" };
  const evidence = (testRuns) => ({
    testSelection: [], qaImpact: { laneKey },
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit, impactKey: laneKey, laneReport: { command: "pnpm test:lanes", matches: [lane] }, entries: [], noTestsReason: "lane only" },
    testRuns, rerunCycles: [],
  });
  const notRun = { lane: lane.name, command: lane.command, status: "not-run", reason: NOT_RUN_NO_DESKTOP_HARNESS, commit, laneKey };
  assert.deepEqual(targetedEvidenceProblems(evidence([notRun]), commit), []);
  assert.match(targetedEvidenceProblems(evidence([{ ...notRun, reason: "" }]), commit).join(), /lane desktop-e2e: no passing run/, "a not-run record names why");
  assert.deepEqual(targetedEvidenceProblems(evidence([{ ...notRun, laneKey: "a".repeat(16) }]), commit), [], "current-head provenance needs no carry key");
  const web = { name: "e2e", command: "pnpm test:e2e" };
  const webEvidence = { ...evidence([{ ...notRun, lane: web.name, command: web.command }]) };
  webEvidence.targetedInventory = { ...webEvidence.targetedInventory, laneReport: { command: "pnpm test:lanes", matches: [web] } };
  assert.match(targetedEvidenceProblems(webEvidence, commit).join(), /lane e2e: no passing run/, "only the Desktop lane is left for CI here");
});

test("the web e2e lane is not required locally when every changed spec is left for CI (ISS-13321)", () => {
  const commit = "b".repeat(40);
  const spec = "e2e/issues-row.spec.ts";
  const capability = {
    selectedTier: null,
    container: { dockerPresent: false, dockerReachable: false, memoryGiB: 0, diskGiB: 0, minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "repo probe" },
    native: { available: false }, remote: { available: false },
    unavailableSpecs: [spec], ciCoverage: ["e2e-test.yml:e2e"],
  };
  const file = { touchFlows: [], touchFlowsReason: "none", runs: [], e2eCapability: capability,
    testSelection: [{ file: ROUTE, selector: "e2e-reference", tests: [spec] }],
    targetedInventory: { laneReport: { command: "pnpm test:lanes", matches: [] } },
    testRuns: [{ path: spec, status: "not-run", commit, reason: NOT_RUN_NO_IDENTITY,
      ciOwner: "e2e-test.yml:e2e", selectionSource: "e2e-reference", laneReportSource: "pnpm test:lanes" }] };
  assert.deepEqual(evidenceProblems(file, [spec], commit), []);
  assert.deepEqual(evidenceProblems({ ...file, e2eCapability: { ...capability, ciCoverage: [] } }, [spec], commit), ["e2e: no run recorded"]);
  assert.deepEqual(evidenceProblems({ ...file, e2eCapability: { ...capability, unavailableSpecs: [] } }, [spec], commit), ["e2e: no run recorded"]);
  const docker = { ...capability, container: { ...capability.container, dockerPresent: true, dockerReachable: true, memoryGiB: 24, diskGiB: 80 } };
  assert.deepEqual(evidenceProblems({ ...file, e2eCapability: docker }, [spec], commit), ["e2e: no run recorded"], "a machine that can run it runs it");
});

test("sibling QA proof carries only through a verified equal-tree publication receipt", t => {
  const f = siblingCarry(t);
  assert.throws(() => qaImpactRequest(f.wt, f.evidence.qaImpactRequest), /ancestor/);
  assert.deepEqual(targetedEvidenceProblems(f.evidence, f.published, f.wt), []);
  const noCarry = structuredClone(f.evidence); delete noCarry.treeEquivalentCarry;
  assert.match(targetedEvidenceProblems(noCarry, f.published, f.wt).join(), /recomputed|ancestor/);
});

test("workflow lane evidence is checked against its committed repository declaration", t => {
  const f = siblingCarry(t);
  assert.deepEqual(targetedEvidenceProblems(f.evidence, f.published, f.wt), []);
  const subset = structuredClone(f.evidence); subset.targetedInventory.laneReport.matches = [];
  assert.match(targetedEvidenceProblems(subset, f.published, f.wt).join(), /workflow.*lane|lane.*workflow/);
  const invented = structuredClone(f.evidence); invented.targetedInventory.laneReport.matches[0].command = "echo passed";
  assert.match(targetedEvidenceProblems(invented, f.published, f.wt).join(), /workflow.*lane|lane.*workflow/);
});

test("tree carry rejects actual unequal trees, dirty covered bytes and a self-consistent forged scope", t => {
  const f = siblingCarry(t);
  assert.deepEqual(targetedEvidenceProblems(f.evidence, f.published, f.wt), []);
  const changed = structuredClone(f.evidence);
  changed.treeEquivalentCarry.proof.commit = f.boundary;
  changed.treeEquivalentCarry.proof.gitTree = f.g("rev-parse", `${f.boundary}^{tree}`);
  changed.treeEquivalentCarry.proof.source = committedSourceIdentity(f.wt, f.boundary);
  f.g("update-ref", changed.treeEquivalentCarry.proof.ref, f.boundary);
  assert.match(targetedEvidenceProblems(changed, f.published, f.wt).join(), /equal Git\/source/);
  f.g("update-ref", changed.treeEquivalentCarry.proof.ref, f.proof);
  writeFileSync(path.join(f.wt, "service.mjs"), "unchecked covered bytes");
  assert.match(targetedEvidenceProblems(f.evidence, f.published, f.wt).join(), /clean equal/);
  f.g("checkout", "--", "service.mjs");
  const forged = structuredClone(f.evidence);
  forged.treeEquivalentCarry.laneKey = forged.qaImpact.laneKey = forged.targetedInventory.impactKey = "0".repeat(16);
  forged.testRuns[0].laneKey = forged.treeEquivalentCarry.runs[0].result.laneKey = "0".repeat(16);
  assert.match(targetedEvidenceProblems(forged, f.published, f.wt).join(), /recomputed proof scope/);
  const wrongSource = structuredClone(f.evidence); wrongSource.source.diffSha256 = "0".repeat(64);
  assert.match(targetedEvidenceProblems(wrongSource, f.published, f.wt).join(), /clean equal/);
});

test("current-head workflow lanes cannot fall back to pnpm or an unverified workflow definition", t => {
  const f = siblingCarry(t); const evidence = structuredClone(f.evidence);
  delete evidence.treeEquivalentCarry; delete evidence.qaImpactRequest;
  evidence.testRuns[0].commit = f.published;
  assert.deepEqual(targetedEvidenceProblems(evidence, f.published, f.wt), []);
  const fallback = structuredClone(evidence); fallback.targetedInventory.laneReport.source = undefined;
  fallback.targetedInventory.laneReport.command = "pnpm test:lanes";
  assert.match(targetedEvidenceProblems(fallback, f.published, f.wt).join(), /repository-declared/);
  const wrongHash = structuredClone(evidence); wrongHash.targetedInventory.laneReport.source.sha256 = "0".repeat(64);
  assert.match(targetedEvidenceProblems(wrongHash, f.published, f.wt).join(), /definition hash/);
  assert.match(targetedEvidenceProblems(evidence, f.published).join(), /verified repository/);
});

test("a tree carry never accepts an old passing result for a lane changed after its QA boundary", t => {
  const f = siblingCarry(t); const e = f.evidence;
  assert.deepEqual(targetedEvidenceProblems(e, f.published, f.wt), []);
  e.testRuns[0].commit = f.boundary;
  e.treeEquivalentCarry.runs[0].result.commit = f.boundary;
  assert.match(targetedEvidenceProblems(e, f.published, f.wt).join(), /scope includes this lane/);
});

test("unchanged lanes retain the older QA-boundary result through the repaired proof and sibling publication", t => {
  const f = siblingCarry(t, "  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node lint.mjs\n", true);
  const command = workflowLaneDefinitions(readFileSync(path.join(f.wt, ".github/workflows/ci.yml"), "utf8")).find(lane => lane.name === "lint").command;
  const result = { lane: "lint", command, status: "passed", exitCode: 0, commit: f.earliest, laneKey: "9".repeat(16) };
  const coveredFiles = f.evidence.treeEquivalentCarry.runs[0].coveredFiles.filter(file => file.path !== "service.mjs");
  const source = committedSourceIdentity(f.wt, f.earliest);
  const bytes = JSON.stringify({ version: 1, source, result, coveredFiles });
  const file = path.join(f.g("rev-parse", "--absolute-git-dir"), "lint-result.json"); writeFileSync(file, bytes);
  f.evidence.targetedInventory.laneReport.matches.push({ name: "lint", command });
  f.evidence.testRuns.push(result);
  f.evidence.treeEquivalentCarry.runs.push({ scopeKey: f.evidence.qaImpact.laneKey, result: structuredClone(result), coveredFiles,
    receipt: { path: "lint-result.json", sha256: createHash("sha256").update(bytes).digest("hex") } });
  assert.deepEqual(targetedEvidenceProblems(f.evidence, f.published, f.wt), []);
  f.evidence.treeEquivalentCarry.runs.pop();
  assert.match(targetedEvidenceProblems(f.evidence, f.published, f.wt).join(), /lane lint: no passing run/);
});

test("the comment adapter verifies workflow/tree carry through the same gate and names the source honestly", t => {
  const f = siblingCarry(t);
  f.evidence.touchFlows = [];
  f.evidence.touchFlowsReason = "fixture";
  f.evidence.testSelection = [
    { file: "service.mjs", selector: "related", tests: [] },
    { file: "service.mjs", selector: "e2e-reference", tests: [] }];
  f.evidence.e2eCapability = { selectedTier: null, container: { dockerPresent: false, dockerReachable: false,
    memoryGiB: 0, diskGiB: 0, minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "fixture probe" },
    native: { available: false, forbidden: false }, remote: { available: false } };
  const text = renderEvidenceComment(f.evidence, f.wt);
  assert.ok(text.includes(f.published)); assert.ok(text.includes(".github/workflows/ci.yml"));
  assert.throws(() => renderEvidenceComment(f.evidence), /incomplete/);
});

test("an open pull request push carries prior host QA only across a verified non-rendering delta from the published head", (t) => {
  const fixture = makeHome("pr-facts-follow-up-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "wt");
  git(fixture.root, ["init", "--quiet", "--initial-branch=main", worktree], fixture.home);
  const ui = "apps/web/src/Card.tsx";
  mkdirSync(path.join(worktree, "apps/web/src"), { recursive: true });
  writeFileSync(path.join(worktree, ui), "export const Card = () => null;\n");
  writeFileSync(path.join(worktree, "README.md"), "base\n");
  git(worktree, ["add", "-A"], fixture.home);
  git(worktree, ["commit", "--quiet", "-m", "earlier QA point"], fixture.home);
  const earlier = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  writeFileSync(path.join(worktree, "README.md"), "published\n");
  git(worktree, ["commit", "--quiet", "-am", "published head"], fixture.home);
  const published = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  writeFileSync(path.join(worktree, "README.md"), "follow-up wording\n");
  git(worktree, ["commit", "--quiet", "-am", "non-rendering follow-up"], fixture.home);
  const head = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  const { writeSessionRecord } = sessionRecords;
  writeSessionRecord(worktree, { pullRequest: { number: 42, head: published } });
  const command = "pnpm qa:web-host";
  const request = { lastQa: { boundary: published }, evidence: { screens: [] }, graphImporters: { importers: {} },
    featureMap: { entries: [] }, laneSelections: { files: { [ui]: [command] } }, config: { docs: [] } };
  const prior = { lane: "web-host", command, status: "passed", outcome: "card renders", commit: published };
  const carried = { lane: "web-host", command, status: "not-run", reason: "delta renders nothing", commit: head, carriedFrom: published };
  const evidence = (runs, extra = {}) => ({ touchFlows: [], touchFlowsReason: "card only", qaImpactRequest: request, runs, ...extra });
  const changed = [ui, "README.md"];
  const refused = (problems, why) => assert.notDeepEqual(problems, [], why);
  assert.deepEqual(evidenceProblems(evidence([prior, carried]), changed, head, worktree), []);

  refused(evidenceProblems(evidence([prior, { ...carried, carriedFrom: "b".repeat(40) }]), changed, head, worktree),
    "a carry from anything but the published head is refused");
  refused(evidenceProblems(evidence([prior, carried, { ...carried, carriedFrom: "b".repeat(40) }]), changed, head, worktree),
    "a second carry record naming another source is refused even beside a valid one");
  refused(evidenceProblems(evidence([prior, carried], { qaImpactRequest: { ...request, lastQa: { boundary: earlier } } }), changed, head, worktree),
    "a last-QA point older than the published head does not carry, even across a docs-only delta");
  refused(evidenceProblems(evidence([{ ...prior, status: "failed" }, carried]), changed, head, worktree),
    "a carry needs the prior run passed on the published head");
  refused(evidenceProblems(evidence([carried]), changed, head, worktree),
    "a carry with no prior run is refused");
  refused(evidenceProblems(evidence([prior, carried], { qaImpactRequest: { ...request, lastQa: { boundary: head } } }), changed, head, worktree),
    "the recorded last-QA point must be the published head");

  const sameMain = { lane: "web-host", command, status: "main-preexisting", outcome: "fails on main too", commit: head, mainSha: "9".repeat(40), ...pairedMainFailure };
  assert.deepEqual(evidenceProblems(evidence([sameMain]), changed, head, worktree), [], "a failure paired with the same failure on main does not block the push");
  refused(evidenceProblems(evidence([{ ...sameMain, mainFailures: [{ id: "other test", assertion: "other assertion" }] }]), changed, head, worktree),
    "a main failure with a different test or assertion is not the same failure");

  writeFileSync(path.join(worktree, ui), "export const Card = () => 'changed';\n");
  git(worktree, ["commit", "--quiet", "-am", "rendering follow-up"], fixture.home);
  const rendering = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  refused(evidenceProblems(evidence([prior, { ...carried, commit: rendering }]), changed, rendering, worktree),
    "a delta that renders needs a new host run");
  writeSessionRecord(worktree, { pullRequest: { number: 42, head } });
  refused(evidenceProblems(evidence([{ ...prior, commit: head }, { ...carried, carriedFrom: head }]), changed, head, worktree),
    "the published head itself never carries to itself");
});
