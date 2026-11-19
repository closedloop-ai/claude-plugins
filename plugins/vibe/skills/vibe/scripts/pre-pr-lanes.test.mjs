import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bindProvider, PROVIDER_BINDING } from "./test-fixtures.mjs";
import { fleetLaneInvocation, graphSelectionFromItem, lanePreflightProblem, NOT_RUN_NO_DESKTOP_HARNESS, NOT_RUN_NO_IDENTITY, stagingIdentity, hasStagingE2eIdentity, hasDisplaylessElectronHarness, isDesktopE2eLane, isWebE2eLane, missingLanes, notRunLanes, reportLanes, sharedMainFailures, targetedE2eCoverage, targetedRecord } from "./pre-pr-lanes.mjs";
import { git, makeHome } from "./test-fixtures.mjs";
import { spawnSync } from "node:child_process";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { workflowLaneDefinitions } from "../../handoff/scripts/ci-job-shape.mjs";

const { sourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");

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

test("AC-018 pre-PR lanes records the exact declared workflow recipe for non-pnpm CI", (t) => {
  const { root, home, cleanup } = makeHome("vibe-pre-pr-workflow-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  git(worktree, ["remote", "add", "origin", "https://github.com/acme/widgets.git"], home);
  const workflow = ".github/workflows/ci.yml";
  const workflowText = JSON.stringify({ on: "push", jobs: { python: { "runs-on": "ubuntu-latest",
    steps: [{ run: "uv run pytest -q" }] } } });
  mkdirSync(path.join(worktree, path.dirname(workflow)), { recursive: true });
  writeFileSync(path.join(worktree, workflow), workflowText);
  writeFileSync(path.join(worktree, "vibe-handoff-paths.json"), JSON.stringify({ laneSource: { kind: "github-workflow", path: workflow } }));
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "workflow"], home);
  const head = git(worktree, ["rev-parse", "HEAD"], home);
  const reportFile = path.join(root, "lanes.json");
  const matches = workflowLaneDefinitions(workflowText).map(({ name, command }) => ({ name, command }));
  assert.match(matches[0].command, /uv run pytest -q/);
  const report = { source: { kind: "github-workflow", path: workflow, commit: head,
    sha256: createHash("sha256").update(workflowText).digest("hex") }, matches };
  writeFileSync(reportFile, JSON.stringify(report));
  const run = (action, ...args) => spawnSync(process.execPath, [SCRIPT, action, "--worktree", worktree, "--report", reportFile, ...args], {
    cwd: worktree, env: { ...process.env, HOME: home, CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "" }, encoding: "utf8",
  });
  const needed = run("check");
  assert.equal(needed.status, 1, needed.stderr);
  assert.ok(needed.stdout.includes(`MISSING-LANE ${matches[0].command}`));
  const triedShell = run("run", "--head", head, "--command", matches[0].command);
  assert.equal(triedShell.status, 2, triedShell.stderr);
  assert.match(triedShell.stderr, /workflow recipe is a CI lane identity/);
  const cloudResult = path.join(root, "cloud-result.json");
  writeFileSync(cloudResult, JSON.stringify({ commit: head, repository: "acme/widgets",
    provenance: { host: "claude-cloud-1", remote: "true", origin: "https://github.com/acme/widgets.git", commit: head },
    laneSource: report.source,
    lanes: [{ name: "python", command: matches[0].command, exitCode: 0, passed: true }] }));
  const wrongRepo = path.join(root, "wrong-repo.json");
  writeFileSync(wrongRepo, readFileSync(cloudResult, "utf8").replaceAll("acme/widgets", "elsewhere/repo"));
  const refusedCloud = run("record", "--head", head, "--command", matches[0].command, "--result", "pass", "--cloud-result", wrongRepo);
  assert.equal(refusedCloud.status, 2, refusedCloud.stderr);
  assert.match(refusedCloud.stderr, /repository differs/);
  const recorded = run("record", "--head", head, "--command", matches[0].command, "--result", "pass", "--cloud-result", cloudResult);
  assert.equal(recorded.status, 0, recorded.stderr);
  const evidence = JSON.parse(readFileSync(path.join(worktree, ".git", "vibe-lane-results.json"), "utf8"))[0];
  assert.deepEqual({ host: evidence.ranOn.host, repository: evidence.ranOn.repository, proofCommit: evidence.ranOn.proofCommit,
    lane: evidence.ranOn.lane, source: evidence.ranOn.source }, {
    host: "claude-cloud-1", repository: "acme/widgets", proofCommit: head, lane: "python", source: "cloud-worker",
  });
  assert.equal(run("check").status, 0);
  writeFileSync(reportFile, JSON.stringify({ ...report, matches: [{ name: "python", command: "uv run pytest -q" }] }));
  const tampered = run("check");
  assert.equal(tampered.status, 2, tampered.stderr);
  assert.match(tampered.stderr, /every exact workflow job\/matrix recipe/);
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

test("ISS-14307: a repository-authorized targeted E2E receipt is scope-bound and includes changed specs", async (t) => {
  const { root, home, cleanup } = makeHome("vibe-pre-pr-targeted-e2e-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  mkdirSync(path.join(worktree, "e2e"));
  git(worktree, ["remote", "add", "origin", "git@github.com:example/product.git"], home);
  writeFileSync(path.join(worktree, "AGENTS.md"), [
    "An e2e lane (`e2e`, `desktop-e2e`) is the exception: locally it is satisfied by the specs closedloop-graph selects for the diff (`code_tests_for_changes`), plus every spec the PR adds or edits.",
    "The full lane runs after merge.",
  ].join("\n"));
  writeFileSync(path.join(worktree, "e2e/existing.spec.ts"), "export const existing = true;\n");
  writeFileSync(path.join(worktree, "e2e/direct.spec.ts"), "export const direct = true;\n");
  writeFileSync(path.join(worktree, "deleted.ts"), "export const removed = true;\n");
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "base"], home);
  const base = git(worktree, ["rev-parse", "HEAD"], home);
  git(worktree, ["update-ref", "refs/remotes/origin/main", base], home);
  writeFileSync(path.join(worktree, "e2e/added.spec.ts"), "export const added = true;\n");
  rmSync(path.join(worktree, "deleted.ts"));
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "change"], home);
  const head = git(worktree, ["rev-parse", "HEAD"], home);
  const lane = "pnpm test:e2e";
  const report = path.join(root, "lanes.txt");
  writeFileSync(report, `    ${lane}\n`);
  const graphItem = { type: "mcpToolCall", id: "graph-call-1", server: "graph", tool: "code_tests_for_changes", status: "completed",
    arguments: { repo: "product", files: [{ path: "e2e/added.spec.ts", status: "added" }, { path: "deleted.ts", status: "deleted" }] },
    result: { structuredContent: { repo: "product", desktop_e2e: { verdict: "RUN_ALL", start_here: { specs: ["e2e/existing.spec.ts"], specs_total: 1 } },
      tier2: { rows: [{ test: "e2e/direct.spec.ts" }], candidates_total: 1 }, unrelated: "e2e/unrelated.spec.ts" } } };
  const readTurn = async () => ({ items: [graphItem] });
  const baseValues = { worktree, base, graphSelector: "code_tests_for_changes", "graph-session": "thread-1", "graph-turn": "turn-1" };
  const graphQuery = JSON.stringify(graphItem.arguments);
  const specs = ["e2e/added.spec.ts", "e2e/direct.spec.ts", "e2e/existing.spec.ts"];
  const record = (...specs) => targetedRecord({ ...baseValues, "targeted-specs": JSON.stringify(specs), "graph-query": graphQuery }, lane, readTurn);
  assert.deepEqual(graphSelectionFromItem(graphItem, "code_tests_for_changes")?.result,
    { mode: "RUN_ALL", selected: ["e2e/direct.spec.ts", "e2e/existing.spec.ts"] });

  await assert.rejects(record("e2e/existing.spec.ts"), /exactly match graph-selected plus added or edited/);
  // Decision 17 (operator ruling, 2026-11-18): the recording syntax lives in the refusal, not in the worker's instructions.
  await assert.rejects(targetedRecord({ ...baseValues, "graph-session": undefined, "graph-turn": undefined, "graph-launcher-result": undefined,
    "targeted-specs": JSON.stringify(specs), "graph-query": graphQuery }, lane, readTurn),
  /--graph-session <native thread> --graph-turn <completed turn> in Codex, or --graph-launcher-result <owned Claude launcher result> in Claude/);
  await assert.rejects(targetedRecord({ ...baseValues, "targeted-specs": JSON.stringify(["e2e/existing.spec.ts", "e2e/added.spec.ts"]),
    "graph-query": "   " }, lane, readTurn), /non-empty graph query/);
  const recorded = await record(...specs);
  const checkArguments = (args) => () => ({ items: [{ ...graphItem, arguments: args }] });
  const alteredProof = (args) => targetedRecord({ ...baseValues, "targeted-specs": JSON.stringify(specs),
    "graph-query": JSON.stringify(args) }, lane, checkArguments(args));
  await assert.rejects(alteredProof({ ...graphItem.arguments, repo: "another-repo" }), /repository/);
  await assert.rejects(alteredProof({ ...graphItem.arguments, e2e: false }), /excluded E2E selection/);
  const narrowed = { ...graphItem.arguments, files: ["e2e/added.spec.ts"] };
  await assert.rejects(alteredProof(narrowed), /exact changed-file scope/);
  const incomplete = structuredClone(graphItem);
  incomplete.result.structuredContent.desktop_e2e.start_here.specs_total = 2;
  await assert.rejects(targetedRecord({ ...baseValues, "targeted-specs": JSON.stringify(specs), "graph-query": graphQuery },
    lane, () => ({ items: [incomplete] })), /incomplete/);
  const selected = { laneKey: "scope-1", source: { treeSha256: "tree-1" } };
  const records = [{ command: lane, result: "pass", targeted: recorded, laneKey: selected.laneKey, source: selected.source }];
  assert.deepEqual(await targetedE2eCoverage(baseValues, [lane], records, selected, readTurn),
    [{ lane, specs }]);
  const replay = structuredClone(records);
  replay[0].targeted.graphQuery = JSON.stringify(narrowed);
  replay[0].targeted.graph.query = JSON.stringify(narrowed);
  assert.deepEqual(await targetedE2eCoverage(baseValues, [lane], replay, selected, checkArguments(narrowed)), []);

  const desktopLane = "pnpm --filter desktop run test:e2e";
  const desktopProof = (args) => targetedRecord({ ...baseValues, "targeted-specs": JSON.stringify(specs),
    "graph-query": JSON.stringify(args) }, desktopLane, checkArguments(args));
  assert.deepEqual((await desktopProof({ repo: "product", change: { base, head } })).specs, specs);
  const baseBlob = git(worktree, ["rev-parse", `${base}:deleted.ts`], home);
  for (const hunks of [
    { "deleted.ts": { base_blob: baseBlob, hunks: [{ base_start: 1, base_count: 1, added: [] }] } },
    { "deleted.ts": { base_blob: "0".repeat(40), hunks: [{ base_start: 1, base_count: 1, added: [] }] } },
  ]) {
    const callerHunks = { ...graphItem.arguments, hunks };
    await assert.rejects(desktopProof(callerHunks), /caller-supplied hunks/);
    const stale = structuredClone(records);
    stale[0].command = desktopLane;
    stale[0].targeted.graphQuery = JSON.stringify(callerHunks);
    stale[0].targeted.graph.query = stale[0].targeted.graphQuery;
    assert.deepEqual(await targetedE2eCoverage(baseValues, [desktopLane], stale, selected, checkArguments(callerHunks)), []);
  }

  const trace = path.join(root, "claude-graph-trace.jsonl");
  const launcher = path.join(root, "claude-graph-result.json");
  writeFileSync(trace, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "claude-graph-1",
    name: "mcp__graph__code_tests_for_changes", input: graphItem.arguments }] } })}\n${JSON.stringify({ type: "user", message: { content: [{
    type: "tool_result", tool_use_id: "claude-graph-1", content: JSON.stringify(graphItem.result.structuredContent) }] } })}\n`);
  writeFileSync(launcher, JSON.stringify({ runtime: "claude", status: "DONE", sessionId: "claude-session-1", tracePath: trace, source: sourceIdentity(worktree) }));
  const claudeValues = { worktree, base, graphSelector: "code_tests_for_changes", "graph-launcher-result": launcher,
    "graph-query": graphQuery, "targeted-specs": JSON.stringify(specs) };
  const claudeTargeted = await targetedRecord(claudeValues, lane);
  assert.equal(claudeTargeted.graph.runtime, "claude");
  const claudeRecords = [{ command: lane, result: "pass", targeted: claudeTargeted, laneKey: selected.laneKey, source: selected.source }];
  assert.equal((await targetedE2eCoverage(claudeValues, [lane], claudeRecords, selected)).length, 1);
  writeFileSync(trace, `${readFileSync(trace, "utf8")}\n`);
  assert.deepEqual(await targetedE2eCoverage(claudeValues, [lane], claudeRecords, selected), []);

  const missingRuntime = structuredClone(records);
  delete missingRuntime[0].targeted.graph;
  assert.deepEqual(await targetedE2eCoverage(baseValues, [lane], missingRuntime, selected, readTurn), []);
  const changedRead = async () => ({ items: [{ ...graphItem, result: { structuredContent: { mode: "SELECTED", selected: ["e2e/other.spec.ts"] } } }] });
  assert.deepEqual(await targetedE2eCoverage(baseValues, [lane], records, selected, changedRead), []);

  writeFileSync(path.join(worktree, "README.md"), "scope moved\n");
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "moved"], home);
  assert.deepEqual(await targetedE2eCoverage(baseValues, [lane], records, selected, readTurn), []);

  writeFileSync(path.join(worktree, "AGENTS.md"), "Every lane runs in full locally.\n");
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "remove policy"], home);
  assert.deepEqual(await targetedE2eCoverage(baseValues, [lane], records, selected, readTurn), []);
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

test("ISS-14387 a lane run elsewhere is recorded main-preexisting only with a main commit and the same failures on both sides", (t) => {
  const { root, home, cleanup } = makeHome("vibe-pre-pr-lanes-record-main-");
  t.after(cleanup);
  const worktree = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", worktree], home);
  writeFileSync(path.join(worktree, "a.txt"), "main\n");
  git(worktree, ["add", "a.txt"], home);
  git(worktree, ["commit", "--quiet", "-m", "main"], home);
  const mainSha = git(worktree, ["rev-parse", "HEAD"], home).trim();
  git(worktree, ["update-ref", "refs/remotes/origin/main", mainSha], home);
  writeFileSync(path.join(worktree, "a.txt"), "session\n");
  git(worktree, ["commit", "--quiet", "--all", "-m", "session"], home);
  const head = git(worktree, ["rev-parse", "HEAD"], home).trim();
  const lane = "pnpm --filter @repo/app test";
  const report = path.join(root, "lanes.txt");
  writeFileSync(report, `IN THE TURBO GRAPH: 1 packages\n    ${lane}\n`);
  const red = { id: "list.test.ts > sorts rows", assertion: "expected [ 2, 1 ] to deeply equal [ 1, 2 ]" };
  const failures = (input) => { const file = path.join(root, `failures-${Math.random().toString(16).slice(2)}.json`); writeFileSync(file, JSON.stringify(input)); return file; };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, "record", "--worktree", worktree, "--head", head, "--command", lane, "--report", report, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const refused = [
    [["--result", "main-preexisting", "--main-sha", mainSha], /needs --main-sha and --failures/],
    [["--result", "main-preexisting", "--main-sha", head, "--failures", failures({ branch: [red], main: [red] })], /not a commit on this clone's fetched origin\/main/],
    [["--result", "main-preexisting", "--main-sha", mainSha, "--failures", failures({ branch: [red], main: [{ ...red, assertion: "expected 3" }] })], /does not fail on main with the same assertion/],
    [["--result", "main-preexisting", "--main-sha", mainSha, "--failures", failures({ branch: [], main: [red] })], /nonempty branch and main lists/],
    [["--result", "pass", "--failures", failures({ branch: [red], main: [red] })], /--failures goes only with it/],
  ];
  for (const [args, message] of refused) {
    const out = run(...args);
    assert.notEqual(out.status, 0, args.join(" "));
    assert.match(out.stderr + out.stdout, message, args.join(" "));
  }
  assert.equal(existsSync(path.join(worktree, ".git", "vibe-lane-results.json")), false, "a refused record writes nothing");
  const recorded = run("--result", "main-preexisting", "--main-sha", mainSha, "--failures", failures({ branch: [red], main: [red, { id: "other", assertion: "x" }] }));
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  const [entry] = JSON.parse(readFileSync(path.join(worktree, ".git", "vibe-lane-results.json"), "utf8"));
  assert.deepEqual([entry.result, entry.mainSha, entry.mainSource.head, entry.failures], ["main-preexisting", mainSha, mainSha, [red]]);
  const checked = spawnSync(process.execPath, [SCRIPT, "check", "--worktree", worktree, "--report", report], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.match(checked.stdout, /^MAIN-PREEXISTING-LANE pnpm --filter @repo\/app test/m);
  assert.deepEqual(sharedMainFailures({ branch: [red], main: [red] }), [red]);
});

