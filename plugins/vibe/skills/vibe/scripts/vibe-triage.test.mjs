import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ACTIONS, CLASSES, E2E_SOURCE, NO_SOURCE, POLICY, POLICY_STEPS, REVIEW_EFFECTIVE, SWITCH_ENV, classify, parsePathList, pathKind, switchOn, validateManifest } from "./vibe-triage.mjs";
import { chooseDispatch } from "../../fleet-orchestrator/scripts/dispatch-route.mjs";
import { recordHandoffGate } from "../../handoff/scripts/handoff-gate.mjs";
import { prEvidenceValidationProblems } from "../../handoff/scripts/pr-facts.mjs";
import { COMMIT as RULED_COMMIT, FILES as RULED_FILES, RULINGS, ruledEvidence } from "../../handoff/scripts/targeted-tests-ruling-test-fixture.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { decideCloudPlacement } = await vibeCore("lib/fleet-orchestrator/scripts/cloud-placement.mjs");
const { abandonDispatch, cloudPrProblem, codexStatus, followupClaude, generateBrief, hydrateCloudRequest, importResult, pollTask, readyForPr, recordCloudEvidence, refreshImportWitness, remoteTrigger, startClaude, startCodex, validateRequest, verifyAuthor } = await vibeCore("lib/vibe/scripts/cloud-worker.mjs");
const { readSessionRecord, writeSessionRecord } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { prCreateGuard } = await vibeCore("hooks/pr-create-guard.mjs");
const { captureReviewReceipt, REVIEW_ROLES } = await vibeCore("lib/handoff/scripts/review-receipts.mjs");
const { sourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "vibe-triage.mjs");
const run = (args, env = {}) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, [SWITCH_ENV]: "", ...env } });

const BACKEND_PATHS = ["apps/api/app/documents/route.ts", "apps/api/app/documents/route.test.ts", "packages/api/src/types/audit.ts"];
const WEB_UI_PATHS = ["apps/app/components/header.tsx", "apps/app/components/footer.tsx"];

test("paths decide the class: backend only, docs only, one UI file, several UI files, UI with backend, metric, prototypes", () => {
  assert.equal(classify({ paths: BACKEND_PATHS }).class, CLASSES.Backend);
  assert.equal(classify({ paths: ["docs/guide.md", "scripts/deploy/run.sh", "e2e/helpers/auth.ts"] }).class, CLASSES.DocsConfig);
  assert.equal(classify({ paths: ["apps/app/components/header.tsx", "apps/app/components/header.test.tsx"] }).class, CLASSES.TrivialUi);
  assert.equal(classify({ paths: WEB_UI_PATHS }).class, CLASSES.UiFeature);
  assert.equal(classify({ paths: [...WEB_UI_PATHS, ...BACKEND_PATHS] }).class, CLASSES.UiFeature);
  assert.equal(classify({ paths: ["packages/app/cost/cost-card.tsx"] }).class, CLASSES.DataMetric);
  assert.equal(classify({ paths: ["apps/prototypes/a/page.tsx"] }).class, CLASSES.Mockup);
});

test("a path in no known area leaves the class unknown, never guessed", () => {
  const manifest = classify({ paths: ["Dockerfile.unknown-area"] });
  assert.equal(manifest.class, CLASSES.Unknown);
  assert.equal(manifest.steps.environment.recommendation.action, ACTIONS.Unknown);
  assert.deepEqual(manifest.skipped, []);
});

test("text decides before paths exist, and text that names no one area stays unknown", () => {
  assert.equal(classify({ request: "Add an audit entry to the write path of the documents API route" }).class, CLASSES.Backend);
  assert.equal(classify({ request: "Rename the header on the settings page" }).class, CLASSES.UiFeature);
  assert.equal(classify({ request: "Make me a mockup with fake data" }).class, CLASSES.Mockup);
  assert.equal(classify({ request: "Why does the total cost differ between two screens" }).class, CLASSES.DataMetric);
  assert.equal(classify({ request: "Make it better" }).class, CLASSES.Unknown);
  assert.equal(classify({ request: "The prototype decides the board lanes; the board header lists them" }).class, CLASSES.UiFeature, "a prototype the ticket cites is not a request for a mockup");
});

test("text alone never recommends leaving a step out", () => {
  const manifest = classify({ request: "Add an audit entry to the write path of the documents API route" });
  assert.equal(manifest.class, CLASSES.Backend);
  assert.deepEqual(manifest.evidence.sources, ["text"]);
  for (const id of ["environment", "desktop"]) assert.equal(manifest.steps[id].recommendation.action, ACTIONS.Unknown, id);
  assert.deepEqual(manifest.skipped, []);
});

test("known paths decide the class; the request text never overrides them", () => {
  const docs = classify({ paths: ["docs/guide.md"], request: "Update the runbook for the cost dashboard" });
  assert.equal(docs.class, CLASSES.DocsConfig);
  assert.deepEqual(docs.evidence.sources, ["paths"]);
  assert.equal(docs.steps.desktop.recommendation.action, ACTIONS.Skip);
  assert.equal(docs.steps.environment.recommendation.action, ACTIONS.Defer);
  assert.deepEqual(docs.steps.extraGates.gates, []);
  const column = ["apps/app/components/projects-board.tsx"];
  const withPaths = classify({ paths: column, request: "Rename the Total column header on the Projects board" });
  assert.equal(withPaths.class, CLASSES.TrivialUi);
  assert.deepEqual(withPaths.steps.extraGates.gates, []);
  const twoFiles = classify({ paths: [...column, "apps/app/components/projects-header.tsx"], request: "Show the cost total in the header" });
  assert.equal(twoFiles.class, CLASSES.UiFeature);
});

test("a text-only request about a column header leaves nothing out, with no paths to decide it", () => {
  const manifest = classify({ request: "Rename the Total column header on the Projects board" });
  assert.deepEqual(manifest.evidence.sources, ["text"]);
  assert.deepEqual(manifest.skipped, []);
  for (const id of ["environment", "desktop"]) assert.ok([ACTIONS.Run, ACTIONS.Unknown].includes(manifest.steps[id].recommendation.action), id);
});

test("the Desktop relevance check reads the shared Desktop host list: any apps/desktop path or packages/app, the main process included", () => {
  assert.equal(classify({ paths: ["apps/desktop/src/main/a.ts", "apps/desktop/src/main/b.ts"] }).steps.desktop.recommendation.action, ACTIONS.Run);
  assert.equal(classify({ paths: ["apps/desktop/src/renderer/a.tsx", "apps/api/x.ts"] }).steps.desktop.recommendation.action, ACTIONS.Run);
  assert.equal(pathKind("packages/app/x.ts"), "ui");
});

test("with touched paths, a backend session recommends deferring the environment and skipping Desktop, each logged with reason and evidence", () => {
  const manifest = classify({ paths: BACKEND_PATHS });
  assert.equal(manifest.steps.environment.recommendation.action, ACTIONS.Defer);
  assert.equal(manifest.steps.desktop.recommendation.action, ACTIONS.Skip);
  assert.deepEqual(manifest.skipped.map((entry) => entry.step), ["environment", "desktop"]);
  for (const entry of manifest.skipped) {
    assert.ok(entry.reason);
    assert.ok(entry.evidence.length > 0);
    assert.equal(entry.applied, false);
  }
});

