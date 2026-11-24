import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildEvalBaseline } from "./eval-baseline.ts";
import { collectClaudeEval, finalizeLocalEval } from "./eval-collector.ts";
import { SystemNightlyCommands } from "./eval-nightly.ts";
import { retainedClaudeFailureEvidenceLine } from "./eval-nightly-diagnostics.ts";
import { isRetrySafeSlackFailure, SlackNightlyRegressionReporter } from "./eval-slack.ts";
import type { SlackClaudeResult } from "./eval-slack.ts";
import { formatNightlyTaskSummary, nightlyTaskSummary } from "./nightly-summary.ts";

const expected = { version: "1.1.103", coreVersion: "1.6.3", cliVersion: "2.1.328",
  vibePath: "/fixture/vibe", corePath: "/fixture/core" };
const evidencePrefix = "VIBE_NIGHTLY_CLAUDE_FAILURE_EVIDENCE ";
const partial = "eval-claude-partial:auth_failed";
const reason = "eval-baseline-runtime-incomplete:claude:" + partial;
const infra = "VIBE_NIGHTLY_INFRA_FAILURE " + reason;
const slackFailure = "VIBE_NIGHTLY_SLACK_FAILURE eval-slack-claude-auth-unavailable";

test("AC-086 emits the exact schema sentinel before applying partial-run semantics", () => {
  assert.throws(() => collectClaudeEval({ schemaVersion: 2, partial: true, partialReason: "auth_failed" }, [], expected),
    { message: "eval-claude-schema:2" });
  assert.throws(() => collectClaudeEval({ schemaVersion: "tainted\nsecret", partial: false }, [], expected),
    { message: "eval-claude-schema:unknown" });
});

test("AC-086 reports a partial reason without publishing malformed native input", () => {
  for (const partialReason of ["auth_failed", "cost_ceiling", "interrupted"]) {
    assert.throws(() => collectClaudeEval({ schemaVersion: 1, partial: true, partialReason }, [], expected),
      { message: "eval-claude-partial:" + partialReason });
  }
  for (const partialReason of [undefined, 7, "private\nfixture"]) {
    assert.throws(() => collectClaudeEval({ schemaVersion: 1, partial: true, partialReason }, [], expected),
      { message: "eval-claude-partial:unknown" });
  }
  assert.throws(() => collectClaudeEval({ schemaVersion: 1, partial: "false" }, [], expected),
    { message: "eval-claude-schema:1" });
});

test("AC-086 preserves auth_failed through baseline and the real failed scheduler child", async () => {
  const catalog = [{ id: "fixture", skill: "vibe" as const, contentHash: "a".repeat(64) }];
  const initial = finalizeLocalEval({ pluginSha: "a".repeat(40), createdAt: "2026-11-20T00:00:00Z",
    wallMs: 1, deterministicOnly: false, selectedCases: ["fixture"],
    runtimes: [{ runtime: "claude", exitCode: 2, result: null, invalidReason: partial },
      { runtime: "codex", exitCode: 1, result: null, invalidReason: "eval-codex-artifact-invalid" }] });
  assert.throws(() => buildEvalBaseline({ results: [initial], catalog, pluginVersion: expected.version }),
    { message: reason });
  const forwarded: string[] = [];
  const commands = new SystemNightlyCommands((line) => forwarded.push(line));
  const child = "process.stderr.write(" + JSON.stringify("Error: " + reason + "\n") + ");process.exitCode=1;";
  await assert.rejects(() => commands.node(["-e", child]), { message: reason });
  assert.deepEqual(forwarded, []);
});

test("AC-086 failed summary keeps exactly the owning evidence pair and both failure diagnostics", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "vibe-nightly-failure-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = join(root, "run 1");
  mkdirSync(join(run, "claude"), { recursive: true });
  const evidence = { claudeResultPath: join(run, "claude", "result.json"), claudeProcessLogPath: join(run, "claude-process.log") };
  assert.equal(retainedClaudeFailureEvidenceLine(run), null);
  for (const file of Object.values(evidence)) writeFileSync(file, "{}");
  const log = join(root, "schedule.log");
  const record = evidencePrefix + JSON.stringify(evidence);
  assert.equal(retainedClaudeFailureEvidenceLine(run), record);
  const malformed = evidencePrefix + JSON.stringify({ ...evidence, claudeProcessLogPath: "/wrong/claude-process.log" });
  const extra = evidencePrefix + JSON.stringify({ ...evidence, unintended: "private fixture information" });
  const forwarded: string[] = [];
  const child = "process.stdout.write(" + JSON.stringify([record, malformed, extra, "noise\n"].join("\n")) +
    ");process.stderr.write(" + JSON.stringify("Error: " + reason + "\n") + ");process.exitCode=1;";
  await assert.rejects(() => new SystemNightlyCommands((line) => forwarded.push(line)).node(["-e", child]), { message: reason });
  assert.deepEqual(forwarded, [record + "\n"]);
  const summary = nightlyTaskSummary(1, forwarded.join("") + infra + "\n" + slackFailure + "\n", log);
  const line = formatNightlyTaskSummary(summary);
  const parsed = JSON.parse(line.slice("VIBE_NIGHTLY_SUMMARY ".length));
  assert.equal(parsed.failure, infra);
  assert.equal(parsed.slackFailure, slackFailure);
  assert.deepEqual(parsed.claudeFailureEvidence, [evidence]);
  assert.equal(nightlyTaskSummary(1, malformed + "\n" + infra, log).claudeFailureEvidence, undefined);
  assert.equal(nightlyTaskSummary(0, "SKIPPED " + log + "\n" + record, log).claudeFailureEvidence, undefined);
});

function relay(result: SlackClaudeResult): SlackNightlyRegressionReporter {
  return new SlackNightlyRegressionReporter("/inert-fixture", (_command, args) => {
    if (args[0] === "plugin") return { status: 0, stderr: "",
      stdout: JSON.stringify([{ id: "slack@anthropic-plugin-directory", enabled: true, installPath: "/fixture/slack" }]) };
    if (args.includes("mcp")) return { status: 0, stderr: "", stdout: "plugin:slack:slack - ✔ Connected\n" };
    return result;
  });
}

const cases: Array<[string, SlackClaudeResult, string]> = [
  ["auth", { status: 1, stdout: "", stderr: "Not logged in · Please run /login" }, "eval-slack-claude-auth-unavailable"],
  ["usage", { status: 1, stdout: '{"type":"result","result":"You have reached your usage limit"}', stderr: "" }, "eval-slack-claude-usage-limit"],
  ["timeout", { status: null, stdout: "", stderr: "", error: new Error("spawnSync timeout ETIMEDOUT") }, "eval-slack-claude-timeout"],
  ["unknown error", { status: 17, stdout: "", stderr: "fixture private process message" }, "eval-slack-claude-failed"],
  ["successful process without a hook", { status: 0, stdout: "", stderr: "" }, "eval-slack-gate-not-confirmed"],
];

for (const [kind, result, code] of cases) {
  test("AC-087 classifies " + kind + " before interpreting an absent gate", async () => {
    await assert.rejects(() => relay(result).reportApprovedTest(), (error: unknown) => {
      assert.equal((error as Error).message, code);
      assert.equal(isRetrySafeSlackFailure(error), false);
      return true;
    });
  });
}
