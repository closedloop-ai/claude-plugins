import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launchesWorker, launchesWriterAgent, pluginVersionGuard, pluginVersionPromptStart, pluginVersionSkillStart } from "./plugin-version-guard.mjs";
import { readHookSkill, readHookSkillRecord } from "./hook-session-scope.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = "11111111-2222-4333-8444-555555555555";

function home(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-plugin-version-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const recordFile = (dir, session = SESSION) => path.join(dir, ".codex", "vibe", "plugin-version", `${session}.json`);

function record(dir, value, session = SESSION) {
  mkdirSync(path.dirname(recordFile(dir, session)), { recursive: true });
  writeFileSync(recordFile(dir, session), JSON.stringify(value));
}

function loaded(dir) {
  pluginVersionSkillStart({ tool_name: "Skill", session_id: SESSION, tool_input: { skill: "vibe:fleet-orchestrator" } }, dir);
  return readHookSkillRecord(SESSION, dir).loadedSkill;
}

const agent = { tool_name: "Agent", session_id: SESSION, tool_input: { subagent_type: "general-purpose", prompt: "Invoke vibe:vibe first: resume the vibe session for ISS-1 and write the fix." } };
const bash = (command) => ({ tool_name: "Bash", session_id: SESSION, tool_input: { command } });
const OUTDATED = { status: "outdated", versions: "vibe: you have 1.0.84, the latest is 1.0.85" };

test("starting vibe or fleet-orchestrator marks the conversation pending, and worker launches wait for the check", (t) => {
  const dir = home(t);
  assert.equal(pluginVersionSkillStart({ tool_name: "Skill", session_id: SESSION, tool_input: { skill: "vibe:fleet-orchestrator" } }, dir), null);
  assert.equal(readHookSkill(SESSION, dir), "fleet-orchestrator");
  assert.equal(JSON.parse(readFileSync(recordFile(dir), "utf8")).status, "pending");
  for (const event of [agent, bash("node /plugins/vibe/skills/vibe/scripts/dist/claude-worker.mjs < brief.json"), bash("scripts/fleet.sh /h local session turn w1 --prompt-file p.md")]) {
    const result = pluginVersionGuard(event, dir);
    assert.equal(result?.decision, "deny", event.tool_input.command ?? "Agent");
    assert.match(result.reason, /the plugin version check has not run in this conversation/);
    assert.match(result.reason, /plugin-version\.mjs check/);
  }
  assert.equal(pluginVersionGuard(bash("node /plugins/vibe/skills/vibe/scripts/plugin-version.mjs check"), dir), null, "the check itself is never refused");
  assert.equal(pluginVersionGuard(bash("git status"), dir), null);
});

test("the documented Codex $vibe prompt records exact hook scope", (t) => {
  const dir = home(t);
  pluginVersionPromptStart({ session_id: SESSION, prompt: "$vibe build the page" }, dir);
  assert.equal(readHookSkill(SESSION, dir), "vibe");
  assert.equal(JSON.parse(readFileSync(recordFile(dir), "utf8")).status, "pending");
  pluginVersionPromptStart({ session_id: "other", prompt: "show me the $vibe docs" }, dir);
  assert.equal(readHookSkill("other", dir), null);
});

test("an outdated plugin with no choice refuses worker launches; either recorded choice lets them through", (t) => {
  const dir = home(t);
  const loadedSkill = loaded(dir);
  record(dir, { ...OUTDATED, loadedSkill });
  const refused = pluginVersionGuard(agent, dir);
  assert.equal(refused.decision, "deny");
  assert.match(refused.reason, /plugins are outdated \(vibe: you have 1\.0\.84, the latest is 1\.0\.85\) and the person has not chosen/);
  assert.match(refused.reason, /proceeding on an outdated plugin could give worse results/);
  for (const choice of ["proceed", "update"]) {
    record(dir, { ...OUTDATED, choice: { choice }, loadedSkill });
    assert.equal(pluginVersionGuard(agent, dir), null, choice);
  }
  for (const status of ["current", "unknown"]) {
    record(dir, { status, loadedSkill });
    assert.equal(pluginVersionGuard(agent, dir), null, status);
  }
});

test("a current version string without machine-observed actor load evidence fails closed", (t) => {
  const dir = home(t);
  record(dir, { status: "current", runtime: "claude", loadedSkill: { actorId: SESSION, version: "1.1.21" } });
  assert.equal(pluginVersionGuard(agent, dir)?.decision, "deny");
  assert.match(pluginVersionGuard(agent, dir)?.reason ?? "", /machine-observed loaded skill evidence|malformed/);
});

test("a conversation that never started either skill is never refused, and a later start keeps its record", (t) => {
  const dir = home(t);
  assert.equal(pluginVersionGuard(agent, dir), null);
  assert.equal(pluginVersionGuard({ ...agent, session_id: "../../etc" }, dir), null);
  record(dir, { ...OUTDATED, choice: { choice: "proceed" } });
  pluginVersionPromptStart({ session_id: SESSION, prompt: "/vibe:vibe add bulk labels" }, dir);
  assert.equal(JSON.parse(readFileSync(recordFile(dir), "utf8")).choice.choice, "proceed");
  pluginVersionPromptStart({ session_id: "other", prompt: "/vibe:fleet-orchestrator" }, dir);
  assert.equal(JSON.parse(readFileSync(recordFile(dir, "other"), "utf8")).status, "pending");
  pluginVersionPromptStart({ session_id: "third", prompt: "tell me about /vibe:vibe" }, dir);
  pluginVersionSkillStart({ tool_name: "Skill", session_id: "third", tool_input: { skill: "vibe:handoff" } }, dir);
  assert.equal(pluginVersionGuard({ ...agent, session_id: "third" }, dir), null);
});

test("worker launches are recognized by program, not by a mention", () => {
  assert.equal(launchesWorker("cd wt && node dist/claude-worker.mjs"), true);
  assert.equal(launchesWorker("./fleet.sh /home remote session turn w2 --prompt-file p"), true);
  assert.equal(launchesWorker("./fleet.sh /home local session last w2"), false);
  assert.equal(launchesWorker("grep -n claude-worker.mjs SKILL.md"), false);
  assert.equal(launchesWorker(undefined), false);
});

test("the hook scripts route the guard: a Skill start then an Agent call is refused end to end", (t) => {
  const dir = home(t);
  const run = (script, payload) => spawnSync(process.execPath, [path.join(HERE, script)], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, HOME: dir } });
  const start = run("pre-tool-use.mjs", { hook_event_name: "PreToolUse", tool_name: "Skill", session_id: SESSION, tool_input: { skill: "vibe:vibe" } });
  assert.deepEqual([start.status, start.stdout], [0, ""]);
  const refused = run("pre-tool-use.mjs", { hook_event_name: "PreToolUse", ...agent });
  assert.equal(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecision, "deny");
  const prompt = run("user-prompt-submit.mjs", { hook_event_name: "UserPromptSubmit", session_id: "prompted", prompt: "/vibe:fleet-orchestrator one writer, one PR" });
  assert.deepEqual([prompt.status, prompt.stdout], [0, ""]);
  assert.equal(JSON.parse(readFileSync(recordFile(dir, "prompted"), "utf8")).status, "pending");
});

