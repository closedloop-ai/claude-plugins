import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectClaudeEval, collectCodexEval, finalizeLocalEval } from "./eval-collector.ts";
import type { EvalCaseResult, EvalSuiteResult, LocalEvalResult } from "./eval-collector.ts";
import { compareLocalEvals, verifyEvalComparisonHash } from "./eval-comparison.ts";
import type { EvalCommands } from "./eval-driver.ts";
import { codexEvalBudgetSeconds, runLocalEvals } from "./eval-driver.ts";

const CASE = "pm-new-session-first-reply";

function comparisonEval(sha: string, states: Record<string, boolean>): LocalEvalResult {
  const ids = Object.keys(states).sort();
  const runtime = (name: "claude" | "codex"): EvalSuiteResult => {
    const cases: EvalCaseResult[] = ids.map((id) => ({ id, passed: states[id],
      failedGraders: states[id] ? [] : [`${name}-route`], skippedGraders: [] }));
    const passed = cases.filter((item) => item.passed).length;
    return { runtime: name, cliVersion: name === "claude" ? "2.1.311" : "codex-cli 0.163.0",
      cases, passed, failed: cases.length - passed, wallMs: 10, costUsd: name === "claude" ? 0.1 : null,
      tokens: name === "codex" ? { input_tokens: 1 } : null, nativeHash: name[0].repeat(64) };
  };
  return finalizeLocalEval({ pluginSha: sha, createdAt: "2026-10-29T00:00:00Z", wallMs: 20,
    deterministicOnly: false, selectedCases: ids, runtimes: [
      { runtime: "claude", exitCode: ids.some((id) => !states[id]) ? 1 : 0,
        result: runtime("claude"), invalidReason: null },
      { runtime: "codex", exitCode: ids.some((id) => !states[id]) ? 1 : 0,
        result: runtime("codex"), invalidReason: null },
    ] });
}

test("eval comparison separates regressions from main failures and requires a current-head rerun", () => {
  const main = comparisonEval("a".repeat(40), { "control-case": true, "pre-existing": false,
    "regressed-case": true });
  const candidate = comparisonEval("b".repeat(40), { "control-case": true, "pre-existing": false,
    "regressed-case": false });
  const rerun = comparisonEval("c".repeat(40), { "control-case": true, "regressed-case": true });
  const comparison = compareLocalEvals(main, candidate, rerun, ["control-case"]);
  assert.equal(comparison.success, true);
  assert.deepEqual(comparison.regressions.map((item) => `${item.runtime}:${item.id}`),
    ["claude:regressed-case", "codex:regressed-case"]);
  assert.deepEqual(comparison.preExisting.map((item) => `${item.runtime}:${item.id}`),
    ["claude:pre-existing", "codex:pre-existing"]);
  assert.deepEqual(comparison.rerunCases, ["control-case", "regressed-case"]);
  verifyEvalComparisonHash(comparison);
  assert.throws(() => compareLocalEvals(main, candidate,
    comparisonEval("c".repeat(40), { "control-case": true }), ["control-case"]), /rerun-coverage/);
  assert.throws(() => compareLocalEvals(main, main,
    comparisonEval("c".repeat(40), { "control-case": true, "pre-existing": true,
      "regressed-case": true }), ["control-case"]), /identity/);
});

test("serial Codex eval budget scales with the full corpus", () => {
  assert.equal(codexEvalBudgetSeconds(1), 1800);
  assert.equal(codexEvalBudgetSeconds(105), 9450);
});

function claudeNative(vibePath = "/snapshot/vibe", corePath = "/snapshot/core", passed = true) {
  return {
    schemaVersion: 1, claudeVersion: "2.1.311", durationSeconds: 12, costUsd: 0.1,
    partial: false, suite: { ablation: "none", modelOverride: "sonnet", plugins: [
      { name: "vibe", version: "1.2.3", path: vibePath },
      { name: "closedloop-core", version: "1.5.3", path: corePath },
    ] }, cases: [{ name: CASE, runsPerCase: 1, arms: { with: [{ passed, error: null,
      skippedPaidGraders: false, graders: [{ name: "route", passed, scored: true }] }] } }],
    aggregates: { casesTotal: 1, casesPassed: passed ? 1 : 0 },
  };
}

function codexNative(vibePath = "/snapshot/vibe", passed = true, deterministicOnly = true,
  skipWording = false) {
  return { run: { source_sha: "a".repeat(40), skill_sha256: "b".repeat(64), version: "1.2.3",
    cli_version: "codex-cli 0.163.0", plugin: vibePath, deterministic_only: deterministicOnly,
    model: "gpt-6-sol", grader_model: "gpt-6-luna", elapsed_seconds: 10,
    usage: { input_tokens: 12 } }, cases: [{ case: "product-manager-new-session-first-reply",
      passed, checks: [{ grader: "route", passed }], skipped_graders: deterministicOnly && skipWording ?
        [{ grader: "plain-language", reason: "deterministic-only" }] : [] }] };
}

