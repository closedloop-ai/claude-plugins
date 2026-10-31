import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sourceIdentity } from "../../vibe/scripts/tested-head.mjs";
import { captureNativeReviewReceipt, captureReviewReceipt, REVIEW_ROLES, reviewReceiptProblems } from "./review-receipts.mjs";
import { finalMarker } from "../../fleet-orchestrator/scripts/helpers.mjs";
import { handoffGateProblem, recordHandoffGate } from "./handoff-gate.mjs";
import { LoadBasis, loadedSkillEvidence } from "../../vibe/scripts/loaded-skill.mjs";

test("review receipts require all launcher roles, completion identity, graph use and current findings", () => {
  const worktree = mkdtempSync(path.join(tmpdir(), "review-receipts-"));
  execFileSync("git", ["init", "-q", "-b", "vibe/example", worktree]);
  writeFileSync(path.join(worktree, "app.txt"), "source\n");
  execFileSync("git", ["-C", worktree, "add", "."]);
  execFileSync("git", ["-C", worktree, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "base"]);
  const source = sourceIdentity(worktree);
  const gitDir = execFileSync("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  const receipts = REVIEW_ROLES.map((role, index) => {
    const sessionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const tracePath = path.join(gitDir, `${role}.jsonl`);
    writeFileSync(tracePath, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__closedloop_graph__code_symbols" }] } })}\n${JSON.stringify({ type: "result", session_id: sessionId })}\n`);
    const resultFile = path.join(gitDir, `${role}-result.json`);
    const output = { runtime: "claude", agentName: role, status: "DONE", sessionId, requestId: `r-${index}`, tracePath, source,
      graphToolAliases: ["mcp__closedloop_graph__code_symbols"], data: { findings: [] } };
    writeFileSync(resultFile, JSON.stringify(output));
    const outFile = path.join(gitDir, `${role}-receipt.json`);
    captureReviewReceipt({ worktree, resultFile, outFile, role });
    return { outFile, resultFile, tracePath, output };
  });
  const saved = () => receipts.map(item => JSON.parse(readFileSync(item.outFile, "utf8")));
  assert.deepEqual(reviewReceiptProblems(saved(), source), { problems: [], findings: [] });
  assert.match(reviewReceiptProblems(saved().map((receipt, index) => index === 1 ? { ...receipt, runtime: "codex" } : receipt), source).problems.join(), /Codex review requires an accepted native FINAL receipt/);
  writeFileSync(receipts[1].resultFile, JSON.stringify({ ...receipts[1].output, runtime: "codex" }));
  assert.throws(() => captureReviewReceipt({ worktree, resultFile: receipts[1].resultFile, outFile: receipts[1].outFile, role: REVIEW_ROLES[1] }), /launcher result needs matching role/, "hand-written Codex launcher JSON cannot reach handoff");
  writeFileSync(receipts[1].resultFile, JSON.stringify(receipts[1].output));
  writeFileSync(receipts[1].tracePath, `${JSON.stringify({ type: "result", session_id: receipts[1].output.sessionId })}\n`);
  writeFileSync(receipts[1].resultFile, JSON.stringify({ ...receipts[1].output, graphToolAliases: [] }));
  captureReviewReceipt({ worktree, resultFile: receipts[1].resultFile, outFile: receipts[1].outFile, role: REVIEW_ROLES[1] });
  assert.deepEqual(reviewReceiptProblems(saved(), source), { problems: [], findings: [] }, "provider-off has no graph-call requirement");
  const verifier = receipts.find(item => item.output.agentName === "vibe-verify-worker");
  writeFileSync(verifier.resultFile, JSON.stringify({ ...verifier.output, data: { findings: [{ id: "V1", blocking: true, evidence: "claimed check failed" }] } }));
  assert.throws(() => captureReviewReceipt({ worktree, resultFile: verifier.resultFile, outFile: verifier.outFile, role: "vibe-verify-worker" }), /list every material premise/);
  writeFileSync(verifier.resultFile, JSON.stringify(verifier.output));
  assert.match(reviewReceiptProblems(saved().slice(1), source).problems.join(), /guardrails.*exactly one/);
  writeFileSync(receipts[0].resultFile, JSON.stringify({ ...receipts[0].output, data: { findings: [{ id: "F1", blocking: true, evidence: "assertion flipped" }] } }));
  assert.throws(() => captureReviewReceipt({ worktree, resultFile: receipts[0].resultFile, outFile: receipts[0].outFile, role: REVIEW_ROLES[0] }), /list every material premise/);
  assert.match(reviewReceiptProblems(saved(), source).problems.join(), /launcher output or trace changed/);
  writeFileSync(receipts[0].resultFile, JSON.stringify(receipts[0].output));
  writeFileSync(receipts[0].tracePath, `${JSON.stringify({ type: "result", session_id: receipts[0].output.sessionId })}\n`);
  assert.throws(() => captureReviewReceipt({ worktree, resultFile: receipts[0].resultFile, outFile: receipts[0].outFile, role: REVIEW_ROLES[0] }), /no graph call/);
  assert.match(reviewReceiptProblems(saved(), source).problems.join(), /trace changed|graph calls missing/);
});

