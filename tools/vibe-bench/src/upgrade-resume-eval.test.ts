import "./no-model-overrides.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { before } from "node:test";
import type { EvalSuiteResult } from "./eval-collector.ts";
import { finalizeLocalEval } from "./eval-collector.ts";
import { buildEvalBaseline } from "./eval-baseline.ts";
import { ensureGitCommits } from "../../shared/git-commit-fixture.mjs";
import { upgradeResumeCaseIds } from "./cli.ts";
import { createClaudeEvalIsolation } from "./eval-claude-isolation.ts";
import { archivePluginRelease } from "./plugin-snapshot.ts";
import type { PluginReleaseArchive } from "./plugin-snapshot.ts";
import * as pluginSnapshots from "./plugin-snapshot.ts";
import { evalCaseCatalog } from "./eval-selection.ts";
import { EVAL_POLICY } from "./eval-policy.ts";
import * as upgradeEval from "./upgrade-resume-eval.ts";
import type { UpgradeCaseEvidence, UpgradeCellRunner, UpgradeFailureCode } from
  "./upgrade-resume-eval.ts";
import { CLAUDE_WRITER_TIMEOUT_MS, CODEX_STATEFUL_ROOT_TIMEOUT_MS, mergeEvalSuiteResults,
  appServerTokenUsage, appServerTurn, resumeStatefulCodexThread,
  claudeStaleRecoveryEligible, claudeStaleRecoveryPrompt,
  claudeUpgradeRootArgs, cleanupClaudeVersionRecords,
  cleanupClaudeVersionRecordsForSignal,
  classifyUpgradeFailure, codexStoppedTurn, enqueueUpgradeRequest, heldCodexWriter,
  holdStatusText, linkCodexAuth,
  prepareClaudeVersionRecord, STATEFUL_CLAUDE_ROOT_TIMEOUT_MS, UPGRADE_GRAPH_CAPABILITIES,
  STATEFUL_INFRASTRUCTURE_RETRIES, runUpgradeCellWithRetry, preserveStatefulClaudeReply,
  runUpgradeResumeCases,
  claudeTerminalReply, nextClaudeTurnReply, nextPlannedClaudeReply, statefulReplyFailureCode,
  assertUpgradeDefinitionPremise,
  requireIdleCodexLedger, targetMigrationChild, upgradeCasePasses, validateClaudeVersionRecord,
  validateClaudeLoadContract, validateUpgradeCapabilities,
  validateCodexInstalledPlugin, statefulInfrastructureInvalidReason,
  statefulSuite } from "./upgrade-resume-eval.ts";

const REPO = realpathSync(join(import.meta.dirname, "../../.."));
const RELEASE_REFS = [
  "b8df21893c6322a0176b16df9fe123cc6f9296c2",
  "5e7eafa03690055da034874fbe2b56129555b453",
  "802afdc075b4ca8442a5644975ef3571f98c38d2",
  "f8517d50715dd8569ceee44f5a9452cbf8fc18f5",
  "f45882fb9118cca457221e48e7cef850557f8246",
] as const;

before(() => ensureGitCommits(REPO, RELEASE_REFS));

test("ISS-13743 stateful Codex root and spawned writer use the shared model without effort overrides", async () => {
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  const handlers = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
  let childModel = EVAL_POLICY.codexModel;
  let reroute = false;
  const client = {
    onNotification(handler: (message: { method: string; params?: Record<string, unknown> }) => void) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    async request(method: string, params: Record<string, any>) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "root-thread" } };
      if (method === "threadSection/list") return { data: [{ id: "section", name: "Fleet workers" }] };
      if (method === "turn/start") {
        queueMicrotask(() => {
          for (const handler of handlers) {
            if (reroute) handler({ method: "model/rerouted",
              params: { toModel: "different-codex-model" } });
            handler({ method: "item/completed", params: { item: { type: "subAgentActivity",
              agentThreadId: "writer-thread" } } });
            handler({ method: "turn/completed" });
          }
        });
        return { turn: { id: "turn-1" } };
      }
      if (method === "thread/read") return { thread: { model: params.threadId === "writer-thread"
        ? childModel : EVAL_POLICY.codexModel } };
      return {};
    },
    async resumeThread(threadId: string, cwd: string, options: {
      model: string; developerInstructions: string }) {
      calls.push({ method: "thread/resume", params: { threadId, cwd, ...options } });
      return { id: threadId, model: options.model };
    },
  } as unknown as Parameters<typeof appServerTurn>[0];
  const input = { cwd: REPO, skill: join(REPO, "plugins/vibe/skills/vibe/SKILL.md"),
    prompt: "$vibe stateful proof" };
  const first = await appServerTurn(client, input);
  assert.equal(first.model, EVAL_POLICY.codexModel);
  assert.ok(first.trace.some((line) => line === `model:writer-thread:${EVAL_POLICY.codexModel}`));
  await resumeStatefulCodexThread(client, first.threadId, REPO);
  await appServerTurn(client, { ...input, threadId: first.threadId });
  for (const method of ["thread/start", "thread/resume", "turn/start"]) {
    const matching = calls.filter((call) => call.method === method);
    assert.ok(matching.length > 0, method);
    assert.ok(matching.every((call) => call.params.model === EVAL_POLICY.codexModel), method);
    assert.ok(matching.every((call) => !("effort" in call.params)), method);
  }
  assert.ok(calls.filter((call) => ["thread/start", "thread/resume"].includes(call.method))
    .every((call) => call.params.developerInstructions.includes(EVAL_POLICY.codexModel)));
  const turns = calls.filter((call) => call.method === "turn/start");
  assert.ok(turns.every((call) => call.params.input[0].text.includes(EVAL_POLICY.codexModel)));
  childModel = "different-codex-model";
  await assert.rejects(appServerTurn(client, { ...input, threadId: first.threadId }),
    /eval-stateful-codex-model-mismatch/);
  childModel = EVAL_POLICY.codexModel;
  reroute = true;
  await assert.rejects(appServerTurn(client, { ...input, threadId: first.threadId }),
    /eval-stateful-codex-model-rerouted/);
});

function suite(runtime: "claude" | "codex", ids: string[]): EvalSuiteResult {
  const cases = ids.map((id) => ({ id, passed: true, failedGraders: [], skippedGraders: [] }));
  return { runtime, cliVersion: runtime === "claude" ? "2.1.311" : "codex-cli 0.163.0",
    cases, passed: cases.length, failed: 0, wallMs: 5,
    agentCostUsd: runtime === "claude" ? 0.1 : null,
    judgeCostUsd: runtime === "claude" ? 0.02 : null,
    costUsd: runtime === "claude" ? 0.12 : null,
    tokens: runtime === "codex" ? { input_tokens: 2 } : null,
    nativeHash: runtime[0].repeat(64) };
}

function evidence(failureCode: UpgradeFailureCode | null,
  attempt: number): UpgradeCaseEvidence {
  return { caseId: "upgrade-resume-changed-definition", runtime: "claude",
    passed: failureCode === null, failureCode, wallMs: attempt * 10, agentCostUsd: attempt / 100,
    tokens: null, cliVersion: "2.1.318", target: { version: "1.1.39", ref: "a".repeat(40) },
    prior: { version: "1.1.23", ref: "b".repeat(40) }, oldArchiveRetained: true,
    proofLines: failureCode === null ? ["turn-one", "turn-two"] : [],
    rootSessionId: `root-${attempt}`, previousWriterId: "writer-1", finalWriterId: "writer-2",
    migrationCount: 1, trace: [`attempt-${attempt}`] };
}

function injectedCell(input: Parameters<UpgradeCellRunner>[0],
  failureCode: UpgradeFailureCode | null, privateReply?: string):
  UpgradeCaseEvidence & { privateReply?: string } {
  const expectedHistoricalFailure = input.role === "historical" && input.expected === "fail";
  const failed = failureCode !== null;
  return { caseId: input.item.id, runtime: input.runtime, passed: !failed, failureCode,
    wallMs: 1, agentCostUsd: input.runtime === "claude" ? 0.01 : null,
    tokens: input.runtime === "codex" ? {} : null, cliVersion: "2.1.318",
    target: input.transition.target, prior: input.transition.prior, oldArchiveRetained: true,
    proofLines: expectedHistoricalFailure ? ["turn-one"] : failed ? [] : ["turn-one", "turn-two"],
    rootSessionId: input.attemptRoot, previousWriterId: "writer-1",
    finalWriterId: failed ? null : "writer-2", migrationCount: expectedHistoricalFailure ? 0 : 1,
    trace: [`${input.role}:${failureCode ?? "complete"}`],
    ...(privateReply ? { privateReply } : {}) };
}