test("Desktop-relevant evidence keeps Desktop: apps/desktop, packages/app, or the request naming Desktop", () => {
  for (const paths of [["packages/app/sessions/list.tsx", "packages/app/sessions/row.tsx"], ["apps/desktop/src/renderer/a.tsx", "apps/desktop/src/renderer/b.tsx"]]) {
    assert.equal(classify({ paths }).steps.desktop.recommendation.action, ACTIONS.Run, paths[0]);
  }
  assert.equal(classify({ paths: WEB_UI_PATHS }).steps.desktop.recommendation.action, ACTIONS.Skip, "web-only UI files name no Desktop surface");
  assert.equal(classify({ paths: WEB_UI_PATHS, request: "Show it on web and Desktop" }).steps.desktop.recommendation.action, ACTIONS.Run);
  assert.equal(classify({ paths: ["apps/app/a.tsx", "apps/app/b.tsx", "apps/api/x.ts"] }).steps.environment.recommendation.action, ACTIONS.Run);
});

test("the switch is off by default and every step's effective stays run, whatever the recommendations say", () => {
  assert.equal(switchOn({}), false);
  assert.equal(switchOn({ [SWITCH_ENV]: "0" }), false);
  assert.equal(switchOn({ [SWITCH_ENV]: "true" }), false);
  for (const input of [{ paths: BACKEND_PATHS }, { paths: ["docs/a.md"] }, { paths: WEB_UI_PATHS }, { request: "Make it better" }]) {
    const manifest = classify(input);
    assert.equal(manifest.applyRecommendations, false);
    for (const id of POLICY_STEPS) assert.equal(manifest.steps[id].effective, ACTIONS.Run, `${id} ${JSON.stringify(input)}`);
  }
});

test("the CLI reads the switch: off without it, on with it, and the manifest records which", () => {
  const off = JSON.parse(run(["classify", "--paths", BACKEND_PATHS.join(",")]).stdout);
  assert.equal(off.applyRecommendations, false);
  assert.equal(off.steps.environment.effective, ACTIONS.Run);
  assert.equal(off.steps.desktop.effective, ACTIONS.Run);
  const on = JSON.parse(run(["classify", "--paths", BACKEND_PATHS.join(",")], { [SWITCH_ENV]: "1" }).stdout);
  assert.equal(on.applyRecommendations, true);
  assert.equal(on.steps.environment.effective, ACTIONS.Defer);
  assert.equal(on.steps.desktop.effective, ACTIONS.Skip);
  assert.ok(on.skipped.every((entry) => entry.applied === true));
  assert.equal(on.steps.ticket.effective, ACTIONS.Run, "the switch never touches the other policy steps");
  assert.equal(on.steps.decisionTable.effective, ACTIONS.Run);
  assert.equal(on.steps.handoffSteps.effective, ACTIONS.Run);
});

test("every class records the policy steps and takes lanes and e2e from test:lanes", () => {
  for (const input of [{ paths: BACKEND_PATHS }, { paths: ["docs/a.md"] }, { paths: WEB_UI_PATHS }, { paths: ["apps/app/a.tsx"] }, { paths: ["apps/prototypes/a.tsx"] }, { request: "Make it better" }]) {
    const manifest = classify(input);
    for (const id of POLICY_STEPS) assert.equal(manifest.steps[id].state, POLICY, id);
    assert.equal(manifest.steps.e2e.source, E2E_SOURCE);
    assert.ok(manifest.steps.review.scope);
    validateManifest(manifest);
  }
  assert.deepEqual(classify({ paths: BACKEND_PATHS }).steps.extraGates.gates, ["workflow-code-review"]);
  assert.deepEqual(classify({ paths: ["packages/app/cost/cost-card.tsx"] }).steps.extraGates.gates, ["logical-qa"]);
});

test("validation rejects a manifest that drops a log entry, a reason, or lets effective move with the switch off", () => {
  const good = () => structuredClone(classify({ paths: BACKEND_PATHS }));
  validateManifest(good());
  const unlogged = good();
  unlogged.skipped.pop();
  assert.throws(() => validateManifest(unlogged), /skipped must log/);
  const noReason = good();
  noReason.skipped[0].reason = "";
  assert.throws(() => validateManifest(noReason), /needs a reason and evidence/);
  const noEvidence = good();
  noEvidence.steps.desktop.recommendation.evidence = [];
  assert.throws(() => validateManifest(noEvidence), /without evidence/);
  const moved = good();
  moved.steps.desktop.effective = ACTIONS.Skip;
  assert.throws(() => validateManifest(moved), /effective must be "run"/);
  const waived = good();
  waived.steps.decisionTable.effective = ACTIONS.Skip;
  assert.throws(() => validateManifest(waived), /always runs/);
  const skippedEnv = good();
  skippedEnv.steps.environment.recommendation.action = ACTIONS.Skip;
  assert.throws(() => validateManifest(skippedEnv), /deferred, never skipped/);
  assert.throws(() => validateManifest({ ...good(), schemaVersion: 2 }), /schemaVersion/);
});

test("check validates a manifest file and exits 1 on a bad one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-triage-"));
  const file = path.join(dir, "manifest.json");
  const written = run(["classify", "--paths", BACKEND_PATHS.join(","), "--out", file]);
  assert.equal(written.status, 0);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).class, CLASSES.Backend);
  assert.equal(run(["check", "--manifest", file]).status, 0);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1 }));
  const bad = run(["check", "--manifest", file]);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
});

test("the same input gives the same manifest", () => {
  assert.deepEqual(classify({ paths: BACKEND_PATHS, request: "x" }), classify({ paths: BACKEND_PATHS, request: "x" }));
  assert.deepEqual(parsePathList("a.ts, ./b.ts\nc.ts\n"), ["a.ts", "b.ts", "c.ts"]);
  assert.equal(pathKind("apps/api/app/x.test.ts"), "test");
});

test("paths are recorded as the brief's likely files with their sources, and the class is still set once from them", () => {
  const sources = [{ path: BACKEND_PATHS[0], source: "closedloop-graph code_symbols" }, { path: BACKEND_PATHS[2], source: "FEATURE_MAP entry documents" }];
  const manifest = classify({ paths: BACKEND_PATHS, pathSources: sources });
  assert.deepEqual(manifest.evidence.likelyFiles, [
    { path: BACKEND_PATHS[0], source: "closedloop-graph code_symbols" },
    { path: BACKEND_PATHS[1], source: NO_SOURCE },
    { path: BACKEND_PATHS[2], source: "FEATURE_MAP entry documents" },
  ]);
  assert.deepEqual(manifest.evidence.paths, BACKEND_PATHS);
  assert.equal(manifest.class, CLASSES.Backend);
  validateManifest(manifest);
  const bad = structuredClone(manifest);
  bad.evidence.likelyFiles.pop();
  assert.throws(() => validateManifest(bad), /likelyFiles must list exactly evidence.paths/);
  const noSource = structuredClone(manifest);
  noSource.evidence.likelyFiles[0].source = "";
  assert.throws(() => validateManifest(noSource), /needs a path and a source/);
});

test("no likelyFiles means no paths: the class comes from the text alone and records no likely files", () => {
  const manifest = classify({ request: "Add an audit entry to the write path of the documents API route" });
  assert.deepEqual(manifest.evidence.paths, []);
  assert.deepEqual(manifest.evidence.likelyFiles, []);
  assert.deepEqual(manifest.evidence.sources, ["text"]);
});

test("the CLI takes --paths and --path-sources-file and records them as likely files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-triage-sources-"));
  const sources = path.join(dir, "sources.json");
  writeFileSync(sources, JSON.stringify([{ path: WEB_UI_PATHS[0], source: "FEATURE_MAP entry header" }]));
  const manifest = JSON.parse(run(["classify", "--paths", WEB_UI_PATHS.join(","), "--path-sources-file", sources]).stdout);
  assert.deepEqual(manifest.evidence.likelyFiles.map((entry) => entry.source), ["FEATURE_MAP entry header", NO_SOURCE]);
  const none = JSON.parse(run(["classify", "--request", "Rename the header on the settings page"]).stdout);
  assert.deepEqual(none.evidence.likelyFiles, []);
});

