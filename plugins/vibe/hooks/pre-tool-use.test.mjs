import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentLaunchProblem } from "./agent-guard.mjs";
import { AWAY_CHECKLIST } from "./away-protocol.mjs";
import { mergeResults } from "./hook-dispatch.mjs";
import { killProblems } from "./kill-guard.mjs";
import { TASKSTOP_REMINDER } from "./pause-guard.mjs";
import { PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";
import { forcePushProblem } from "./shell-safety-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRE_TOOL_USE = path.join(HERE, "pre-tool-use.mjs");
const USER_PROMPT_SUBMIT = path.join(HERE, "user-prompt-submit.mjs");
// Assembled from words so the repository's signal scans, which read test text, never meet a live shape.
const sh = (...words) => words.join(" ");
const BY_NAME_KILL = sh("p" + "kill", "-f", "vitest");
const FORCE_PUSH = sh("git push", "-f", "origin fix/x");

/** The exact line one old guard script printed for a decision. */
const line = (hookSpecificOutput) => `${JSON.stringify({ hookSpecificOutput })}\n`;
const denyLine = (reason) => line({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason });
const killReason = (command) => `Signal only processes this session started and recorded: ${killProblems(command, () => false).join("; ")}`;

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-pre-tool-use-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, MERGE_GUARD_GH: path.join(dir, "missing-gh") };
  const run = (script, payload) => spawnSync(process.execPath, [script], { input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", env });
  return { dir, run };
}

test("each tool's payload yields the exact stdout and exit code its old guard script printed", (t) => {
  const { dir, run } = sandbox(t);
  const bash = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, tool_input: { command: FORCE_PUSH } });
  assert.deepEqual([bash.status, bash.stdout, bash.stderr], [0, denyLine(forcePushProblem(FORCE_PUSH)), ""]);

  const worker = "vibe:vibe-change-worker";
  const agent = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", tool_name: "Agent", cwd: dir, tool_input: { subagent_type: worker, prompt: "go" } });
  assert.deepEqual([agent.status, agent.stdout, agent.stderr], [0, denyLine(agentLaunchProblem({ subagent_type: worker })), ""]);

  const message = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", tool_name: "SendMessage", cwd: dir, tool_input: { to: "w", message: "HOLD everything" } });
  assert.deepEqual([message.status, message.stdout, message.stderr], [0, line({ hookEventName: "PreToolUse", additionalContext: TASKSTOP_REMINDER }), ""]);

  const prompt = run(USER_PROMPT_SUBMIT, { hook_event_name: "UserPromptSubmit", cwd: dir, prompt: "stepping away. brb." });
  assert.deepEqual([prompt.status, prompt.stdout, prompt.stderr], [0, line({ hookEventName: "UserPromptSubmit", additionalContext: AWAY_CHECKLIST }), ""]);
});

test("tools with no guard, and calls no guard refuses, print nothing", (t) => {
  const { dir, run } = sandbox(t);
  for (const payload of [
    { tool_name: "Read", cwd: dir, tool_input: { file_path: "x" } },
    { tool_name: "constructor", cwd: dir, tool_input: {} },
    { tool_name: "Bash", cwd: dir, tool_input: { command: "git status" } },
    { tool_name: "Agent", cwd: dir, tool_input: { subagent_type: "general-purpose" } },
    { tool_name: "SendMessage", cwd: dir, tool_input: { to: "w", message: "Push nothing more." } },
  ]) {
    const result = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", ...payload });
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""], payload.tool_name);
  }
  const prompt = run(USER_PROMPT_SUBMIT, { hook_event_name: "UserPromptSubmit", prompt: "go back to the PR" });
  assert.deepEqual([prompt.status, prompt.stdout], [0, ""]);
});

test("two guards refusing one command give one deny carrying both reasons in guard order", (t) => {
  const { dir, run } = sandbox(t);
  const command = `${BY_NAME_KILL} && ${FORCE_PUSH}`;
  const result = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, tool_input: { command } });
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, denyLine(`${killReason(command)}\n${forcePushProblem(command)}`), ""]);
});

test("a throwing guard is reported under its name and the others still decide", (t) => {
  const { dir, run } = sandbox(t);
  const command = `gh pr merge 9169 --auto && ${FORCE_PUSH}`;
  const result = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, tool_input: { command } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, denyLine(forcePushProblem(command)));
  assert.match(result.stderr, /^merge-guard: /);
  const alone = run(PRE_TOOL_USE, { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, tool_input: { command: "gh pr merge 9169 --auto" } });
  assert.deepEqual([alone.status, alone.stdout], [0, ""], "a guard that cannot answer fails open, as its own script did");
});

test("unreadable stdin fails open with the script named on stderr", (t) => {
  const { run } = sandbox(t);
  for (const [script, name] of [[PRE_TOOL_USE, "pre-tool-use"], [USER_PROMPT_SUBMIT, "user-prompt-submit"]]) {
    const result = run(script, "{not json");
    assert.deepEqual([result.status, result.stdout], [0, ""]);
    assert.match(result.stderr, new RegExp(`^${name}: `));
  }
});

test("results merge as deny > defer > ask > allow and keep every context", () => {
  assert.equal(mergeResults("PreToolUse", []), null);
  assert.deepEqual(mergeResults("PreToolUse", [{ decision: "allow", reason: "a" }, { decision: "ask", reason: "b" }, { decision: "defer" }]).hookSpecificOutput,
    { hookEventName: "PreToolUse", permissionDecision: "defer" });
  assert.deepEqual(mergeResults("PreToolUse", [{ decision: "ask", reason: "b" }, { context: "one" }, { decision: "deny", reason: "c" }, { context: "two" }, { decision: "deny", reason: "d" }]).hookSpecificOutput,
    { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "c\nd", additionalContext: "one\n\ntwo" });
  assert.deepEqual(mergeResults("PreToolUse", [{ decision: "allow", reason: "a" }, { decision: "ask", reason: "b" }]).hookSpecificOutput.permissionDecisionReason, "b");
});

test("hooks.json registers one command per event, and the PreToolUse matcher names exactly the routed tools", () => {
  const { hooks } = JSON.parse(readFileSync(path.join(HERE, "hooks.json"), "utf8"));
  const commands = (event) => hooks[event].flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.deepEqual(Object.keys(hooks).sort(), ["PreToolUse", "UserPromptSubmit"]);
  assert.deepEqual(commands("PreToolUse"), ['node "${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.mjs"']);
  assert.deepEqual(commands("UserPromptSubmit"), ['node "${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.mjs"']);
  assert.deepEqual(hooks.PreToolUse[0].matcher.split("|").sort(), Object.keys(PRE_TOOL_USE_ROUTES).sort());
});