async function runInjectedClaudeBoundary(root: string, currentFailure: UpgradeFailureCode | null,
  currentTrace: string, currentTurnStreams: string[] = []) {
  const item = evalCaseCatalog(join(REPO, "plugins/vibe"))
    .find((candidate) => candidate.id === "upgrade-resume-changed-definition");
  assert.ok(item);
  const pluginSha = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"],
    { encoding: "utf8" }).trim();
  const cellRunner: UpgradeCellRunner = async (input) => {
    if (input.role === "historical") {
      return injectedCell(input, input.expected === "fail" ? "MODEL_BLOCK" : null,
        "historical reply");
    }
    let privateReply = "";
    for (const stream of currentTurnStreams) {
      privateReply = nextClaudeTurnReply(privateReply, stream);
    }
    return { ...injectedCell(input, currentFailure, privateReply || undefined),
      trace: [currentTrace] };
  };
  const runRoot = join(root, "run");
  const suites = await runUpgradeResumeCases({ repo: REPO, pluginSha,
    currentSnapshot: { sha: pluginSha, vibeDir: realpathSync(join(REPO, "plugins/vibe")),
      coreDir: realpathSync(join(REPO, "plugins/closedloop-core")), agentModels: {} },
    runRoot, claudeExecutable: "unused-claude", codexExecutable: "unused-codex",
    cases: [item], runtimes: ["claude"], cellRunner });
  return { runRoot, suite: suites.claude! };
}

test("ISS-13743 stateful-only and combined Codex suites retain the observed model", () => {
  const cell: UpgradeCaseEvidence = { ...evidence(null, 1), runtime: "codex",
    model: EVAL_POLICY.codexModel, cliVersion: "codex-cli 0.163.0",
    agentCostUsd: null, tokens: { input_tokens: 2 } };
  const stateful = statefulSuite("codex", [cell]);
  assert.equal(stateful.model, EVAL_POLICY.codexModel);
  const ordinary = { ...suite("codex", ["pm-ordinary"]), model: EVAL_POLICY.codexModel };
  const merged = mergeEvalSuiteResults(ordinary, stateful,
    ["pm-ordinary", cell.caseId]);
  assert.equal(merged?.model, EVAL_POLICY.codexModel);
  const claude = statefulSuite("claude", [evidence(null, 1)]);
  const run = finalizeLocalEval({ pluginSha: "a".repeat(40), createdAt: "2026-11-05T00:00:00Z",
    wallMs: 10, deterministicOnly: false, selectedCases: [cell.caseId],
    runtimes: [
      { runtime: "claude", exitCode: 0, result: claude, invalidReason: null },
      { runtime: "codex", exitCode: 0, result: stateful, invalidReason: null },
    ] });
  const baseline = buildEvalBaseline({ results: [run], catalog: [{ id: cell.caseId,
    skill: "vibe", kind: "upgrade-resume", deterministic: true, contentHash: "b".repeat(64) }],
  pluginVersion: "1.1.48" });
  assert.equal(baseline.models.codex, EVAL_POLICY.codexModel);
  assert.throws(() => statefulSuite("codex", [{ ...cell, model: "different-codex-model" }]),
    /eval-stateful-codex-model-mismatch/);
});

