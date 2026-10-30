import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { codexCaseId, collectClaudeEval, collectCodexEval, finalizeLocalEval } from "./eval-collector.ts";
import type { EvalCaseResult, EvalSuiteResult, LocalEvalResult } from "./eval-collector.ts";
import { buildEvalBaseline, isGreenEvalBaseline, publishEvalBaseline,
  reconcileEvalBaselineQuarantine, requireCurrentEvalQuarantine, resolveEvalBaselineHistory,
  resolveLastGreenEvalBaseline, resolveLatestEvalBaseline, verifyEvalBaseline } from "./eval-baseline.ts";
import { loadEvalQuarantine } from "./eval-baseline.ts";
import type { EvalBaselineArtifact } from "./eval-baseline.ts";
import { EVAL_POLICY, requireDeveloperMachine } from "./eval-policy.ts";
import type { EvalRuntime } from "./eval-policy.ts";
import { evalCaseCatalog, skillFromPrompt } from "./eval-selection.ts";
import type { EvalCommands } from "./eval-driver.ts";
import { codexEvalBudgetSeconds, codexEvalRunnerPath, confirmedNightlyRegressions,
  deliverPendingRegressionReports, evalModelProcessEnv, recoverPendingNightlyPublications,
  requireCleanMainSnapshot, runLocalEvals, runT2Evals,
  stageFocusedClaudeEvalCases } from "./eval-driver.ts";
import { main as runEvalNightly } from "./eval-nightly.ts";
import { formatNightlyRegressionMessage, SlackNightlyRegressionReporter } from "./eval-slack.ts";
import type { NightlyRegressionNotice } from "./eval-slack.ts";
import { requireLatestNightlyBenchmarkBaseline } from "./phase2-driver.ts";

const CASE = "pm-new-session-first-reply";

test("model evals are local-only and use two failure retries", () => {
  assert.equal(EVAL_POLICY.claudeModel, "claude-sonnet-5-5");
  assert.equal(EVAL_POLICY.claudeJudgeModel, "claude-opus-5-5");
  assert.equal(EVAL_POLICY.failureReruns, 2);
  assert.equal(EVAL_POLICY.baselineRuns, 1);
  assert.throws(() => requireDeveloperMachine({ GITHUB_ACTIONS: "true" }), /forbidden-in-ci/);
  assert.doesNotThrow(() => requireDeveloperMachine({ CI: "false" }));
});

