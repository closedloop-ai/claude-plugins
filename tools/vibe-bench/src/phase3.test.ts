import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { codexCaseId, collectClaudeEval, collectCodexEval, finalizeLocalEval } from "./eval-collector.ts";
import type { EvalCaseResult, EvalSuiteResult, LocalEvalResult } from "./eval-collector.ts";
import { buildEvalBaseline, isGreenEvalBaseline, publishEvalBaseline,
  evalQuarantineStatus, reconcileEvalBaselineQuarantine, resolveEvalBaselineHistory,
  resolveLastGreenEvalBaseline, resolveLatestEvalBaseline, verifyEvalBaseline } from "./eval-baseline.ts";
import { loadEvalQuarantine } from "./eval-baseline.ts";
import type { EvalBaselineArtifact } from "./eval-baseline.ts";
import { EVAL_POLICY, requireDeveloperMachine } from "./eval-policy.ts";
import type { EvalRuntime } from "./eval-policy.ts";
import { evalCaseCatalog, skillFromPrompt } from "./eval-selection.ts";
import type { EvalCommands } from "./eval-driver.ts";
import { codexEvalBudgetSeconds, codexEvalRunnerPath, confirmedNightlyRegressions,
  deliverPendingRegressionReports, evalModelProcessEnv, recoverPendingNightlyPublications,
  runLocalEvals, runT2Evals,
  stageFocusedClaudeEvalCases } from "./eval-driver.ts";
import { main as runEvalNightly, reportNightlyInfrastructureFailure } from "./eval-nightly.ts";
import { formatNightlyInfrastructureMessage, formatNightlyRegressionMessage, nightlyChangesSince,
  isRetrySafeSlackFailure, SLACK_DELIVERY_TEST_MESSAGE, SlackDeliveryError,
  SlackNightlyRegressionReporter } from "./eval-slack.ts";
import type { NightlyRegressionNotice } from "./eval-slack.ts";
import { formatNightlyTaskSummary, nightlyTaskSummary } from "./nightly-summary.ts";
import { requireLatestNightlyBenchmarkBaseline } from "./phase2-driver.ts";
import { runApprovedSlackTest } from "./slack-relay-test.ts";
import { slackToolGateDecision } from "./slack-tool-gate.ts";

const CASE = "pm-new-session-first-reply";
const REPO_ROOT = realpathSync(join(import.meta.dirname, "../../.."));

test("vibe-bench skill copies share the Slack MCP relay contract", () => {
  const contract = "Nightly Slack delivery uses the authenticated Slack MCP relay through " +
    "headless Claude Code; no Slack bot-token file or scheduler environment file is required.";
  for (const path of [".claude/skills/vibe-bench/SKILL.md",
    ".agents/skills/vibe-bench/SKILL.md"]) {
    const skill = readFileSync(join(REPO_ROOT, path), "utf8");
    assert.match(skill, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(skill, /SLACK_BOT_TOKEN|SLACK_CHANNEL_ID/);
  }
});

test("model evals are local-only and use two failure retries", () => {
  assert.equal(EVAL_POLICY.claudeModel, "claude-sonnet-5-5");
  assert.equal(EVAL_POLICY.claudeJudgeModel, "claude-opus-5-5");
  assert.equal(EVAL_POLICY.failureReruns, 2);
  assert.throws(() => requireDeveloperMachine({ GITHUB_ACTIONS: "true" }), /forbidden-in-ci/);
  assert.doesNotThrow(() => requireDeveloperMachine({ CI: "false" }));
});

test("model processes inherit only the explicit environment allow-list", () => {
  const inherited = evalModelProcessEnv({ PATH: "/bin", GH_TOKEN: "github-secret",
    RANDOM_SECRET: "secret" });
  assert.deepEqual(inherited, { PATH: "/bin" });
  assert.throws(() => evalModelProcessEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "secret" }),
    /eval-model-api-credential-forbidden:ANTHROPIC_API_KEY/);
});

function comparisonEval(sha: string, states: Record<string, boolean>,
  runtimes: EvalRuntime[] = ["claude", "codex"],
  runtimeStates: Partial<Record<EvalRuntime, Record<string, boolean>>> = {}): LocalEvalResult {
  const ids = Object.keys(states).sort();
  const runtime = (name: "claude" | "codex"): EvalSuiteResult => {
    const outcomes = runtimeStates[name] ?? states;
    const cases: EvalCaseResult[] = ids.map((id) => ({ id, passed: outcomes[id],
      failedGraders: outcomes[id] ? [] : [`${name}-route`], skippedGraders: [] }));
    const passed = cases.filter((item) => item.passed).length;
    return { runtime: name, cliVersion: name === "claude" ? "2.1.311" : "codex-cli 0.163.0",
      cases, passed, failed: cases.length - passed, wallMs: 10,
      agentCostUsd: name === "claude" ? 0.08 : null,
      judgeCostUsd: name === "claude" ? 0.02 : null,
      costUsd: name === "claude" ? 0.1 : null,
      tokens: name === "codex" ? { input_tokens: 1 } : null, nativeHash: name[0].repeat(64) };
  };
  return finalizeLocalEval({ pluginSha: sha, createdAt: "2026-10-29T00:00:00Z", wallMs: 20,
    deterministicOnly: false, selectedCases: ids, runtimes: runtimes.map((name) => {
      const result = runtime(name);
      return { runtime: name, exitCode: result.failed ? 1 : 0, result, invalidReason: null };
    }) });
}

