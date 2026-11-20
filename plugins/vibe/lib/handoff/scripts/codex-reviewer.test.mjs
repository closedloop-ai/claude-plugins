import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureReviewReceipt, reviewReceiptProblems } from "./review-receipts.mjs";
import { acceptManagedReviewer, readCodexReviewTurn, runManagedReviewer } from "./codex-review-runtime.mjs";

/** A deterministic App Server boundary. All session, helper and receipt code runs unchanged. */
function reviewFixture(t, { finalBody = JSON.stringify, markerSeparator = "\n" } = {}) {
  const orchDir = realpathSync(mkdtempSync(path.join(tmpdir(), "managed-review-")));
  t.after(() => rmSync(orchDir, { recursive: true, force: true }));
  const worktree = path.join(orchDir, "worktree");
  mkdirSync(worktree);
  execFileSync("git", ["init", "-q", "-b", "main", worktree]);
  execFileSync("git", ["-C", worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-qm", "base", "--allow-empty"]);
  const role = "vibe-adversarial-reviewer";
  const definitionPath = fileURLToPath(new URL("../../../agents/" + role + ".md", import.meta.url));
  const capabilities = path.join(orchDir, "capabilities.json");
  const brief = path.join(orchDir, "brief.md");
  writeFileSync(brief, "Review the source for regressions.");
  writeFileSync(capabilities, JSON.stringify([{ name: "mcp__test_graph__code_symbols", service: "graph", access: "read", operation: "code_symbols" }]));
  const input = { orchDir, worktree, role, helper: "first-pass", model: "gpt-6.2-astra", capabilities, brief,
    definitionPath };
  const calls = [];
  const threadId = "thread-1";
  const turnId = "turn-1";
  const items = [{ type: "mcpToolCall", server: "test-graph", tool: "code_symbols",
    status: "completed" }];
  let notify;
  const client = {
    onNotification(handler) { notify = handler; return () => {}; },
    onConnection() { return () => {}; },
    close() {},
    async request(method, params) {
      calls.push([method, params]);
      switch (method) {
        case "model/list": return { data: [{ model: "gpt-6.2-astra" }] };
        case "thread/list": return { data: [] };
        case "thread/start":
        case "thread/read": return { thread: { id: threadId, cwd: worktree, turns: [], status: { type: "idle" } } };
        case "turn/start": return { turn: { id: turnId } };
        case "turn/steer": {
          const [fields, marker] = params.input[0].text.split("\nLast line: ");
          const result = { ...JSON.parse(fields.slice("Use these fields: ".length)), observedToolCalls: [], findings: [] };
          const final = { type: "agentMessage", phase: "final_answer",
            text: finalBody(result) + markerSeparator + marker };
          items.push(final);
          notify("item/completed", { threadId, turnId, item: final });
          notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
          return { turnId };
        }
        case "thread/turns/list": return { data: [{ id: turnId, status: "completed" }] };
        case "thread/items/list": return { data: items.map(item => ({ item })) };
        default: throw new Error("Unexpected App Server method " + method);
      }
    },
  };
  const runtimeRead = (threadId, turnId) => readCodexReviewTurn(threadId, turnId, client);
  return { input, calls, client, items, runtimeRead, readHelper: () => JSON.parse(readFileSync(path.join(orchDir, "helpers.json"), "utf8"))[input.helper] };
}

test("AC-1, AC-2, AC-3, AC-6, AC-7: the named read-only managed reviewer yields an independently accepted native receipt", async t => {
  const { input, calls, client, readHelper } = reviewFixture(t);
  const { threadId, report, deliverable } = await runManagedReviewer(input, async () => client);
  assert.equal(threadId, "thread-1");
  const request = method => calls.find(([name]) => name === method)[1];
  assert.equal(request("thread/start").model, "gpt-6.2-astra");
  assert.equal(request("thread/start").cwd, input.worktree);
  assert.equal(request("thread/start").sandbox, "read-only");
  assert.equal(request("turn/start").approvalPolicy, "never");
  assert.deepEqual(request("turn/start").sandboxPolicy, { type: "readOnly" });
  assert.ok(request("turn/start").input[0].text.includes("Adversarially review one implemented session"));
  assert.equal(request("turn/steer").expectedTurnId, "turn-1");
  assert.equal(readHelper().workerId, threadId);
  assert.equal(readHelper().agentDefinition.path, input.definitionPath);
  assert.equal(readHelper().acceptedAt, undefined);
  await assert.rejects(acceptManagedReviewer({ ...input, report: deliverable }), /finalized report/);
  const receipt = await acceptManagedReviewer({ ...input, report }, (thread, turn) => readCodexReviewTurn(thread, turn, client));
  const captured = JSON.parse(readFileSync(receipt.receipt, "utf8"));
  assert.equal(captured.kind, "native-final");
  assert.deepEqual(captured.graphCalls, ["mcp__test_graph__code_symbols"]);
  assert.equal(captured.trace.path, deliverable);
  assert.ok(readHelper().acceptedAt);
  assert.deepEqual(reviewReceiptProblems([captured], captured.source).problems.filter(problem => problem.startsWith(input.role)), []);
});

// The reported checkpoint and FINAL are separate lines after the JSON review.
const terminalCheckpoint = {
  event_id: "cd5d7702-230f-44a1-b101-d9b7657ab951", kind: "checkpoint", status: "completed", terminal: true,
  payload: { verdict: "CHANGES_REQUIRED", blocking_findings: 7, source_frozen: true },
};
const checkpointLine = event => "APP_SERVER_ORCHESTRATOR_EVENT v1 " + JSON.stringify(event);
const withCheckpoint = (result, event = terminalCheckpoint) => JSON.stringify(result, null, 2) + "\n\n" + checkpointLine(event);

test("a managed checkpoint before FINAL passes native capture and handoff verification", async t => {
  const { input, client, runtimeRead, readHelper } = reviewFixture(t, { finalBody: withCheckpoint });
  const { report } = await runManagedReviewer(input, async () => client);
  const accepted = await acceptManagedReviewer({ ...input, report }, runtimeRead);
  assert.ok(readHelper().acceptedAt);
  const saved = JSON.parse(readFileSync(accepted.receipt));
  assert.deepEqual(reviewReceiptProblems([saved], saved.source).problems.filter(problem => problem.startsWith(input.role)), []);
});

test("a leading UTF-8 BOM remains valid during native capture and handoff replay", async t => {
  const { input, client, runtimeRead } = reviewFixture(t, {
    finalBody: result => "\uFEFF" + JSON.stringify(result),
  });
  const { report } = await runManagedReviewer(input, async () => client);
  const accepted = await acceptManagedReviewer({ ...input, report }, runtimeRead);
  const saved = JSON.parse(readFileSync(accepted.receipt));
  assert.deepEqual(reviewReceiptProblems([saved], saved.source).problems.filter(problem => problem.startsWith(input.role)), []);
});

test("a checkpoint and FINAL on the same line fail native receipt capture", async t => {
  const { input, client, runtimeRead } = reviewFixture(t, { finalBody: withCheckpoint, markerSeparator: "" });
  const { report } = await runManagedReviewer(input, async () => client);
  await assert.rejects(acceptManagedReviewer({ ...input, report }, runtimeRead), /exact final line/);
});

test("native receipt rejects trailing text and a checkpoint report missing its owner identity", async t => {
  for (const [finalBody, expected] of [
    [result => JSON.stringify(result) + "\ntrailing output", /Native FINAL requires one JSON review object/],
    [() => withCheckpoint({ verdict: "CHANGES_REQUIRED", disposition: "changes requested", data: {} }), /identity or source differs/],
  ]) {
    const { input, client, runtimeRead } = reviewFixture(t, { finalBody });
    const { report } = await runManagedReviewer(input, async () => client);
    await assert.rejects(acceptManagedReviewer({ ...input, report }, runtimeRead), expected);
  }
});

test("AC-4: a raw codex exec result cannot become a native receipt", async t => {
  const { input } = reviewFixture(t);
  const raw = path.join(input.orchDir, "raw.json");
  writeFileSync(raw, JSON.stringify({ runtime: "codex", agentName: input.role, status: "DONE", sessionId: "raw", requestId: "raw", tracePath: raw }));
  assert.throws(() => captureReviewReceipt({ worktree: input.worktree, role: input.role, resultFile: raw,
    outFile: path.join(input.orchDir, "receipt.json") }), /launcher result needs matching role/);
  await assert.rejects(acceptManagedReviewer({ ...input, report: raw }), /finalized report/);
});

test("AC-1, AC-5, AC-7: the shipped launcher requires the selected model and refuses a writer role", t => {
  const { input } = reviewFixture(t);
  const cli = fileURLToPath(new URL("../../../skills/vibe/scripts/dist/codex-reviewer.mjs", import.meta.url));
  const args = [cli, "run", "--orch-dir", input.orchDir, "--helper", "cli-test", "--role", "vibe-change-worker",
    "--worktree", input.worktree, "--capabilities", input.capabilities, "--brief", input.brief];
  const missing = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing --model/);
  const writer = spawnSync(process.execPath, [...args, "--model", input.model], { encoding: "utf8" });
  assert.equal(writer.status, 1);
  assert.match(writer.stderr, /Unknown native review role: vibe-change-worker/);
  for (const doc of ["../../../skills/handoff/references/handoff-pr.md", "../../../skills/fleet-orchestrator/SKILL.md"]) {
    assert.match(readFileSync(new URL(doc, import.meta.url), "utf8"), /vibe\/scripts\/dist\/codex-reviewer\.mjs/);
  }
});

test("AC-8: helper registration uses the YAML name of a repository critic", t => {
  const { input } = reviewFixture(t);
  const cli = fileURLToPath(new URL("../../fleet-orchestrator/scripts/helpers.mjs", import.meta.url));
  const critic = "visual-qa-critic";
  const cases = [
    [critic, `name: ${critic}`], [critic, `name: "${critic}"`], [critic, `name: '${critic}'`],
    [critic, `{\nname: ${critic}\n}`],
    [critic, `name: ${critic}`, undefined, { opening: "\uFEFF---" }],
    [critic, `name: ${critic}`, undefined, { closing: "--- " }],
    [critic, `name: ${critic}`, undefined, { opening: "---\t" }],
    ["api-architect", "name: api-architect\ndescription: Reviews routes in apps/api: thin routes and service logic."],
    [critic, "name: another-critic", /canonical agent definition does not name the requested role/],
    [critic, `name:  ${critic}\n  assistant\ndescription: Legacy: text.`, /canonical agent definition does not name the requested role/],
    [critic, `name: >- # folded role\n  ${critic}\ndescription: Legacy: text.`],
    [critic, `name: ${critic}\nname: other`, /top-level string name/],
    [critic, `metadata:\n  name: ${critic}`, /top-level string name/],
    [critic, "name: true", /top-level string name/],
  ];
  for (const [index, [role, metadata, refusal, { opening = "---", closing = "---" } = {}]] of cases.entries()) {
    const definition = path.join(input.orchDir, `critic-${index}.md`);
    writeFileSync(definition, `${opening}\n${metadata}\n${closing}\nname: ${role}\n`);
    const result = spawnSync(process.execPath, [cli, input.orchDir, "start", `critic-${index}`, "--kind", "critic",
      "--worktree", input.worktree, "--runtime", "codex", "--worker-id", `critic-thread-${index}`, "--role", role,
      "--agent-definition", definition, "--capabilities", input.capabilities, "--brief", input.brief], { encoding: "utf8" });
    if (refusal) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, refusal);
    } else {
      assert.equal(result.status, 0, result.stderr);
    }
  }
});

