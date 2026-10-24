import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { holdMessageProblem } from "./pause-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "pause-guard.mjs");

test("a hold sent as a message is refused until the agent was stopped with TaskStop (two ignored HOLDs, 2026-10-23)", () => {
  for (const message of ["HOLD: main is being reverted", "Pause all work now.", "stop, the rebase target is wrong"]) {
    assert.match(holdMessageProblem({ to: "vibe-writer", message }) ?? "", /TaskStop/, message);
  }
  for (const message of ["HOLD: stopped with TaskStop; wait for the revert", "Holding steady on #9230, ready for review", "Your stop condition looks right", "Fix the stop button label"]) {
    assert.equal(holdMessageProblem({ to: "vibe-writer", message }), null, message);
  }
  assert.equal(holdMessageProblem({ to: "lead", message: { type: "shutdown_response", request_id: "1", approve: true } }), null);
});

test("the SendMessage hook denies a hold message and is registered", () => {
  const run = (message) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: "SendMessage", tool_input: { to: "w", message } }), encoding: "utf8" });
  assert.equal(JSON.parse(run("HOLD everything").stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(run("Here is the next brief").stdout, "");
  const hooks = JSON.parse(readFileSync(path.join(HERE, "hooks.json"), "utf8")).hooks.PreToolUse;
  assert.ok(hooks.some((entry) => entry.matcher === "SendMessage" && entry.hooks.some((hook) => hook.command.includes("hooks/pause-guard.mjs"))));
});
