import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentGuard, agentLaunchProblem, writerBindingProblem } from "./agent-guard.mjs";
import { PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";
import { vibeRoot } from "../shared/vibe-install.mjs";
import { activatedChat } from "./activation-test-support.mjs";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-tool-use.mjs");

test("an orchestrator cannot launch a vibe worker directly outside a vibe session", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-agent-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const chat = activatedChat(t);
  const run = (subagentType, cwd = dir) => spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(chat.payload({ tool_name: "Agent", cwd, tool_input: { subagent_type: subagentType, prompt: "Implement the ticket" } })),
    encoding: "utf8", env: chat.env,
  });

  assert.match(agentLaunchProblem({ subagent_type: "vibe:vibe-change-worker" }), /invoke `vibe:vibe`/);
  const denied = JSON.parse(run("vibe:vibe-change-worker").stdout).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /session record, environment setup, guardrails and adversarial review, PR preflight and SendMessage path/);
  assert.equal(run("general-purpose").stdout, "", "a Claude agent may invoke the vibe skill");

  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  const gitDir = execFileSync("git", ["-C", dir, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(gitDir, "vibe-session.json"), "{}\n");
  assert.equal(JSON.parse(run("vibe:vibe-change-worker", dir).stdout).hookSpecificOutput.permissionDecision, "deny", "the skill also uses the capability-binding launcher inside a session");
  for (const role of ["guardrails-reviewer", "adversarial-reviewer", "storybook-decomposer"]) {
    const name = `vibe:vibe-${role}`;
    assert.match(agentLaunchProblem({ subagent_type: name }), /capability-binding worker launcher/);
    assert.equal(JSON.parse(run(name, dir).stdout).hookSpecificOutput.permissionDecision, "deny", `${name} needs bound graph tools even inside a session`);
  }
  assert.ok(PRE_TOOL_USE_ROUTES.Agent.some((guard) => guard.run === agentGuard), "the Agent guard is routed");
});

const WRITER_REFUSAL = "do not launch vibe:vibe-change-worker through the native Agent tool: invoke `vibe:vibe` and use its capability-binding worker launcher so the writer gets its session record, environment setup, guardrails and adversarial review, PR preflight and SendMessage path";
const PLUGIN_ROOT = vibeRoot();
const LAUNCHER = path.join(PLUGIN_ROOT, "skills/vibe/scripts/dist/claude-worker.mjs");

test("a startup role's refusal names the shipped sessionless launcher route, not a vibe session", () => {
  assert.ok(existsSync(LAUNCHER), "the named launcher ships in this plugin");
  for (const role of ["requirements-worker", "setup-worker"]) {
    const problem = agentLaunchProblem({ subagent_type: `vibe:vibe-${role}` });
    assert.ok(problem.includes(`node ${LAUNCHER}`), problem);
    assert.ok(problem.includes(`"agentName": "vibe-${role}"`), problem);
    assert.ok(problem.includes(`"sessionless": {"kind": "startup"}`), problem);
    assert.ok(problem.includes(`"mode": "request"`), problem);
    assert.doesNotMatch(problem, /invoke `vibe:vibe`|session record/, "a startup role needs no vibe session");
  }
});

test("the writer refusal is unchanged and never offers a sessionless route", () => {
  assert.equal(agentLaunchProblem({ subagent_type: "vibe:vibe-change-worker" }), WRITER_REFUSAL);
  for (const role of ["change-worker", "environment-worker", "ticket-worker", "prototype-worker"]) {
    assert.doesNotMatch(agentLaunchProblem({ subagent_type: `vibe:vibe-${role}` }), /sessionless|takeover/);
  }
});

