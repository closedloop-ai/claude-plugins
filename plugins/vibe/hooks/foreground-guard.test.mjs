import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { foregroundProblem } from "./foreground-guard.mjs";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "foreground-guard.mjs");

test("a foreground wait over 5 minutes is refused; background runs and short waits pass (answers sent three times)", () => {
  assert.match(foregroundProblem({ command: "pnpm test", timeout: 600000 }), /at most 5 minutes/);
  assert.equal(foregroundProblem({ command: "pnpm test", timeout: 600000, run_in_background: true }), null);
  assert.equal(foregroundProblem({ command: "git status", timeout: 300000 }), null);
  assert.equal(foregroundProblem({ command: "git status" }), null);
});

test("the hook applies only inside a vibe session's worktree", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "foreground-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", dir]);
  const long = { tool_name: "Bash", cwd: dir, tool_input: { command: "pnpm test", timeout: 900000 } };
  const run = (event) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify(event), encoding: "utf8" }).stdout;
  assert.equal(run(long), "", "outside a vibe session the guard stays silent");
  writeFileSync(path.join(dir, ".git", "vibe-session.json"), "{}\n");
  assert.equal(JSON.parse(run(long)).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(run({ ...long, tool_input: { ...long.tool_input, run_in_background: true } }), "");
});