test("native collectors preserve a wrong route as red on both runtimes", () => {
  const claude = collectClaudeEval(claudeNative(undefined, undefined, false), [CASE], {
    version: "1.2.3", coreVersion: "1.5.3", cliVersion: "2.1.311",
    vibePath: "/snapshot/vibe", corePath: "/snapshot/core",
  });
  const codex = collectCodexEval(codexNative(undefined, false), [CASE], {
    sourceSha: "a".repeat(40), skillSha: "b".repeat(64), version: "1.2.3",
    cliVersion: "codex-cli 0.163.0", vibePath: "/snapshot/vibe", deterministicOnly: true,
    model: "gpt-6-sol", graderModel: "gpt-6-luna", wordingCases: [],
  });
  assert.deepEqual(claude.cases[0].failedGraders, ["route"]);
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
    vibePath: "/snapshot/vibe", corePath: "/snapshot/core",
  }), /partial-or-schema/);
  const duplicate = claudeNative();
  duplicate.cases.push(duplicate.cases[0]);
  assert.throws(() => collectClaudeEval(duplicate, [CASE], {
    version: "1.2.3", coreVersion: "1.5.3", cliVersion: "2.1.311",
    vibePath: "/snapshot/vibe", corePath: "/snapshot/core",
  }), /coverage-mismatch/);
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
  calls: Array<{ command: string; args: string[] }> = [];
  run(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
    this.calls.push({ command, args });
    if (args.length === 1 && args[0] === "--version") {
      return { status: 0, stdout: command.includes("claude") ?
        "2.1.311 (Claude Code)\n" : "codex-cli 0.163.0\n", stderr: "" };
    }
    if (command.includes("claude")) {
      const vibePath = args.includes("--eval-dir") ? join(args[2], "vibe") : args[2];
      const resultFile = args[args.indexOf("--json") + 1];
      writeFileSync(resultFile, JSON.stringify(claudeNative(vibePath, join(dirname(vibePath),
        "closedloop-core"))));
      return { status: 0, stdout: "", stderr: "" };
    }
    const vibePath = args[args.indexOf("--plugin") + 1];
    const output = args[args.indexOf("--output") + 1];
    mkdirSync(output, { recursive: true });
    const sourceSha = args[args.indexOf("--source-sha") + 1];
    const skillSha = createHash("sha256").update(
      readFileSync(join(vibePath, "skills/vibe/SKILL.md"))).digest("hex");
    const native = codexNative(vibePath);
    native.run.source_sha = sourceSha;
    native.run.skill_sha256 = skillSha;
    writeFileSync(join(output, "results.json"), JSON.stringify(native));
    return { status: 0, stdout: "", stderr: "" };
  }
}

test("local driver snapshots one committed tree and writes one immutable dual-runtime result", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-driver-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "plugins/vibe/.claude-plugin"), { recursive: true });
    mkdirSync(join(repo, "plugins/vibe/agents"), { recursive: true });
    mkdirSync(join(repo, "plugins/vibe/skills/vibe"), { recursive: true });
    mkdirSync(join(repo, `plugins/vibe/evals/${CASE}`), { recursive: true });
    mkdirSync(join(repo, "plugins/vibe/evals/codex"), { recursive: true });
    mkdirSync(join(repo, "plugins/closedloop-core/.claude-plugin"), { recursive: true });
    writeFileSync(join(repo, "plugins/vibe/.claude-plugin/plugin.json"), JSON.stringify({
      name: "vibe", version: "1.2.3", dependencies: ["closedloop-core"],
    }));
    writeFileSync(join(repo, "plugins/closedloop-core/.claude-plugin/plugin.json"), JSON.stringify({
      name: "closedloop-core", version: "1.5.3",
    }));
    writeFileSync(join(repo, "plugins/vibe/agents/vibe-change-worker.md"),
      "---\nname: vibe-change-worker\nmodel: sonnet\n---\n");
    writeFileSync(join(repo, "plugins/vibe/skills/vibe/SKILL.md"), "fixture skill\n");
    writeFileSync(join(repo, `plugins/vibe/evals/${CASE}/prompt.md`), "---\ntags: []\n---\nfixture\n");
    writeFileSync(join(repo, "plugins/vibe/evals/codex/run.py"), "# fixture\n");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c",
      "user.email=fixture@invalid.local", "commit", "-m", "fixture"], { stdio: "ignore" });
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const commands = new FakeCommands();
    const output = runLocalEvals({ repo, pluginSha: sha, runRoot: join(root, "run"),
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
    assert.ok(modelCalls.every((call) => call.args[call.args.indexOf("--concurrency") + 1] === "1"));
    const claudeCall = modelCalls.find((call) => call.command.includes("claude"))!;
    assert.equal(claudeCall.args[2].endsWith("/plugin-snapshot/plugins"), true);
    assert.equal(claudeCall.args[2], realpathSync(claudeCall.args[2]));
    assert.equal(claudeCall.args[claudeCall.args.indexOf("--eval-dir") + 1], "vibe/evals");
    assert.equal(claudeCall.args.includes("--case"), false);
    const codexCall = modelCalls.find((call) => call.command.includes("uv"))!;
    assert.deepEqual(codexCall.args.slice(0, 6),
      ["run", "--with", "Pillow==12.3.0", "--with", "PyYAML", "python"]);
    assert.throws(() => runLocalEvals({ repo, pluginSha: sha, runRoot: join(root, "run"),
      outputDir: join(root, "results"), claudeExecutable: "fixture-claude",
      codexExecutable: "fixture-codex", uvExecutable: "fixture-uv" }, commands),
    /run-root-exists/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