test("a takeover reviewer's refusal names the takeover launch and its head-bound receipt", () => {
  for (const role of ["adversarial-reviewer", "guardrails-reviewer"]) {
    const problem = agentLaunchProblem({ subagent_type: `vibe:vibe-${role}` });
    assert.match(problem, /capability-binding worker launcher so available graph tools reach the reviewer/);
    assert.ok(problem.includes(`node ${LAUNCHER}`), problem);
    assert.ok(problem.includes(`"sessionless": {"kind": "takeover", "evidence": {"prUrl": "<PR URL>", "headSha": "<full head SHA>"}}`), problem);
    assert.ok(problem.includes(`"mode": "pull-request"`), problem);
    assert.ok(problem.includes(`${path.join(PLUGIN_ROOT, "skills/handoff/scripts/review-receipts.mjs")} --worktree`), problem);
    assert.match(problem, /--role vibe-.+ --pr-url <PR URL> --head <full head SHA>/);
  }
  assert.ok(existsSync(path.join(PLUGIN_ROOT, "skills/handoff/scripts/review-receipts.mjs")));
  assert.doesNotMatch(agentLaunchProblem({ subagent_type: "vibe:vibe-storybook-decomposer" }), /takeover/);
});

test("a seed-refresh worker's refusal says seed refresh runs in Codex", (t) => {
  const chat = activatedChat(t);
  for (const role of ["seed-check-worker", "seed-fix-worker", "seed-pr-worker"]) {
    assert.ok(existsSync(path.join(PLUGIN_ROOT, "agents", `vibe-${role}.md`)), role);
    assert.equal(agentLaunchProblem({ subagent_type: `vibe:vibe-${role}` }),
      `do not launch vibe:vibe-${role} in Claude Code: vibe seed refresh runs in Codex (\`$vibe-seed-refresh\`), which dispatches its own seed workers; it has no Claude Code worker path`);
    const denied = JSON.parse(spawnSync(process.execPath, [GUARD], { encoding: "utf8", env: chat.env,
      input: JSON.stringify(chat.payload({ tool_name: "Agent", tool_input: { subagent_type: `vibe:vibe-${role}`, prompt: "Check the seed" } })) }).stdout).hookSpecificOutput;
    assert.equal(denied.permissionDecision, "deny");
    assert.match(denied.permissionDecisionReason, /runs in Codex/);
  }
});

test("the seed-refresh skill claims no Claude Code worker path", () => {
  const skill = readFileSync(path.join(PLUGIN_ROOT, "skills/vibe-seed-refresh/SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /in Claude Code use `vibe:<name>`|--runtime claude/);
  assert.match(skill, /Seed refresh has no Claude Code worker path/);
});

test("a Claude writer started through the Agent tool works under the starting chat's binding, and another binding is refused", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vibe-agent-binding-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const records = path.join(home, ".codex", "vibe", "plugin-version");
  mkdirSync(records, { recursive: true });
  writeFileSync(path.join(records, "lead-chat.json"), JSON.stringify({ conversation: "lead-chat", status: "current",
    provider: { state: "bound", name: "vibe-closedloop-provider", capabilities: ["tickets"], root: home } }));
  const writer = (prompt, session_id = "lead-chat") => writerBindingProblem({ cwd: home, session_id, tool_input: { subagent_type: "general-purpose", prompt } }, home);
  assert.equal(writer("Invoke vibe:vibe first: fix ISS-12\nProvider: vibe-closedloop-provider\n"), null);
  assert.equal(writer("Invoke vibe:vibe first: fix ISS-12\n"), null, "a brief with no line inherits the lead's binding");
  assert.match(writer("Invoke vibe:vibe first: fix #12\nProvider: none\n"), /this lead is bound as "Provider: vibe-closedloop-provider"; a writer works under the lead.s binding; name the lead's binding on that line or drop the line/);
  assert.equal(writer("Invoke vibe:vibe first: fix #12\nProvider: none\n", "generic-chat"), null, "a generic lead's writer carries Provider: none");
  assert.equal(writer("Review this diff and report findings."), null, "a prompt that starts no writer is untouched");
});