test("model processes never inherit nightly Slack credentials", () => {
  const inherited = evalModelProcessEnv({ PATH: "/bin", SLACK_BOT_TOKEN: "secret",
    SLACK_CHANNEL_ID: "C123", GH_TOKEN: "github-secret", RANDOM_SECRET: "secret" });
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

test("T2 accepts only a clean main checkout at fetched origin main", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-main-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  try {
    execFileSync("git", ["init", "--bare", "-q", origin]);
    execFileSync("git", ["clone", "-q", origin, repo]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "switch", "-qc", "main"]);
    writeFileSync(join(repo, "tracked.txt"), "main\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "main"]);
    execFileSync("git", ["-C", repo, "push", "-qu", "origin", "main"]);
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", sha]);
    requireCleanMainSnapshot(repo, sha);
    writeFileSync(join(repo, "tracked.txt"), "dirty\n");
    assert.throws(() => requireCleanMainSnapshot(repo, sha), /main-snapshot-invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test("launchd scheduler keeps T2 behind the local heavy slot", () => {
  const plist = readFileSync(join(import.meta.dirname,
    "../schedule/com.closedloop.vibe-eval-t2.plist.example"), "utf8");
  assert.match(plist, /NIGHTLY_WRAPPER_SCRIPT[\s\S]*PRIVATE_ENV_FILE[\s\S]*HEAVY_SLOT_EXECUTABLE/);
  assert.match(plist, /NODE_EXECUTABLE[\s\S]*VIBE_EVAL_NIGHTLY_SCRIPT[\s\S]*CLEAN_MAIN_CHECKOUT/);
  assert.match(plist, /RUN_ROOT_PARENT[\s\S]*RESULTS_STORE[\s\S]*CLAUDE_EXECUTABLE/);
  assert.match(plist, /CODEX_EXECUTABLE[\s\S]*UV_EXECUTABLE[\s\S]*GH_EXECUTABLE/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>2<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.doesNotMatch(plist, /SLACK_BOT_TOKEN|SLACK_CHANNEL_ID/);
  const wrapper = readFileSync(join(import.meta.dirname, "../schedule/run-nightly.sh"), "utf8");
  assert.match(wrapper, /SLACK_BOT_TOKEN/);
  assert.match(wrapper, /SLACK_CHANNEL_ID/);
  assert.match(wrapper, /exec "\$heavy_slot" vibe-eval-nightly/);
  const script = join(import.meta.dirname, "../schedule/run-nightly.sh");
  const missing = spawnSync(script, ["/missing/private.env", "/heavy", "/node", "/nightly",
    "/repo", "/run-root", "/results", "/claude", "/codex", "/uv", "/gh"],
  { encoding: "utf8" });
  assert.equal(missing.status, 78);
  assert.match(missing.stderr, /credential file is missing/);
  const fixture = mkdtempSync(join(tmpdir(), "vibe-nightly-wrapper-"));
  try {
    const privateEnv = join(fixture, "vibe-eval.env");
    const checkout = join(fixture, "repo");
    mkdirSync(checkout);
    const heavySlot = join(fixture, "heavy-slot.sh");
    const argumentsFile = join(fixture, "arguments.txt");
    const environmentFile = join(fixture, "environment.txt");
    writeFileSync(privateEnv, "SLACK_BOT_TOKEN='test-token'\nSLACK_CHANNEL_ID='C123'\n",
      { mode: 0o600 });
    writeFileSync(heavySlot, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsFile}'\nprintf '%s\\n%s\\n' "$SLACK_BOT_TOKEN" "$SLACK_CHANNEL_ID" > '${environmentFile}'\n`);
    chmodSync(heavySlot, 0o700);
    const dispatched = spawnSync(script, [privateEnv, heavySlot, "/node", "/nightly",
      checkout, "/run-root", "/results", "/claude", "/codex", "/uv", "/gh"],
    { encoding: "utf8" });
    assert.equal(dispatched.status, 0, dispatched.stderr);
    assert.deepEqual(readFileSync(argumentsFile, "utf8").trim().split("\n"), [
      "vibe-eval-nightly", "/node", "--experimental-strip-types", "/nightly", checkout,
      "/run-root", "/results", "/claude", "/codex", "/uv", "/gh",
    ]);
    assert.equal(readFileSync(environmentFile, "utf8"), "test-token\nC123\n");

    chmodSync(privateEnv, 0o644);
    const openMode = spawnSync(script, [privateEnv, heavySlot, "/node", "/nightly",
      checkout, "/run-root", "/results", "/claude", "/codex", "/uv", "/gh"],
    { encoding: "utf8" });
    assert.equal(openMode.status, 78);
    assert.match(openMode.stderr, /mode 0600/);
    chmodSync(privateEnv, 0o600);

    writeFileSync(privateEnv, "SLACK_BOT_TOKEN=test-token\nSLACK_CHANNEL_ID=C123\nEXTRA_COMMAND=bad\n",
      { mode: 0o600 });
    const unsupported = spawnSync(script, [privateEnv, heavySlot, "/node", "/nightly",
      checkout, "/run-root", "/results", "/claude", "/codex", "/uv", "/gh"],
    { encoding: "utf8" });
    assert.equal(unsupported.status, 78);
    assert.match(unsupported.stderr, /unsupported key/);

    const link = join(fixture, "linked.env");
    symlinkSync(privateEnv, link);
    const linked = spawnSync(script, [link, heavySlot, "/node", "/nightly",
      checkout, "/run-root", "/results", "/claude", "/codex", "/uv", "/gh"],
    { encoding: "utf8" });
    assert.equal(linked.status, 78);
    assert.match(linked.stderr, /must not be a symlink/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
  const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");
  assert.match(readme, /Install it only after this change is merged/);
  assert.match(readme, /git clone[\s\S]*pull --ff-only origin main/);
  assert.match(readme, /command -v node[\s\S]*Do not rely on launchd's `PATH`/);
  assert.match(readme, /launchctl bootstrap[\s\S]*launchctl print/);
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

test("historical baselines remain readable while current quarantine expiry fails loudly", () => {
  const catalog = [{ id: "case-a", skill: "vibe" as const, contentHash: "a".repeat(64) }];
  const baseline = buildEvalBaseline({ results: [comparisonEval("a".repeat(40), { "case-a": true })],
    catalog, pluginVersion: "1.2.3", createdAt: "2026-10-29T00:00:00Z" });
  assert.doesNotThrow(() => verifyEvalBaseline(baseline));
  assert.throws(() => requireCurrentEvalQuarantine(new Date("2026-11-14T00:00:00Z")),
    /quarantine-expired/);
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

  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200,
      headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await new SlackNightlyRegressionReporter({ SLACK_BOT_TOKEN: "secret", SLACK_CHANNEL_ID: "C123" },
    send).report(notice);
  assert.equal(requests[0].url, "https://slack.com/api/chat.postMessage");
  assert.match(String(requests[0].init?.headers && JSON.stringify(requests[0].init.headers)),
    /Bearer secret/);
  assert.match(String(requests[0].init?.body), /C123/);
  await new SlackNightlyRegressionReporter({ SLACK_BOT_TOKEN: "secret", SLACK_CHANNEL_ID: "C123" },
    send).report(notice);
  const firstBody = JSON.parse(String(requests[0].init?.body)) as { client_msg_id?: string };
  const secondBody = JSON.parse(String(requests[1].init?.body)) as { client_msg_id?: string };
  assert.match(firstBody.client_msg_id ?? "", /^[a-f0-9-]{36}$/);
  assert.equal(secondBody.client_msg_id, firstBody.client_msg_id);
  assert.ok(requests[0].init?.signal instanceof AbortSignal);
  await assert.rejects(() => new SlackNightlyRegressionReporter({}, send).report(notice),
    /credentials-missing/);
});

test("a failed Slack delivery retries from disk without repeating model work", async () => {
  const store = mkdtempSync(join(tmpdir(), "vibe-eval-slack-pending-"));
  const file = join(store, `eval-t2-regression-${"b".repeat(12)}.json`);
  const notice: NightlyRegressionNotice = {
    baselineSha: "a".repeat(40), currentSha: "b".repeat(40),
    cases: [{ runtime: "claude", case: "vibe-route" }], mergedPullRequests: [],
    quarantineOwner: "vibe-maintainers", resultsArtifact: "eval-t2-result.json",
  };
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, delivery: "pending",
    deliveredAt: null, notice })}\n`);
  try {
    await assert.rejects(() => deliverPendingRegressionReports(store,
      { report: async () => { throw new Error("fixture-slack-unavailable"); } }),
    /fixture-slack-unavailable/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).delivery, "pending");
    const delivered: NightlyRegressionNotice[] = [];
    await deliverPendingRegressionReports(store,
      { report: async (item) => { delivered.push(item); } });
    assert.deepEqual(delivered, [notice]);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).delivery, "sent");
    await deliverPendingRegressionReports(store,
      { report: async (item) => { delivered.push(item); } });
    assert.deepEqual(delivered, [notice]);
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
    const skippedCommands = new FakeCommands();
    const skipped = await runT2Evals({ repo, pluginSha: sha, runRoot: join(root, "t2-skipped"),
      outputDir: store, claudeExecutable: "fixture-claude",
      codexExecutable: "fixture-codex", uvExecutable: "fixture-uv",
      ghExecutable: "fixture-gh" }, skippedCommands);
    assert.equal(skipped.skipped, true);
    assert.equal(skippedCommands.calls.length, 0);
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
