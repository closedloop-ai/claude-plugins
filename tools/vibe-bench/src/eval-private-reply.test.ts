import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EvalRuntimeRecord } from "./eval-collector.ts";
import { evalCaseInputText, failPrivateReplyCases, privateReplyGrader } from "./eval-private-reply.ts";

function record(): EvalRuntimeRecord {
  const cases = [
    { id: "case-a", passed: true, failedGraders: [], skippedGraders: [] },
    { id: "case-b", passed: true, failedGraders: [], skippedGraders: [] },
    { id: "case-c", passed: false, failedGraders: ["route"], skippedGraders: [] },
  ];
  return { runtime: "claude", exitCode: 1, invalidReason: null, result: {
    runtime: "claude", cliVersion: "1", cases, passed: 2, failed: 1, wallMs: 1, agentCostUsd: 0,
    judgeCostUsd: 0, costUsd: 0, tokens: null, nativeHash: "h" } };
}

test("ISS-14116 one private reply fails only its own case and names its category", () => {
  const next = failPrivateReplyCases(record(), [{ caseId: "case-b", category: "absolute-path" }]);
  assert.deepEqual(next.result?.cases.map((item) => [item.id, item.passed]),
    [["case-a", true], ["case-b", false], ["case-c", false]]);
  assert.deepEqual(next.result?.cases[1].failedGraders, [privateReplyGrader("absolute-path")]);
  assert.equal(privateReplyGrader("absolute-path"), "private-reply:absolute-path");
  assert.deepEqual([next.result?.passed, next.result?.failed, next.exitCode], [1, 2, 1]);
  assert.equal(failPrivateReplyCases(record(), []).result?.passed, 2);
});

test("ISS-14116 case input holds the prompt and fixtures but not the graders", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-case-input-"));
  try {
    mkdirSync(join(root, "evals", "pm-x", "graders"), { recursive: true });
    writeFileSync(join(root, "evals", "pm-x", "prompt.md"), "uses /Users/vibe-person/a.png");
    writeFileSync(join(root, "evals", "pm-x", "graders", "g.md"), "grader-only /Users/secret/b");
    const input = evalCaseInputText(root, "pm-x");
    assert.match(input, /vibe-person/);
    assert.doesNotMatch(input, /grader-only/);
    assert.equal(evalCaseInputText(root, "pm-missing"), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
