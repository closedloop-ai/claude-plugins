// The code plugin registers one script per hook event (pre-tool-use.sh,
// subagent-stop.sh) that runs the handler scripts it used to register
// separately. Each real-payload case runs a handler alone, as its own hooks.json
// command did, and the event script on an identical fixture, and compares them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HOOKS = path.dirname(fileURLToPath(import.meta.url));
const script = (name) => path.join(HOOKS, name);
const SESSION = "s-1";
const AGENT = "agent-1";

function cleanEnv(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CLOSEDLOOP_")));
  return { ...env, HOME: home, CLAUDE_SECURITY_OVERRIDES: path.join(home, "no-overrides.json") };
}

/** A fresh ClosedLoop session fixture: cwd mapped to a workdir, optional self-learning. */
function fixture(t, { selfLearning = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "code-hook-dispatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  const workdir = path.join(root, "work");
  mkdirSync(path.join(cwd, ".closedloop-ai"), { recursive: true });
  mkdirSync(path.join(workdir, ".closedloop-ai"), { recursive: true });
  writeFileSync(path.join(cwd, ".closedloop-ai", `session-${SESSION}.workdir`), workdir);
  writeFileSync(path.join(workdir, ".closedloop-ai", "config.env"), `CLOSEDLOOP_SELF_LEARNING=${selfLearning}\nCLOSEDLOOP_RUN_ID=run-1\n`);
  let calls = 0;
  // stdin is a file: on Linux, node's `input` is a socket, which pre-tool-use-hook.sh cannot open as /dev/stdin.
  const run = (name, payload) => {
    const file = path.join(root, `payload-${(calls += 1)}.json`);
    writeFileSync(file, JSON.stringify(payload));
    const stdin = openSync(file, "r");
    try {
      return spawnSync(script(name), { stdio: [stdin, "pipe", "pipe"], encoding: "utf8", env: cleanEnv(root) });
    } finally {
      closeSync(stdin);
    }
  };
  return { root, cwd, workdir, run };
}

const result = (r) => ({ status: r.status, stdout: r.stdout });

test("PreToolUse: each handler's decision passes through unchanged, and both handlers still run for the tools they ran on", (t) => {
  for (const [toolName, toolInput] of [
    ["Bash", { command: "cat ~/.ssh/id_" + "rsa" }],
    ["Read", { file_path: "/tmp/x/.closedloop-ai/plan.json" }],
    ["Write", { file_path: "src/app.ts" }],
  ]) {
    const old = fixture(t);
    const payload = { hook_event_name: "PreToolUse", session_id: SESSION, cwd: old.cwd, tool_name: toolName, tool_input: toolInput, tool_use_id: "tu-1" };
    const alone = old.run("pretooluse-hook.sh", payload);
    const sentinelAlone = old.run("pre-tool-use-hook.sh", payload);
    const neu = fixture(t);
    const dispatched = neu.run("pre-tool-use.sh", { ...payload, cwd: neu.cwd });
    assert.deepEqual(result(dispatched), { status: 0, stdout: alone.stdout }, toolName);
    assert.deepEqual([alone.status, sentinelAlone.status, sentinelAlone.stdout], [0, 0, ""]);
    const sentinel = (fx) => JSON.parse(readFileSync(path.join(fx.workdir, ".tool-calls", "tu-1"), "utf8"));
    const { started_at: _old, ...oldSentinel } = sentinel(old);
    const { started_at: _new, ...newSentinel } = sentinel(neu);
    assert.deepEqual(newSentinel, oldSentinel, `${toolName} sentinel`);
  }
});

test("PreToolUse: a tool outside the old matcher runs only the sentinel handler", (t) => {
  const old = fixture(t);
  const payload = { hook_event_name: "PreToolUse", session_id: SESSION, cwd: old.cwd, tool_name: "Agent", tool_input: { subagent_type: "code:plan-writer" }, tool_use_id: "tu-2" };
  old.run("pre-tool-use-hook.sh", payload);
  const neu = fixture(t);
  const dispatched = neu.run("pre-tool-use.sh", { ...payload, cwd: neu.cwd });
  assert.deepEqual(result(dispatched), { status: 0, stdout: "" });
  assert.ok(existsSync(path.join(neu.workdir, ".tool-calls", "tu-2")));
  const spawnEvent = (fx) => JSON.parse(readFileSync(path.join(fx.workdir, "perf.jsonl"), "utf8").trim());
  assert.equal(spawnEvent(neu).planned_subagent_type, spawnEvent(old).planned_subagent_type);
  assert.equal(existsSync(path.join(neu.workdir, ".learnings")), false, "the learnings handler did not run for Agent");
});

test("PreToolUse outside a ClosedLoop session: silent unless the security policy refuses", (t) => {
  const fx = fixture(t);
  const quiet = fx.run("pre-tool-use.sh", { hook_event_name: "PreToolUse", session_id: "other", cwd: fx.cwd, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "tu-3" });
  assert.deepEqual(result(quiet), { status: 0, stdout: "" });
  const refused = fx.run("pre-tool-use.sh", { hook_event_name: "PreToolUse", session_id: "other", cwd: fx.cwd, tool_name: "Read", tool_input: { file_path: "/home/u/.aws/credentials" } });
  assert.equal(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecision, "deny");
});

/** A loop agent that ended without its promise, with self-learning on and no acknowledgment. */
function stoppingLoopAgent(t) {
  const fx = fixture(t, { selfLearning: true });
  mkdirSync(path.join(fx.workdir, ".agent-types"), { recursive: true });
  writeFileSync(path.join(fx.workdir, ".agent-types", AGENT), "code:code-reviewer|code-reviewer|2026-10-26T00:00:00Z");
  writeFileSync(path.join(fx.workdir, ".closedloop-ai", "code-reviewer-loop.local.md"), "---\niteration: 0\nmax_iterations: 5\nprd_file: \"prd.md\"\nworkdir: \".\"\n---\nReview the diff again.\n");
  const transcript = path.join(fx.root, "agent.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Done reviewing." }] } })}\n`);
  const payload = { hook_event_name: "SubagentStop", session_id: SESSION, cwd: fx.cwd, agent_id: AGENT, agent_transcript_path: transcript, stop_hook_active: false };
  return { ...fx, payload };
}

test("SubagentStop: both handlers blocking give one block carrying both reasons and messages, loop handler first", (t) => {
  const portable = (fx, stdout) => JSON.parse(stdout.replaceAll(fx.root, "<root>"));
  const loopOnly = stoppingLoopAgent(t);
  const loop = portable(loopOnly, loopOnly.run("loop-stop-hook.sh", loopOnly.payload).stdout);
  const learnOnly = stoppingLoopAgent(t);
  const learn = portable(learnOnly, learnOnly.run("subagent-stop-hook.sh", learnOnly.payload).stdout);
  assert.equal(loop.decision, "block");
  assert.equal(learn.decision, "block");

  const fx = stoppingLoopAgent(t);
  const dispatched = fx.run("subagent-stop.sh", fx.payload);
  assert.equal(dispatched.status, 0);
  assert.deepEqual(portable(fx, dispatched.stdout), {
    decision: "block",
    reason: `${loop.reason}\n\n${learn.reason}`,
    systemMessage: `${loop.systemMessage}\n\n${learn.systemMessage}`,
  });
  assert.equal(existsSync(path.join(fx.workdir, ".agent-types", AGENT)), true, "a blocked stop keeps the agent record for the next stop");
  assert.match(readFileSync(path.join(fx.workdir, ".closedloop-ai", "code-reviewer-loop.local.md"), "utf8"), /^iteration: 1$/m, "the loop handler advanced its iteration");
});

test("SubagentStop: an agent outside the loop prints the stop handler's {} as before", (t) => {
  const fx = fixture(t);
  mkdirSync(path.join(fx.workdir, ".agent-types"), { recursive: true });
  writeFileSync(path.join(fx.workdir, ".agent-types", AGENT), "code:pre-explorer|pre-explorer|2026-10-26T00:00:00Z");
  const payload = { hook_event_name: "SubagentStop", session_id: SESSION, cwd: fx.cwd, agent_id: AGENT };
  assert.deepEqual(result(fx.run("subagent-stop.sh", payload)), { status: 0, stdout: "{}\n" });
  const outside = fixture(t);
  assert.deepEqual(result(outside.run("subagent-stop.sh", { ...payload, session_id: "other", cwd: outside.cwd })), { status: 0, stdout: "" });
});

/** Runs dispatch_hooks over stand-in handlers, each `{ stdout, stderr, status }`. */
function dispatchStandIns(t, handlers) {
  const dir = mkdtempSync(path.join(tmpdir(), "code-hook-standins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = handlers.map(({ stdout = "", stderr = "", status = 0 }, index) => {
    const file = path.join(dir, `h${index}.sh`);
    writeFileSync(path.join(dir, `h${index}.out`), stdout);
    writeFileSync(path.join(dir, `h${index}.err`), stderr);
    writeFileSync(file, `#!/usr/bin/env bash\ncat > /dev/null\ncat "${dir}/h${index}.out"\ncat "${dir}/h${index}.err" >&2\nexit ${status}\n`);
    chmodSync(file, 0o755);
    return file;
  });
  const quoted = files.map((file) => `"${file}"`).join(" ");
  return spawnSync("/bin/bash", ["-c", `source "${script("dispatch.sh")}"; dispatch_hooks '{}' ${quoted}`], { encoding: "utf8" });
}