function withJudgeModel(artifact: EvalBaselineArtifact, judge: string): EvalBaselineArtifact {
  const { resultHash: _priorHash, ...prior } = artifact;
  const payload = { ...prior, models: { ...prior.models, claudeJudge: judge } };
  return { ...payload, resultHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

test("case skills come from actual invocations", () => {
  const vibeDir = join(import.meta.dirname, "../../../plugins/vibe");
  const catalog = evalCaseCatalog(vibeDir);
  assert.equal(catalog.length, 109);
  assert.deepEqual(Object.fromEntries(["vibe", "handoff", "fleet-orchestrator"].map((skill) =>
    [skill, catalog.filter((item) => item.skill === skill).length])),
  { vibe: 74, handoff: 24, "fleet-orchestrator": 11 });
  assert.throws(() => skillFromPrompt("no invocation"), /skill-invocation-invalid/);
});

test("nightly scheduler fast-forwards main and dispatches one unique T2 run", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-nightly-"));
  try {
    const calls: string[][] = [];
    const sha = "a".repeat(40);
    const output = await runEvalNightly(["/repo", root, "/results", "/claude", "/codex", "/uv", "/gh"], {
      git: (_repo, args) => {
        calls.push(["git", ...args]);
        if (args[0] === "status") return "";
        if (args[0] === "branch") return "main";
        if (args[0] === "rev-parse") return sha;
        return "";
      },
      node: (args) => { calls.push(["node", ...args]); return "/results/baseline.json"; },
      now: () => new Date("2026-10-30T02:00:00Z"),
    });
    assert.equal(output, "/results/baseline.json");
    assert.ok(calls.some((call) => call.join(" ") === "git merge --ff-only origin/main"));
    const node = calls.find((call) => call[0] === "node")!;
    assert.deepEqual(node.slice(-4), ["/claude", "/codex", "/uv", "/gh"]);
    assert.match(node.join(" "), /t2-2026-10-30T020000Z-aaaaaaaaaaaa/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scheduled task summary line reports skipped, run and failed outcomes", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-nightly-summary-"));
  const log = join(root, "nightly.log");
  const artifact = join(root, "eval-t2-result.json");
  try {
    writeFileSync(artifact, JSON.stringify({ cases: [
      { outcomes: { claude: { recentNightlyOutcomes: [{ passes: 2, runs: 3 }] },
        codex: { recentNightlyOutcomes: [{ passes: 4, runs: 4 }] } } },
    ] }));
    const ran = nightlyTaskSummary(0, `${artifact}\nVIBE_NIGHTLY_SLACK_POSTED\n`, log);
    assert.deepEqual(ran, { result: "RAN", passed: 6, failed: 1, posted: "yes",
      path: artifact, failure: null });
    const line = formatNightlyTaskSummary(ran);
    assert.match(line, /^VIBE_NIGHTLY_SUMMARY \{"result":"RAN","passed":6,"failed":1,/);
    assert.deepEqual(JSON.parse(line.slice("VIBE_NIGHTLY_SUMMARY ".length)), ran);
    assert.deepEqual(nightlyTaskSummary(0, `SKIPPED ${artifact}\n`, log),
      { result: "SKIPPED", passed: 0, failed: 0, posted: "no", path: artifact,
        failure: null });
    const failure = "VIBE_NIGHTLY_SLACK_FAILURE eval-slack-claude-timeout";
    assert.deepEqual(nightlyTaskSummary(0, `${artifact}\n${failure}\n`, log),
      { result: "FAILED", passed: 0, failed: 0, posted: "no", path: artifact,
        failure });
    assert.deepEqual(nightlyTaskSummary(69, "wrapper failed\n", log),
      { result: "FAILED", passed: 0, failed: 0, posted: "no", path: log,
        failure: "VIBE_NIGHTLY_INFRA_FAILURE nightly process exited with status 69" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scheduled task wrapper keeps T2 behind the local heavy slot", () => {
  const wrapper = readFileSync(join(import.meta.dirname, "../schedule/run-nightly.sh"), "utf8");
  assert.doesNotMatch(wrapper, /private_env|SLACK_BOT_TOKEN|SLACK_CHANNEL_ID/);
  assert.match(wrapper, /exec "\$heavy_slot" vibe-eval-nightly/);
  const script = join(import.meta.dirname, "../schedule/run-nightly.sh");
  const missing = spawnSync(script, ["/heavy", "/node", "/nightly", "/repo", "/run-root",
    "/results", "/claude", "/codex", "/uv", "/gh"],
  { encoding: "utf8" });
  assert.equal(missing.status, 69);
  assert.match(missing.stderr, /clean main checkout is missing/);
  assert.match(missing.stderr, /VIBE_NIGHTLY_SLACK_FAILURE/);
  const fixture = mkdtempSync(join(tmpdir(), "vibe-nightly-wrapper-"));
  try {
    const checkout = join(fixture, "repo");
    mkdirSync(checkout);
    const heavySlot = join(fixture, "heavy-slot.sh");
    const nightly = join(fixture, "eval-nightly.ts");
    const node = join(fixture, "node");
    const claude = join(fixture, "claude");
    const codex = join(fixture, "codex");
    const uv = join(fixture, "uv");
    const gh = join(fixture, "gh");
    const argumentsFile = join(fixture, "arguments.txt");
    const notificationFile = join(fixture, "notification.txt");
    const artifact = join(fixture, "eval-t2-result.json");
    writeFileSync(artifact, JSON.stringify({ cases: [{ outcomes: {
      claude: { recentNightlyOutcomes: [{ passes: 1, runs: 1 }] },
      codex: { recentNightlyOutcomes: [{ passes: 1, runs: 2 }] },
    } }] }));
    writeFileSync(heavySlot, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsFile}'\n` +
      `printf '%s\\n' '${artifact}' 'VIBE_NIGHTLY_SLACK_POSTED'\n`);
    chmodSync(heavySlot, 0o700);
    writeFileSync(nightly, "// fixture\n");
    writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$@" > '${notificationFile}'\n`);
    for (const executable of [claude, codex, uv, gh]) writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    for (const executable of [node, claude, codex, uv, gh]) chmodSync(executable, 0o700);
    const dispatched = spawnSync(script, [heavySlot, node, nightly,
      checkout, "/run-root", "/results", claude, codex, uv, gh],
    { encoding: "utf8" });
    assert.equal(dispatched.status, 0, dispatched.stderr);
    assert.deepEqual(readFileSync(argumentsFile, "utf8").trim().split("\n"), [
      "vibe-eval-nightly", node, "--experimental-strip-types", nightly, checkout,
      "/run-root", "/results", claude, codex, uv, gh,
    ]);
    const wrapperLog = join(fixture, "wrapper.log");
    writeFileSync(wrapperLog, dispatched.stdout);
    const summaryCli = join(import.meta.dirname, "nightly-summary.ts");
    const summary = spawnSync(process.execPath, ["--experimental-strip-types", summaryCli,
      "0", wrapperLog], { encoding: "utf8" });
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout,
      /^VIBE_NIGHTLY_SUMMARY \{"result":"RAN","passed":2,"failed":1,"posted":"yes",/);

    rmSync(codex);
    const missingBinary = spawnSync(script, [heavySlot, node, nightly,
      checkout, "/run-root", "/results", claude, codex, uv, gh], { encoding: "utf8" });
    assert.equal(missingBinary.status, 69);
    assert.match(missingBinary.stderr, /VIBE_NIGHTLY_INFRA_FAILURE.*Codex/);
    const notification = readFileSync(notificationFile, "utf8").trim().split("\n");
    const notifyIndex = notification.indexOf("--notify-infra");
    assert.deepEqual(notification.slice(notifyIndex, notifyIndex + 2), ["--notify-infra", claude]);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
  const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");
  assert.match(readme, /visible ChatGPT scheduled task[\s\S]*Run on this computer/);
  assert.match(readme, /<home>\/\.config\/vibe-eval-nightly\/run-nightly\.sh/);
  assert.match(readme, /VIBE_NIGHTLY_SUMMARY[\s\S]*SKIPPED[\s\S]*RAN[\s\S]*FAILED/);
  assert.doesNotMatch(readme, /launchctl|LaunchAgent|\.plist/);
  assert.doesNotMatch(readme, /SLACK_BOT_TOKEN|SLACK_CHANNEL_ID|vibe-eval\.env/);
});

test("the initial quarantine names all 29 runtime failures with one owner and deadline", () => {
  const entries = loadEvalQuarantine();
  assert.equal(entries.length, 29);
  assert.equal(entries.filter((item) => item.runtime === "claude").length, 18);
  assert.equal(entries.filter((item) => item.runtime === "codex").length, 11);
  assert.deepEqual(new Set(entries.map((item) => item.owner)), new Set(["vibe-maintainers"]));
  assert.deepEqual(new Set(entries.map((item) => item.deadline)), new Set(["2026-11-13"]));
});

test("T2 store rolls reliability forward and resolves only its atomic newest baseline", () => {
  const id = "case-a";
  const catalog = [{ id, skill: "vibe" as const, contentHash: "a".repeat(64) }];
  const first = buildEvalBaseline({ results: [comparisonEval("a".repeat(40), { [id]: true })],
    catalog, pluginVersion: "1.2.3", createdAt: "2026-10-29T00:00:00Z" });
  const second = buildEvalBaseline({ results: [comparisonEval("b".repeat(40), { [id]: true })],
    catalog, pluginVersion: "1.2.3", previous: first, createdAt: "2026-10-30T00:00:00Z" });
  assert.equal(second.cases[0].outcomes.claude?.observations, 2);
  assert.deepEqual(second.cases[0].outcomes.claude?.recentNightlyOutcomes,
    [{ passes: 1, runs: 1 }, { passes: 1, runs: 1 }]);
  assert.equal(second.cases[0].outcomes.claude?.reliable, false);
  const store = mkdtempSync(join(tmpdir(), "vibe-eval-store-"));
  try {
    publishEvalBaseline(store, first);
    const unrelated = buildEvalBaseline({ results: [comparisonEval("c".repeat(40), { [id]: true })],
      catalog, pluginVersion: "1.2.3" });
    assert.throws(() => publishEvalBaseline(store, unrelated), /lineage-mismatch/);
    publishEvalBaseline(store, second);
    const latest = resolveLatestEvalBaseline(store);
    assert.equal(latest.artifact.resultHash, second.resultHash);
    assert.equal(latest.index.history.length, 2);
    assert.deepEqual(resolveEvalBaselineHistory(store).map((item) => item.resultHash),
      [second.resultHash, first.resultHash]);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test("a journaled nightly publication resumes without repeating model work", async () => {
  const store = mkdtempSync(join(tmpdir(), "vibe-eval-publication-"));
  try {
    const id = "case-a";
    const artifact = buildEvalBaseline({
      results: [comparisonEval("a".repeat(40), { [id]: true })],
      catalog: [{ id, skill: "vibe", contentHash: "a".repeat(64) }],
      pluginVersion: "1.2.3", createdAt: "2026-10-30T00:00:00Z",
    });
    const journal = join(store, `eval-t2-publication-${"a".repeat(12)}.json`);
    const retainedArtifact = `eval-t2-${artifact.pluginVersion}-${artifact.pluginSha.slice(0, 12)}-` +
      `${artifact.resultHash.slice(0, 12)}.json`;
    writeFileSync(join(store, retainedArtifact), `${JSON.stringify(artifact, null, 2)}\n`,
      { mode: 0o600 });
    writeFileSync(journal, `${JSON.stringify({ schemaVersion: 1, artifact,
      resetLineage: true, lastGreenSha: null, regressions: [] }, null, 2)}\n`, { mode: 0o600 });
    let posts = 0;
    const recovered = await recoverPendingNightlyPublications({ store, repo: "/unused",
      ghExecutable: "/unused" }, { report: async () => { posts += 1; } });
    assert.deepEqual(recovered, [journal]);
    assert.equal(posts, 0);
    assert.equal(existsSync(journal), false);
    assert.equal(resolveLatestEvalBaseline(store).artifact.resultHash, artifact.resultHash);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test("on-demand benchmark refuses a baseline older than the latest accepted nightly", () => {
  const store = mkdtempSync(join(tmpdir(), "vibe-eval-benchmark-freshness-"));
  try {
    const id = "case-a";
    const catalog = [{ id, skill: "vibe" as const, contentHash: "a".repeat(64) }];
    const latest = buildEvalBaseline({ results: [comparisonEval("b".repeat(40), { [id]: true })],
      catalog, pluginVersion: "1.2.3" });
    publishEvalBaseline(store, latest);
    assert.doesNotThrow(() => requireLatestNightlyBenchmarkBaseline("b".repeat(40), store));
    assert.throws(() => requireLatestNightlyBenchmarkBaseline("a".repeat(40), store),
      new RegExp(`benchmark-baseline-not-latest-nightly:${"b".repeat(40)}`));
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test("the last-green pointer survives more red nights than bounded index history", () => {
  const store = mkdtempSync(join(tmpdir(), "vibe-eval-green-pointer-"));
  try {
    const id = "case-a";
    const catalog = [{ id, skill: "vibe" as const, contentHash: "a".repeat(64) }];
    let baseline = buildEvalBaseline({ results: [comparisonEval("1".repeat(40), { [id]: true })],
      catalog, pluginVersion: "1.2.3" });
    publishEvalBaseline(store, baseline);
    const greenHash = baseline.resultHash;
    for (let index = 2; index <= 8; index += 1) {
      baseline = buildEvalBaseline({ results: [comparisonEval(
        index.toString(16).repeat(40), { [id]: false })], catalog,
      pluginVersion: "1.2.3", previous: baseline });
      publishEvalBaseline(store, baseline);
    }
    assert.equal(resolveLatestEvalBaseline(store).index.history.length, 5);
    assert.equal(resolveLastGreenEvalBaseline(store)?.resultHash, greenHash);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test("must-pass reliability uses only the five most recent nightly outcomes", () => {
  const id = "case-a";
  const catalog = [{ id, skill: "vibe" as const, contentHash: "a".repeat(64) }];
  let baseline = buildEvalBaseline({ results: [comparisonEval("1".repeat(40), { [id]: true })],
    catalog, pluginVersion: "1.2.3" });
  for (let index = 2; index <= 20; index += 1) {
    baseline = buildEvalBaseline({ results: [comparisonEval(
      index.toString(16).padStart(40, "0"), { [id]: true })],
    catalog, pluginVersion: "1.2.3", previous: baseline });
  }
  baseline = buildEvalBaseline({ results: [comparisonEval("f".repeat(40), { [id]: false })],
    catalog, pluginVersion: "1.2.3", previous: baseline });
  assert.equal(baseline.cases[0].outcomes.claude!.passRate > 0.95, true);
  assert.equal(baseline.cases[0].outcomes.claude?.reliable, false);

  let recovered = buildEvalBaseline({ results: [comparisonEval("a".repeat(40), { [id]: false })],
    catalog, pluginVersion: "1.2.3" });
  for (let index = 0; index < 5; index += 1) {
    recovered = buildEvalBaseline({ results: [comparisonEval(
      (index + 10).toString(16).padStart(40, "0"), { [id]: true })],
    catalog, pluginVersion: "1.2.3", previous: recovered });
  }
  assert.equal(recovered.cases[0].outcomes.claude?.reliable, true);
  assert.deepEqual(recovered.cases[0].outcomes.claude?.recentNightlyOutcomes,
    Array.from({ length: 5 }, () => ({ passes: 1, runs: 1 })));
});

test("confirmed nightly regressions require a reliable green case with unchanged content", () => {
  const catalog = [{ id: "case-a", skill: "vibe" as const, contentHash: "a".repeat(64) }];
  let accepted = buildEvalBaseline({ results: [comparisonEval("1".repeat(40), { "case-a": true })],
    catalog, pluginVersion: "1.2.3" });
  for (const sha of ["2", "3"]) accepted = buildEvalBaseline({
    results: [comparisonEval(sha.repeat(40), { "case-a": true })], catalog,
    pluginVersion: "1.2.3", previous: accepted });
  const failed = buildEvalBaseline({ results: [comparisonEval("4".repeat(40), { "case-a": false })],
    catalog, pluginVersion: "1.2.3", previous: accepted });
  assert.equal(isGreenEvalBaseline(accepted), true);
  assert.equal(isGreenEvalBaseline(failed), false);
  assert.deepEqual(confirmedNightlyRegressions(accepted, failed), [
    { runtime: "claude", case: "case-a" }, { runtime: "codex", case: "case-a" },
  ]);
  const changed = buildEvalBaseline({ results: [comparisonEval("5".repeat(40), { "case-a": false })],
    catalog: [{ ...catalog[0], contentHash: "b".repeat(64) }], pluginVersion: "1.2.3",
    previous: accepted });
  assert.deepEqual(confirmedNightlyRegressions(accepted, changed), []);
});

test("nightly baseline accepts failure-only retries and rejects rerunning a passing case", () => {
  const sha = "a".repeat(40);
  const catalog = ["case-a", "case-b"].map((id) => ({ id, skill: "vibe" as const,
    contentHash: id[5].repeat(64) }));
  const initial = comparisonEval(sha, { "case-a": false, "case-b": true });
  const claudeRetry = comparisonEval(sha, { "case-a": true }, ["claude"]);
  const codexRetry = comparisonEval(sha, { "case-a": true }, ["codex"]);
  const baseline = buildEvalBaseline({ results: [initial, claudeRetry, codexRetry], catalog,
    pluginVersion: "1.2.3" });
  assert.equal(baseline.cases.find((item) => item.id === "case-a")?.outcomes.claude?.passes, 1);
  assert.equal(baseline.cases.find((item) => item.id === "case-b")?.outcomes.claude?.passes, 1);
  assert.throws(() => buildEvalBaseline({ results: [initial,
    comparisonEval(sha, { "case-b": true }, ["claude"])], catalog, pluginVersion: "1.2.3" }),
  /passing-case-rerun/);
});

test("expired quarantine remains readable, gates failures and is surfaced for Slack", () => {
  const catalog = [{ id: "case-a", skill: "vibe" as const, contentHash: "a".repeat(64) }];
  const baseline = buildEvalBaseline({ results: [comparisonEval("a".repeat(40), { "case-a": true })],
    catalog, pluginVersion: "1.2.3", createdAt: "2026-10-29T00:00:00Z" });
  assert.doesNotThrow(() => verifyEvalBaseline(baseline));
  const quarantine = evalQuarantineStatus(new Date("2026-11-14T00:00:00Z"));
  assert.equal(quarantine.entries.length, 29);
  assert.equal(quarantine.expired.length, 29);
  const failedAfterExpiry = buildEvalBaseline({
    results: [comparisonEval("b".repeat(40), { "case-a": false })], catalog,
    pluginVersion: "1.2.3", createdAt: "2026-11-14T00:00:00Z",
  });
  assert.equal(isGreenEvalBaseline(failedAfterExpiry), false);
  const extended = baseline.quarantine.map((item) => ({ ...item, deadline: "2026-12-01" }));
  const reconciled = reconcileEvalBaselineQuarantine(baseline, extended,
    "2026-11-14T00:00:00Z");
  assert.notEqual(reconciled.resultHash, baseline.resultHash);
  assert.equal(reconciled.historyResultHashes.at(-1), baseline.resultHash);
  assert.doesNotThrow(() => verifyEvalBaseline(reconciled));
});

test("nightly regression Slack message names cases, runtimes, PR authors and results", async () => {
  const notice: NightlyRegressionNotice = {
    baselineSha: "a".repeat(40), currentSha: "b".repeat(40),
    cases: [{ runtime: "claude", case: "vibe-route" },
      { runtime: "codex", case: "handoff-close" }],
    mergedPullRequests: [{ number: 368, title: "Start-to-PR benchmark\n<!channel>",
      url: "https://github.com/closedloop-ai/claude-plugins/pull/368", author: "octocat",
      mergeCommit: "b".repeat(40) }],
    directCommits: [], expiredQuarantine: [],
    quarantineOwner: "vibe-maintainers", resultsArtifact: "eval-t2-result.json",
  };
  const message = formatNightlyRegressionMessage(notice);
  assert.match(message, /claude: vibe-route/);
  assert.match(message, /codex: handoff-close/);
  assert.match(message, /#368> by @octocat/);
  assert.doesNotMatch(message, /<!channel>/);
  assert.match(message, /&lt;!channel&gt;/);
  assert.match(message, /Quarantine owner: vibe-maintainers/);
  assert.match(message, /coordinate a fix-forward or revert/);
  assert.match(message, /Full results: eval-t2-result.json/);
  const escaped = formatNightlyRegressionMessage({ ...notice,
    cases: [{ runtime: "claude", case: "case-<!channel>" }],
    quarantineOwner: "owner<@U123>", resultsArtifact: "result<@U123>.json" });
  assert.doesNotMatch(escaped, /<!channel>|<@U123>/);
  assert.match(escaped, /case-&lt;!channel&gt;/);
  const expiryMessage = formatNightlyRegressionMessage({ ...notice, cases: [],
    mergedPullRequests: [], directCommits: [], expiredQuarantine: [{ runtime: "claude",
      case: "vibe-route", owner: "vibe-maintainers", deadline: "2026-11-13",
      reason: "fixture" }] });
  assert.match(expiryMessage, /Expired quarantine entries are gating/);
  assert.match(expiryMessage, /claude: vibe-route, owner @vibe-maintainers, expired 2026-11-13/);

  const invocations: Array<{ command: string; args: string[]; input: string; timeout: number }> = [];
  const transcript = (text: string, extras: object[] = [], isError = false) => [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1",
      name: "mcp__plugin_slack_slack__slack_send_message",
      input: { channel_id: "C0CC9G7V01G", message: text } }] } },
    ...extras,
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1",
      is_error: isError, content: isError ? "PreToolUse hook denied this tool call" :
        JSON.stringify({ message_context: { channel_id: "C0CC9G7V01G",
          message_ts: "1793393000.000100" },
        message_link: "https://closedloop.slack.com/archives/test" }) }] } },
    { type: "result", subtype: "success", is_error: false },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const pluginList = JSON.stringify([{ id: "slack@anthropic-plugin-directory", enabled: true,
    installPath: "/plugins/slack" }]);
  const runConfiguredGate = (args: string[], options: { input: string },
    toolInput?: { channel_id: string; message: string }) => {
    const payload = JSON.parse(options.input.split("\n").at(-1)!) as {
      channel_id: string; message: string;
    };
    const relaySettings = JSON.parse(args[args.indexOf("--settings") + 1]);
    const gateCommand = relaySettings.hooks.PreToolUse[0].hooks[0].command as string;
    return spawnSync("/bin/sh", ["-c", gateCommand], { encoding: "utf8", input: JSON.stringify({
      tool_name: "mcp__plugin_slack_slack__slack_send_message", tool_input: toolInput ?? payload,
    }) });
  };
  const withPlugin = (delivery: (command: string, args: string[], options: {
    input: string; timeout: number;
  }) => { status: number | null; stdout: string; stderr: string; error?: Error }) =>
    (command: string, args: string[], options: { input: string; timeout: number }) => {
      if (args[0] === "plugin") return { status: 0, stdout: pluginList, stderr: "" };
      if (args.includes("mcp") && args.includes("list")) {
        return { status: 0, stdout: "plugin:slack:slack - ✔ Connected\n", stderr: "" };
      }
      const gated = runConfiguredGate(args, options);
      assert.equal(gated.status, 0, gated.stderr);
      assert.equal(JSON.parse(gated.stdout).hookSpecificOutput.permissionDecision, "allow");
      return delivery(command, args, options);
    };
  const run = (command: string, args: string[], options: { input: string; timeout: number }) => {
    invocations.push({ command, args, ...options });
    if (args[0] === "plugin") return { status: 0, stdout: pluginList, stderr: "" };
    if (args.includes("mcp") && args.includes("list")) {
      return { status: 0, stdout: "plugin:slack:slack - ✔ Connected\n", stderr: "" };
    }
    const payload = JSON.parse(options.input.split("\n").at(-1)!) as {
      channel_id: string; message: string;
    };
    const gated = runConfiguredGate(args, options, payload);
    assert.equal(gated.status, 0, gated.stderr);
    assert.equal(JSON.parse(gated.stdout).hookSpecificOutput.permissionDecision, "allow");
    return { status: 0, stdout: transcript(payload.message), stderr: "" };
  };
  await new SlackNightlyRegressionReporter("/opt/claude", run).report(notice);
  assert.deepEqual(invocations[0].args, ["plugin", "list", "--json"]);
  assert.equal(invocations[0].timeout, 5_000);
  assert.deepEqual(invocations[1].args, ["--plugin-dir", "/plugins/slack",
    "--setting-sources", "", "--settings", "{}", "mcp", "list"]);
  assert.equal(invocations[1].timeout, 10_000);
  const delivery = invocations[2];
  assert.equal(delivery.command, "/opt/claude");
  assert.equal(delivery.args[delivery.args.indexOf("--model") + 1],
    "claude-haiku-5-5");
  assert.equal(delivery.args[delivery.args.indexOf("--tools") + 1], "");
  assert.equal(delivery.args[delivery.args.indexOf("--allowedTools") + 1],
    "mcp__plugin_slack_slack__slack_send_message");
  assert.equal(delivery.args[delivery.args.indexOf("--max-budget-usd") + 1], "0.20");
  assert.equal(delivery.args[delivery.args.indexOf("--setting-sources") + 1], "");
  const settings = JSON.parse(delivery.args[delivery.args.indexOf("--settings") + 1]);
  assert.equal(settings.hooks.PreToolUse[0].matcher,
    "mcp__plugin_slack_slack__slack_send_message");
  assert.deepEqual(Object.keys(settings.hooks.PreToolUse[0].hooks[0]).sort(),
    ["command", "timeout", "type"]);
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /slack-tool-gate\.ts/);
  assert.equal(delivery.args[delivery.args.indexOf("--plugin-dir") + 1], "/plugins/slack");
  assert.equal(delivery.args.includes("--no-session-persistence"), true);
  assert.equal(delivery.args.includes("stream-json"), true);
  assert.equal(delivery.timeout, 20_000);
  assert.deepEqual(JSON.parse(delivery.input.split("\n").at(-1)!),
    { channel_id: "C0CC9G7V01G", message });

  let deniedFailure: unknown;
  const deniedByGate = (command: string, args: string[], options: {
    input: string; timeout: number;
  }) => {
    if (args[0] === "plugin") return { status: 0, stdout: pluginList, stderr: "" };
    if (args.includes("mcp") && args.includes("list")) {
      return { status: 0, stdout: "plugin:slack:slack - ✔ Connected\n", stderr: "" };
    }
    const payload = JSON.parse(options.input.split("\n").at(-1)!) as {
      channel_id: string; message: string;
    };
    const gated = runConfiguredGate(args, options,
      { ...payload, message: `${payload.message} altered` });
    assert.equal(gated.status, 0, gated.stderr);
    assert.equal(JSON.parse(gated.stdout).hookSpecificOutput.permissionDecision, "deny");
    return { status: 0, stdout: transcript(payload.message, [], true), stderr: "" };
  };
  try {
    await new SlackNightlyRegressionReporter("/claude", deniedByGate).report(notice);
  } catch (error) { deniedFailure = error; }
  assert.match(String(deniedFailure), /eval-slack-gate-denied/);
  assert.equal(isRetrySafeSlackFailure(deniedFailure), true);

  const withoutGate = (command: string, args: string[]) => {
    if (args[0] === "plugin") return { status: 0, stdout: pluginList, stderr: "" };
    if (args.includes("mcp") && args.includes("list")) {
      return { status: 0, stdout: "plugin:slack:slack - ✔ Connected\n", stderr: "" };
    }
    return { status: 0, stdout: transcript(message), stderr: "" };
  };
  await assert.rejects(() => new SlackNightlyRegressionReporter("/claude",
    withoutGate).report(notice), /eval-slack-gate-not-confirmed/);

  const altered = () => ({ status: 0, stdout: transcript(`${message} altered`), stderr: "" });
  await assert.rejects(() => new SlackNightlyRegressionReporter("/claude",
    withPlugin(altered)).report(notice),
    /tool-call-altered/);
  const extra = { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-2",
    name: "mcp__plugin_slack_slack__slack_send_message",
    input: { channel_id: "C0CC9G7V01G", message } }] } };
  const duplicated = () => ({ status: 0, stdout: transcript(message, [extra]), stderr: "" });
  await assert.rejects(() => new SlackNightlyRegressionReporter("/claude",
    withPlugin(duplicated)).report(notice),
    /tool-call-count-invalid/);
  const failed = () => ({ status: 1, stdout: "", stderr: "auth unavailable" });
  await assert.rejects(() => new SlackNightlyRegressionReporter("/claude",
    withPlugin(failed)).report(notice),
    /claude-failed/);
  const timedOut = () => ({ status: null, stdout: "", stderr: "",
    error: new Error("spawnSync /claude ETIMEDOUT") });
  await assert.rejects(() => new SlackNightlyRegressionReporter("/claude",
    withPlugin(timedOut)).report(notice),
    /claude-timeout/);
  const lockedKeychain = (_command: string, args: string[]) => {
    if (args[0] === "plugin") return { status: 0, stdout: pluginList, stderr: "" };
    if (args.includes("mcp") && args.includes("list")) {
      return { status: 0, stdout: "Checking MCP server health…\n\n" +
        "plugin:slack:slack: https://mcp.slack.com/mcp (HTTP) - ✘ Failed to connect — " +
        "Couldn't read the stored credentials because the Mac's keychain is locked.\n",
      stderr: "" };
    }
    return { status: 0, stdout: [
      { type: "system", subtype: "init", mcp_servers: [
        { name: "plugin:slack:slack", status: "failed", source: "plugin" },
      ] },
      { type: "result", subtype: "success", is_error: false },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n", stderr: "" };
  };
  await assert.rejects(() => new SlackNightlyRegressionReporter("/claude",
    lockedKeychain).report(notice),
  /macOS login keychain is locked.*unlock the login keychain.*GUI session logged in/);
  const lockedLogs: string[] = [];
  await reportNightlyInfrastructureFailure("eval-fixture-failure",
    new SlackNightlyRegressionReporter("/claude", lockedKeychain),
    (line) => lockedLogs.push(line));
  assert.match(lockedLogs.join(""),
    /VIBE_NIGHTLY_SLACK_FAILURE eval-slack-credentials-unavailable: macOS login keychain is locked.*unlock the login keychain.*GUI session logged in/);
  const approved = await new SlackNightlyRegressionReporter("/opt/claude", run)
    .reportApprovedTest();
  assert.deepEqual(approved, { timestamp: "1793393000.000100",
    permalink: "https://closedloop.slack.com/archives/test" });
  assert.deepEqual(JSON.parse(invocations.at(-1)!.input.split("\n").at(-1)!),
    { channel_id: "C0CC9G7V01G", message: SLACK_DELIVERY_TEST_MESSAGE });
  assert.match(formatNightlyInfrastructureMessage({ reason: "eval-binary-missing",
    occurredAt: "2026-10-30T00:00:00Z" }), /eval-binary-missing/);
  await new SlackNightlyRegressionReporter("/opt/claude", run).reportInfrastructure({
    reason: "eval-binary-missing",
    occurredAt: "2026-10-30T00:00:00Z" });
  assert.match(invocations.at(-1)!.input, /Vibe nightly infrastructure failure/);
  assert.match(invocations.at(-1)!.input, /eval-binary-missing/);
  const logs: string[] = [];
  await reportNightlyInfrastructureFailure("eval-regression-pull-request-attribution-incomplete",
    { reportInfrastructure: async () => { throw new Error("eval-slack-post-failed"); } },
    (line) => logs.push(line));
  assert.match(logs.join(""), /VIBE_NIGHTLY_INFRA_FAILURE.*attribution-incomplete/);
  assert.match(logs.join(""), /VIBE_NIGHTLY_SLACK_FAILURE eval-slack-post-failed/);
  const successLogs: string[] = [];
  await reportNightlyInfrastructureFailure("eval-fetch-failed",
    { reportInfrastructure: async () => {} }, (line) => successLogs.push(line),
    (line) => successLogs.push(line));
  assert.match(successLogs.join(""), /VIBE_NIGHTLY_SLACK_POSTED/);
});

test("approved Slack relay test is fixed, one-shot and prints the Slack receipt", async () => {
  let claims = 0;
  let relayCalls = 0;
  const result = await runApprovedSlackTest(["/absolute/claude"], {
    claimAttempt: () => { claims += 1; },
    reporter: (claude) => {
      assert.equal(claude, "/absolute/claude");
      return { reportApprovedTest: async () => {
        relayCalls += 1;
        return { timestamp: "1793393000.000100",
          permalink: "https://closedloop.slack.com/archives/test" };
      } };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(claims, 1);
  assert.equal(relayCalls, 1);
  assert.deepEqual(JSON.parse(result.line.slice("VIBE_NIGHTLY_SLACK_TEST ".length)), {
    result: "POSTED", timestamp: "1793393000.000100",
    permalink: "https://closedloop.slack.com/archives/test",
  });

  const duplicate = await runApprovedSlackTest(["/absolute/claude"], {
    claimAttempt: () => { throw new Error("eval-slack-approved-test-already-attempted"); },
    reporter: () => ({ reportApprovedTest: async () => {
      relayCalls += 1;
      return { timestamp: null, permalink: null };
    } }),
  });
  assert.equal(duplicate.exitCode, 1);
  assert.match(duplicate.line, /already-attempted/);
  assert.equal(relayCalls, 1);
  const locked = await runApprovedSlackTest(["/absolute/claude"], {
    claimAttempt: () => {},
    reporter: () => ({ reportApprovedTest: async () => {
      throw new Error("eval-slack-credentials-unavailable: macOS login keychain is locked; " +
        "unlock the login keychain or keep the GUI session logged in");
    } }),
  });
  assert.equal(locked.exitCode, 1);
  assert.deepEqual(JSON.parse(locked.line.slice("VIBE_NIGHTLY_SLACK_TEST ".length)), {
    result: "FAILED",
    error: "eval-slack-credentials-unavailable: macOS login keychain is locked; " +
      "unlock the login keychain or keep the GUI session logged in",
  });
  assert.equal((await runApprovedSlackTest(["/claude", "arbitrary message"])).exitCode, 64);
});

test("Slack pre-tool gate denies altered and repeated requests before execution", () => {
  const expected = { channel_id: "C0CC9G7V01G", message: "fixed message" };
  const exact = slackToolGateDecision({
    tool_name: "mcp__plugin_slack_slack__slack_send_message", tool_input: expected,
  }, expected);
  assert.equal(exact.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(exact.hookSpecificOutput.updatedInput, expected);
  const altered = slackToolGateDecision({
    tool_name: "mcp__plugin_slack_slack__slack_send_message",
    tool_input: { ...expected, message: "model changed it" },
  }, expected);
  assert.equal(altered.hookSpecificOutput.permissionDecision, "deny");

  const root = mkdtempSync(join(tmpdir(), "vibe-slack-gate-"));
  try {
    const expectedFile = join(root, "expected.json");
    const attemptFile = join(root, "attempted");
    writeFileSync(expectedFile, JSON.stringify(expected));
    const gate = join(import.meta.dirname, "slack-tool-gate.ts");
    const input = JSON.stringify({
      tool_name: "mcp__plugin_slack_slack__slack_send_message", tool_input: expected,
    });
    const first = spawnSync(process.execPath, ["--experimental-strip-types", gate,
      expectedFile, attemptFile], { input, encoding: "utf8" });
    assert.equal(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision, "allow");
    const second = spawnSync(process.execPath, ["--experimental-strip-types", gate,
      expectedFile, attemptFile], { input, encoding: "utf8" });
    assert.equal(JSON.parse(second.stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a non-PR main commit is attributed directly instead of wedging alerts", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-direct-commit-"));
  const priorPath = process.env.PATH;
  try {
    execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "config", "user.name", "Direct Author"]);
    execFileSync("git", ["-C", root, "config", "user.email", "direct@example.com"]);
    writeFileSync(join(root, "file.txt"), "one\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-m", "baseline"], { stdio: "ignore" });
    const baselineSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"],
      { encoding: "utf8" }).trim();
    writeFileSync(join(root, "file.txt"), "two\n");
    execFileSync("git", ["-C", root, "commit", "-am", "direct maintenance"], { stdio: "ignore" });
    writeFileSync(join(root, "file.txt"), "three\n");
    execFileSync("git", ["-C", root, "commit", "-am", "second direct maintenance"],
      { stdio: "ignore" });
    const currentSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"],
      { encoding: "utf8" }).trim();
    const gh = join(root, "gh");
    writeFileSync(gh, "#!/bin/sh\nif [ \"$1\" = repo ]; then printf 'closedloop-ai/claude-plugins\\n'; else printf '[]\\n'; fi\n",
      { mode: 0o700 });
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = join(root, "bin");
    const gitLog = join(root, "git-calls.txt");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\n` +
      `exec '${realGit}' "$@"\n`, { mode: 0o700 });
    process.env.PATH = `${bin}:${priorPath}`;
    const changes = nightlyChangesSince({ repo: root, ghExecutable: gh,
      baselineSha, currentSha });
    assert.deepEqual(changes.mergedPullRequests, []);
    assert.equal(changes.directCommits.length, 2);
    assert.deepEqual(changes.directCommits.map((item) => item.title),
      ["second direct maintenance", "direct maintenance"]);
    assert.match(changes.directCommits[0].author, /Direct Author/);
    assert.equal(readFileSync(gitLog, "utf8").split("\n")
      .filter((line) => line.includes("show -s")).length, 1);
  } finally {
    process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("nightly attribution rejects an over-limit commit range before GitHub lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-attribution-limit-"));
  const priorPath = process.env.PATH;
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const git = join(bin, "git");
    writeFileSync(git, "#!/bin/sh\ni=0\nwhile [ $i -le 1000 ]; do printf '%040d\\n' \"$i\"; i=$((i + 1)); done\n",
      { mode: 0o700 });
    process.env.PATH = `${bin}:${priorPath}`;
    assert.throws(() => nightlyChangesSince({ repo: root, ghExecutable: "/never-called-gh",
      baselineSha: "a".repeat(40), currentSha: "b".repeat(40) }),
    /commit-range-too-large/);
  } finally {
    process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("only proven pre-send Slack failures retry; ambiguous attempts never replay", async () => {
  const store = mkdtempSync(join(tmpdir(), "vibe-eval-slack-pending-"));
  const file = join(store, `eval-t2-regression-${"b".repeat(12)}.json`);
  const notice: NightlyRegressionNotice = {
    baselineSha: "a".repeat(40), currentSha: "b".repeat(40),
    cases: [{ runtime: "claude", case: "vibe-route" }], mergedPullRequests: [],
    directCommits: [], expiredQuarantine: [],
    quarantineOwner: "vibe-maintainers", resultsArtifact: "eval-t2-result.json",
  };
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, delivery: "pending",
    deliveredAt: null, notice })}\n`);
  try {
    await assert.rejects(() => deliverPendingRegressionReports(store,
      { report: async () => { throw new SlackDeliveryError("fixture-slack-unavailable", true); } }),
    /fixture-slack-unavailable/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).delivery, "pending");
    const delivered: NightlyRegressionNotice[] = [];
    await deliverPendingRegressionReports(store,
      { report: async (item) => { delivered.push(item); } });
    assert.deepEqual(delivered, [notice]);
    const sentRecord = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(sentRecord.schemaVersion, 2);
    assert.equal(sentRecord.delivery, "sent");
    await deliverPendingRegressionReports(store,
      { report: async (item) => { delivered.push(item); } });
    assert.deepEqual(delivered, [notice]);

    const ambiguousFile = join(store, `eval-t2-regression-${"c".repeat(12)}.json`);
    writeFileSync(ambiguousFile, `${JSON.stringify({ schemaVersion: 1, delivery: "pending",
      attemptedAt: null, deliveredAt: null, notice })}\n`);
    let attempts = 0;
    await assert.rejects(() => deliverPendingRegressionReports(store, { report: async () => {
      attempts += 1;
      throw new Error("fixture-after-side-effect-timeout");
    } }), /after-side-effect-timeout/);
    assert.equal(JSON.parse(readFileSync(ambiguousFile, "utf8")).delivery, "attempting");
    await deliverPendingRegressionReports(store, { report: async () => { attempts += 1; } });
    assert.equal(attempts, 1);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test("Codex eval budget scales with the full corpus", () => {
  assert.equal(codexEvalBudgetSeconds(1), 1800);
  assert.equal(codexEvalBudgetSeconds(105), 9450);
});

test("focused Claude evals stage only the selected cases under the plugin root", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-focused-"));
  try {
    const vibeDir = join(root, "plugins/vibe");
    for (const id of ["case-a", "case-b", "case-c"]) {
      const caseDir = join(vibeDir, "evals", id);
      mkdirSync(caseDir, { recursive: true });
      writeFileSync(join(caseDir, "prompt.md"), "fixture\n");
    }
    assert.equal(stageFocusedClaudeEvalCases(vibeDir, ["case-b", "case-a"]),
      "vibe/evals-focused");
    assert.deepEqual(readdirSync(join(vibeDir, "evals-focused")).sort(), ["case-a", "case-b"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function claudeNative(vibePath = "/snapshot/vibe", corePath = "/snapshot/core", passed = true,
  caseIds: string[] = [CASE]) {
  return {
    schemaVersion: 1, claudeVersion: "2.1.311", durationSeconds: 12, costUsd: 0.1,
    partial: false, suite: { ablation: "none", modelOverride: "claude-sonnet-5-5", plugins: [
      { name: "vibe", version: "1.2.3", path: vibePath },
      { name: "closedloop-core", version: "1.5.3", path: corePath },
    ] }, cases: caseIds.map((name) => ({ name, runsPerCase: 1, arms: { with: [{ passed, error: null,
      costUsd: 0.1 / caseIds.length, judgeCostUsd: 0.02 / caseIds.length,
      skippedPaidGraders: false, graders: [{ name: "route", passed, scored: true }] }] } })),
    aggregates: { casesTotal: caseIds.length, casesPassed: passed ? caseIds.length : 0 },
  };
}

function codexNative(vibePath = "/snapshot/vibe", passed = true, deterministicOnly = true,
  skipWording = false, caseIds: string[] = [CASE]) {
  return { run: { source_sha: "a".repeat(40), skill_sha256: "b".repeat(64), version: "1.2.3",
    cli_version: "codex-cli 0.163.0", plugin: vibePath, deterministic_only: deterministicOnly,
    model: "gpt-6-sol", grader_model: "gpt-6-luna", elapsed_seconds: 10,
    usage: { input_tokens: 12 } }, cases: caseIds.map((id) => ({ case: codexCaseId(id),
      passed, checks: [{ grader: "route", passed }], skipped_graders: deterministicOnly && skipWording ?
        [{ grader: "plain-language", reason: "deterministic-only" }] : [] })) };
}

test("native collectors preserve a wrong route as red on both runtimes", () => {
  const claude = collectClaudeEval(claudeNative(undefined, undefined, false), [CASE], {
    version: "1.2.3", coreVersion: "1.5.3", cliVersion: "2.1.311",
    vibePath: "/snapshot/vibe", corePath: "/snapshot/core", model: "claude-sonnet-5-5",
  });
  const codex = collectCodexEval(codexNative(undefined, false), [CASE], {
    sourceSha: "a".repeat(40), skillSha: "b".repeat(64), version: "1.2.3",
    cliVersion: "codex-cli 0.163.0", vibePath: "/snapshot/vibe", deterministicOnly: true,
    model: "gpt-6-sol", graderModel: "gpt-6-luna", wordingCases: [],
  });
  assert.deepEqual(claude.cases[0].failedGraders, ["route"]);
  assert.equal(claude.agentCostUsd, 0.1);
  assert.equal(claude.judgeCostUsd, 0.02);
  assert.ok(Math.abs((claude.costUsd ?? 0) - 0.12) < 0.000001);
  assert.deepEqual(codex.cases[0].failedGraders, ["route"]);
  const combined = finalizeLocalEval({ pluginSha: "a".repeat(40), createdAt: "2026-10-29T00:00:00Z",
    wallMs: 20_000, deterministicOnly: true, selectedCases: [CASE], runtimes: [
      { runtime: "claude", exitCode: 1, result: claude, invalidReason: null },
      { runtime: "codex", exitCode: 1, result: codex, invalidReason: null },
    ] });
  assert.equal(combined.success, false);
  assert.match(combined.resultHash, /^[a-f0-9]{64}$/);
});

test("collectors reject partial, duplicate, identity-drifted and dishonest artifacts", () => {
  assert.throws(() => collectClaudeEval({ ...claudeNative(), partial: true }, [CASE], {
    version: "1.2.3", coreVersion: "1.5.3", cliVersion: "2.1.311",
    vibePath: "/snapshot/vibe", corePath: "/snapshot/core", model: "claude-sonnet-5-5",
  }), /partial-or-schema/);
  const duplicate = claudeNative();
  duplicate.cases.push(duplicate.cases[0]);
  assert.throws(() => collectClaudeEval(duplicate, [CASE], {
    version: "1.2.3", coreVersion: "1.5.3", cliVersion: "2.1.311",
    vibePath: "/snapshot/vibe", corePath: "/snapshot/core", model: "claude-sonnet-5-5",
  }), /coverage-mismatch/);
  const aliased = claudeNative();
  aliased.suite.modelOverride = "sonnet";
  assert.throws(() => collectClaudeEval(aliased, [CASE], {
    version: "1.2.3", coreVersion: "1.5.3", cliVersion: "2.1.311",
    vibePath: "/snapshot/vibe", corePath: "/snapshot/core", model: "claude-sonnet-5-5",
  }), /mode-mismatch/);
  assert.throws(() => collectCodexEval(codexNative(), [CASE], {
    sourceSha: "a".repeat(40), skillSha: "b".repeat(64), version: "1.2.3",
    cliVersion: "codex-cli 0.163.0", vibePath: "/wrong", deterministicOnly: true,
    model: "gpt-6-sol", graderModel: "gpt-6-luna", wordingCases: [],
  }), /identity-mismatch/);
  const conflict = codexNative();
  conflict.cases[0].passed = true;
  conflict.cases[0].checks[0].passed = false;
  assert.throws(() => collectCodexEval(conflict, [CASE], {
    sourceSha: "a".repeat(40), skillSha: "b".repeat(64), version: "1.2.3",
    cliVersion: "codex-cli 0.163.0", vibePath: "/snapshot/vibe", deterministicOnly: true,
    model: "gpt-6-sol", graderModel: "gpt-6-luna", wordingCases: [],
  }), /check-conflict/);
});

test("Codex deterministic-only artifacts record exactly the expected wording skips", () => {
  const expected = {
    sourceSha: "a".repeat(40), skillSha: "b".repeat(64), version: "1.2.3",
    cliVersion: "codex-cli 0.163.0", vibePath: "/snapshot/vibe", deterministicOnly: true,
    model: "gpt-6-sol", graderModel: "gpt-6-luna", wordingCases: [CASE],
  };
  const collected = collectCodexEval(codexNative(undefined, true, true, true), [CASE], expected);
  assert.deepEqual(collected.cases[0].skippedGraders, ["plain-language"]);
  assert.throws(() => collectCodexEval(codexNative(), [CASE], expected), /skip-mismatch/);
  assert.throws(() => collectCodexEval(codexNative(undefined, true, true, true), [CASE], {
    ...expected, wordingCases: [],
  }), /skip-mismatch/);
});

class FakeCommands implements EvalCommands {
  readonly localModelExecution = false;
  calls: Array<{ command: string; args: string[]; deadline: number | null }> = [];
  async run(command: string, args: string[], _cwd?: string, _options?: {
    deadline: number; signal?: AbortSignal;
  }): Promise<{
    status: number; stdout: string; stderr: string;
  }> {
    this.calls.push({ command, args, deadline: _options?.deadline ?? null });
    if (args.length === 1 && args[0] === "--version") {
      return { status: 0, stdout: command.includes("claude") ?
        "2.1.311 (Claude Code)\n" : "codex-cli 0.163.0\n", stderr: "" };
    }
    if (command.includes("claude")) {
      const vibePath = args.includes("--eval-dir") ? join(args[2], "vibe") : args[2];
      const resultFile = args[args.indexOf("--json") + 1];
      const evalRoot = join(args[2], args[args.indexOf("--eval-dir") + 1]);
      const caseIds = readdirSync(evalRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(evalRoot, entry.name, "prompt.md")))
        .map((entry) => entry.name).sort();
      writeFileSync(resultFile, JSON.stringify(claudeNative(vibePath, join(dirname(vibePath),
        "closedloop-core"), true, caseIds)));
      return { status: 0, stdout: "", stderr: "" };
    }
    const vibePath = args[args.indexOf("--plugin") + 1];
    const output = args[args.indexOf("--output") + 1];
    mkdirSync(output, { recursive: true });
    const sourceSha = args[args.indexOf("--source-sha") + 1];
    const skillSha = createHash("sha256").update(
      readFileSync(join(vibePath, "skills/vibe/SKILL.md"))).digest("hex");
    const deterministic = args.includes("--deterministic-only");
    const selectedCodex = args.flatMap((arg, index) => args[index - 1] === "--case" ? [arg] : []);
    const native = codexNative(vibePath, true, deterministic);
    native.cases = selectedCodex.map((name) => ({ case: name, passed: true,
      checks: [{ grader: "route", passed: true }], skipped_graders: [] }));
    native.run.deterministic_only = deterministic;
    native.run.source_sha = sourceSha;
    native.run.skill_sha256 = skillSha;
    writeFileSync(join(output, "results.json"), JSON.stringify(native));
    return { status: 0, stdout: "", stderr: "" };
  }
}

class FailingSiblingCommands extends FakeCommands {
  siblingAborted = false;
  override async run(command: string, args: string[], _cwd?: string,
    options?: { deadline: number; signal?: AbortSignal }): Promise<{
      status: number; stdout: string; stderr: string;
    }> {
    if (args.length === 1 && args[0] === "--version") return super.run(command, args);
    if (command.includes("claude")) throw new Error("fixture-claude-launch-failed");
    return new Promise((_resolve, reject) => {
      const stop = () => {
        this.siblingAborted = true;
        reject(new Error("fixture-codex-aborted"));
      };
      if (options?.signal?.aborted) stop();
      else options?.signal?.addEventListener("abort", stop, { once: true });
    });
  }
}

class DriftingCommands extends FakeCommands {
  private changed = false;
  private readonly repo: string;
  constructor(repo: string) { super(); this.repo = repo; }
  override async run(command: string, args: string[], cwd?: string, options?: {
    deadline: number; signal?: AbortSignal;
  }): Promise<{ status: number; stdout: string; stderr: string }> {
    const result = await super.run(command, args, cwd, options);
    if (!this.changed && args.length !== 1) {
      this.changed = true;
      writeFileSync(join(this.repo, "plugins/vibe/agents/vibe-change-worker.md"),
        "---\nname: vibe-change-worker\nmodel: sonnet\n---\nchanged during run\n");
    }
    return result;
  }
}

test("local driver snapshots one committed tree and writes one immutable dual-runtime result", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vibe-eval-driver-")));
  try {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "plugins/vibe/.claude-plugin"), { recursive: true });
    mkdirSync(join(repo, "plugins/vibe/.codex-plugin"), { recursive: true });
    mkdirSync(join(repo, "plugins/vibe/agents"), { recursive: true });
    mkdirSync(join(repo, "plugins/vibe/skills/vibe"), { recursive: true });
    mkdirSync(join(repo, "plugins/vibe/skills/vibe/scripts"), { recursive: true });
    mkdirSync(join(repo, `plugins/vibe/evals/${CASE}`), { recursive: true });
    mkdirSync(join(repo, "plugins/vibe/evals/codex"), { recursive: true });
    mkdirSync(join(repo, "plugins/closedloop-core/.claude-plugin"), { recursive: true });
    writeFileSync(join(repo, "plugins/vibe/.claude-plugin/plugin.json"), JSON.stringify({
      name: "vibe", version: "1.2.3", dependencies: ["closedloop-core"],
    }));
    writeFileSync(join(repo, "plugins/vibe/.codex-plugin/plugin.json"), JSON.stringify({
      name: "vibe", version: "1.2.3", skills: "./skills/",
    }));
    writeFileSync(join(repo, "plugins/closedloop-core/.claude-plugin/plugin.json"), JSON.stringify({
      name: "closedloop-core", version: "1.5.3",
    }));
    writeFileSync(join(repo, "plugins/vibe/agents/vibe-change-worker.md"),
      "---\nname: vibe-change-worker\nmodel: sonnet\n---\n");
    writeFileSync(join(repo, "plugins/vibe/skills/vibe/SKILL.md"), "fixture skill\n");
    for (const name of ["tested-head.mjs", "session-record.mjs"]) {
      cpSync(join(import.meta.dirname, `../../../plugins/vibe/skills/vibe/scripts/${name}`),
        join(repo, `plugins/vibe/skills/vibe/scripts/${name}`));
    }
    writeFileSync(join(repo, `plugins/vibe/evals/${CASE}/prompt.md`),
      "---\ntags: []\n---\n/vibe:vibe\nfixture\n");
    writeFileSync(join(repo, "plugins/vibe/evals/codex/run.py"), "# fixture\n");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c",
      "user.email=fixture@invalid.local", "commit", "-m", "fixture"], { stdio: "ignore" });
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", sha]);
    const commands = new FakeCommands();
    const output = await runLocalEvals({ repo, pluginSha: sha, runRoot: join(root, "run"),
      outputDir: join(root, "results"), claudeExecutable: "fixture-claude",
      codexExecutable: "fixture-codex", uvExecutable: "fixture-uv",
      deterministicOnly: true }, commands);
    assert.equal(output.result.success, true);
    assert.deepEqual(output.result.runtimes.map((item) => item.runtime), ["claude", "codex"]);
    assert.match(output.result.resultHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(readFileSync(output.reportFile, "utf8"), /\/Users\/|\/private\/tmp|laptop/);
    assert.ok(commands.calls.every((call) => !call.args.some((arg) => arg.includes(".codex/plugins/cache"))));
    const modelCalls = commands.calls.filter((call) => !call.args.includes("--version"));
    assert.equal(modelCalls.length, 2);
    assert.equal(modelCalls.find((call) => call.command.includes("claude"))!.args[
      modelCalls.find((call) => call.command.includes("claude"))!.args.indexOf("--concurrency") + 1], "3");
    assert.equal(modelCalls.find((call) => call.command.includes("uv"))!.args[
      modelCalls.find((call) => call.command.includes("uv"))!.args.indexOf("--concurrency") + 1], "2");
    const claudeCall = modelCalls.find((call) => call.command.includes("claude"))!;
    assert.equal(claudeCall.args[2].endsWith("/plugin-snapshot/plugins"), true);
    assert.equal(claudeCall.args[2], realpathSync(claudeCall.args[2]));
    assert.equal(claudeCall.args[claudeCall.args.indexOf("--eval-dir") + 1], "vibe/evals");
    assert.equal(claudeCall.args.includes("--case"), false);
    const codexCall = modelCalls.find((call) => call.command.includes("uv"))!;
    assert.deepEqual(codexCall.args.slice(0, 6),
      ["run", "--with", "Pillow==12.3.0", "--with", "PyYAML", "python"]);
    assert.equal(codexCall.args[6], codexEvalRunnerPath());
    assert.equal(codexCall.args[6].includes("/plugin-snapshot/"), false);
    assert.equal(codexCall.args[codexCall.args.indexOf("--model") + 1], EVAL_POLICY.codexModel);
    assert.equal(codexCall.args[codexCall.args.indexOf("--grader-model") + 1],
      EVAL_POLICY.codexJudgeModel);
    const failing = new FailingSiblingCommands();
    await assert.rejects(() => runLocalEvals({ repo, pluginSha: sha, runRoot: join(root, "failed-run"),
      outputDir: join(root, "failed-results"), claudeExecutable: "fixture-claude",
      codexExecutable: "fixture-codex", uvExecutable: "fixture-uv",
      deterministicOnly: true }, failing), /fixture-claude-launch-failed/);
    assert.equal(failing.siblingAborted, true);
    await assert.rejects(() => runLocalEvals({ repo, pluginSha: sha, runRoot: join(root, "run"),
      outputDir: join(root, "results"), claudeExecutable: "fixture-claude",
      codexExecutable: "fixture-codex", uvExecutable: "fixture-uv" }, commands),
    /run-root-exists/);

    const t2Commands = new FakeCommands();
    const store = join(root, "t2-store");
    assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }), "");
    assert.equal(execFileSync("git", ["-C", repo, "branch", "--show-current"],
      { encoding: "utf8" }).trim(), "main");
    assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "origin/main"],
      { encoding: "utf8" }).trim(), sha);
    const nightly = await runT2Evals({ repo, pluginSha: sha, runRoot: join(root, "t2-nightly"),
      outputDir: store, claudeExecutable: "fixture-claude",
      codexExecutable: "fixture-codex", uvExecutable: "fixture-uv",
      ghExecutable: "fixture-gh" }, t2Commands);
    assert.equal(nightly.skipped, false);
    assert.equal(t2Commands.calls.filter((call) => call.args.includes("--eval-dir")).length, 1);
    assert.equal(t2Commands.calls.filter((call) => call.command.includes("fixture-uv")).length, 1);
    const acceptedHash = resolveLatestEvalBaseline(store).artifact.resultHash;
    assert.equal(nightly.result.costs?.claude?.agentUsd, 0.1);
    assert.equal(nightly.result.costs?.claude?.judgeUsd, 0.02);

    const legacyStore = join(root, "t2-legacy-store");
    mkdirSync(legacyStore);
    publishEvalBaseline(legacyStore, withJudgeModel(nightly.result, "claude-haiku-4-5"));
    const lineageCommands = new FakeCommands();
    const notices: unknown[] = [];
    const lineage = await runT2Evals({ repo, pluginSha: sha,
      runRoot: join(root, "t2-new-judge-lineage"), outputDir: legacyStore,
      claudeExecutable: "fixture-claude", codexExecutable: "fixture-codex",
      uvExecutable: "fixture-uv", ghExecutable: "fixture-gh" }, lineageCommands,
    { report: async (notice) => { notices.push(notice); } });
    assert.equal(lineage.skipped, false);
    assert.equal(lineage.lineageReset, true);
    assert.match(lineage.lineageReason ?? "", /model-policy-changed:/);
    assert.match(lineage.lineageReason ?? "",
      /claudeJudge=claude-haiku-4-5\/claude-opus-5-5/);
    assert.deepEqual(notices, []);
    assert.equal(lineage.regressionReportFile, null);
    assert.equal(resolveLatestEvalBaseline(legacyStore).index.history.length, 1);
    const lineageClaude = lineageCommands.calls.find((call) => call.args.includes("--judge-model"));
    assert.equal(lineageClaude?.args[lineageClaude.args.indexOf("--judge-model") + 1],
      "claude-opus-5-5");
    const pendingFile = join(store, `eval-t2-regression-${sha.slice(0, 12)}.json`);
    const pendingNotice: NightlyRegressionNotice = { baselineSha: sha, currentSha: sha,
      cases: [{ runtime: "claude", case: CASE }], mergedPullRequests: [], directCommits: [],
      expiredQuarantine: [], quarantineOwner: "vibe-maintainers",
      resultsArtifact: "fixture-result.json" };
    writeFileSync(pendingFile, `${JSON.stringify({ schemaVersion: 1, delivery: "pending",
      deliveredAt: null, notice: pendingNotice })}\n`);
    const skippedCommands = new FakeCommands();
    let failedDeliveryAttempts = 0;
    const skipped = await runT2Evals({ repo, pluginSha: sha, runRoot: join(root, "t2-skipped"),
      outputDir: store, claudeExecutable: "fixture-claude",
      codexExecutable: "fixture-codex", uvExecutable: "fixture-uv",
      ghExecutable: "fixture-gh" }, skippedCommands, { report: async () => {
        failedDeliveryAttempts += 1;
        throw new Error("fixture-slack-unavailable");
      } });
    assert.equal(skipped.skipped, true);
    assert.equal(skippedCommands.calls.length, 0);
    assert.equal(failedDeliveryAttempts, 1);
    assert.equal(JSON.parse(readFileSync(pendingFile, "utf8")).delivery, "attempting");
    assert.equal(resolveLatestEvalBaseline(store).artifact.resultHash, acceptedHash);

    const driftStore = join(root, "t2-drift-store");
    await assert.rejects(() => runT2Evals({ repo, pluginSha: sha,
      runRoot: join(root, "t2-drift"), outputDir: driftStore,
      claudeExecutable: "fixture-claude", codexExecutable: "fixture-codex",
      uvExecutable: "fixture-uv", ghExecutable: "fixture-gh" }, new DriftingCommands(repo)),
    /benchmark-plugin-checkout-dirty|eval-t2-main-snapshot-invalid/);
    assert.equal(existsSync(join(driftStore, "eval-t2-latest.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