// PR #350 review: every Agent call was refused, so research subagents could not run while the question waited.
test("every Claude dispatch in an active stale session waits for the current loaded release", (t) => {
  const dir = home(t);
  record(dir, { ...OUTDATED, loadedSkill: loaded(dir) });
  const research = { ...agent, tool_input: { subagent_type: "Explore", prompt: "find where the board renders writer rows" } };
  assert.equal(pluginVersionGuard(research, dir)?.decision, "deny");
  const worker = { ...agent, tool_input: { subagent_type: "vibe:vibe-setup-worker", prompt: "install node" } };
  assert.equal(pluginVersionGuard(worker, dir)?.decision, "deny");
  assert.equal(pluginVersionGuard(agent, dir)?.decision, "deny", "a writer brief that invokes vibe:vibe");
  assert.equal(launchesWriterAgent({ subagent_type: "general-purpose", prompt: "review the vibe-sessions code" }), false);
  const send = { tool_name: "SendMessage", session_id: SESSION, cwd: process.cwd(), tool_input: { message: "continue" } };
  assert.equal(pluginVersionGuard(send, dir)?.decision, "deny");
  record(dir, { status: "current", loadedSkill: readHookSkillRecord(SESSION, dir).loadedSkill });
  assert.equal(pluginVersionGuard({ ...send, tool_input: { message: "run handoff/scripts/qa-merge-order.mjs" } }, dir)?.decision, "deny");
  assert.equal(pluginVersionGuard({ ...send, session_id: "ordinary" }, dir), null, "ordinary sessions remain untouched");
});