test("ISS-13743 stateful attempt evidence records the validated Codex model", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-stateful-model-evidence-"));
  try {
    const cell: UpgradeCaseEvidence = { ...evidence(null, 1), runtime: "codex",
      model: EVAL_POLICY.codexModel, agentCostUsd: null, tokens: {} };
    const result = await runUpgradeCellWithRetry({ transitionRoot: root,
      run: async () => cell });
    assert.equal(result.model, EVAL_POLICY.codexModel);
    assert.equal(result.attemptResults?.[0]?.model, EVAL_POLICY.codexModel);
    const written = JSON.parse(readFileSync(join(root, "attempts/1/evidence.json"), "utf8")) as
      UpgradeCaseEvidence;
    assert.equal(written.model, EVAL_POLICY.codexModel);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-13760 stateful Claude replies stay in reply.txt and out of evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-stateful-reply-"));
  try {
    const transition = join(root, "transition");
    const result = await runUpgradeCellWithRetry({ transitionRoot: transition,
      run: async () => ({ ...evidence(null, 1), runtime: "claude" as const,
        privateReply: "stateful final reply" }) });
    assert.equal(result.privateReply, "stateful final reply");
    assert.doesNotMatch(readFileSync(join(transition, "attempts/1/evidence.json"), "utf8"),
      /stateful final reply|privateReply/);
    mkdirSync(join(root, "claude/upgrade-resume-changed-definition"), { recursive: true });
    preserveStatefulClaudeReply(root, "upgrade-resume-changed-definition", result.privateReply!);
    assert.equal(readFileSync(join(root,
      "claude/upgrade-resume-changed-definition/reply.txt"), "utf8"),
    "stateful final reply\n");
    const trace = upgradeEval.statefulClaudeEvidenceTrace([
      "stdout: stateful final reply",
      "failure saved at file:///private/tmp/reply.txt",
      "Bearer secret-token-value",
    ], result.privateReply!);
    assert.doesNotMatch(JSON.stringify(trace),
      /stateful final reply|file:\/\/\/private|secret-token-value/);
    assert.throws(() => preserveStatefulClaudeReply(root,
      "upgrade-resume-unchanged-definition", "Bearer secret-token-value"),
    /eval-private-reply-private-data/);
    assert.throws(() => preserveStatefulClaudeReply(root,
      "upgrade-resume-unchanged-definition", "saved at file:///private/tmp/reply.txt"),
    /eval-private-reply-private-data/);
    assert.equal(existsSync(join(root,
      "claude/upgrade-resume-unchanged-definition/reply.txt")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-13760 stateful reply selection never falls back to an earlier turn or transition", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-stateful-no-stale-reply-"));
  try {
  const turnOne = `${JSON.stringify({ type: "result", result: "turn-one reply" })}\n`;
  const turnTwoNoResult = `${JSON.stringify({ type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "working" }] } })}\n`;
  assert.equal(claudeTerminalReply(turnOne), "turn-one reply");
  assert.equal(claudeTerminalReply(turnTwoNoResult), "");
  let caseReply = nextPlannedClaudeReply("historical reply");
  caseReply = nextPlannedClaudeReply(undefined);
  assert.equal(caseReply, "", "current transition cannot inherit historical text");
  mkdirSync(join(root, "claude/upgrade-resume-changed-definition"), { recursive: true });
  if (caseReply) preserveStatefulClaudeReply(root, "upgrade-resume-changed-definition", caseReply);
  assert.equal(existsSync(join(root,
    "claude/upgrade-resume-changed-definition/reply.txt")), false);
  assert.equal(statefulReplyFailureCode("AUTH_UNAVAILABLE", true), "AUTH_UNAVAILABLE");
  assert.equal(statefulReplyFailureCode("TIMEOUT", true), "TIMEOUT");
  assert.equal(statefulReplyFailureCode(null, true), "ORACLE_MISMATCH");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-13760 runUpgradeResumeCases never writes a historical reply for a replyless current transition",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "vibe-stateful-historical-reply-"));
    try {
      const { runRoot, suite } = await runInjectedClaudeBoundary(root, null,
        "current-terminal-no-result");
      assert.deepEqual(suite.cases[0]?.failedGraders, ["ORACLE_MISMATCH"]);
      assert.equal(existsSync(join(runRoot, "claude/upgrade-resume-changed-definition/reply.txt")),
        false);
      assert.doesNotMatch(readFileSync(join(runRoot,
        "claude/upgrade-resume-changed-definition/evidence.json"), "utf8"),
      /historical reply|privateReply/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

test("ISS-13760 runUpgradeResumeCases never falls back to turn one after terminal stale recovery",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "vibe-stateful-terminal-reply-"));
    try {
      const turnOne = `${JSON.stringify({ type: "result", result: "turn-one reply" })}\n`;
      const noResult = (turn: string) => `${JSON.stringify({ type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: turn }] } })}\n`;
      const { runRoot, suite } = await runInjectedClaudeBoundary(root, null,
        "turn-one-result:terminal-stale-recovery-no-result",
        [turnOne, noResult("turn-two no result"), noResult("stale recovery no result")]);
      assert.deepEqual(suite.cases[0]?.failedGraders, ["ORACLE_MISMATCH"]);
      assert.equal(existsSync(join(runRoot, "claude/upgrade-resume-changed-definition/reply.txt")),
        false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

for (const failureCode of ["AUTH_UNAVAILABLE", "TIMEOUT"] as const) {
  test(`ISS-13760 runUpgradeResumeCases retains terminal ${failureCode} without stale reply`, async () => {
    const root = mkdtempSync(join(tmpdir(), `vibe-stateful-${failureCode.toLowerCase()}-`));
    try {
      const { runRoot, suite } = await runInjectedClaudeBoundary(root, failureCode,
        `current-terminal:${failureCode}:no-result`);
      assert.deepEqual(suite.cases[0]?.failedGraders, [failureCode]);
      assert.equal(statefulInfrastructureInvalidReason(suite),
        `eval-stateful-infrastructure:${failureCode}:upgrade-resume-changed-definition`);
      assert.equal(existsSync(join(runRoot, "claude/upgrade-resume-changed-definition/reply.txt")),
        false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("ISS-13720 isolated Claude MCP config contains only granted local graph tools", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-mcp-isolation-"));
  try {
    const isolated = createClaudeEvalIsolation(join(root, "graph"), process.execPath,
      UPGRADE_GRAPH_CAPABILITIES);
    const config = JSON.parse(readFileSync(isolated.mcpConfigFile, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.deepEqual(Object.keys(config.mcpServers), ["closedloop-graph"]);
    assert.equal(config.mcpServers["closedloop-graph"]?.command, process.execPath);
    assert.deepEqual(config.mcpServers["closedloop-graph"]?.args.at(-1)?.split(","),
      UPGRADE_GRAPH_CAPABILITIES.map((item) => item.operation).sort());
    const wrapper = readFileSync(isolated.executable, "utf8");
    assert.match(wrapper, /--setting-sources ''/);
    assert.match(wrapper, /--strict-mcp-config/);
    assert.match(wrapper, new RegExp(isolated.mcpConfigFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const empty = createClaudeEvalIsolation(join(root, "ordinary"), process.execPath, []);
    assert.deepEqual(JSON.parse(readFileSync(empty.mcpConfigFile, "utf8")), { mcpServers: {} });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-13720 isolated MCP fixture exposes only its declared operations", () => {
  const script = join(import.meta.dirname, "eval-mcp-stub.ts");
  const calls = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "code_symbols", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_document", arguments: {} } },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";
  const result = spawnSync(process.execPath,
    ["--experimental-strip-types", script, "--operations", "code_symbols,code_grep"],
    { input: calls, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as {
    id: number; result?: { tools?: Array<{ name: string }> }; error?: { code: number };
  });
  assert.deepEqual(responses.find((item) => item.id === 2)?.result?.tools?.map((item) => item.name),
    ["code_grep", "code_symbols"]);
  assert.equal(responses.find((item) => item.id === 3)?.error, undefined);
  assert.equal(responses.find((item) => item.id === 4)?.error?.code, -32601);
});

test("ISS-13720 transient stateful infrastructure retries once and retains both attempts", async () => {
  assert.equal(STATEFUL_INFRASTRUCTURE_RETRIES, 1);
  const root = mkdtempSync(join(tmpdir(), "vibe-stateful-retry-"));
  try {
    let calls = 0;
    const recovered = await runUpgradeCellWithRetry({ transitionRoot: join(root, "recovered"),
      run: async () => evidence(++calls === 1 ? "INSTALL_INVALID" : null, calls) });
    assert.equal(recovered.passed, true);
    assert.equal(recovered.failureCode, null);
    assert.deepEqual(recovered.attemptResults?.map((item) => item.failureCode),
      ["INSTALL_INVALID", null]);
    assert.equal(recovered.wallMs, 30);
    assert.equal(existsSync(join(root, "recovered/attempts/1/evidence.json")), true);
    assert.equal(existsSync(join(root, "recovered/attempts/2/evidence.json")), true);

    calls = 0;
    const persistent = await runUpgradeCellWithRetry({ transitionRoot: join(root, "persistent"),
      run: async () => evidence("INSTALL_INVALID", ++calls) });
    assert.equal(persistent.failureCode, "INSTALL_INVALID");
    assert.equal(persistent.attemptResults?.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-13720 definition premise mismatch is a harness error", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-definition-premise-"));
  try {
    const release = (name: string, version: string, body: string): PluginReleaseArchive => {
      const claudeVibeRoot = join(root, name);
      mkdirSync(join(claudeVibeRoot, "agents"), { recursive: true });
      writeFileSync(join(claudeVibeRoot, "agents/vibe-change-worker.md"), body);
      return { sha: name.padEnd(40, "a").slice(0, 40), version, archiveRoot: claudeVibeRoot,
        vibeDir: claudeVibeRoot, coreDir: claudeVibeRoot, claudeVibeRoot,
        claudeCoreRoot: claudeVibeRoot };
    };
    const prior = release("prior", "1.1.38", "same definition\n");
    const same = release("same", "1.1.39", "same definition\n");
    const changed = release("changed", "1.1.39", "changed definition\n");
    assert.doesNotThrow(() => assertUpgradeDefinitionPremise(
      { id: "unchanged", definition: "unchanged" }, prior, same));
    assert.doesNotThrow(() => assertUpgradeDefinitionPremise(
      { id: "changed", definition: "changed" }, prior, changed));
    assert.throws(() => assertUpgradeDefinitionPremise(
      { id: "stale", definition: "unchanged" }, prior, changed), /definition-premise-mismatch/);
    assert.throws(() => assertUpgradeDefinitionPremise(
      { id: "wrong-stored-digest", definition: "unchanged", nightlyPrior: {
        version: prior.version, ref: prior.sha, writerDigestSha256: "f".repeat(64),
      } }, prior, same), /nightly-prior-digest-mismatch:wrong-stored-digest/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("AC1 released archive builds Claude cache roots and retains exact release bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-release-archive-"));
  try {
    const release = archivePluginRelease(REPO, "802afdc075b4ca8442a5644975ef3571f98c38d2",
      join(root, "release"), "1.1.23");
    assert.equal(release.version, "1.1.23");
    assert.equal(release.claudeVibeRoot.endsWith("/vibe/1.1.23"), true);
    assert.equal(release.claudeCoreRoot.includes("/closedloop-core/"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-13563 AC3 current target uses candidate snapshot bytes while history keeps Git bytes", () => {
  const api = pluginSnapshots as unknown as { archiveSnapshotTarget?: (repo: string,
    ref: string, root: string, snapshot: unknown, version: string) => {
      vibeDir: string; claudeVibeRoot: string; version: string;
    } };
  assert.equal(typeof api.archiveSnapshotTarget, "function");
  const root = mkdtempSync(join(tmpdir(), "vibe-current-snapshot-"));
  try {
    const ref = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const version = JSON.parse(readFileSync(join(REPO, "plugins/vibe/.claude-plugin/plugin.json"),
      "utf8")).version as string;
    const historicalVersion = JSON.parse(execFileSync("git", ["-C", REPO, "show",
      `${ref}:plugins/vibe/.claude-plugin/plugin.json`], { encoding: "utf8" })).version as string;
    const snapshotRoot = join(root, "snapshot");
    mkdirSync(join(snapshotRoot, "plugins"), { recursive: true });
    const vibeDir = join(snapshotRoot, "plugins/vibe");
    const coreDir = join(snapshotRoot, "plugins/closedloop-core");
    cpSync(join(REPO, "plugins/vibe"), vibeDir, { recursive: true });
    cpSync(join(REPO, "plugins/closedloop-core"), coreDir, { recursive: true });
    const relative = "skills/vibe/scripts/dist/claude-worker.mjs";
    const source = join(vibeDir, relative);
    const marker = "candidate snapshot marker";
    writeFileSync(source, `${readFileSync(source, "utf8")}\n// ${marker}\n`);
    const snapshot = { sha: ref, vibeDir, coreDir, agentModels: {} };
    const current = api.archiveSnapshotTarget!(REPO, ref, join(root, "current"), snapshot, version);
    const historical = archivePluginRelease(REPO, ref, join(root, "historical"), historicalVersion);
    assert.match(readFileSync(join(current.vibeDir, relative), "utf8"), /candidate snapshot marker/);
    assert.match(readFileSync(join(current.claudeVibeRoot, relative), "utf8"), /candidate snapshot marker/);
    assert.doesNotMatch(readFileSync(join(historical.vibeDir, relative), "utf8"),
      /candidate snapshot marker/);
    const [major, minor, patch] = version.split(".").map(Number);
    const bumpedVersion = `${major}.${minor}.${patch! + 1}`;
    for (const manifest of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
      const path = join(vibeDir, manifest);
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      writeFileSync(path, JSON.stringify({ ...value, version: bumpedVersion }));
    }
    const bumped = api.archiveSnapshotTarget!(REPO, ref, join(root, "bumped"), snapshot,
      bumpedVersion);
    assert.equal(bumped.version, bumpedVersion);
    assert.equal(bumped.claudeVibeRoot.endsWith(`/vibe/${bumpedVersion}`), true);
    assert.equal(historical.version, historicalVersion, "historical archive keeps its Git version");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-13563 AC3 current subject reads an uncommitted snapshot version", () => {
  const api = upgradeEval as unknown as { upgradeSubject?: (input: {
    repo: string; targetRef: string; pluginSha: string;
    currentSnapshot: { sha: string; vibeDir: string; coreDir: string; agentModels: Record<string, string> };
  }) => { ref: string; version: string } };
  assert.equal(typeof api.upgradeSubject, "function");
  const root = mkdtempSync(join(tmpdir(), "vibe-current-version-"));
  try {
    const ref = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const vibeDir = join(root, "vibe");
    mkdirSync(join(vibeDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(vibeDir, ".codex-plugin"), { recursive: true });
    writeFileSync(join(vibeDir, ".claude-plugin/plugin.json"), JSON.stringify({ version: "9.9.9" }));
    writeFileSync(join(vibeDir, ".codex-plugin/plugin.json"), JSON.stringify({ version: "9.9.9" }));
    const subject = api.upgradeSubject!({ repo: REPO, targetRef: ref, pluginSha: ref,
      currentSnapshot: { sha: ref, vibeDir, coreDir: root, agentModels: {} } });
    assert.deepEqual(subject, { ref, version: "9.9.9" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("AC1 Codex cache validator binds installedPath, version, bytes and single target cache", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-codex-install-"));
  try {
    const release = archivePluginRelease(REPO, "f45882fb9118cca457221e48e7cef850557f8246",
      join(root, "release"), "1.1.25");
    const home = join(root, "home");
    const installed = join(home, "plugins/cache/closedloop-ai/vibe/1.1.25");
    mkdirSync(join(installed, ".."), { recursive: true });
    cpSync(release.vibeDir, installed, { recursive: true });
    assert.equal(validateCodexInstalledPlugin({ home, release,
      result: { version: "1.1.25", installedPath: installed } }), realpathSync(installed));
    assert.throws(() => validateCodexInstalledPlugin({ home, release,
      result: { version: "1.1.24", installedPath: installed } }), /install-invalid/);
    mkdirSync(join(home, "plugins/cache/closedloop-ai/vibe/1.1.23"));
    assert.throws(() => validateCodexInstalledPlugin({ home, release,
      result: { version: "1.1.25", installedPath: installed } }), /cache-invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("B1 Codex auth uses a disposable link and fails closed when the source is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-codex-auth-"));
  try {
    const source = join(root, "source");
    const home = join(root, "home");
    mkdirSync(source);
    writeFileSync(join(source, "auth.json"), "fixture\n", { mode: 0o600 });
    linkCodexAuth(home, source);
    assert.equal(realpathSync(join(home, "auth.json")), realpathSync(join(source, "auth.json")));
    assert.equal(readlinkSync(join(home, "auth.json")), realpathSync(join(source, "auth.json")));
    rmSync(home, { recursive: true, force: true });
    assert.equal(existsSync(join(source, "auth.json")), true);
    assert.throws(() => linkCodexAuth(join(root, "missing-home"), join(root, "missing-source")),
      /AUTH_UNAVAILABLE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("S8 mixed suite merge gives every selected case exactly one owner", () => {
  const ordinary = suite("claude", ["pm-ordinary"]);
  ordinary.deterministicOverride = { sha256: "d".repeat(64),
    graders: ["pm-prd-children-are-scope/claims-untouched"], checkerVersion: "1.1.49",
    checkerSha256: "c".repeat(64) };
  const stateful = suite("claude", ["upgrade-resume-unchanged-definition"]);
  const selected = ["pm-ordinary", "upgrade-resume-unchanged-definition"];
  assert.deepEqual(mergeEvalSuiteResults(ordinary, stateful, selected)?.cases.map((item) => item.id),
    selected);
  assert.deepEqual(mergeEvalSuiteResults(ordinary, stateful, selected)?.deterministicOverride,
    ordinary.deterministicOverride);
  const unavailable = statefulSuite("claude", [{ ...evidence(null, 1),
    caseId: "upgrade-resume-unchanged-definition", passed: false,
    unavailableReason: "NO_VALID_PRIOR fixture", cliVersion: ordinary.cliVersion }]);
  const merged = mergeEvalSuiteResults(ordinary, unavailable, selected);
  assert.equal(merged?.passed, 1);
  assert.equal(merged?.failed, 0);
  assert.equal(merged?.unavailable, 1);
  assert.throws(() => mergeEvalSuiteResults(ordinary, stateful, ["pm-ordinary"]),
    /coverage-mismatch/);
});

function failedStatefulSuite(code: string, mixed = false): EvalSuiteResult {
  const ids = mixed ? ["upgrade-resume-changed-definition",
    "upgrade-resume-unchanged-definition"] : ["upgrade-resume-changed-definition"];
  const result = suite("claude", ids);
  result.cases = result.cases.map((item, index) => index === 0
    ? { ...item, passed: false, failedGraders: [code] } : item);
  result.passed = result.cases.filter((item) => item.passed).length;
  result.failed = result.cases.length - result.passed;
  return result;
}

for (const code of ["AUTH_UNAVAILABLE", "INSTALL_INVALID", "MODEL_UNAVAILABLE", "TIMEOUT",
  "SANDBOX_REFUSAL"] as const) {
  test(`B1 ${code} stateful boundary invalidates the runtime`, () => {
    assert.equal(statefulInfrastructureInvalidReason(failedStatefulSuite(code)),
      `eval-stateful-infrastructure:${code}:upgrade-resume-changed-definition`);
  });
}

test("B1 mixed pass and infrastructure failure invalidates the complete runtime", () => {
  assert.equal(statefulInfrastructureInvalidReason(
    failedStatefulSuite("AUTH_UNAVAILABLE", true)),
  "eval-stateful-infrastructure:AUTH_UNAVAILABLE:upgrade-resume-changed-definition");
});

test("B1 vibe regressions remain retryable case outcomes", () => {
  for (const code of ["STALE_PLUGIN_ROOT", "MODEL_BLOCK", "WRONG_SESSION", "ORACLE_MISMATCH"]) {
    assert.equal(statefulInfrastructureInvalidReason(failedStatefulSuite(code)), null, code);
  }
});

test("S9 stateful root bound leaves writer timeout observable", () => {
  assert.equal(CLAUDE_WRITER_TIMEOUT_MS, 900_000);
  assert.equal(STATEFUL_CLAUDE_ROOT_TIMEOUT_MS, 1_200_000);
  assert.ok(STATEFUL_CLAUDE_ROOT_TIMEOUT_MS > CLAUDE_WRITER_TIMEOUT_MS);
  assert.equal(STATEFUL_CLAUDE_ROOT_TIMEOUT_MS - CLAUDE_WRITER_TIMEOUT_MS, 300_000);
  assert.equal(CODEX_STATEFUL_ROOT_TIMEOUT_MS, 1_800_000);
});

test("S12 Claude turn two resumes the exact root id with the target plugin root", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-claude-resume-"));
  try {
    const release = archivePluginRelease(REPO, "f45882fb9118cca457221e48e7cef850557f8246",
      join(root, "release"), "1.1.25");
    const id = "11111111-2222-4333-8444-555555555555";
    const args = claudeUpgradeRootArgs({ release, settings: join(root, "settings.json"),
      rootSessionId: id, prompt: "continue exact fixture", resume: true,
      caseId: "upgrade-resume-changed-definition" });
    assert.deepEqual(args.slice(-3), ["--resume", id, "continue exact fixture"]);
    assert.deepEqual(args.flatMap((arg, index) => args[index - 1] === "--plugin-dir" ? [arg] : []),
      [release.claudeCoreRoot, release.claudeVibeRoot]);
    assert.equal(args[args.indexOf("--allowedTools") + 1], "Bash");
    assert.equal(args.includes("--effort"), false, "stateful root uses Claude's default effort");
    assert.throws(() => claudeUpgradeRootArgs({ release, settings: "settings", rootSessionId: "wrong",
      prompt: "continue", resume: true, caseId: "case" }), /session-invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("request two is enqueued through the released stdin-only contract", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-enqueue-contract-"));
  try {
    const dist = join(root, "skills/vibe/scripts/dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "writer-state.mjs"), `import {readFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(input));\n`);
    const result = enqueueUpgradeRequest(root, { worktree: "/fixture", workerId: "writer-1",
      requestId: "request-two", text: "append turn two" });
    assert.deepEqual(result, { worktree: "/fixture", workerId: "writer-1",
      requestId: "request-two", input: "append turn two" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("queued second-request oracle accepts runtime identities and rejects old-request replay", () => {
  const base = { previousWriterId: "writer-1", proofLines: ["turn-one", "turn-two"],
    terminalText: "DONE", requestCompleted: true, oldArchiveRetained: true };
  assert.equal(upgradeCasePasses({ ...base, runtime: "claude", definition: "unchanged",
    finalWriterId: "writer-1", migrationCount: 0 }), true);
  assert.equal(upgradeCasePasses({ ...base, runtime: "claude", definition: "changed",
    finalWriterId: "writer-2", migrationCount: 1 }), true);
  assert.equal(upgradeCasePasses({ ...base, runtime: "codex", definition: "unchanged",
    finalWriterId: "writer-2", migrationCount: 1 }), true);
  assert.equal(upgradeCasePasses({ ...base, runtime: "codex", definition: "changed",
    finalWriterId: "writer-2", migrationCount: 1 }), true);
  assert.equal(upgradeCasePasses({ ...base, runtime: "codex", definition: "unchanged",
    finalWriterId: "writer-1", migrationCount: 0, proofLines: ["turn-one"],
    terminalText: "prior request completed; no edit" }), false);
  assert.equal(upgradeCasePasses({ ...base, runtime: "claude", definition: "changed",
    finalWriterId: "writer-2", migrationCount: 1, terminalText: "BLOCKED: ask the person" }), false);
});

test("S10 recovered internal stale refusal passes only after complete automatic migration", () => {
  const recovered = { runtime: "claude" as const, definition: "changed" as const,
    previousWriterId: "writer-1", finalWriterId: "writer-2", migrationCount: 1,
    proofLines: ["turn-one", "turn-two"], requestCompleted: true, oldArchiveRetained: true,
    terminalText: "DONE. The first launch returned STALE_PLUGIN_ROOT. The hook blocked me on the first migrate form, then the migration retry succeeded and request two completed." };
  assert.equal(upgradeCasePasses(recovered), true);
  for (const terminalText of ["STALE_PLUGIN_ROOT", "BLOCKED: STALE_PLUGIN_ROOT needs migration",
    "FAILED: STALE_PLUGIN_ROOT migration stopped", "NEEDS_PERSON: migration approval",
    "DONE STALE_PLUGIN_ROOT NEEDS_PERSON",
    "DONE STALE_PLUGIN_ROOT requires user action"]) {
    assert.equal(upgradeCasePasses({ ...recovered, terminalText }), false, terminalText);
  }
  assert.equal(upgradeCasePasses({ ...recovered, requestCompleted: false }), false);
  assert.equal(upgradeCasePasses({ ...recovered, oldArchiveRetained: false }), false);
  assert.equal(upgradeCasePasses({ ...recovered, finalWriterId: "writer-1" }), false);
  assert.equal(upgradeCasePasses({ ...recovered, migrationCount: 0 }), false);
  assert.equal(upgradeCasePasses({ ...recovered, proofLines: ["turn-one"] }), false);
});

test("S10 exact stale state permits one same-root root-decided recovery", () => {
  const oldWriterId = "writer-1";
  const requestId = "upgrade-resume-changed-definition-two";
  const eligible = { exitCode: 0, terminalText: "STALE_PLUGIN_ROOT", requestId,
    oldWriterId, proofLines: ["turn-one"], oldArchiveRetained: true,
    ledger: { runtime: "claude", workerId: oldWriterId, migrations: [], completed: [],
      active: undefined, pending: [{ id: requestId, input: "append turn two" }] } };
  assert.equal(claudeStaleRecoveryEligible(eligible), true);
  assert.equal(upgradeCasePasses({ runtime: "claude", definition: "changed",
    previousWriterId: oldWriterId, finalWriterId: "writer-2", migrationCount: 1,
    proofLines: ["turn-one", "turn-two"], requestCompleted: true,
    oldArchiveRetained: true, terminalText: "DONE" }), true);
  for (const override of [
    { terminalText: "STALE_PLUGIN_ROOT requires human action" },
    { ledger: { ...eligible.ledger, active: { id: requestId, lease: "lease" }, pending: [] } },
    { ledger: { ...eligible.ledger, pending: [{ id: "wrong-request" }] } },
    { ledger: { ...eligible.ledger, workerId: "wrong-writer" } },
    { ledger: { ...eligible.ledger, migrations: [{ at: "now" }] } },
  ]) assert.equal(claudeStaleRecoveryEligible({ ...eligible, ...override }), false);
  assert.equal(upgradeCasePasses({ runtime: "claude", definition: "changed",
    previousWriterId: oldWriterId, finalWriterId: "writer-2", migrationCount: 1,
    proofLines: ["turn-one", "turn-two"], requestCompleted: true,
    oldArchiveRetained: true, terminalText: "STALE_PLUGIN_ROOT" }), false,
  "a second stale terminal remains failure");
});

test("ISS-13563 AC3 structured stale refusal permits bounded recovery after a verbose root answer", () => {
  const api = upgradeEval as unknown as { claudeStaleToolResult?: (stdout: string,
    requestId: string) => boolean };
  assert.equal(typeof api.claudeStaleToolResult, "function");
  const requestId = "upgrade-resume-changed-definition-two";
  const line = JSON.stringify({ status: "BLOCKED", code: "STALE_PLUGIN_ROOT", requestId,
    leaseRetained: false });
  const stdout = `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result",
    content: `1\t${line}\n2\t[exited with code 1]` }] } })}\n`;
  assert.equal(api.claudeStaleToolResult!(stdout, requestId), true);
  assert.equal(api.claudeStaleToolResult!(stdout, "wrong-request"), false);
  const eligible = { exitCode: 0, terminalText: "Request two is not done: STALE_PLUGIN_ROOT; command shape was rejected.",
    requestId, oldWriterId: "writer-1", proofLines: ["turn-one"], oldArchiveRetained: true,
    staleToolResult: api.claudeStaleToolResult!(stdout, requestId),
    ledger: { runtime: "claude", workerId: "writer-1", migrations: [], completed: ["request-one"],
      active: undefined, pending: [{ id: requestId, input: "append turn two" }] } };
  assert.equal(claudeStaleRecoveryEligible(eligible), true);
  assert.equal(claudeStaleRecoveryEligible({ ...eligible, terminalText:
    "STALE_PLUGIN_ROOT requires human action" }), false);
  assert.match(claudeStaleRecoveryPrompt({ requestId,
    sessionSlug: "upgrade-resume-changed-definition" }), /single literal .*pipeline/i);
});

test("S10 stale continuation resumes the exact target root with default effort", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-claude-stale-recovery-"));
  try {
    const release = archivePluginRelease(REPO, "f45882fb9118cca457221e48e7cef850557f8246",
      join(root, "release"), "1.1.25");
    const rootSessionId = "11111111-2222-4333-8444-555555555555";
    const requestId = "upgrade-resume-changed-definition-two";
    const prompt = claudeStaleRecoveryPrompt({ requestId,
      sessionSlug: "upgrade-resume-changed-definition" });
    const args = claudeUpgradeRootArgs({ release, settings: join(root, "settings.json"),
      rootSessionId, prompt, resume: true, caseId: "upgrade-resume-changed-definition" });
    assert.deepEqual(args.slice(-3), ["--resume", rootSessionId, prompt]);
    assert.equal(args.includes("--effort"), false);
    assert.equal(args.includes(release.claudeVibeRoot), true);
    assert.doesNotMatch(prompt, /previousWorkerId|definitionDigest|workerId|migrate payload/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude launcher grant contains the required bounded graph operations and rejects empty grants", () => {
  assert.deepEqual(UPGRADE_GRAPH_CAPABILITIES.map((item) => item.operation), [
    "get_routing_protocol", "code_projects", "code_symbols", "code_callers", "code_importers",
    "blast_radius_tickets", "code_grep", "code_snippet", "code_tests_for",
  ]);
  assert.ok(UPGRADE_GRAPH_CAPABILITIES.every((item) => item.service === "graph" &&
    item.access === "read" && item.name === `mcp__closedloop-graph__${item.operation}`));
  assert.doesNotThrow(() => validateUpgradeCapabilities(UPGRADE_GRAPH_CAPABILITIES));
  assert.throws(() => validateUpgradeCapabilities([]), /capabilities-missing/);
});

test("Codex HOLD bootstrap permits one same-root continuation and rejects ambiguous states", () => {
  const child = "01a19a97-07be-77a2-a5b5-1c6232017907";
  const activity = JSON.stringify({ method: "item/started", params: { threadId: "root-1",
    item: { type: "subAgentActivity", agentPath: "/root/vibe_change_worker",
      agentThreadId: child } } });
  const hold = JSON.stringify({ method: "item/completed", params: { threadId: child,
    item: { type: "agentMessage", text: "HOLD" } } });
  assert.equal(heldCodexWriter([activity, hold], false, []), "/root/vibe_change_worker");
  const explained = hold.replace("HOLD", "HOLD pending registration and claim of your actual native ID.");
  assert.equal(heldCodexWriter([activity, explained], false, []), "/root/vibe_change_worker");
  assert.equal(upgradeCasePasses({ runtime: "codex", definition: "unchanged",
    previousWriterId: child, finalWriterId: "writer-2", migrationCount: 1,
    proofLines: ["turn-one", "turn-two"], terminalText: "DONE", requestCompleted: true,
    oldArchiveRetained: true }), true);
  assert.equal(heldCodexWriter([hold], false, []), null, "HOLD without child id");
  assert.equal(heldCodexWriter([activity, activity.replace(child, "child-2"), hold], false, []), null,
    "multiple children");
  assert.equal(heldCodexWriter([activity, hold.replace("HOLD", "DONE")], false, []), null,
    "non-HOLD terminal");
  assert.equal(heldCodexWriter([activity, hold], true, []), null, "existing ledger");
  assert.equal(heldCodexWriter([activity, hold], false, ["turn-one"]), null, "existing proof");
  assert.equal(heldCodexWriter([activity, hold], false, []), "/root/vibe_change_worker",
    "second HOLD remains detectable and fatal");
});

test("HOLD status accepts one bounded explanatory line and rejects false or mixed terminals", () => {
  assert.equal(holdStatusText("HOLD"), true);
  assert.equal(holdStatusText(" HOLD: pending registration. "), true);
  assert.equal(holdStatusText("HOLD pending registration and claim of your actual native ID."), true);
  for (const value of ["prefix HOLD", "HOLDING", "DONE HOLD", "HOLD then DONE",
    "HOLD: BLOCKED", "HOLD\nDONE", `HOLD ${"x".repeat(513)}`]) {
    assert.equal(holdStatusText(value), false, value);
  }
});

test("failure taxonomy ignores harmless auth metadata and preserves exact terminal signals", () => {
  assert.equal(classifyUpgradeFailure('{"authMode":"stored","author":"fixture"}\nWORKER_TURN_FAILED'),
    "MODEL_BLOCK");
  assert.equal(classifyUpgradeFailure("CLAUDE_SIGN_IN_NEEDED: sign in required"), "AUTH_UNAVAILABLE");
  assert.equal(classifyUpgradeFailure("credentials unavailable for this worker"), "AUTH_UNAVAILABLE");
  assert.equal(classifyUpgradeFailure("WORKER_TURN_FAILED"), "MODEL_BLOCK");
  assert.equal(classifyUpgradeFailure("STALE_PLUGIN_ROOT"), "STALE_PLUGIN_ROOT");
  assert.equal(classifyUpgradeFailure("spawn fixture-claude ENOENT"), "INSTALL_INVALID");
  assert.equal(classifyUpgradeFailure("MCP_TOOLS_MISSING closedloop-graph"), "INSTALL_INVALID");
  assert.equal(classifyUpgradeFailure("permission denied cleaning owned record"), "SANDBOX_REFUSAL");
  assert.equal(classifyUpgradeFailure("owned process deadline exceeded"), "TIMEOUT");
});

test("Codex token usage keeps only the final cumulative total per distinct thread", () => {
  const event = (threadId: string, input: number, cached: number, output: number, reasoning: number) =>
    JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: { total: {
      totalTokens: input + output, inputTokens: input, cachedInputTokens: cached,
      cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: reasoning,
    }, last: { inputTokens: 999 } } } });
  assert.deepEqual(appServerTokenUsage([
    event("root", 10, 4, 2, 1), event("child", 5, 1, 1, 0),
    event("root", 20, 8, 3, 2), event("child", 8, 2, 2, 1),
  ]), { total_tokens: 33, input_tokens: 28, cached_input_tokens: 10,
    cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 3 });
});

test("Codex completed turn evidence finalizes the exact active lease before target install", () => {
  const workerId = "/root/vibe_change_worker";
  const child = "01a19a97-07be-77a2-a5b5-1c6232017907";
  const activity = JSON.stringify({ method: "item/started", params: { threadId: "root-1",
    item: { type: "subAgentActivity", agentPath: workerId, agentThreadId: child } } });
  const completed = JSON.stringify({ method: "turn/completed", params: { threadId: child,
    turn: { status: "completed" } } });
  const ledger = { runtime: "codex", workerId, active: { id: "request-one", lease:
    "11111111-2222-4333-8444-555555555555" } };
  assert.deepEqual(codexStoppedTurn([activity, completed], ledger), { runtime: "codex", workerId,
    requestId: "request-one", lease: ledger.active.lease, state: "completed" });
  assert.equal(codexStoppedTurn([activity.replace(workerId, "/root/other"), completed], ledger), null);
  assert.equal(codexStoppedTurn([activity, activity.replace(child, "child-2"), completed], ledger), null);
  assert.equal(codexStoppedTurn([activity, completed.replace("completed", "failed")], ledger), null);
  assert.throws(() => requireIdleCodexLedger(ledger), /not idle/);
  assert.doesNotThrow(() => requireIdleCodexLedger({ runtime: "codex", workerId, active: undefined }));
});

test("ISS-13563 AC3 Codex request two is finalized before its oracle", async () => {
  const api = upgradeEval as unknown as { finalizeCodexObservedRequest?: (input: {
    trace: string[]; ledger: Record<string, unknown>; requestId: string; worktree: string;
    resultSummary: string;
    finish: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  }) => Promise<Record<string, unknown>> };
  assert.equal(typeof api.finalizeCodexObservedRequest, "function");
  const workerId = "/root/vibe_change_worker_migrated";
  const child = "01a19a97-07be-77a2-a5b5-1c6232017907";
  const trace = [
    JSON.stringify({ method: "item/started", params: { threadId: "root",
      item: { type: "subAgentActivity", agentPath: workerId, agentThreadId: child } } }),
    JSON.stringify({ method: "turn/completed", params: { threadId: child,
      turn: { status: "completed" } } }),
  ];
  const active = { runtime: "codex", workerId, active: { id: "case-two", lease: "lease-two" },
    completed: ["case-one"], pending: [] };
  const payloads: Record<string, unknown>[] = [];
  const complete = async (payload: Record<string, unknown>) => {
    payloads.push(payload);
    return { ...active, active: undefined, completed: ["case-one", "case-two"] };
  };
  const after = await api.finalizeCodexObservedRequest!({ trace, ledger: active,
    requestId: "case-two", worktree: "/fixture", resultSummary: "Upgrade eval turn two completed",
    finish: complete });
  assert.deepEqual(payloads[0], { worktree: "/fixture", workerId, requestId: "case-two",
    lease: "lease-two", status: "DONE", resultSummary: "Upgrade eval turn two completed",
    stoppedTurn: { runtime: "codex", workerId, requestId: "case-two",
      lease: "lease-two", state: "completed" } });
  assert.deepEqual(after.completed, ["case-one", "case-two"]);
  await assert.rejects(() => api.finalizeCodexObservedRequest!({ trace, ledger: active,
    requestId: "wrong-request", worktree: "/fixture",
    resultSummary: "Upgrade eval turn two completed", finish: complete }), /request/);
  assert.equal(payloads.length, 1, "wrong request must not finish a lease");
});

test("ISS-13563 AC3 historical expected failures stay separate from current pass gate", () => {
  const api = upgradeEval as unknown as { scoreUpgradeTransitions?: (items: Array<{
    role: "historical" | "current"; expected: "pass" | "fail";
    evidence: { target: { version: string; ref: string }; passed: boolean;
      failureCode: string | null; proofLines: string[]; previousWriterId: string | null;
      migrationCount: number };
  }>) => { passed: boolean; transitions: Array<{ matched: boolean; expected: string;
    observed: string }> } };
  assert.equal(typeof api.scoreUpgradeTransitions, "function");
  const historical = { role: "historical" as const, expected: "fail" as const,
    evidence: { target: { version: "1.1.23", ref: "a".repeat(40) }, passed: false,
      failureCode: "MODEL_BLOCK", proofLines: ["turn-one"], previousWriterId: "writer-1",
      migrationCount: 0 } };
  const current = { role: "current" as const, expected: "pass" as const,
    evidence: { target: { version: "1.1.26", ref: "b".repeat(40) }, passed: true,
      failureCode: null, proofLines: ["turn-one", "turn-two"], previousWriterId: "writer-1",
      migrationCount: 1 } };
  const good = api.scoreUpgradeTransitions!([historical, current]);
  assert.equal(good.passed, true);
  assert.deepEqual(good.transitions.map((item) => [item.expected, item.observed, item.matched]),
    [["fail", "fail", true], ["pass", "pass", true]]);
  assert.equal(api.scoreUpgradeTransitions!([historical, { ...current,
    evidence: { ...current.evidence, passed: false, failureCode: "ORACLE_MISMATCH" } }]).passed,
  false, "historical expected failure cannot mask a current failure");
  assert.equal(api.scoreUpgradeTransitions!([{ ...historical,
    evidence: { ...historical.evidence, passed: true, failureCode: null } }, current]).passed,
  false, "an unexpected historical pass must be recorded as mismatch");
  assert.equal(api.scoreUpgradeTransitions!([{ ...historical,
    evidence: { ...historical.evidence, failureCode: "AUTH_UNAVAILABLE" } }, current]).passed,
  false, "infrastructure failures cannot count as expected product failures");
  assert.equal(api.scoreUpgradeTransitions!([{ ...historical,
    evidence: { ...historical.evidence, proofLines: [], previousWriterId: null } }, current]).passed,
  false, "a first-turn failure is not the expected second-turn failure");
  assert.equal(api.scoreUpgradeTransitions!([{ ...historical,
    evidence: { ...historical.evidence, failureCode: "WRONG_SESSION" } }, current]).passed,
  false, "an unrelated wrong session is not an expected historical failure");
  assert.equal(api.scoreUpgradeTransitions!([{ ...historical,
    evidence: { ...historical.evidence, failureCode: "ORACLE_MISMATCH" } }, current]).passed,
  false, "a generic oracle failure is not an expected historical failure");
});

test("ISS-13563 AC3 Claude root gives the released launcher its CLI on PATH", () => {
  const api = upgradeEval as unknown as { claudeRootEnvironment?: (executable: string,
    base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };
  assert.equal(typeof api.claudeRootEnvironment, "function");
  const env = api.claudeRootEnvironment!("/fixture/cli-bin/claude",
    { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/unrelated/config" });
  assert.equal(env.PATH, "/fixture/cli-bin:/usr/bin");
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
});

test("ISS-13563 AC3 Claude first-turn terminal reason classifies missing graph as infrastructure", () => {
  const api = upgradeEval as unknown as { claudeTurnFailureText?: (result: {
    exitCode: number; stdout: string; stderr: string }) => string };
  assert.equal(typeof api.claudeTurnFailureText, "function");
  const result = { exitCode: 0,
    stdout: `${JSON.stringify({ type: "system", subtype: "init", padding: "i".repeat(5000) })}\n` +
      `${JSON.stringify({ type: "result", result: "BLOCKED MCP_TOOLS_MISSING: closedloop-graph" })}\n`,
    stderr: "" };
  const reason = api.claudeTurnFailureText!(result);
  assert.match(reason, /MCP_TOOLS_MISSING: closedloop-graph/);
  assert.equal(classifyUpgradeFailure(reason), "INSTALL_INVALID");
});

test("ISS-13563 AC3 Codex model capacity is infrastructure, not a historical oracle failure", () => {
  const api = upgradeEval as unknown as { codexServerFailure?: (trace: string[]) =>
    string | null };
  assert.equal(typeof api.codexServerFailure, "function");
  const overloaded = JSON.stringify({ method: "error", params: { error: {
    message: "Selected model is at capacity. Please try a different model.",
    codexErrorInfo: "serverOverloaded" }, willRetry: false } });
  const failedTurn = JSON.stringify({ method: "turn/completed", params: { turn: {
    status: "failed", error: { codexErrorInfo: "serverOverloaded" } } } });
  assert.equal(api.codexServerFailure!([overloaded, failedTurn]), "MODEL_UNAVAILABLE");
  assert.equal(api.codexServerFailure!([overloaded, failedTurn,
    JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } })]),
  null, "a recovered capacity error cannot mask a later oracle failure");
  assert.equal(classifyUpgradeFailure("Selected model is at capacity. Please try a different model."),
    "MODEL_UNAVAILABLE");
  assert.equal(classifyUpgradeFailure("ORACLE_MISMATCH first turn created no writer ledger"),
    "ORACLE_MISMATCH");
});

test("ISS-13563 AC3 Claude migration refusal is not an installer failure", () => {
  const terminal = "The recorded definition is changed, and the installed 1.1.25 release is newer. " +
    "The session rules say to migrate before launching. " +
    "The first migrate attempt failed validation because agentRoot, previousWorkerId and previousDigest " +
    "were omitted. The hook blocked the second migrate attempt with Upgrade eval allows only one " +
    "bounded writer command. The edit was not made.";
  assert.equal(classifyUpgradeFailure(terminal), "MODEL_BLOCK");
  assert.equal(classifyUpgradeFailure("eval-stateful-codex-install-invalid"), "INSTALL_INVALID");
  assert.equal(classifyUpgradeFailure("eval-stateful-codex-cache-file-drift"), "INSTALL_INVALID");
  assert.equal(classifyUpgradeFailure("WRONG_SESSION Codex resumed another root"), "WRONG_SESSION");
});

test("ISS-13563 AC3 Claude changed continuation supplies the complete migrate command", () => {
  const api = upgradeEval as unknown as { rootPrompt?: (input: {
    fixture: { worktree: string; sessionSlug: string }; requestId: string; marker: string;
    continuation: boolean; vibeRoot: string; runtime: "claude";
    migration: { previousWorkerId: string; previousDigest: string };
  }) => string };
  assert.equal(typeof api.rootPrompt, "function");
  const prompt = api.rootPrompt!({ fixture: { worktree: "/fixture/worktree",
    sessionSlug: "upgrade-resume-changed-definition" }, requestId: "case-two",
    marker: "turn-two", continuation: true, vibeRoot: "/fixture/target", runtime: "claude",
    migration: { previousWorkerId: "prior-writer", previousDigest: "b".repeat(64) } });
  assert.match(prompt, /"agentRoot":"\/fixture\/target"/);
  assert.match(prompt, /"previousWorkerId":"prior-writer"/);
  assert.match(prompt, /"previousDigest":"b{64}"/);
  assert.match(prompt, /writer-state\.mjs' migrate/);
});

test("Codex target migration requires the exact new HOLD child identity", () => {
  const trace = (path: string, child: string) => [
    JSON.stringify({ method: "item/started", params: { threadId: "root-1",
      item: { type: "subAgentActivity", agentPath: path, agentThreadId: child } } }),
    JSON.stringify({ method: "item/completed", params: { threadId: child,
      item: { type: "agentMessage", text: "HOLD" } } }),
  ];
  assert.equal(targetMigrationChild(trace("/root/vibe_migrated_writer", "new-child"),
    "/root/vibe_change_worker"), "/root/vibe_migrated_writer");
  assert.equal(targetMigrationChild(trace("/root/vibe_change_worker", "old-child"),
    "/root/vibe_change_worker"), null);
  assert.equal(targetMigrationChild([...trace("/root/vibe_migrated_writer", "new-child"),
    ...trace("/root/vibe_another", "other-child")], "/root/vibe_change_worker"), null);
});

test("ISS-13563 AC3 Codex accepts an observed migrated child that completed without HOLD", () => {
  const oldWriter = "/root/vibe_writer";
  const newWriter = "/root/vibe_writer_migrated";
  const child = "01a19a97-07be-77a2-a5b5-1c6232017907";
  const trace = [
    JSON.stringify({ method: "item/started", params: { threadId: "root",
      item: { type: "subAgentActivity", agentPath: newWriter, agentThreadId: child } } }),
    JSON.stringify({ method: "turn/completed", params: { threadId: child,
      turn: { status: "completed" } } }),
    JSON.stringify({ method: "item/completed", params: { threadId: "root",
      item: { type: "subAgentActivity", agentPath: newWriter,
        agentThreadId: child, kind: "completed" } } }),
  ];
  const select = targetMigrationChild as unknown as (trace: string[], previous: string,
    migrated?: string) => string | null;
  assert.equal(select(trace, oldWriter, newWriter), newWriter);
  assert.equal(select(trace, oldWriter, "/root/other"), null);
  assert.equal(select(trace.slice(0, 1), oldWriter, newWriter), null);
  assert.equal(select([...trace, trace[0].replace(newWriter, "/root/vibe_another")], oldWriter,
    newWriter), null);
});

test("Claude version cleanup covers success, failure, signals, parallel cases and unrelated files", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-version-record-"));
  const home = join(root, "home");
  const conversation = "11111111-2222-4333-8444-555555555555";
  const unrelated = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const bin = join(root, "bin");
  const realCodexMarker = join(root, "real-codex-was-called");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(realCodexMarker)},'called');process.exit(9);\n`);
  chmodSync(join(bin, "codex"), 0o700);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  const prior = archivePluginRelease(REPO, "f8517d50715dd8569ceee44f5a9452cbf8fc18f5",
    join(root, "prior"), "1.1.24");
  const target = archivePluginRelease(REPO, "f45882fb9118cca457221e48e7cef850557f8246",
    join(root, "target"), "1.1.25");
  const files = new Map([
    ["/.claude-plugin/marketplace.json", join(target.archiveRoot, ".claude-plugin/marketplace.json")],
    ["/plugins/vibe/.claude-plugin/plugin.json", join(target.vibeDir, ".claude-plugin/plugin.json")],
    ["/plugins/closedloop-core/.claude-plugin/plugin.json",
      join(target.coreDir, ".claude-plugin/plugin.json")],
  ]);
  const server = createServer((request, response) => {
    const file = files.get(request.url ?? "");
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200); response.end(readFileSync(file));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const old = await prepareClaudeVersionRecord({ release: prior, latestBase: url,
      root, rootSessionId: conversation, home, env });
    assert.match(old, /version 1\.1\.24 status=outdated choice=proceed/);
    const current = await prepareClaudeVersionRecord({ release: target, latestBase: url,
      root, rootSessionId: conversation, home, refresh: true, env });
    assert.match(current, /version 1\.1\.25 status=current choice=none/);
    assert.throws(() => validateClaudeVersionRecord({ conversation: "wrong", runtime: "claude",
      harnesses: [{ harness: "claude", plugins: [{ name: "vibe", version: "1.1.25" }] }] },
    "1.1.25", conversation), /record-invalid/);
    assert.throws(() => validateClaudeVersionRecord({ conversation, runtime: "claude",
      harnesses: [{ harness: "claude", plugins: [{ name: "vibe", version: "1.1.24" }] }] },
    "1.1.25", conversation), /record-invalid/);
    for (const base of [join(home, ".codex/vibe/plugin-version"), join(home, ".vibe-hook-scope")]) {
      mkdirSync(base, { recursive: true }); writeFileSync(join(base, `${unrelated}.json`), "{}\n");
    }
    cleanupClaudeVersionRecords(root, conversation, home);
    assert.equal(existsSync(join(home, ".codex/vibe/plugin-version", `${conversation}.json`)), false);
    assert.equal(existsSync(join(home, ".vibe-hook-scope", `${conversation}.json`)), false);
    assert.equal(existsSync(join(home, ".codex/vibe/plugin-version", `${unrelated}.json`)), true);
    assert.equal(existsSync(join(home, ".vibe-hook-scope", `${unrelated}.json`)), true);
    assert.equal(existsSync(realCodexMarker), false);
    assert.deepEqual(readdirSync(root).filter((name) => /^(?:claude|codex)-list-|plugin-version-state/.test(name)), []);

    const failedRoot = join(root, "failed-case");
    mkdirSync(failedRoot);
    const failedConversation = "11111111-2222-4333-8444-555555555556";
    await assert.rejects(() => prepareClaudeVersionRecord({ release: target,
      latestBase: `${url}/missing`, root: failedRoot, rootSessionId: failedConversation, home }),
    /version-check-failed|404|fetch/i);
    assert.equal(existsSync(join(home, ".codex/vibe/plugin-version",
      `${failedConversation}.json`)), false);
    assert.equal(existsSync(join(home, ".vibe-hook-scope", `${failedConversation}.json`)), false);

    for (const [signal, suffix] of [["SIGINT", "7"], ["SIGTERM", "8"]] as const) {
      const sessions = [
        `11111111-2222-4333-8444-55555555555${suffix}`,
        `22222222-3333-4444-8555-66666666666${suffix}`,
      ];
      await Promise.all(sessions.map(async (session, index) => {
        const caseRoot = join(root, `${signal.toLowerCase()}-${index}`);
        mkdirSync(caseRoot);
        await prepareClaudeVersionRecord({ release: target, latestBase: url,
          root: caseRoot, rootSessionId: session, home });
      }));
      cleanupClaudeVersionRecordsForSignal(signal);
      for (const session of sessions) {
        assert.equal(existsSync(join(home, ".codex/vibe/plugin-version", `${session}.json`)), false);
        assert.equal(existsSync(join(home, ".vibe-hook-scope", `${session}.json`)), false);
      }
      assert.equal(existsSync(join(home, ".codex/vibe/plugin-version", `${unrelated}.json`)), true);
      assert.equal(existsSync(join(home, ".vibe-hook-scope", `${unrelated}.json`)), true);
    }
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy Claude releases use startup records while modern releases require hook evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-legacy-version-record-"));
  const target = archivePluginRelease(REPO, "802afdc075b4ca8442a5644975ef3571f98c38d2",
    join(root, "target"), "1.1.23");
  const files = new Map([
    ["/.claude-plugin/marketplace.json", join(target.archiveRoot, ".claude-plugin/marketplace.json")],
    ["/plugins/vibe/.claude-plugin/plugin.json", join(target.vibeDir, ".claude-plugin/plugin.json")],
    ["/plugins/closedloop-core/.claude-plugin/plugin.json",
      join(target.coreDir, ".claude-plugin/plugin.json")],
  ]);
  const server = createServer((request, response) => {
    const file = files.get(request.url ?? "");
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200); response.end(readFileSync(file));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const legacy = [
      ["1.1.20", "b8df21893c6322a0176b16df9fe123cc6f9296c2"],
      ["1.1.22", "5e7eafa03690055da034874fbe2b56129555b453"],
    ] as const;
    for (const [index, [version, ref]] of legacy.entries()) {
      const release = archivePluginRelease(REPO, ref, join(root, `release-${version}`), version);
      const caseRoot = join(root, `case-${version}`); mkdirSync(caseRoot);
      const home = join(root, `home-${version}`);
      const conversation = `11111111-2222-4333-8444-55555555555${index}`;
      const result = await prepareClaudeVersionRecord({ release, latestBase: url, root: caseRoot,
        rootSessionId: conversation, home });
      assert.match(result, new RegExp(`version ${version.replaceAll(".", "\\.")} .*load=legacy-startup`));
      assert.equal(existsSync(join(home, ".vibe-hook-scope", `${conversation}.json`)), false);
      const record = JSON.parse(readFileSync(join(caseRoot, "plugin-version-state.json"), "utf8"));
      const module = await import(pathToFileURL(join(release.claudeVibeRoot,
        "skills/vibe/scripts/plugin-version.mjs")).href) as { blockingProblem(value: unknown): string | null };
      assert.equal(module.blockingProblem(record), null, `legacy ${version} startup record is complete`);
      cleanupClaudeVersionRecords(caseRoot, conversation, home);
    }
    const modernRoot = join(root, "case-1.1.23"); mkdirSync(modernRoot);
    const modernHome = join(root, "home-1.1.23");
    const modernConversation = "11111111-2222-4333-8444-555555555559";
    const modern = await prepareClaudeVersionRecord({ release: target, latestBase: url,
      root: modernRoot, rootSessionId: modernConversation, home: modernHome });
    assert.match(modern, /load=hook/);
    assert.equal(existsSync(join(modernHome, ".vibe-hook-scope", `${modernConversation}.json`)), true);
    assert.throws(() => validateClaudeLoadContract({}, { conversation: modernConversation,
      version: "1.1.23", pluginRoot: target.claudeVibeRoot, helperExists: true,
      hookExists: false }), /load-contract-invalid/);
    assert.throws(() => validateClaudeLoadContract({ loadedSkillRequired: true,
      loadedSkill: { actorId: "wrong", runtime: "claude", version: "1.1.23",
        pluginRoot: target.claudeVibeRoot } }, { conversation: modernConversation,
      version: "1.1.23", pluginRoot: target.claudeVibeRoot, helperExists: true,
      hookExists: true }), /load-contract-invalid/);
    cleanupClaudeVersionRecords(modernRoot, modernConversation, modernHome);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC6 fixed manifests include both runtime cases and current-subject priors", () => {
  const cases = evalCaseCatalog(join(REPO, "plugins/vibe"))
    .filter((item) => item.kind === "upgrade-resume");
  assert.deepEqual(cases.map((item) => item.definition), ["changed", "unchanged"]);
  assert.ok(cases.every((item) => item.deterministic === true && item.nightlyPrior &&
    /^[a-f0-9]{64}$/.test(item.nightlyPrior.writerDigestSha256) &&
    item.transitions && item.transitions.length >= 2));
  assert.ok(cases.find((item) => item.definition === "changed")?.transitions
    ?.some((item) => item.target.version === "1.1.24"));
});

test("focused proof case selector accepts only exact ids supported by the target ref", () => {
  const vibeDir = join(REPO, "plugins/vibe");
  const target125 = "f45882fb9118cca457221e48e7cef850557f8246";
  const target124 = "f8517d50715dd8569ceee44f5a9452cbf8fc18f5";
  assert.deepEqual(upgradeResumeCaseIds(vibeDir, target125),
    ["upgrade-resume-changed-definition", "upgrade-resume-unchanged-definition"]);
  assert.deepEqual(upgradeResumeCaseIds(vibeDir, target125,
    "upgrade-resume-unchanged-definition"), ["upgrade-resume-unchanged-definition"]);
  assert.deepEqual(upgradeResumeCaseIds(vibeDir, target124),
    ["upgrade-resume-changed-definition"]);
  assert.throws(() => upgradeResumeCaseIds(vibeDir, target124,
    "upgrade-resume-unchanged-definition"), /case-invalid/);
  assert.throws(() => upgradeResumeCaseIds(vibeDir, target125, "upgrade-resume-*"), /case-invalid/);
});

test("ISS-13563 AC3 focused current target selects both upgrade cases", () => {
  const vibeDir = join(REPO, "plugins/vibe");
  const currentRef = "773eea077abb4481d5f3e9654966b48294ac466f";
  const select = upgradeResumeCaseIds as unknown as (vibeDir: string, targetRef: string,
    requestedCase?: string, currentRef?: string) => string[];
  assert.deepEqual(select(vibeDir, currentRef, undefined, currentRef),
    ["upgrade-resume-changed-definition", "upgrade-resume-unchanged-definition"]);
});

test("ISS-13563 AC3 fixed historical expectations and current pass gate are explicit", () => {
  const cases = evalCaseCatalog(join(REPO, "plugins/vibe"))
    .filter((item) => item.kind === "upgrade-resume");
  const changed = cases.find((item) => item.definition === "changed")!;
  const unchanged = cases.find((item) => item.definition === "unchanged")!;
  assert.equal(changed.transitions?.find((item) => item.target.version === "1.1.23")
    ?.expected?.claude, "fail");
  assert.equal(changed.transitions?.find((item) => item.target.version === "1.1.24")
    ?.expected?.claude, "fail");
  assert.equal(unchanged.transitions?.find((item) => item.target.version === "1.1.23")
    ?.expected?.claude, "fail");
  assert.equal(changed.transitions?.find((item) => item.target.version === "1.1.25")
    ?.expected?.codex, "pass");
  const plan = (upgradeEval as unknown as { upgradeTransitionPlan?: (item: typeof changed,
    runtime: "claude" | "codex", subject: { version: string; ref: string },
    targetRef?: string) => Array<{ role: string; expected: string;
      transition: { target: { version: string } } }> }).upgradeTransitionPlan;
  assert.equal(typeof plan, "function");
  const current = { version: "1.1.26", ref: "773eea077abb4481d5f3e9654966b48294ac466f" };
  assert.deepEqual(plan!(changed, "claude", current).map((item) =>
    [item.role, item.transition.target.version, item.expected]), [
    ["historical", "1.1.23", "fail"], ["historical", "1.1.24", "fail"],
    ["historical", "1.1.25", "pass"], ["current", "1.1.26", "pass"],
  ]);
});