test("the review steps carry effective: apply with the switch on and as-today with it off, and check enforces it", () => {
  const off = classify({ paths: BACKEND_PATHS });
  const on = classify({ paths: BACKEND_PATHS, apply: true });
  for (const id of ["review", "extraGates"]) {
    assert.equal(off.steps[id].effective, REVIEW_EFFECTIVE.AsToday, id);
    assert.equal(on.steps[id].effective, REVIEW_EFFECTIVE.Apply, id);
  }
  const moved = structuredClone(off);
  moved.steps.extraGates.effective = REVIEW_EFFECTIVE.Apply;
  assert.throws(() => validateManifest(moved), /step extraGates effective must be "as-today"/);
});

const cloudRequest = (worktree = '/tmp/vibe-example') => ({
  worktree, ticket: 'ISS-13804', provider: 'codex', model: 'gpt-6-sol', reservedVersion: '1.1.61', branch: 'codex-cloud/iss-13804-cloud',
  repository: 'acme/widgets', codexEnvironment: 'widgets-env',
  placement: { codeOnly: true, needsRunningApp: false, localEvidence: [] },
  criteria: [{ id: 'AC-1', source: 'ISS-13804 v2', text: 'Dispatch autonomously.' }],
  graph: { ownership: 'dispatch-route.mjs owns routing', collisions: 'No active duplicate', blastRadius: 'fleet skill and tests' },
  validationCommands: ['node --test plugins/vibe/skills/fleet-orchestrator/scripts/dispatch-route.test.mjs'], connectorAllowlist: [],
});
const OPERATOR = Object.freeze({ id: 'operator_1', name: 'Test Operator', email: 'operator@example.test' });

test('AC-9: route and dispatcher share the cloud placement corpus and name local-only reasons', () => {
  const cases = [
    [{ codeOnly: true, needsRunningApp: false, localEvidence: [] }, 'cloud', null],
    [{ codeOnly: false, needsRunningApp: false, localEvidence: [] }, 'local', 'code-only'],
    [{ codeOnly: true, needsRunningApp: true, localEvidence: [] }, 'local', 'running app'],
    [{ codeOnly: true, needsRunningApp: false, localEvidence: ['trace'] }, 'local', 'trace'],
    [{ codeOnly: true, needsRunningApp: false, localEvidence: ['App Server item'] }, 'local', 'App Server'],
    [{ codeOnly: true, needsRunningApp: false, localEvidence: ['local log'] }, 'local', 'local log'],
    [{ codeOnly: true, needsRunningApp: false, localEvidence: ['signed-in browser'] }, 'local', 'browser'],
    [{ codeOnly: true, needsRunningApp: false, localEvidence: ['Desktop'] }, 'local', 'Desktop'],
    [undefined, 'local', 'missing'],
  ];
  for (const [placementInput, expected, reason] of cases) {
    const direct = decideCloudPlacement(placementInput);
    const routed = chooseDispatch({ enabled: false, placementInput, manifest: null }).placement;
    assert.deepEqual(routed, direct);
    assert.equal(direct.placement, expected);
    if (reason) {
      assert.match(direct.reason, new RegExp(reason, 'i'));
      assert.throws(() => validateRequest({ ...cloudRequest(), placement: placementInput }), new RegExp(reason, 'i'));
    } else assert.doesNotThrow(() => validateRequest({ ...cloudRequest(), placement: placementInput }));
  }
});

test('AC-2: generated brief embeds sourced criteria, local graph findings and reserved version', () => {
  const request = cloudRequest();
  const brief = generateBrief(request, { operator: OPERATOR });
  for (const phrase of ['ISS-13804 v2', 'Dispatch autonomously.', 'No active duplicate', 'dispatch-route.mjs owns routing', 'fleet skill and tests', '1.1.61', request.validationCommands[0], 'exactly one commit']) assert.ok(brief.includes(phrase), phrase);
  assert.match(brief, /no local Vibe record/);
  assert.throws(() => generateBrief({ ...request, reservedVersion: '' }, { operator: OPERATOR }), /reserved semantic version/);
  assert.throws(() => validateRequest({ ...request, graph: { ownership: 'x', collisions: 'y' } }), /blastRadius/);
});

test('AC-1: Claude clears auto-attached connectors before run and refuses an unconfirmed allow list', async (t) => {
  const request = { ...cloudRequest(), provider: 'claude', branch: 'cloud/iss-13804-cloud', connectorAllowlist: [], claudeEnvironment: 'env_01TestRequest' };
  // Each case gets its own routine ledger home; runs reuse one standing routine per home (ISS-13998).
  const newHome = () => { const home = mkdtempSync(path.join(tmpdir(), 'cloud-ledger-')); t.after(() => rmSync(home, { recursive: true, force: true })); return home; };
  const calls = [];
  const remote = (action, payload) => {
    calls.push({ action, payload });
    if (action === 'create') return { trigger: { id: 'routine_1', mcp_connections: [{ name: 'Slack' }] } };
    if (action === 'update') return { trigger: { id: 'routine_1', mcp_connections: [] } };
    return { session_id: 'run_1' };
  };
  assert.equal((await startClaude(request, 'brief', { remote, home: newHome() })).taskId, 'run_1');
  assert.deepEqual(calls.map((call) => call.action), ['create', 'update', 'run']);
  assert.equal(calls[1].payload.body.clear_mcp_connections, true);
  assert.equal(calls[0].payload.body.job_config.ccr.environment_id, 'env_01TestRequest');
  assert.equal(calls[0].payload.body.job_config.ccr.session_context.model, request.model);
  assert.equal(calls[1].payload.body.job_config.ccr.session_context.model, request.model, 'each run sets its own model through update');
  await assert.rejects(startClaude(request, 'brief', { home: newHome(), remote: (action) => action === 'create' ? { trigger: { id: 'routine_2', mcp_connections: [{ name: 'Slack' }] } } : { trigger: { mcp_connections: [{ name: 'Slack' }] } } }), /connector clearing/);
  assert.throws(() => validateRequest({ ...request, connectorAllowlist: ['slack'] }), /connector allow list/);
  const withClosedLoop = [];
  const allowedRequest = { ...request, connectorAllowlist: ['closedloop'] };
  await startClaude(allowedRequest, 'brief', { home: newHome(), remote: (action, payload) => {
    withClosedLoop.push({ action, payload });
    if (action === 'create') return { trigger: { id: 'routine_3', mcp_connections: [{ name: 'Slack' }, { name: 'ClosedLoop', connector_uuid: 'cl_1' }] } };
    if (action === 'update' && payload.body.clear_mcp_connections) return { trigger: { mcp_connections: [] } };
    if (action === 'update') return { trigger: { mcp_connections: [{ name: 'ClosedLoop' }] } };
    return { session_id: 'run_3' };
  } });
  // One update per run now sets the job_config and the allow-listed connector together (operator ruling q1, ISS-13998).
  assert.deepEqual(withClosedLoop.map((call) => call.action), ['create', 'update', 'run']);
  assert.deepEqual(withClosedLoop[1].payload.body.mcp_connections.map((entry) => entry.name), ['ClosedLoop']);
  assert.equal(withClosedLoop[1].payload.body.clear_mcp_connections, undefined);
});