const pre = (permissionDecision, permissionDecisionReason, extra = {}) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason, ...extra } });

test("dispatch_hooks merges as deny > defer > ask > allow and keeps every reason and context", (t) => {
  const merged = dispatchStandIns(t, [{ stdout: pre("allow", "a") }, { stdout: pre("deny", "d1", { additionalContext: "c1" }) }, { stdout: pre("deny", "d2", { additionalContext: "c2" }) }]);
  assert.equal(merged.status, 0);
  assert.deepEqual(JSON.parse(merged.stdout).hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "d1\nd2", additionalContext: "c1\n\nc2" });
  assert.equal(JSON.parse(dispatchStandIns(t, [{ stdout: pre("allow", "a") }, { stdout: pre("ask", "q") }]).stdout).hookSpecificOutput.permissionDecision, "ask");
  const one = `${pre("allow", "only")}\n`;
  assert.deepEqual(result(dispatchStandIns(t, [{ stdout: one }, { stdout: "{}\n" }, { stdout: "" }])), { status: 0, stdout: one }, "a single contribution passes through byte for byte");
});

test("dispatch_hooks keeps plain text, empty objects and failures as each handler had them", (t) => {
  assert.deepEqual(result(dispatchStandIns(t, [{ stdout: "Loop: Validation passed!\n" }, { stdout: "{}\n" }])), { status: 0, stdout: "Loop: Validation passed!\n" });
  const textAndBlock = dispatchStandIns(t, [{ stdout: "note\n" }, { stdout: '{"decision":"block","reason":"r"}' }]);
  assert.deepEqual([textAndBlock.status, textAndBlock.stdout, textAndBlock.stderr], [0, '{"decision":"block","reason":"r"}', "note\n"]);
  assert.deepEqual(result(dispatchStandIns(t, [{ stdout: "{}\n" }, { stdout: "{}\n" }])), { status: 0, stdout: "{}\n" });

  const blocked = dispatchStandIns(t, [{ stderr: "quiet\n" }, { stderr: "blocked: reason\n", status: 2 }, { stdout: pre("allow", "a") }]);
  assert.deepEqual([blocked.status, blocked.stdout, blocked.stderr], [2, "", "blocked: reason\n"]);

  const failedAlone = dispatchStandIns(t, [{ stderr: "boom\n", status: 1 }, { stdout: "{}\n" }]);
  assert.deepEqual([failedAlone.status, failedAlone.stdout, failedAlone.stderr], [1, "", "boom\n"], "the non-blocking error notice still shows");
  const failedBesideDecision = dispatchStandIns(t, [{ stdout: pre("deny", "ignored"), stderr: "boom\n", status: 1 }, { stdout: pre("deny", "kept") }]);
  assert.deepEqual([failedBesideDecision.status, JSON.parse(failedBesideDecision.stdout).hookSpecificOutput.permissionDecisionReason, failedBesideDecision.stderr], [0, "kept", "boom\n"]);
});

test("hooks.json registers one command per event, PreToolUse and SubagentStop through their event scripts", () => {
  const { hooks } = JSON.parse(readFileSync(path.join(HOOKS, "hooks.json"), "utf8"));
  for (const [event, groups] of Object.entries(hooks)) {
    assert.equal(groups.flatMap((group) => group.hooks).length, 1, event);
  }
  assert.deepEqual(hooks.PreToolUse, [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.sh" }] }]);
  assert.deepEqual(hooks.SubagentStop, [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-stop.sh" }] }]);
});