test("Codex native FINAL helper artifacts reach the same four-role handoff gate", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "native-review-gate-"));
  const worktree = path.join(dir, "source");
  const orchDir = path.join(dir, "orch");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(orchDir);
  const pluginRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
  writeFileSync(path.join(orchDir, "plugin-version.json"), JSON.stringify({ status: "current", runtime: "codex", checkedAt: "now",
    loadedSkill: loadedSkillEvidence("native-test", "codex", pluginRoot, "fleet-orchestrator", LoadBasis.HookObserved), harnesses: [] }));
  execFileSync("git", ["init", "-q", "-b", "vibe/example", worktree]);
  writeFileSync(path.join(worktree, "app.txt"), "source\n");
  execFileSync("git", ["-C", worktree, "add", "."]);
  execFileSync("git", ["-C", worktree, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "base"]);
  execFileSync("git", ["-C", worktree, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  const source = sourceIdentity(worktree);
  const capabilities = path.join(orchDir, "capabilities.json");
  writeFileSync(capabilities, JSON.stringify([{ name: "mcp__custom_graph__sync_status", service: "graph", operation: "sync_status", access: "read" }]));
  const helperCli = new URL("../../fleet-orchestrator/scripts/helpers.mjs", import.meta.url).pathname;
  const helper = (...args) => spawnSync(process.execPath, [helperCli, orchDir, ...args], { encoding: "utf8" });
  const receipts = [];
  for (const [index, role] of REVIEW_ROLES.entries()) {
    const workerId = `native-reviewer-${index}`;
    writeFileSync(path.join(orchDir, `brief-${index}.md`), "Review the current source.\n");
    const definition = path.join(orchDir, `${role}-agent.md`);
    writeFileSync(definition, `---\nname: ${role}\n---\n`);
    const started = helper("start", role, "--kind", role === "vibe-verify-worker" ? "verifier" : "reviewer", "--brief", `brief-${index}.md`,
      "--worktree", worktree, "--worker-id", workerId, "--role", role, "--agent-definition", definition, "--capabilities", capabilities);
    assert.equal(started.status, 0, started.stderr);
    if (index === 0) {
      const duplicate = helper("start", "duplicate", "--kind", "reviewer", "--brief", "duplicate.md", "--worktree", worktree,
        "--worker-id", workerId, "--role", role, "--agent-definition", definition, "--capabilities", capabilities);
      assert.notEqual(duplicate.status, 0);
      assert.match(duplicate.stderr, /cannot share a native worker identity/);
    }
    const owner = JSON.parse(readFileSync(path.join(orchDir, "helpers.json"), "utf8"))[role];
    const completion = { sessionId: workerId, turnId: `turn-${index}`, status: "completed" };
    const deliverable = path.join(orchDir, `${role}-final.txt`);
    const payload = { runtime: "codex", role, workerId, source, completion,
      observedToolCalls: ["mcp__custom_graph__sync-status"], findings: [] };
    writeFileSync(deliverable, `${JSON.stringify(payload)}\n${finalMarker(owner, completion)}\n`);
    const report = path.join(orchDir, `${role}-report.json`);
    assert.equal(helper("final", role, "--deliverable", deliverable, "--session-id", completion.sessionId,
      "--turn-id", completion.turnId, "--out", report).status, 0);
    const outFile = path.join(orchDir, `${role}-receipt.json`);
    await assert.rejects(captureNativeReviewReceipt({ worktree, orchDir, helperName: role, outFile, role }), /no accepted owner/, "a turn ending is not helper acceptance");
    assert.equal(helper("accepted", role, "--report", report).status, 0);
    await assert.rejects(captureNativeReviewReceipt({ worktree, orchDir, helperName: role, outFile,
      role: REVIEW_ROLES[(index + 1) % REVIEW_ROLES.length] }), /canonical role/);
    const actualTurn = async () => ({ sessionId: workerId, turnId: completion.turnId, status: "completed",
      toolCalls: ["mcp__custom_graph__sync-status"] });
    await assert.rejects(captureNativeReviewReceipt({ worktree, orchDir, helperName: role, outFile, role },
      async () => ({ sessionId: workerId, turnId: completion.turnId, status: "completed", toolCalls: [] })),
    /no observed tool call/, "a helper's claimed call cannot replace App Server items");
    await captureNativeReviewReceipt({ worktree, orchDir, helperName: role, outFile, role }, actualTurn);
    receipts.push(outFile);
  }
  assert.deepEqual(reviewReceiptProblems(receipts.map(file => JSON.parse(readFileSync(file, "utf8"))), source), { problems: [], findings: [] });
  const body = path.join(orchDir, "body.md");
  const runs = path.join(orchDir, "runs.json");
  writeFileSync(body, "PR body\n");
  writeFileSync(runs, "{}\n");
  recordHandoffGate({ worktree, base: "main", body, runs, receipts }, { runScript: () => ({ status: 0,
    stdout: JSON.stringify({ ok: true, blocking: { prBody: true, prEvidence: true } }), stderr: "" }) });
  assert.equal(handoffGateProblem(worktree, { base: "main", bodyFile: body }), null);
  const changed = JSON.parse(readFileSync(receipts[0], "utf8"));
  writeFileSync(changed.trace.path, "changed after native receipt\n");
  assert.match(handoffGateProblem(worktree, { base: "main", bodyFile: body }) ?? "", /review|evidence/);
});