test("direct Codex helper registration accepts a readable symlinked brief", t => {
  const { input, readHelper } = reviewFixture(t);
  const link = path.join(input.orchDir, "linked-brief.md");
  symlinkSync(input.brief, link);
  const cli = fileURLToPath(new URL("../../fleet-orchestrator/scripts/helpers.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, input.orchDir, "start", input.helper, "--kind", "reviewer",
    "--worktree", input.worktree, "--runtime", "codex", "--worker-id", "direct-thread", "--role", input.role,
    "--agent-definition", input.definitionPath, "--capabilities", input.capabilities, "--brief", link], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readHelper().brief, link);
});

test("a managed relative brief uses the orchestration directory and binds its symlink target", async t => {
  const { input, client, calls, readHelper } = reviewFixture(t);
  const name = "review-instructions.md";
  const intended = readFileSync(input.brief);
  symlinkSync(input.brief, path.join(input.orchDir, name));
  const decoy = "Instructions from the caller directory.";
  writeFileSync(path.join(input.worktree, name), decoy);
  const previous = process.cwd();
  try {
    process.chdir(input.worktree);
    await runManagedReviewer({ ...input, brief: name }, async () => client);
  } finally {
    process.chdir(previous);
  }
  const prompt = calls.find(([method]) => method === "turn/start")[1].input[0].text;
  assert.ok(prompt.includes(intended.toString("utf8")));
  assert.ok(!prompt.includes(decoy));
  assert.deepEqual(readHelper().briefEvidence, { path: input.brief, sha256: createHash("sha256").update(intended).digest("hex") });
});

test("changed launch inputs stop the registered helper before its review turn", async t => {
  for (const field of ["brief", "capabilities"]) {
    const { input, client, calls, readHelper } = reviewFixture(t);
    await assert.rejects(runManagedReviewer(input, async () => {
      writeFileSync(input[field], field === "brief" ? "Updated instructions" : "[]");
      return client;
    }), /Reviewer inputs changed before registration/);
    assert.ok(readHelper().abandonedAt);
    assert.equal(calls.some(([method]) => method === "turn/start"), false);
  }
});
