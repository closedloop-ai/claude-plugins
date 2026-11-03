import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as upgradeEval from "./upgrade-resume-eval.ts";
import { claudeRootCommandDecision } from "./claude-root-command-gate.ts";

test("Claude root gate allows exact JSON-on-stdin writer commands and denies unrelated Bash", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-claude-root-gate-"));
  try {
    const worktree = join(root, "worktree");
    const scripts = join(root, "release", "skills/vibe/scripts/dist");
    mkdirSync(worktree);
    mkdirSync(scripts, { recursive: true });
    const state = join(scripts, "writer-state.mjs");
    const worker = join(scripts, "claude-worker.mjs");
    writeFileSync(state, "fixture\n");
    writeFileSync(worker, "fixture\n");
    const config = { worktree: realpathSync(worktree), scripts: [state, worker] };
    const payload = JSON.stringify({ worktree: config.worktree });
    const allowed = claudeRootCommandDecision({ tool_name: "Bash", tool_input: {
      command: `printf '%s\\n' '${payload}' | node '${state}' status`,
    } }, config);
    assert.equal(allowed.hookSpecificOutput.permissionDecision, "allow");
    const workerPayload = JSON.stringify({ worktree: config.worktree, agentName: "vibe-change-worker",
      mode: "request", requestId: "request-one", input: "append turn one", capabilities: [{
        name: "mcp__closedloop-graph__code_symbols", service: "graph", access: "read",
        operation: "code_symbols",
      }] });
    assert.equal(claudeRootCommandDecision({ tool_name: "Bash", tool_input: {
      command: `printf '%s\\n' '${workerPayload}' | node '${worker}'`,
    } }, config).hookSpecificOutput.permissionDecision, "allow");
    for (const command of [
      "git status", `printf '%s' '${payload}' | node '${state}' status; rm -rf fixture`,
      `printf '%s' '${JSON.stringify({ worktree: "/other" })}' | node '${state}' status`,
      `node '${worker}'`,
    ]) assert.equal(claudeRootCommandDecision({ tool_name: "Bash", tool_input: { command } },
      config).hookSpecificOutput.permissionDecision, "deny");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-13563 AC3 incomplete Claude migration is denied before a canonical correction", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-claude-migrate-gate-"));
  try {
    const worktree = join(root, "worktree");
    const agentRoot = join(root, "release");
    const scripts = join(agentRoot, "skills/vibe/scripts/dist");
    mkdirSync(worktree);
    mkdirSync(scripts, { recursive: true });
    const state = join(scripts, "writer-state.mjs");
    writeFileSync(state, "fixture\n");
    const config = { worktree: realpathSync(worktree), scripts: [state] };
    const incomplete = `printf '%s\\n' '${JSON.stringify({ worktree: config.worktree,
      runtime: "claude", agentName: "vibe-change-worker" })}' | node '${state}' migrate`;
    assert.equal(claudeRootCommandDecision({ tool_name: "Bash", tool_input: {
      command: incomplete,
    } }, config).hookSpecificOutput.permissionDecision, "deny");
    const command = (upgradeEval as unknown as { claudeMigrationCommand?: (input: {
      worktree: string; agentRoot: string; previousWorkerId: string;
      previousDigest: string;
    }) => string }).claudeMigrationCommand;
    assert.equal(typeof command, "function");
    const corrected = command!({ worktree: config.worktree, agentRoot,
      previousWorkerId: "existing-writer", previousDigest: "a".repeat(64) });
    assert.equal(claudeRootCommandDecision({ tool_name: "Bash", tool_input: {
      command: corrected,
    } }, config).hookSpecificOutput.permissionDecision, "allow");
    assert.equal(claudeRootCommandDecision({ tool_name: "Bash", tool_input: {
      command: `R=${root}\n${corrected}`,
    } }, config).hookSpecificOutput.permissionDecision, "deny");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
