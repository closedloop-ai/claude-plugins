import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BENCHMARK_EFFORT, BENCHMARK_MODEL, BENCHMARK_TASK } from "./contract.ts";
import { collectClaude } from "./claude-collector.ts";
import { main as benchmarkCli } from "./cli.ts";
import { compareResults, mad, median } from "./comparison.ts";
import { changedPathsInCheckout, collectLocalProbe, discoverRunTranscripts, readOtelFile } from "./driver.ts";
import { buildReport } from "./report.ts";
import { resultHash, verifyResultHash } from "./result-schema.ts";
import type { ClaudeBenchmarkResult, ClaudeRunIdentity } from "./result-schema.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const realStream = readFileSync(join(fixtureDir, "phase0-claude-anonymized.jsonl"), "utf8");
const realTranscript = readFileSync(join(fixtureDir, "phase0-transcript-anonymized.jsonl"), "utf8");
const syntheticOtel = readOtelFile(join(fixtureDir, "phase0-otel-overlay.synthetic.jsonl"));

function identity(overrides: Partial<ClaudeRunIdentity> = {}): ClaudeRunIdentity {
  return {
    id: "run-1", shape: "vibe", pluginSha: "a".repeat(40), taskId: BENCHMARK_TASK.id,
    taskVersion: "task-v1", fixtureVersion: "fixture-v1", cliVersion: "2.1.311",
    configuredModel: BENCHMARK_MODEL, configuredEffort: BENCHMARK_EFFORT,
    startedAt: "2026-10-29T17:00:00.000Z", stackSetupMs: 63_649,
    stackTeardownMs: 2_979, wallMs: 83_790, oraclePassed: true,
    noOutOfScopeEdits: true, taskComplete: true, prDraftRecordedAndClosed: true,
    ...overrides,
  };
}

function collect(stream = realStream, otel: typeof syntheticOtel | null = null, overrides: Partial<ClaudeRunIdentity> = {}) {
  return collectClaude({ stream, otel, identity: identity(overrides),
    transcripts: stream === realStream && !otel ? [{ jsonl: realTranscript }] : undefined,
    agentModels: { "vibe-change-worker": "sonnet", "vibe-adversarial-reviewer": "opus" }, env: {} });
}

test("anonymized real Phase 0 result is authoritative; repeated message blocks count once", () => {
  const result = collect();
  assert.equal(result.valid, true);
  assert.equal(result.success, true);
  assert.equal(result.modelCalls, 5);
  assert.equal(result.totals.inputTokens, 10);
  assert.equal(result.totals.uncachedInputTokens, 10);
  assert.equal(result.totals.cachedInputTokens, 179_648);
  assert.equal(result.totals.cacheWriteTokens, 7_855);
  assert.equal(result.totals.outputTokens, 892); // assistant placeholders sum to 254
  assert.equal(result.costUsd, 0.0583248);
  assert.ok(result.calls.every((call) => call.tokens?.outputTokens === null));
  assert.ok(result.calls.every((call) => call.component === "vibe"));
  assert.equal(result.agentModels["vibe-adversarial-reviewer"], "opus");
  verifyResultHash(result);
  const changed = structuredClone(result);
  changed.totals.outputTokens++;
  assert.throws(() => verifyResultHash(changed), /benchmark-result-hash-mismatch/);
});

test("final modelUsage remains authoritative when result.usage is only the last turn", () => {
  const lines = realStream.trim().split("\n");
  const final = JSON.parse(lines.at(-1)!) as { usage: Record<string, number> };
  final.usage.input_tokens = 1;
  final.usage.cache_read_input_tokens = 100;
  final.usage.cache_creation_input_tokens = 200;
  final.usage.output_tokens = 50;
  lines[lines.length - 1] = JSON.stringify(final);
  const result = collectClaude({ stream: `${lines.join("\n")}\n`,
    transcripts: [{ jsonl: realTranscript }], identity: identity(),
    agentModels: { "vibe-change-worker": "sonnet" }, env: {} });
  assert.equal(result.valid, true);
  assert.equal(result.totals.outputTokens, 892);
  assert.equal(result.totals.cachedInputTokens, 179_648);
});