test('AC-1: RemoteTrigger requires a real matching tool result, not a model-only JSON claim', () => {
  // The tool input carries the whole call, as RemoteTrigger receives it (ISS-13998 F3 binds the result to it).
  const toolOutput = (action, output, input = { action }) => [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool_1', name: 'RemoteTrigger', input } ] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: `HTTP 200\n${JSON.stringify(output)}` }] } }),
  ].join('\n');
  const run = (_command, args) => {
    assert.deepEqual(args.slice(0, 2), ['-p', args[1]]);
    assert.ok(args.includes('RemoteTrigger'));
    assert.ok(args.includes('--no-session-persistence'), 'headless RemoteTrigger must not save a local session');
    return { status: 0, stdout: toolOutput('update', { trigger: { mcp_connections: [] } }, { action: 'update', trigger_id: 'routine_1', body: { clear_mcp_connections: true } }), stderr: '' };
  };
  assert.deepEqual(remoteTrigger('update', { trigger_id: 'routine_1', body: { clear_mcp_connections: true } }, { run }), { trigger: { mcp_connections: [] } });
  assert.throws(() => remoteTrigger('run', { trigger_id: 'routine_1' }, { run }), /unexpected action/);
  assert.throws(() => remoteTrigger('run', { trigger_id: 'routine_1' }, { run: () => ({ status: 0, stdout: '{"result":"run complete"}', stderr: '' }) }), /no verified tool result/);
});

test('AC-1 and AC-3: Codex uses legacy environment and treats exit 1 as pending only with pending status', () => {
  const calls = [];
  const cwd = mkdtempSync(path.join(tmpdir(), 'codex-status-'));
  const run = (command, args) => { calls.push([command, ...args]); writeFileSync(path.join(cwd, 'error.log'), 'CLI diagnostic'); return { status: 0, stdout: 'Task ID: task_abc', stderr: '' }; };
  assert.equal(startCodex(cloudRequest(), 'brief', { run, cwd }).taskId, 'task_abc');
  assert.equal(existsSync(path.join(cwd, 'error.log')), false);
  assert.deepEqual(calls[0].slice(0, 7), ['codex', 'cloud', 'exec', '--env', 'widgets-env', '--branch', 'main']);
  assert.ok(calls[0].includes('model=gpt-6-sol'));
  assert.deepEqual(codexStatus('task_abc', { cwd, run: () => ({ status: 1, stdout: 'Pending', stderr: '' }) }), { status: 'pending' });
  assert.deepEqual(codexStatus('task_abc', { cwd, run: () => ({ status: 1, stdout: '[PENDING] Task name\nrepo • now', stderr: '' }) }), { status: 'pending' });
  assert.deepEqual(codexStatus('task_abc', { cwd, run: () => ({ status: 0, stdout: '[READY] Task name\nrepo • 7h ago', stderr: '' }) }), { status: 'completed' });
  assert.throws(() => codexStatus('task_abc', { cwd, run: () => ({ status: 1, stdout: '', stderr: 'unauthorized' }) }), /unauthorized/);
  assert.throws(() => codexStatus('task_abc', { cwd, run: () => ({ status: 0, stdout: 'Not ready', stderr: '' }) }), /unrecognized/);
  const pending = codexStatus('task_abc', { cwd, run: () => { writeFileSync(path.join(cwd, 'error.log'), 'CLI diagnostic'); return { status: 1, stdout: '[PENDING] Task name', stderr: '' }; } });
  assert.equal(pending.status, 'pending');
  assert.equal(existsSync(path.join(cwd, 'error.log')), false);
  writeFileSync(path.join(cwd, 'error.log'), 'user log');
  assert.throws(() => codexStatus('task_abc', { cwd, run: () => { throw new Error('must not run'); } }), /pre-existing error.log is preserved/);
  assert.equal(readFileSync(path.join(cwd, 'error.log'), 'utf8'), 'user log');
});

test('AC-3: polling stops at completion and reports elapsed wall time', async () => {
  let current = 1000;
  let reads = 0;
  const receipt = { provider: 'codex', taskId: 'task_abc', startedAt: new Date(current).toISOString() };
  const result = await pollTask(receipt, { maxWallMs: 5000, pollMs: 1000 }, {
    codex: () => ++reads === 1 ? { status: 'pending' } : { status: 'completed' },
    sleep: async (ms) => { current += ms; }, now: () => current,
  });
  assert.equal(result.wallMs, 1000);
  assert.equal(reads, 2);
  await assert.rejects(() => pollTask(receipt, { maxWallMs: 1000, pollMs: 1000 }, {
    codex: () => ({ status: 'pending' }), sleep: async (ms) => { current += ms; }, now: () => current,
  }), /exceeded/);
});

test('AC-3: Claude active session becomes complete only when its worker is idle', async () => {
  let current = 1000;
  let reads = 0;
  const calls = [];
  const result = await pollTask({ provider: 'claude', routineId: 'routine_1', taskId: 'session_1', startedAt: new Date(current).toISOString() }, { maxWallMs: 3000, pollMs: 1000 }, {
    remote: (action, payload) => {
      calls.push(action);
      if (action === 'get_run_log') { assert.equal(payload.session_id, 'session_1'); return { events_fetched: 1 }; }
      return { data: [{ id: 'session_1', status: 'active', worker_status: ++reads === 1 ? 'running' : 'idle' }] };
    },
    sleep: async (ms) => { current += ms; }, now: () => current,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.wallMs, 1000);
  assert.deepEqual(calls, ['list_runs', 'list_runs', 'get_run_log']);
});

test('DT-14: Claude uses run ID for list matching and a distinct session ID for logs', async (t) => {
  const request = { ...cloudRequest(), provider: 'claude', branch: 'cloud/iss-13804-cloud', claudeEnvironment: 'env_01TestRequest' };
  const home = mkdtempSync(path.join(tmpdir(), 'cloud-ledger-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const started = await startClaude(request, 'brief', { home, remote: (action) => {
    if (action === 'create') return { trigger: { id: 'routine_1', mcp_connections: [] } };
    if (action === 'update') return { trigger: { mcp_connections: [] } };
    return { run_id: 'run_1', session_id: 'session_1' };
  } });
  assert.equal(started.runId, 'run_1');
  assert.equal(started.sessionId, 'session_1');
  const calls = [];
  const finished = await pollTask(started, { maxWallMs: 5000, pollMs: 1000 }, { now: () => Date.parse(started.startedAt) + 1000, remote: (action, payload) => {
    calls.push([action, payload]);
    if (action === 'list_runs') return { data: [{ id: 'run_1', session_id: 'session_1', status: 'active', worker_status: 'idle' }] };
    return { session_id: 'session_1', events_fetched: 1 };
  } });
  assert.equal(finished.sessionId, 'session_1');
  assert.deepEqual(calls.map(([action]) => action), ['list_runs', 'get_run_log']);
  assert.equal(calls[1][1].session_id, 'session_1');
  const followupArgs = [];
  followupClaude(started.sessionId, 'Fix this', { run: (_command, args) => { followupArgs.push(args); return { status: 0, stdout: '{"result":"{\\"ok\\":true}"}', stderr: '' }; } });
  assert.deepEqual(followupArgs[0].slice(0, 4), ['-p', 'Fix this', '--cloud', 'session_1']);
  assert.ok(followupArgs[0].includes('--no-session-persistence'), 'the cloud follow-up keeps only its remote session');
});

test('AC-6: Claude follow-up targets the existing cloud session noninteractively', () => {
  const calls = [];
  const result = followupClaude('session_12345', 'Fix the issue', { run: (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '{"result":"{\\"ok\\":true}"}', stderr: '' }; } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].slice(0, 5), ['claude', '-p', 'Fix the issue', '--cloud', 'session_12345']);
  assert.ok(calls[0].includes('--no-session-persistence'), 'the follow-up must not save an unnamed local session');
});

