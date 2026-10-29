import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { BaselineArtifact, BaselineRun } from "./baseline.ts";
import { orchestrateWaves } from "./baseline.ts";
import { finalizeDeveloperBenchmark, instructionWordsAtRef } from "./developer-benchmark.ts";
import type { DeveloperBenchmarkArtifact } from "./developer-benchmark.ts";
import { buildDeveloperReport } from "./developer-report.ts";
import { listOpenPullRequests, preflightSelectedPullRequest, publishBenchmarkSection,
  replaceBenchmarkSection } from "./developer-pr.ts";
import type { DeveloperPrCommands } from "./developer-pr.ts";
import { finalizeLocalEval } from "./eval-collector.ts";
import type { EvalSuiteResult, LocalEvalResult } from "./eval-collector.ts";
import { resultHash } from "./result-schema.ts";

const baselinePath = join(import.meta.dirname,
  "../../../.closedloop-ai/benchmarks/iss-13401/2026-10-29-main-6746cd6c0a49-f7fd8ef6.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineArtifact;
const HEAD = "d".repeat(40);

function candidateRuns(): BaselineRun[] {
  return baseline.runs.slice(0, 6).map((source, index) => {
    const payload = structuredClone(source.result);
    delete (payload as Partial<typeof payload>).resultHash;
    payload.identity.id = `candidate-${index}`;
    payload.identity.pluginSha = HEAD;
    payload.identity.stackSetupMs = 0;
    payload.identity.stackTeardownMs = 0;
    return { ...structuredClone(source), index, prNumber: 900 + index,
      prUrl: `https://github.com/closedloop-ai/symphony-alpha/pull/${900 + index}`,
      proofBaseRef: `benchmark/base-${index}`, proofRef: `benchmark/head-${index}`,
      recordedDigest: "a".repeat(64), result: { ...payload, resultHash: resultHash(payload) } };
  });
}

function developer(): DeveloperBenchmarkArtifact {
  return finalizeDeveloperBenchmark({ selectedPr: { number: 77,
    url: "https://github.com/closedloop-ai/claude-plugins/pull/77",
    branch: "feat/benchmark", headSha: HEAD }, baseline, runs: candidateRuns(),
  setupMs: 120, teardownMs: 30, preflightMs: 5, fullWallMs: 400_000,
  sourceSha: baseline.sourceSha, pluginSha: HEAD, cliVersion: baseline.cliVersion,
  instructionWords: { baseline: 10_000, pr: 10_000 }, createdAt: "2026-10-29T20:00:00.000Z" });
}

function evaluation(pluginSha = HEAD, deterministicOnly = false): LocalEvalResult {
  const suite = (runtime: "claude" | "codex"): EvalSuiteResult => ({ runtime,
    cliVersion: runtime === "claude" ? "2.1.311" : "codex-cli 0.163.0",
    cases: [{ id: "case-a", passed: true, failedGraders: [], skippedGraders: [] }],
    passed: 1, failed: 0, wallMs: 10, costUsd: runtime === "claude" ? 0.1 : null,
    tokens: runtime === "codex" ? { input_tokens: 1 } : null, nativeHash: runtime[0].repeat(64) });
  return finalizeLocalEval({ pluginSha, createdAt: "2026-10-29T20:10:00.000Z", wallMs: 20,
    deterministicOnly, selectedCases: ["case-a"], runtimes: [
      { runtime: "claude", exitCode: 0, result: suite("claude"), invalidReason: null },
      { runtime: "codex", exitCode: 0, result: suite("codex"), invalidReason: null },
    ] });
}

test("three balanced waves reuse one setup and wait for peers before teardown", async () => {
  const events: string[] = [];
  let active = 0;
  let maximum = 0;
  const output = await orchestrateWaves(Array.from({ length: 3 }, () =>
    ["vibe", "fleet-one-writer"] as const), {
    async setup() { events.push("setup"); },
    async run(index, shape) {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      events.push(`${index}:${shape}`);
      return index;
    },
    async teardown() { events.push("teardown"); },
  });
  assert.equal(output.runs.length, 6);
  assert.equal(maximum, 2);
  assert.equal(events[0], "setup");
  assert.equal(events.at(-1), "teardown");
});

test("developer finalizer enforces six proof lifecycles, allocates stack time and hashes comparisons", () => {
  const artifact = developer();
  assert.equal(artifact.runs.length, 6);
  assert.equal(artifact.runs[0].result.identity.stackSetupMs, 20);
  assert.equal(artifact.runs[0].result.identity.stackTeardownMs, 5);
  assert.equal(artifact.comparisons.vibe.prPluginSha, HEAD);
  assert.equal(artifact.comparisons["fleet-one-writer"].prPluginSha, HEAD);
  assert.match(artifact.resultHash, /^[a-f0-9]{64}$/);
  const duplicate = candidateRuns();
  duplicate[1].prNumber = duplicate[0].prNumber;
  assert.throws(() => finalizeDeveloperBenchmark({ selectedPr: { number: 77, url: "u",
    branch: "feat/benchmark", headSha: HEAD }, baseline, runs: duplicate, setupMs: 1,
    teardownMs: 1, preflightMs: 1, fullWallMs: 1, sourceSha: baseline.sourceSha,
    pluginSha: HEAD, cliVersion: baseline.cliVersion, instructionWords: { baseline: 1, pr: 1 },
    createdAt: "2026-10-29T20:00:00.000Z" }), /identity-or-proof-drift/);
});

test("publication report requires exact full dual-runtime eval identity", () => {
  const report = buildDeveloperReport(developer(), evaluation(), ["case-a"]);
  assert.match(report, /^## Benchmark$/m);
  assert.match(report, /^### Component calls$/m);
  assert.match(report, /^### Model-driven evals$/m);
  assert.match(report, /claude: 1\/1 passed/);
  assert.match(report, /codex: 1\/1 passed/);
  assert.throws(() => buildDeveloperReport(developer(), evaluation(HEAD, true), ["case-a"]),
    /eval-not-publishable/);
  assert.throws(() => buildDeveloperReport(developer(), evaluation("e".repeat(40)), ["case-a"]),
    /eval-not-publishable/);
  assert.throws(() => buildDeveloperReport(developer(), evaluation(), ["case-b"]),
    /case-coverage-mismatch/);
});

test("instruction word counts are absolute at each committed ref", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-words-"));
  try {
    mkdirSync(join(root, "plugins/vibe"), { recursive: true });
    writeFileSync(join(root, "plugins/vibe/SKILL.md"), "one two\n");
    execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "-c", "user.name=fixture", "-c",
      "user.email=fixture@invalid.local", "commit", "-m", "one"], { stdio: "ignore" });
    const first = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(root, "plugins/vibe/SKILL.md"), "one two three four\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "-c", "user.name=fixture", "-c",
      "user.email=fixture@invalid.local", "commit", "-m", "two"], { stdio: "ignore" });
    assert.equal(instructionWordsAtRef(root, first), 2);
    assert.equal(instructionWordsAtRef(root, "HEAD"), 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

class FakePrCommands implements DeveloperPrCommands {
  body = "Purpose\n\n## Benchmark\n\nold\n\n## Tests\n\nkept\n";
  head = HEAD;
  calls: string[] = [];
  run(command: string, args: string[]): string {
    this.calls.push(`${command} ${args.join(" ")}`);
    if (command === "git") {
      if (args[0] === "status") return "";
      if (args[0] === "remote") return "git@github.com:closedloop-ai/claude-plugins.git";
      if (args[0] === "branch") return "feat/benchmark";
      if (args[0] === "rev-parse") return this.head;
    }
    if (args[1] === "list") return JSON.stringify([{ number: 77, url: "https://example/77",
      headRefName: "feat/benchmark", headRefOid: this.head, title: "feature" }]);
    if (args[1] === "view" && args.at(-1)?.includes("baseRefName")) return JSON.stringify({
      number: 77, url: "https://example/77", headRefName: "feat/benchmark", headRefOid: this.head,
      state: "OPEN", baseRefName: "main",
    });
    if (args[1] === "view") return JSON.stringify({ body: this.body, headRefOid: this.head });
    if (args[1] === "edit") {
      const file = args[args.indexOf("--body-file") + 1];
      this.body = readFileSync(file, "utf8");
      return "";
    }
    throw new Error(`unexpected:${command}:${args.join(" ")}`);
  }
}

test("PR selection is read-only and publication is head-safe, section-only and idempotent", () => {
  const commands = new FakePrCommands();
  assert.equal(listOpenPullRequests("repo", commands, "gh")[0].number, 77);
  const selected = preflightSelectedPullRequest("repo", 77, commands, "gh");
  const root = mkdtempSync(join(tmpdir(), "vibe-bench-publish-"));
  try {
    const section = join(root, "section.md");
    writeFileSync(section, "## Benchmark\n\nnew result\n");
    publishBenchmarkSection("repo", selected, section, commands, "gh");
    const once = commands.body;
    assert.match(once, /Purpose[\s\S]*new result[\s\S]*## Tests[\s\S]*kept/);
    publishBenchmarkSection("repo", selected, section, commands, "gh");
    assert.equal(commands.body, once);
    assert.equal((commands.body.match(/^## Benchmark$/gm) ?? []).length, 1);
    assert.ok(commands.calls.every((call) => !/comment|add-label|remove-label/.test(call)));
    commands.head = "e".repeat(40);
    assert.throws(() => publishBenchmarkSection("repo", selected, section, commands, "gh"),
      /head-moved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rendered section replacement ignores hidden headings and rejects duplicates", () => {
  const hidden = "<!--\n## Benchmark\n-->\n```md\n## Benchmark\n```\n## Tests\nkept\n";
  const appended = replaceBenchmarkSection(hidden, "## Benchmark\n\nresult\n");
  assert.match(appended, /## Tests\nkept[\s\S]*## Benchmark\n\nresult/);
  assert.throws(() => replaceBenchmarkSection("## Benchmark\na\n## Benchmark\nb\n",
    "## Benchmark\nc\n"), /duplicate/);
  const outside = "Purpose  \n\n## Benchmark\nold\n\n## Tests\nkept  \n\n";
  const replaced = replaceBenchmarkSection(outside, "## Benchmark\nnew\n");
  assert.equal(replaced.slice(0, "Purpose  \n\n".length), "Purpose  \n\n");
  assert.ok(replaced.endsWith("## Tests\nkept  \n\n"));
});

test("canonical Claude skill and thin Codex adapter expose no label or comment mutation", () => {
  const canonical = readFileSync(join(import.meta.dirname, "../../../.claude/skills/vibe-bench/SKILL.md"), "utf8");
  const adapter = readFileSync(join(import.meta.dirname, "../../../.agents/skills/vibe-bench/SKILL.md"), "utf8");
  assert.match(canonical, /^---\nname: vibe-bench\n/);
  assert.match(canonical, /claude-sonnet-5-5` at effort `high/);
  assert.match(canonical, /three paired waves/);
  assert.doesNotMatch(canonical, /gh pr comment|--add-label|--remove-label/);
  assert.match(adapter, /\.claude\/skills\/vibe-bench\/SKILL\.md/);
  assert.ok(adapter.length < canonical.length / 3);
});