test("task-notification result supersedes an interim result without double counting", () => {
  const lines = realStream.trim().split("\n");
  const interim = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  interim.result_index = 0;
  const completed = structuredClone(interim);
  completed.result_index = 1;
  completed.origin = { kind: "task-notification", producer: "session-task", runId: "fixture" };
  completed.result = "The delegated writer finished the edit.";
  lines[lines.length - 1] = JSON.stringify(interim);
  lines.push(JSON.stringify(completed));
  const input = { stream: `${lines.join("\n")}\n`, transcripts: [{ jsonl: realTranscript }],
    identity: identity(), agentModels: { "vibe-change-worker": "sonnet" }, env: {} };
  const result = collectClaude(input);
  assert.equal(result.valid, true);
  assert.equal(result.modelCalls, 5);
  assert.equal(result.totals.outputTokens, 892);
  const skipped = structuredClone(completed);
  skipped.result_index = 2;
  assert.throws(() => collectClaude({ ...input,
    stream: `${lines.slice(0, -1).join("\n")}\n${JSON.stringify(skipped)}\n` }),
  /benchmark-collector-final-sequence-invalid/);
});

test("OTEL request detail reconciles to final totals and supplies actual effort/output", () => {
  const result = collect(realStream, syntheticOtel);
  assert.equal(result.observedEffort, "high");
  assert.equal(result.totals.outputTokens, 892);
  assert.equal(result.calls.reduce((sum, call) => sum + (call.tokens?.outputTokens ?? 0), 0), 892);
  assert.ok(result.calls.every((call) => call.source === "both" && call.skill === "vibe:vibe"));
  assert.match(buildReport(result), /### Skill calls/);
  assert.match(buildReport(result), /### Worker calls/);
  assert.match(buildReport(result), /### Phase calls/);
});

test("OTEL-only compaction is counted with an explicit attribution reason", () => {
  const lines = realStream.trim().split("\n");
  const final = JSON.parse(lines.at(-1)!) as {
    modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
    usage: { input_tokens: number; output_tokens: number };
    total_cost_usd: number;
  };
  final.modelUsage[BENCHMARK_MODEL].inputTokens++;
  final.modelUsage[BENCHMARK_MODEL].outputTokens++;
  final.modelUsage[BENCHMARK_MODEL].costUSD += 0.001;
  final.usage.input_tokens++;
  final.usage.output_tokens++;
  final.total_cost_usd += 0.001;
  lines[lines.length - 1] = JSON.stringify(final);
  const otel = [...syntheticOtel, { eventName: "claude_code.api_request", attributes: {
    request_id: "req-compact", model: BENCHMARK_MODEL, effort: "high", input_tokens: 1,
    cache_read_tokens: 0, cache_creation_tokens: 0, output_tokens: 1, duration_ms: 10,
    query_source: "compact",
  } }];
  const result = collect(lines.join("\n"), otel);
  assert.equal(result.modelCalls, 6);
  assert.equal(result.totals.outputTokens, 893);
  assert.equal(result.calls.at(-1)?.source, "otel");
  assert.equal(result.calls.at(-1)?.component, "unattributed");
  assert.match(result.calls.at(-1)?.unattributedReason ?? "", /unknown-query-source:compact/);
});

test("real transcript supplies effort and identity but never contributes output", () => {
  const result = collectClaude({ stream: realStream, transcripts: [{ jsonl: realTranscript }],
    identity: identity(), agentModels: { "vibe-adversarial-reviewer": "opus" }, env: {} });
  assert.equal(result.observedEffort, "high");
  assert.equal(result.modelCalls, 5);
  assert.equal(result.totals.outputTokens, 892);
  assert.ok(result.calls.every((call) => call.tokens?.outputTokens === null));
  const missing = realTranscript.replaceAll(',"effort":"high"', "");
  const invalid = collectClaude({ stream: realStream, transcripts: [{ jsonl: missing }],
    identity: identity(), agentModels: {}, env: {} });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.invalidReasons.includes("benchmark-effort-missing"));
});

test("truncation, dropped records and conflicting totals fail closed", () => {
  assert.throws(() => collect(realStream.slice(0, -25)), /truncated-line/);
  assert.throws(() => collect(realStream.split("\n").filter((line) => !line.includes('"request_id":"req-c"')).join("\n")), /transcript-total-mismatch/);
  assert.throws(() => collect(realStream.replace('"modelUsage":{', '"missingModelUsage":{')), /final-usage-missing/);
  const lines = realStream.trim().split("\n");
  const excessive = JSON.parse(lines.at(-1)!) as { usage: Record<string, number> };
  excessive.usage.output_tokens = 893;
  lines[lines.length - 1] = JSON.stringify(excessive);
  assert.throws(() => collect(lines.join("\n")), /final-total-mismatch/);
  assert.throws(() => collect(realStream, syntheticOtel.slice(0, 4)), /otel-dropped-request/);
  const mismatched = structuredClone(syntheticOtel);
  (mismatched[4].attributes as Record<string, unknown>).output_tokens = 768;
  assert.throws(() => collect(realStream, mismatched), /otel-total-mismatch/);
  const conflicting = `${realStream.trim().split("\n").slice(0, -1).join("\n")}\n${realStream.trim().split("\n")[1].replace('"msg-a"', '"msg-conflict"')}\n${realStream.trim().split("\n").at(-1)}\n`;
  assert.throws(() => collect(conflicting), /duplicate-message-conflict/);
});

test("model, effort and environment drift invalidate without changing totals", () => {
  assert.deepEqual(collectClaude({ stream: realStream, identity: identity(), agentModels: {}, env: {} }).invalidReasons,
    ["benchmark-effort-missing"]);
  assert.equal(collect(realStream, null, { configuredModel: "sonnet" }).valid, false);
  assert.equal(collect(realStream, null, { configuredEffort: "" }).valid, false);
  assert.equal(collect(realStream, null, { wallMs: -1 }).valid, false);
  assert.equal(collect(realStream.replaceAll(BENCHMARK_MODEL, "claude-opus-4-6")).valid, false);
  const unknownEffort = structuredClone(syntheticOtel);
  (unknownEffort[0].attributes as Record<string, unknown>).effort = "unknown";
  assert.throws(() => collect(realStream, unknownEffort), /otel-effort-conflict/);
  const allUnknown = structuredClone(syntheticOtel);
  for (const item of allUnknown) (item.attributes as Record<string, unknown>).effort = "unknown";
  assert.equal(collect(realStream, allUnknown).valid, false);
  const missingEffort = structuredClone(syntheticOtel);
  delete (missingEffort[0].attributes as Record<string, unknown>).effort;
  assert.throws(() => collect(realStream, missingEffort), /otel-required-field-missing/);
  const override = collectClaude({ stream: realStream, identity: identity(), agentModels: {},
    env: { CLAUDE_CODE_EFFORT_LEVEL: "xhigh" } });
  assert.equal(override.valid, false);
  assert.match(override.invalidReasons.join(" "), /benchmark-effort-env-override/);
  for (const key of ["CLAUDE_CODE_SUBAGENT_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"] as const) {
    const drifted = collectClaude({ stream: realStream, transcripts: [{ jsonl: realTranscript }],
      identity: identity(), agentModels: {}, env: { [key]: "claude-opus-4-6" } });
    assert.equal(drifted.valid, false);
    assert.match(drifted.invalidReasons.join(" "), /benchmark-model-env-override/);
  }
});

test("subagent model and phase are preserved; unknown worker gets a reason", () => {
  const stream = [
    { type: "system", subtype: "init" },
    { type: "assistant", request_id: "root", parent_tool_use_id: null, effort: "high", message: {
      id: "root-msg", model: BENCHMARK_MODEL,
      usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
      content: [
        { type: "tool_use", name: "Skill", id: "skill-tool", input: { skill: "vibe:vibe" } },
        { type: "tool_use", name: "Agent", id: "agent-tool", input: { subagent_type: "vibe-adversarial-reviewer" } },
      ],
    } },
    { type: "assistant", request_id: "child", parent_tool_use_id: "agent-tool", effort: "high", message: {
      id: "child-msg", model: "claude-opus-4-6",
      usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
      content: [],
    } },
    { type: "result", is_error: false, total_cost_usd: 0.03,
      usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 300 },
      modelUsage: {
        [BENCHMARK_MODEL]: { inputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 100, thinkingTokens: 0, costUSD: 0.01 },
        "claude-opus-4-6": { inputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 200, thinkingTokens: 0, costUSD: 0.02 },
      } },
  ].map((item) => JSON.stringify(item)).join("\n");
  const result = collect(stream);
  assert.equal(result.valid, true);
  assert.equal(result.calls[1].component, "vibe");
  assert.equal(result.calls[1].worker, "vibe-adversarial-reviewer");
  assert.equal(result.calls[1].declaredAgentModel, "opus");
  assert.equal(result.calls[1].phase, "review");
  assert.equal(result.calls[0].skill, null);
  assert.equal(result.calls[1].skill, "vibe:vibe");
  const generalPurpose = collect(stream.replace('"subagent_type":"vibe-adversarial-reviewer"',
    '"subagent_type":"general-purpose","description":"vibe-adversarial-reviewer checks the diff"'));
  assert.equal(generalPurpose.calls[1].worker, "vibe-adversarial-reviewer");
  const fleet = collect(stream, null, { shape: "fleet-one-writer" });
  assert.deepEqual(fleet.calls.map((call) => call.component), ["fleet-orchestrator", "vibe"]);
  assert.deepEqual(fleet.calls.map((call) => call.skill), [null, "vibe:vibe"]);
  const fleetSkill = collect(stream.replace('"skill":"vibe:vibe"',
    '"skill":"vibe:fleet-orchestrator"'), null, { shape: "fleet-one-writer" });
  assert.deepEqual(fleetSkill.calls.map((call) => call.component), ["fleet-orchestrator", "vibe"]);
  assert.deepEqual(fleetSkill.calls.map((call) => call.skill), [null, "vibe:fleet-orchestrator"]);
  const unknown = collect(stream.replace("vibe-adversarial-reviewer", "custom-worker"));
  assert.equal(unknown.calls[1].component, "unattributed");
  assert.match(unknown.calls[1].unattributedReason ?? "", /unknown-agent/);
  const undeclaredOverride = collectClaude({ stream, identity: identity(),
    agentModels: { "vibe-adversarial-reviewer": "sonnet" }, env: {} });
  assert.equal(undeclaredOverride.valid, false);
  assert.ok(undeclaredOverride.invalidReasons.includes("benchmark-agent-model-mismatch:vibe-adversarial-reviewer"));
});

let sampleRunSequence = 0;
function sampleRun(pluginSha: string, wallMs: number, input: number, output: number, calls: number, success = true): ClaudeBenchmarkResult {
  const source = collect();
  const { resultHash: _hash, ...payload } = source;
  payload.identity = { ...source.identity, id: `sample-${++sampleRunSequence}`, pluginSha, wallMs };
  payload.totals = { ...source.totals, uncachedInputTokens: input, inputTokens: input, outputTokens: output };
  payload.modelCalls = calls;
  payload.success = success;
  return { ...payload, resultHash: resultHash(payload) };
}

function compare(walls: number[], inputs = [100, 100, 100], outputs = [100, 100, 100], calls = [10, 10, 10], successes = [true, true, true], words = 1000) {
  const baseline = [90, 100, 100, 100, 110].map((wall) => sampleRun("a".repeat(40), wall, 100, 100, 10));
  const pr = walls.map((wall, index) => sampleRun("b".repeat(40), wall, inputs[index], outputs[index], calls[index], successes[index]));
  return compareResults(baseline, pr, { baseline: 1000, pr: words });
}

test("five-versus-three median and MAD wall thresholds and cap are exact", () => {
  assert.equal(median([1, 9, 3]), 3);
  assert.equal(mad([90, 100, 100, 100, 110]), 0);
  assert.equal(compare([120, 120, 120]).signals[0].status, "green");
  assert.equal(compare([121, 121, 121]).signals[0].status, "yellow");
  assert.equal(compare([201, 201, 201]).signals[0].status, "red");
  assert.equal(compare([100, 100, 600_001]).signals[0].status, "red");
  assert.equal(compare([100, 100, 600_001]).signals[0].thresholdRed, 200);
  const noisyBase = [60, 80, 100, 120, 140].map((wall) => sampleRun("a".repeat(40), wall, 100, 100, 10));
  const noisyPr = [161, 161, 161].map((wall) => sampleRun("b".repeat(40), wall, 100, 100, 10));
  const noisy = compareResults(noisyBase, noisyPr, { baseline: 1000, pr: 1000 });
  assert.equal(noisy.signals[0].baselineMad, 20);
  assert.equal(noisy.signals[0].thresholdYellow, 160);
  assert.equal(noisy.signals[0].status, "yellow");
  assert.throws(() => compareResults([], [], { baseline: 1000, pr: 1000 }), /run-count/);
  assert.throws(() => compareResults([noisyBase[0], noisyBase[0], ...noisyBase.slice(2)], noisyPr,
    { baseline: 1000, pr: 1000 }), /duplicate-run/);
  const { resultHash: _hash, ...missingEffort } = noisyPr[0];
  missingEffort.observedEffort = null;
  assert.throws(() => compareResults(noisyBase, [{ ...missingEffort, resultHash: resultHash(missingEffort) },
    ...noisyPr.slice(1)], { baseline: 1000, pr: 1000 }), /invalid-run/);
});

test("token, call, success and static instruction thresholds follow section 5", () => {
  const yellow = compare([100, 100, 100], [121, 121, 121], [121, 121, 121], [13, 13, 13], [true, true, false], 1021);
  assert.deepEqual(yellow.signals.map((signal) => signal.status), ["green", "yellow", "yellow", "yellow", "yellow", "yellow"]);
  assert.equal(yellow.redRequiresApproverAcceptance, false);
  const red = compare([100, 100, 100], [151, 151, 151], [151, 151, 151], [16, 16, 16], [true, false, false], 1020);
  assert.deepEqual(red.signals.map((signal) => signal.status), ["green", "red", "red", "red", "red", "green"]);
  assert.equal(red.redRequiresApproverAcceptance, true);
  assert.throws(() => buildReport(collect(), yellow), /benchmark-explanation-missing/);
  const explanations = Object.fromEntries(yellow.signals.filter((signal) => signal.status !== "green")
    .map((signal) => [signal.signal, { component: "vibe", phase: "build", why: "A measured extra model call." }]));
  const report = buildReport(collect(), yellow, explanations);
  assert.match(report, /component \*\*vibe\*\*, phase \*\*build\*\*/);
  const redExplanations = Object.fromEntries(red.signals.filter((signal) => signal.status !== "green")
    .map((signal) => [signal.signal, { component: "vibe", phase: "build", why: "Measured regression." }]));
  assert.match(buildReport(collect(), red, redExplanations), /benchmark approver's explicit acceptance/);
  const baseline = [90, 100, 100, 100, 110].map((wall) => sampleRun("a".repeat(40), wall, 100, 100, 10));
  const cached = [100, 100, 100].map((wall) => {
    const source = sampleRun("b".repeat(40), wall, 100, 100, 10);
    const { resultHash: _hash, ...payload } = source;
    payload.totals = { ...source.totals, cachedInputTokens: 9_999_999 };
    return { ...payload, resultHash: resultHash(payload) };
  });
  const informational = compareResults(baseline, cached, { baseline: 1000, pr: 1000 });
  assert.equal(informational.status, "green");
  assert.equal(informational.informational.cachedInputTokens.prMedian, 9_999_999);
  assert.match(buildReport(cached[0], informational), /Informational measures \(no independent gate\)/);
});

test("baseline MAD protects non-wall signals from ordinary unchanged variation", () => {
  const baseline = [60, 80, 100, 120, 140].map((input, index) =>
    sampleRun("a".repeat(40), 100 + index, input, input, 10));
  const candidate = [121, 121, 121].map((input) =>
    sampleRun("b".repeat(40), 100, input, input, 10));
  const comparison = compareResults(baseline, candidate, { baseline: 1000, pr: 1000 });
  const input = comparison.signals.find((signal) => signal.signal === "uncachedInputTokens")!;
  assert.equal(input.baselineMad, 20);
  assert.equal(input.thresholdYellow, 160);
  assert.equal(input.thresholdRed, 220);
  assert.equal(input.status, "green");
});

test("local collector CLI surface writes only local, hash-stamped artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-phase1-"));
  try {
    const repo = join(root, "repo");
    const plugin = join(repo, "plugins/vibe");
    mkdirSync(plugin, { recursive: true });
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
    writeFileSync(join(plugin, "agent.md"), "model: sonnet\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid.local", "commit", "-m", "fixture"], { stdio: "ignore" });
    const claude = join(root, "claude");
    writeFileSync(claude, "#!/bin/sh\nprintf '2.1.311\\n'\n", { mode: 0o755 });
    const phase0File = join(root, "phase0-live-result.json");
    writeFileSync(phase0File, JSON.stringify({
      startedAt: "2026-10-29T17:00:00.000Z", sourceSha: "c".repeat(40),
      setupMs: 60_000, teardownMs: 3_000, wall: { wallMs: 83_000 }, error: null,
      probe: { stdout: realStream, oracleAfter: { pass: true }, agentModels: { "vibe-change-worker": "sonnet" } },
    }));
    const transcriptFile = join(root, "transcript.jsonl");
    const manifestFile = join(root, "transcripts.json");
    writeFileSync(transcriptFile, realTranscript);
    writeFileSync(manifestFile, JSON.stringify([{ path: transcriptFile }]));
    const output = collectLocalProbe(phase0File, plugin, claude, undefined, manifestFile);
    assert.equal(output.result.valid, true);
    assert.equal(output.result.success, false); // Phase 0 did not create or close a PR.
    assert.match(readFileSync(output.markdownFile, "utf8"), /## Benchmark/);
    verifyResultHash(JSON.parse(readFileSync(output.jsonFile, "utf8")) as ClaudeBenchmarkResult);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("porcelain status keeps its leading columns for task-scope checks", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-status-"));
  try {
    execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
    const target = join(root, BENCHMARK_TASK.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "before\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid.local", "commit", "-m", "fixture"], { stdio: "ignore" });
    writeFileSync(target, "after\n");
    assert.deepEqual(changedPathsInCheckout(root), [BENCHMARK_TASK.file]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compare CLI writes one local five-versus-three verdict and report", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-compare-"));
  try {
    const baselineFile = join(root, "baseline.json");
    const prFile = join(root, "pr.json");
    writeFileSync(baselineFile, JSON.stringify([90, 100, 100, 100, 110]
      .map((wall) => sampleRun("a".repeat(40), wall, 100, 100, 10))));
    writeFileSync(prFile, JSON.stringify([95, 100, 105]
      .map((wall) => sampleRun("b".repeat(40), wall, 100, 100, 10))));
    const paths = await benchmarkCli(["compare", baselineFile, prFile, "1000", "1000", root]);
    assert.match(paths, /phase1-comparison\.json/);
    assert.equal(JSON.parse(readFileSync(join(root, "phase1-comparison.json"), "utf8")).status, "green");
    assert.match(readFileSync(join(root, "phase1-comparison.md"), "utf8"), /## Benchmark/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("run-owned transcript discovery reads only its session and agent metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-transcripts-"));
  const session = "301afefc-5370-4e42-bf58-3cef40092f6b";
  try {
    const checkout = join(root, "checkout");
    const projects = join(root, "projects");
    const project = join(projects, "-checkout");
    const subagents = join(project, session, "subagents");
    mkdirSync(checkout);
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(project, `${session}.jsonl`), `${JSON.stringify({ type: "queue-operation", cwd: checkout })}\n${realTranscript}`);
    writeFileSync(join(subagents, "agent-test.jsonl"), realTranscript);
    writeFileSync(join(subagents, "agent-test.meta.json"), JSON.stringify({
      agentType: "general-purpose", description: "vibe-adversarial-reviewer checks changes", toolUseId: "tool-1",
    }));
    const bundles = discoverRunTranscripts(session, checkout, projects);
    assert.equal(bundles.length, 2);
    assert.equal(bundles[1].agentName, "vibe-adversarial-reviewer");
    assert.equal(bundles[1].parentToolUseId, "tool-1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
