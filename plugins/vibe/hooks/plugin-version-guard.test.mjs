import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launchesWorker, launchesWriterAgent, pluginVersionGuard, pluginVersionPromptStart, pluginVersionSkillStart } from "./plugin-version-guard.mjs";
import { readHookSkill, readHookSkillRecord } from "./hook-session-scope.mjs";
import { isolatedVibeEnvironment } from "../../vibe/skills/vibe/scripts/test-fixtures.mjs";

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

// PR #371 review: Codex prompts recorded runtime "claude" and $fleet-orchestrator recorded nothing.
test("Codex skill prompts record hook scope with the runtime read from the hook input", (t) => {
  const dir = home(t);
  const codex = { turn_id: "turn-1", model: "gpt-5.5" };
  pluginVersionPromptStart({ session_id: SESSION, prompt: "$vibe build the page", ...codex }, dir);
  assert.equal(readHookSkill(SESSION, dir), "vibe");
  assert.deepEqual([readHookSkillRecord(SESSION, dir).loadedSkill.runtime, readHookSkillRecord(SESSION, dir).loadedSkill.basis], ["codex", "hook-observed"]);
  // The check keys its record by a conversation id Codex does not document for hooks, so a
  // pending mark could never clear: Codex prompts never mark pending.
  assert.equal(existsSync(recordFile(dir)), false);
  for (const prompt of ["$fleet-orchestrator resume the program", "$vibe:fleet-orchestrator resume"]) {
    pluginVersionPromptStart({ session_id: "fleet", prompt, ...codex }, dir);
    assert.equal(readHookSkill("fleet", dir), "fleet-orchestrator", prompt);
    assert.equal(readHookSkillRecord("fleet", dir).loadedSkill.runtime, "codex", prompt);
  }
  pluginVersionPromptStart({ session_id: "claude", prompt: "/vibe:vibe build the page" }, dir);
  assert.equal(readHookSkillRecord("claude", dir).loadedSkill.runtime, "claude");
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

test("a current version string without valid hook-observed actor load evidence fails closed", (t) => {
  const dir = home(t);
  record(dir, { status: "current", runtime: "claude", loadedSkill: { actorId: SESSION, version: "1.1.21" } });
  assert.equal(pluginVersionGuard(agent, dir)?.decision, "deny");
  assert.match(pluginVersionGuard(agent, dir)?.reason ?? "", /recorded loaded skill evidence|malformed/);
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
  const run = (script, payload) => spawnSync(process.execPath, [path.join(HERE, script)], {
    cwd: dir, input: JSON.stringify({ cwd: dir, ...payload }), encoding: "utf8", env: isolatedVibeEnvironment(dir),
  });
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

// PR #371 review: any Agent or SendMessage naming a repository's own skills/<x>/scripts file was
// refused in every conversation, vibe or not.
test("only vibe or fleet conversations check dispatched script paths, and only vibe plugin paths", (t) => {
  const dir = home(t);
  const repo = path.join(dir, "repo");
  mkdirSync(path.join(repo, ".claude", "skills", "control", "scripts"), { recursive: true });
  writeFileSync(path.join(repo, ".claude", "skills", "control", "scripts", "app.mjs"), "export {};\n");
  const dispatch = (session, text) => [
    { tool_name: "Agent", session_id: session, cwd: repo, tool_input: { subagent_type: "general-purpose", prompt: text } },
    { tool_name: "SendMessage", session_id: session, cwd: repo, tool_input: { to: "writer", message: text } },
  ];
  for (const text of ["Read .claude/skills/control/scripts/app.mjs and summarize", "run vibe/scripts/nonexistent.mjs"]) {
    for (const event of dispatch("ordinary", text)) assert.equal(pluginVersionGuard(event, dir), null, `${event.tool_name}: ${text}`);
  }
  pluginVersionSkillStart({ tool_name: "Skill", session_id: SESSION, tool_input: { skill: "vibe:fleet-orchestrator" } }, dir);
  record(dir, { status: "current", loadedSkill: readHookSkillRecord(SESSION, dir).loadedSkill });
  for (const text of ["Read .claude/skills/control/scripts/app.mjs", "Read skills/control/scripts/app.mjs", "run vibe/scripts/plugin-version.mjs check"]) {
    for (const event of dispatch(SESSION, text)) assert.equal(pluginVersionGuard(event, dir), null, `${event.tool_name}: ${text}`);
  }
  for (const event of dispatch(SESSION, "run vibe/scripts/nonexistent.mjs")) {
    assert.match(pluginVersionGuard(event, dir)?.reason ?? "", /skills\/vibe\/scripts\/nonexistent\.mjs: plugin script does not exist/, event.tool_name);
  }
});

test("vibe-generic's skills, prompts and workers are vibe's to the check", (t) => {
  const dir = home(t);
  pluginVersionSkillStart({ tool_name: "Skill", session_id: SESSION, tool_input: { skill: "vibe-generic:fleet-orchestrator" } }, dir);
  assert.equal(readHookSkill(SESSION, dir), "fleet-orchestrator");
  assert.equal(JSON.parse(readFileSync(recordFile(dir), "utf8")).status, "pending", "a vibe-generic start marks the conversation pending");
  pluginVersionPromptStart({ session_id: "prompt-start", prompt: "/vibe-generic:vibe build the page" }, dir);
  assert.equal(readHookSkill("prompt-start", dir), "vibe");
  assert.equal(JSON.parse(readFileSync(recordFile(dir, "prompt-start"), "utf8")).status, "pending");
  pluginVersionPromptStart({ session_id: "codex-start", prompt: "$vibe-generic:fleet-orchestrator resume", turn_id: "turn-1" }, dir);
  assert.equal(readHookSkill("codex-start", dir), "fleet-orchestrator");
  assert.equal(launchesWriterAgent({ subagent_type: "vibe-generic:vibe-change-worker" }), true);
  assert.equal(launchesWriterAgent({ subagent_type: "general-purpose", prompt: "Invoke vibe-generic:vibe first: resume the session" }), true);
  assert.equal(launchesWriterAgent({ subagent_type: "vibe-core:vibe-change-worker" }), false);
});

test("AC-020 SendMessage resolves repository test paths from a nested worktree cwd", (t) => {
  const dir = home(t);
  const repo = path.join(dir, "repo");
  execFileSync("git", ["init", "-q", repo]);
  const scriptDir = path.join(repo, "plugins", "vibe", "skills", "vibe", "scripts");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(path.join(scriptDir, "queue-regression.test.mjs"), "export {};\n");
  record(dir, { status: "current", loadedSkill: loaded(dir) });
  const send = (message) => pluginVersionGuard({ tool_name: "SendMessage", session_id: SESSION,
    cwd: path.join(repo, "plugins"), tool_input: { to: "writer", message } }, dir);
  for (const reference of ["vibe/scripts/queue-regression.test.mjs", "plugins/vibe/skills/vibe/scripts/queue-regression.test.mjs"]) {
    assert.equal(send(`Read ${reference}:1.`), null, reference);
  }
  assert.match(send("Run vibe/scripts/not-installed.mjs")?.reason ?? "", /skills\/vibe\/scripts\/not-installed\.mjs.*does not exist/);
  const other = path.join(repo, "another", "vibe", "scripts");
  mkdirSync(other, { recursive: true });
  writeFileSync(path.join(other, "queue-regression.test.mjs"), "export {};\n");
  assert.match(send("Run vibe/scripts/queue-regression.test.mjs")?.reason ?? "", /does not exist in installed vibe/);
});

// Operator item 31(b), #433: in a claude-plugins worktree, a brief naming that checkout's own plugins/vibe/...
// script (one the change is adding) was refused as missing from the installed release.
test("a session checkout's own plugin source is a script root; another checkout's is still checked", (t) => {
  const dir = home(t);
  const pluginSource = (checkout) => {
    execFileSync("git", ["init", "-q", checkout]);
    const root = path.join(checkout, "plugins", "vibe");
    mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "0.0.1" }));
    mkdirSync(path.join(root, "skills", "vibe", "scripts"), { recursive: true });
    return root;
  };
  const checkout = path.join(dir, "checkout");
  const own = pluginSource(checkout);
  const other = pluginSource(path.join(dir, "other-checkout"));
  record(dir, { status: "current", loadedSkill: loaded(dir) });
  const send = (message) => pluginVersionGuard({ tool_name: "SendMessage", session_id: SESSION, cwd: checkout,
    tool_input: { to: "writer", message } }, dir);
  for (const reference of ["plugins/vibe/skills/vibe/scripts/branch-new.mjs", path.join(own, "skills", "vibe", "scripts", "branch-new.mjs")]) {
    assert.equal(send(`Add ${reference} and its test.`), null, reference);
  }
  assert.match(send(`Run ${path.join(other, "skills", "vibe", "scripts", "branch-new.mjs")}.`)?.reason ?? "",
    /skills\/vibe\/scripts\/branch-new\.mjs: plugin script does not exist in installed vibe/,
    "a plugin root in a checkout that is not the session's is checked against the installed release");
});