function gitAt(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: OPERATOR.name, GIT_AUTHOR_EMAIL: OPERATOR.email, GIT_COMMITTER_NAME: OPERATOR.name, GIT_COMMITTER_EMAIL: OPERATOR.email } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function vibeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cloud-'));
  const remote = path.join(dir, 'remote.git');
  const root = path.join(dir, 'repo');
  const worktree = path.join(root, '.claude', 'worktrees', 'vibe-iss-13804-cloud-dispatch');
  mkdirSync(root);
  gitAt(root, 'init', '--initial-branch=main');
  writeFileSync(path.join(root, 'existing.txt'), 'old\n');
  writeFileSync(path.join(root, 'AGENTS.md'), 'Run node --test for changed scripts.\n');
  gitAt(root, 'add', '.');
  gitAt(root, 'commit', '-m', 'baseline');
  gitAt(dir, 'clone', '--bare', root, remote);
  gitAt(root, 'remote', 'add', 'origin', remote);
  mkdirSync(path.dirname(worktree), { recursive: true });
  gitAt(root, 'worktree', 'add', '-b', 'vibe/iss-13804-cloud-dispatch', worktree);
  const gitDir = gitAt(worktree, 'rev-parse', '--absolute-git-dir');
  const now = new Date().toISOString();
  writeSessionRecord(worktree, { slug: 'iss-13804-cloud-dispatch', branch: 'vibe/iss-13804-cloud-dispatch', summary: 'Cloud worker test', ticket: 'ISS-13804', liveTicket: 'ISS-13804', liveTicketCreatedBySession: false, status: 'active', mode: 'blank', operator: OPERATOR, baseCommit: gitAt(worktree, 'rev-parse', 'HEAD'), createdAt: now, lastActiveAt: now });
  writeFileSync(path.join(gitDir, 'vibe-spec-card.json'), JSON.stringify({ stage: 'locked', source: 'ISS-13804', criteria: [{ id: 'AC-1', text: 'Dispatch autonomously.', source: 'ISS-13804 v2' }] }), { mode: 0o600 });
  return { root, worktree, gitDir, remote };
}

function sourcedCloudRequest(worktree) {
  const request = cloudRequest(worktree);
  const observedAt = new Date().toISOString();
  const evidence = recordCloudEvidence(request, { graph: {
    ownership: { tool: 'code_symbols', query: 'dispatch owner', text: request.graph.ownership, observedAt },
    collisions: { tool: 'query_collisions', query: 'ticket overlap', text: request.graph.collisions, observedAt },
    blastRadius: { tool: 'blast_radius_tickets', query: 'touched files', text: request.graph.blastRadius, observedAt },
  }, validationCommands: request.validationCommands, validationSources: ['AGENTS.md'] });
  return { ...request, evidenceSha256: evidence.evidenceSha256 };
}

