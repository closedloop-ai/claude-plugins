import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentGuard, agentLaunchProblem } from "./agent-guard.mjs";
import { PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-tool-use.mjs");

test("an orchestrator cannot launch a vibe worker directly outside a vibe session", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-agent-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (subagentType, cwd = dir) => spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Agent", cwd, tool_input: { subagent_type: subagentType, prompt: "Implement the ticket" } }),
    encoding: "utf8",
  });

  assert.match(agentLaunchProblem({ subagent_type: "vibe:vibe-change-worker" }), /invoke `vibe:vibe`/);
  const denied = JSON.parse(run("vibe:vibe-change-worker").stdout).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /session record, environment setup, guardrails and adversarial review, PR preflight and SendMessage path/);
  assert.equal(run("general-purpose").stdout, "", "a Claude agent may invoke the vibe skill");

  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  const gitDir = execFileSync("git", ["-C", dir, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(gitDir, "vibe-session.json"), "{}\n");
  assert.equal(run("vibe:vibe-change-worker", dir).stdout, "", "the vibe skill may dispatch its own worker inside a session");
  assert.ok(PRE_TOOL_USE_ROUTES.Agent.some((guard) => guard.run === agentGuard), "the Agent guard is routed");
});