function completedReceipt(request, gitDir, taskId, extras = {}) {
  const dispatchIdentity = { ...hydrateCloudRequest(request, { requireCurrentSource: false }) };
  delete dispatchIdentity.reservedVersion;
  const receipt = { provider: request.provider, taskId, status: 'completed', requestDigest: createHash('sha256').update(JSON.stringify(dispatchIdentity)).digest('hex'), ...extras };
  writeFileSync(path.join(gitDir, 'cloud-worker-iss-13804.json'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return receipt;
}

function followupCli(request, gitDir, sessionId) {
  const bin = path.join(gitDir, 'fake-bin');
  const marker = path.join(gitDir, 'remote-called');
  const requestFile = path.join(gitDir, 'cloud-request.json');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\nprocess.stdout.write(${JSON.stringify('{"result":"{\\"ok\\":true}"}')} + '\\n');\n`);
  chmodSync(path.join(bin, 'claude'), 0o755);
  writeFileSync(requestFile, JSON.stringify(request));
  const result = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'cloud-worker.mjs'), 'followup', '--request', requestFile, '--session-id', sessionId, '--message', 'Fix this'], {
    cwd: request.worktree, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  return { result, marker };
}

test('DT-19: pre-import Claude follow-up continues the recorded cloud session', () => {
  const { worktree, gitDir } = vibeFixture();
  const request = { ...sourcedCloudRequest(worktree), provider: 'claude', branch: 'cloud/iss-13804-cloud' };
  completedReceipt(request, gitDir, 'run_1', { runId: 'run_1', sessionId: 'session_1' });
  const { result, marker } = followupCli(request, gitDir, 'session_1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(marker), true);
  assert.equal(JSON.parse(readFileSync(path.join(gitDir, 'cloud-worker-iss-13804.json'), 'utf8')).followups, 1);
});

test('ISS-13998 AC-5: abandon ends a dispatch for good and removes the routine its receipt names once get answers not found', async (t) => {
  const { worktree, gitDir } = vibeFixture();
  const home = mkdtempSync(path.join(tmpdir(), 'cloud-ledger-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const request = { ...sourcedCloudRequest(worktree), provider: 'claude', branch: 'cloud/iss-13804-cloud' };
  // A dispatch receipt records its reserved version (cloud-worker.mjs dispatch), which a later dispatch compares first.
  completedReceipt(request, gitDir, 'run_1', { status: 'running', runId: 'run_1', sessionId: 'session_1', routineId: 'trig_old_dispatch', reservedVersion: request.reservedVersion });
  const gone = new Set();
  const removed = [];
  const remote = (action, payload) => {
    if (action === 'get' && gone.has(payload.trigger_id)) throw Object.assign(new Error('RemoteTrigger get failed: HTTP 404'), { httpStatus: 404 });
    if (action === 'get') return { trigger: { id: payload.trigger_id } };
    throw new Error(`unexpected ${action}`);
  };
  const executor = async (entries) => { for (const entry of entries) { removed.push([entry.id, entry.name]); gone.add(entry.id); } };
  const abandoned = await abandonDispatch(request, { home, remote, executor, stderr: () => {} });
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(JSON.parse(readFileSync(path.join(gitDir, 'cloud-worker-iss-13804.json'), 'utf8')).status, 'abandoned');
  assert.deepEqual(removed, [['trig_old_dispatch', 'ISS-13804 cloud worker']]);
  const ledger = JSON.parse(readFileSync(path.join(home, '.codex', 'vibe', 'cloud', 'routines.json'), 'utf8'));
  assert.deepEqual([ledger.removal, ledger.removed.map((entry) => entry.id)], [[], ['trig_old_dispatch']]);
  const file = path.join(gitDir, 'cloud-request.json');
  writeFileSync(file, JSON.stringify(request));
  const again = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'cloud-worker.mjs'), 'dispatch', '--request', file], { cwd: worktree, encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(again.status, 2);
  assert.match(again.stderr, /cloud task already ended: abandoned/, 'an abandoned dispatch is never resumed');
});

test('AC-9: cloud CLI refuses local-evidence work before dispatch and generates a brief for code-only work', () => {
  const { worktree, gitDir } = vibeFixture();
  const file = path.join(gitDir, 'cloud-request.json');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cloud-worker.mjs');
  const eligible = sourcedCloudRequest(worktree);
  writeFileSync(file, JSON.stringify(eligible));
  const yes = spawnSync(process.execPath, [script, 'brief', '--request', file], { cwd: worktree, encoding: 'utf8' });
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(JSON.parse(yes.stdout).brief, /Reserved plugin version: 1\.1\.61/);
  writeFileSync(file, JSON.stringify({ ...eligible, placement: { codeOnly: true, needsRunningApp: false, localEvidence: ['App Server item'] } }));
  const no = spawnSync(process.execPath, [script, 'dispatch', '--request', file], { cwd: worktree, encoding: 'utf8' });
  assert.equal(no.status, 2);
  assert.match(no.stderr, /cloud dispatch refused: ticket needs local evidence: App Server item/);
  assert.equal(existsSync(path.join(gitDir, 'cloud-worker-iss-13804.json')), false);
});

test('DT-17: brief refuses fabricated criteria, graph research and validation commands', () => {
  const { worktree, gitDir } = vibeFixture();
  const request = sourcedCloudRequest(worktree);
  assert.equal(hydrateCloudRequest(request).criteria[0].source, 'ISS-13804 v2');
  assert.throws(() => hydrateCloudRequest({ ...request, criteria: [{ id: 'AC-1', source: 'ISS-13804 v2', text: 'Invented acceptance' }] }), /request criteria differs/);
  assert.throws(() => hydrateCloudRequest({ ...request, graph: { ...request.graph, ownership: 'Invented graph owner' } }), /request graph differs/);
  assert.throws(() => hydrateCloudRequest({ ...request, validationCommands: ['false'] }), /request validationCommands differs/);
  assert.throws(() => hydrateCloudRequest({ ...request, evidenceSha256: '0'.repeat(64) }), /ENOENT/);
  assert.throws(() => recordCloudEvidence(request, { graph: { ownership: { tool: 'unknown', query: 'x', text: 'invented', observedAt: new Date().toISOString() } }, validationCommands: ['false'], validationSources: ['AGENTS.md'] }), /graph ownership/);
  writeFileSync(path.join(gitDir, 'vibe-spec-card.json'), JSON.stringify({ stage: 'locked', source: 'ISS-13804', criteria: [{ id: 'AC-1', text: 'Invented card', source: 'ISS-13804 v2' }] }));
  assert.throws(() => hydrateCloudRequest(request), /locked card/);
});

test('DT-16: a fabricated git-init Vibe record is not a creation witness', () => {
  const worktree = mkdtempSync(path.join(tmpdir(), 'fake-vibe-cloud-'));
  gitAt(worktree, 'init', '--initial-branch=vibe/iss-13804-cloud-dispatch');
  writeFileSync(path.join(worktree, 'existing.txt'), 'old\n');
  gitAt(worktree, 'add', '.');
  gitAt(worktree, 'commit', '-m', 'baseline');
  const now = new Date().toISOString();
  writeSessionRecord(worktree, { slug: 'iss-13804-cloud-dispatch', branch: 'vibe/iss-13804-cloud-dispatch', ticket: 'ISS-13804', liveTicket: 'ISS-13804', liveTicketCreatedBySession: false, operator: OPERATOR, baseCommit: gitAt(worktree, 'rev-parse', 'HEAD'), createdAt: now });
  assert.throws(() => importResult({ ...cloudRequest(worktree), provider: 'claude', branch: 'cloud/iss-13804-cloud' }, { provider: 'claude', status: 'completed' }), /Vibe-created linked worktree/);
});

test('AC-4 and AC-5: Claude branch imports its one operator-authored commit into Vibe without committing', () => {
  const { worktree, gitDir } = vibeFixture();
  gitAt(worktree, 'switch', '-c', 'cloud/iss-13804-cloud');
  writeFileSync(path.join(worktree, 'existing.txt'), 'cloud edit\n');
  gitAt(worktree, 'add', '.');
  gitAt(worktree, 'commit', '-m', 'cloud change');
  gitAt(worktree, 'push', 'origin', 'cloud/iss-13804-cloud');
  gitAt(worktree, 'switch', 'vibe/iss-13804-cloud-dispatch');
  const request = { ...sourcedCloudRequest(worktree), provider: 'claude', branch: 'cloud/iss-13804-cloud' };
  const receipt = completedReceipt(request, gitDir, 'run_1', { runId: 'run_1', sessionId: 'session_1' });
  const event = { cwd: worktree, session_id: 'unscoped', transcript_path: null, tool_input: { command: 'gh pr create --base main --body-file body.md' } };
  assert.match(prCreateGuard(event)?.reason ?? '', /no imported source witness/);
  const before = gitAt(worktree, 'rev-parse', 'HEAD');
  const imported = importResult(request, receipt);
  assert.match(imported.changed, /existing.txt/);
  assert.equal(readFileSync(path.join(worktree, 'existing.txt'), 'utf8'), 'cloud edit\n');
  assert.equal(gitAt(worktree, 'rev-parse', 'HEAD'), before);
  assert.throws(() => readyForPr(request, { gate: () => null, reviews: () => [{ runtime: 'codex' }] }), /stale for the current source/);
  gitAt(worktree, 'commit', '-m', 'local reviewed import');
  writeFileSync(path.join(gitDir, 'vibe-handoff-gate.json'), '{}\n');
  assert.throws(() => refreshImportWitness(worktree, { gate: () => null, reviews: () => [{ runtime: 'claude', model: null }] }), /independent codex or Fable 5.2 \(claude-fable-5-2\) review is missing/);
  refreshImportWitness(worktree, { gate: () => null, reviews: () => [{ runtime: 'codex' }] });
  assert.equal(cloudPrProblem(worktree, { gate: () => null, reviews: () => [{ runtime: 'codex' }] }), null);
  assert.throws(() => readyForPr(request, { gate: () => null, reviews: () => [{ runtime: 'claude', model: null }] }), /independent codex or Fable 5.2 \(claude-fable-5-2\) review is missing/);
  assert.equal(readyForPr(request, { gate: () => null, reviews: () => [{ runtime: 'codex' }] }).ready, true);
  assert.equal(readyForPr({ ...request, reservedVersion: '1.1.62' }, { gate: () => null, reviews: () => [{ runtime: 'codex' }] }).ready, true, 'local publication may reserve the next free version without replaying the cloud task');
  const receiptFile = path.join(gitDir, 'cloud-worker-iss-13804.json');
  const witnessFile = path.join(gitDir, 'vibe-cloud-import.json');
  const beforeReceipt = readFileSync(receiptFile, 'utf8');
  const beforeWitness = readFileSync(witnessFile, 'utf8');
  const blocked = followupCli(request, gitDir, 'session_1');
  assert.equal(blocked.result.status, 2);
  assert.match(blocked.result.stderr, /already imported; use a new dispatch\/session/);
  assert.equal(existsSync(blocked.marker), false, 'the remote CLI was not called');
  assert.equal(readFileSync(receiptFile, 'utf8'), beforeReceipt);
  assert.equal(readFileSync(witnessFile, 'utf8'), beforeWitness);
  assert.equal(cloudPrProblem(worktree, { gate: () => null, reviews: () => [{ runtime: 'codex' }] }), null, 'PR readiness survives the refused follow-up');
  assert.deepEqual(verifyAuthor(worktree, 'HEAD', OPERATOR), { name: OPERATOR.name, email: OPERATOR.email });
  assert.throws(() => verifyAuthor(worktree, 'HEAD', { name: 'Unrelated Author', email: 'unrelated@example.test' }), /not the Vibe operator/);
});

test('AC-5: Claude branch with an AI-authored commit is refused before applying its diff', () => {
  const { worktree, gitDir } = vibeFixture();
  gitAt(worktree, 'switch', '-c', 'cloud/iss-13804-cloud');
  writeFileSync(path.join(worktree, 'existing.txt'), 'AI edit\n');
  gitAt(worktree, 'add', '.');
  const aiCommit = spawnSync('git', ['commit', '-m', 'AI authored'], { cwd: worktree, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Claude', GIT_AUTHOR_EMAIL: 'noreply@anthropic.com', GIT_COMMITTER_NAME: 'Claude', GIT_COMMITTER_EMAIL: 'noreply@anthropic.com' } });
  assert.equal(aiCommit.status, 0, aiCommit.stderr);
  gitAt(worktree, 'push', 'origin', 'cloud/iss-13804-cloud');
  gitAt(worktree, 'switch', 'vibe/iss-13804-cloud-dispatch');
  const request = { ...sourcedCloudRequest(worktree), provider: 'claude', branch: 'cloud/iss-13804-cloud' };
  const receipt = completedReceipt(request, gitDir, 'run_1');
  assert.throws(() => importResult(request, receipt), /not the Vibe operator/);
  assert.equal(readFileSync(path.join(worktree, 'existing.txt'), 'utf8'), 'old\n');
});

test('ISS-14039: a Claude import accepts a Codex or trace-proven Fable 5.2 review that is not the writer', () => {
  const { worktree, gitDir } = vibeFixture();
  gitAt(worktree, 'switch', '-c', 'cloud/iss-13804-cloud');
  writeFileSync(path.join(worktree, 'existing.txt'), 'cloud edit\n');
  gitAt(worktree, 'add', '.');
  gitAt(worktree, 'commit', '-m', 'cloud change');
  gitAt(worktree, 'push', 'origin', 'cloud/iss-13804-cloud');
  gitAt(worktree, 'switch', 'vibe/iss-13804-cloud-dispatch');
  const request = { ...sourcedCloudRequest(worktree), provider: 'claude', branch: 'cloud/iss-13804-cloud' };
  importResult(request, completedReceipt(request, gitDir, 'run_1', { runId: 'run_1', sessionId: 'session_1' }));
  gitAt(worktree, 'commit', '-m', 'local reviewed import');
  const gate = () => null;
  const handoff = (models) => {
    const receipts = REVIEW_ROLES.map((role, index) => {
      const sessionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const tracePath = path.join(gitDir, `${role}.jsonl`);
      writeFileSync(tracePath, [{ type: 'system', subtype: 'init', model: models[index] },
        { type: 'assistant', message: { model: models[index], content: [{ type: 'tool_use', name: 'mcp__closedloop_graph__code_symbols' }] } },
        { type: 'result', session_id: sessionId }].map((event) => JSON.stringify(event)).join('\n'));
      const resultFile = path.join(gitDir, `${role}-result.json`);
      writeFileSync(resultFile, JSON.stringify({ runtime: 'claude', agentName: role, status: 'DONE', sessionId, requestId: `request-${index}`, tracePath, source: sourceIdentity(worktree), graphToolAliases: ['mcp__closedloop_graph__code_symbols'], data: { findings: [] } }));
      const outFile = path.join(gitDir, `${role}-receipt.json`);
      captureReviewReceipt({ worktree, resultFile, outFile, role });
      return { path: outFile, sessionId };
    });
    writeFileSync(path.join(gitDir, 'vibe-handoff-gate.json'), `${JSON.stringify({ receipts: receipts.map((item) => ({ path: item.path })) })}\n`);
    return receipts;
  };
  const opus = 'claude-opus-5-5';
  const fable = 'claude-fable-5-2';
  const missing = /independent codex or Fable 5\.2 \(claude-fable-5-2\) review is missing/;
  handoff([opus, opus, opus, opus]);
  assert.throws(() => refreshImportWitness(worktree, { gate }), missing, 'a non-Fable Claude review is not independent of a Claude import');
  const claimed = handoff([opus, opus, opus, opus]);
  const forged = JSON.parse(readFileSync(claimed[0].path, 'utf8'));
  writeFileSync(claimed[0].path, `${JSON.stringify({ ...forged, model: fable })}\n`);
  assert.throws(() => refreshImportWitness(worktree, { gate }), missing, 'a recorded Fable model its trace does not show is unverified');
  const reviewed = handoff([fable, opus, opus, opus]);
  assert.equal(JSON.parse(readFileSync(reviewed[0].path, 'utf8')).model, fable, 'the receipt records the model the CLI ran');
  const writerFile = path.join(gitDir, 'vibe-writer.json');
  writeFileSync(writerFile, JSON.stringify({ workerId: 'writer-now', migrations: [{ previous: { workerId: reviewed[0].sessionId } }] }));
  assert.throws(() => refreshImportWitness(worktree, { gate }), missing, "the session writer's own Fable review is refused");
  assert.throws(() => refreshImportWitness(worktree, { gate, reviews: () => [{ runtime: 'codex', identities: ['writer-now'] }] }), missing, "the session writer's own Codex review is refused");
  writeFileSync(writerFile, JSON.stringify({ workerId: 'writer-now', migrations: [] }));
  refreshImportWitness(worktree, { gate });
  assert.equal(cloudPrProblem(worktree, { gate }), null, 'a Fable 5.2 review proven by its trace clears the PR guard');
  assert.equal(readyForPr(request, { gate }).ready, true);
  const fableTrace = reviewed[0].path.replace(/-receipt\.json$/, '.jsonl');
  writeFileSync(fableTrace, `${readFileSync(fableTrace, 'utf8')}\n`);
  assert.match(cloudPrProblem(worktree, { gate }), missing, 'a trace changed after capture no longer proves the model');
});

test('AC-4: Codex polling and import leave the Vibe candidate free of CLI error.log', async () => {
  const { worktree, gitDir } = vibeFixture();
  const request = sourcedCloudRequest(worktree);
  const receipt = completedReceipt(request, gitDir, 'task_abc');
  let current = 1000;
  let reads = 0;
  const finished = await pollTask({ ...receipt, startedAt: new Date(current).toISOString() }, { maxWallMs: 5000, pollMs: 1000 }, {
    codex: () => codexStatus('task_abc', { cwd: worktree, run: () => {
      writeFileSync(path.join(worktree, 'error.log'), 'status diagnostic');
      return ++reads === 1 ? { status: 1, stdout: '[PENDING] Task name', stderr: '' } : { status: 0, stdout: '[READY] Task name', stderr: '' };
    } }),
    sleep: async (ms) => { current += ms; }, now: () => current,
  });
  assert.equal(finished.status, 'completed');
  assert.equal(existsSync(path.join(worktree, 'error.log')), false);
  writeFileSync(path.join(gitDir, 'cloud-worker-iss-13804.json'), `${JSON.stringify(finished)}\n`);
  const calls = [];
  const imported = importResult(request, finished, { run: (_command, args) => {
    calls.push(args.slice(0, 2).join(' '));
    writeFileSync(path.join(worktree, 'error.log'), 'CLI diagnostic');
    if (args[1] === 'diff') return { status: 0, stdout: 'diff --git a/existing.txt b/existing.txt\n', stderr: '' };
    writeFileSync(path.join(worktree, 'existing.txt'), 'codex edit\n');
    writeFileSync(path.join(worktree, 'error.log'), 'diagnostic');
    return { status: 0, stdout: '', stderr: '' };
  } });
  assert.deepEqual(calls, ['cloud diff', 'cloud apply']);
  assert.match(imported.changed, /existing.txt/);
  assert.equal(existsSync(path.join(worktree, 'error.log')), false);
  gitAt(worktree, 'add', 'existing.txt');
  gitAt(worktree, 'commit', '-m', 'local reviewed import');
  const bodyFile = path.join(gitDir, 'body.md');
  writeFileSync(bodyFile, 'PR body\n');
  const reviews = claudeReviewReceipts(worktree, gitDir);
  recordHandoffGate({ worktree, base: 'main', body: bodyFile, runs: reviews[0], receipts: reviews }, { runScript: () => ({ status: 0, stdout: JSON.stringify({ ok: true, blocking: { prBody: true, prEvidence: true } }), stderr: '' }) });
  refreshImportWitness(worktree, { bodyFile });
  const event = { cwd: worktree, session_id: 'unscoped', transcript_path: null, tool_input: { command: `gh pr create --base main --body-file ${bodyFile}` } };
  assert.equal(prCreateGuard(event), null, 'the actual PR hook admits the imported source after handoff and an independent Claude review');
  writeFileSync(path.join(worktree, 'existing.txt'), 'changed after review\n');
  assert.match(prCreateGuard(event)?.reason ?? '', /cloud import witness is stale for the current source/);
});

test('ISS-14077 AC-2: a cloud import whose gate passes under a recorded targeted-tests ruling refreshes and opens its PR without an override', () => {
  const { worktree, gitDir } = vibeFixture();
  const request = sourcedCloudRequest(worktree);
  const receipt = completedReceipt(request, gitDir, 'task_ruled');
  importResult(request, receipt, { run: (_command, args) => {
    if (args[1] === 'diff') return { status: 0, stdout: 'diff --git a/existing.txt b/existing.txt\n', stderr: '' };
    writeFileSync(path.join(worktree, 'existing.txt'), 'codex edit\n');
    return { status: 0, stdout: '', stderr: '' };
  } });
  gitAt(worktree, 'add', 'existing.txt');
  gitAt(worktree, 'commit', '-m', 'local reviewed import');
  const bodyFile = path.join(gitDir, 'body.md');
  writeFileSync(bodyFile, 'PR body\n');
  const runsFile = path.join(gitDir, 'vibe-pr-evidence.json');
  writeFileSync(runsFile, JSON.stringify(ruledEvidence('rulings')));
  const rulingsFile = path.join(gitDir, 'rulings.md');
  writeFileSync(rulingsFile, RULINGS);
  const receipts = claudeReviewReceipts(worktree, gitDir);
  // The inventory needs a whole repository, so this stand-in judges only the verifier evidence, with the real
  // pr-facts check and the rulings file the gate passed it.
  const runScript = (_command, args) => {
    const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const rulings = value('--rulings');
    const problems = prEvidenceValidationProblems(JSON.parse(readFileSync(value('--runs'), 'utf8')), RULED_COMMIT,
      { candidateFiles: RULED_FILES, receiptDir: gitDir, rulingsText: rulings && readFileSync(rulings, 'utf8') });
    return { status: 0, stdout: JSON.stringify({ ok: problems.length === 0, blocking: { prBody: true, prEvidence: problems.length === 0 } }), stderr: '' };
  };
  const gate = (rulings) => recordHandoffGate({ worktree, base: 'main', body: bodyFile, runs: runsFile, rulings, receipts }, { runScript });
  const event = { cwd: worktree, session_id: 'unscoped', transcript_path: null, tool_input: { command: `gh pr create --base main --body-file ${bodyFile}` } };
  assert.throws(() => gate(undefined), /did not pass body and verifier evidence checks/, 'the cited ruling is unverified without its rulings file');
  assert.throws(() => refreshImportWitness(worktree, { bodyFile }), /cloud import cannot refresh: handoff gate has not passed/);
  gate(rulingsFile);
  refreshImportWitness(worktree, { bodyFile });
  assert.equal(cloudPrProblem(worktree, { bodyFile }), null);
  assert.equal(prCreateGuard(event), null, 'the PR opens with no gate override in its body');
  writeFileSync(rulingsFile, RULINGS.replace('TARGETED inventory', 'full suites'));
  assert.match(prCreateGuard(event)?.reason ?? '', /handoff rulings evidence changed/, 'the witness binds the rulings file it was judged with');
  assert.throws(() => refreshImportWitness(worktree, { bodyFile }), /cloud import cannot refresh: handoff rulings evidence changed/);
});

test('ISS-14077 AC-4: a cloud import whose session delivers member tickets refreshes and opens its PR when the PR title names them', () => {
  const { worktree, gitDir } = vibeFixture();
  // What `vibe-sessions.mjs touch --member-ticket` leaves on the session record.
  writeSessionRecord(worktree, { ...readSessionRecord(worktree), memberTickets: ['ISS-13805', 'ISS-13806'] });
  const request = sourcedCloudRequest(worktree);
  const receipt = completedReceipt(request, gitDir, 'task_members');
  importResult(request, receipt, { run: (_command, args) => {
    if (args[1] === 'diff') return { status: 0, stdout: 'diff --git a/existing.txt b/existing.txt\n', stderr: '' };
    writeFileSync(path.join(worktree, 'existing.txt'), 'codex edit\n');
    return { status: 0, stdout: '', stderr: '' };
  } });
  gitAt(worktree, 'add', 'existing.txt');
  gitAt(worktree, 'commit', '-m', 'local reviewed import');
  const bodyFile = path.join(gitDir, 'body.md');
  writeFileSync(bodyFile, 'Delivers ISS-13804, ISS-13805 and ISS-13806.\n');
  const title = 'ISS-13804, ISS-13805, ISS-13806: Cloud dispatch';
  const oneMember = 'ISS-13804, ISS-13805: Cloud dispatch';
  const reviews = claudeReviewReceipts(worktree, gitDir);
  recordHandoffGate({ worktree, base: 'main', body: bodyFile, runs: reviews[0], receipts: reviews, title }, { runScript: () => ({ status: 0, stdout: JSON.stringify({ ok: true, blocking: { prBody: true, prEvidence: true } }), stderr: '' }) });

  const before = readFileSync(path.join(gitDir, 'vibe-cloud-import.json'), 'utf8');
  assert.throws(() => refreshImportWitness(worktree, { bodyFile }), /cloud import cannot refresh: the session delivers member tickets ISS-13805, ISS-13806; pass --title so the gate checks the PR names them/);
  assert.throws(() => refreshImportWitness(worktree, { bodyFile, title: oneMember }), /cloud import cannot refresh: the PR title does not name member ticket ISS-13806/);
  assert.equal(readFileSync(path.join(gitDir, 'vibe-cloud-import.json'), 'utf8'), before, 'a refused refresh leaves the import witness as it was');

  assert.equal(refreshImportWitness(worktree, { bodyFile, title }).reviewedSource.head, gitAt(worktree, 'rev-parse', 'HEAD'));
  assert.equal(cloudPrProblem(worktree, { bodyFile, title }), null);
  assert.match(cloudPrProblem(worktree, { bodyFile, title: oneMember }) ?? '', /the PR title does not name member ticket ISS-13806/);
  assert.equal(readyForPr(request, { bodyFile, title }).ready, true);
  assert.throws(() => readyForPr(request, { bodyFile, title: oneMember }), /PR refused: the PR title does not name member ticket ISS-13806/);

  const create = (prTitle) => prCreateGuard({ cwd: worktree, session_id: 'unscoped', transcript_path: null, tool_input: { command: `gh pr create --base main --title "${prTitle}" --body-file ${bodyFile}` } });
  assert.equal(create(title), null, 'the PR hook admits the import with no gate override in its body');
  assert.match(create(oneMember)?.reason ?? '', /the PR title does not name member ticket ISS-13806/);
});

/** One clean Claude launcher receipt per handoff review role, captured on the worktree's current source. */
function claudeReviewReceipts(worktree, gitDir) {
  return REVIEW_ROLES.map((role, index) => {
    const sessionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const tracePath = path.join(gitDir, `${role}.jsonl`);
    writeFileSync(tracePath, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__closedloop_graph__code_symbols' }] } })}\n${JSON.stringify({ type: 'result', session_id: sessionId })}\n`);
    const resultFile = path.join(gitDir, `${role}-result.json`);
    writeFileSync(resultFile, JSON.stringify({ runtime: 'claude', agentName: role, status: 'DONE', sessionId, requestId: `request-${index}`, tracePath, source: sourceIdentity(worktree), graphToolAliases: ['mcp__closedloop_graph__code_symbols'], data: { findings: [] } }));
    const outFile = path.join(gitDir, `${role}-receipt.json`);
    captureReviewReceipt({ worktree, resultFile, outFile, role });
    return outFile;
  });
}
