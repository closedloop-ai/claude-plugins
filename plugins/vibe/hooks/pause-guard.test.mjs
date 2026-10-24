import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { holdReminder, TASKSTOP_REMINDER } from "./pause-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "pause-guard.mjs");

test("a message asking its recipient to pause or hold itself gets the TaskStop reminder (two ignored HOLDs, 2026-10-23)", () => {
  for (const message of ["HOLD: main is being reverted", "PAUSE until the revert lands", "Please pause your writer now.",
    "hold all work on #9230", "Stop your subagents and wait", "Stand down until I say go", "freeze everything"]) {
    assert.equal(holdReminder({ to: "vibe-writer", message }), TASKSTOP_REMINDER, message);
  }
});

test("ordinary freeze and stop instructions, and a hold already done with TaskStop, get nothing", () => {
  for (const message of ["Push nothing more to the branch.", "Stop the investigation and report what you found.",
    "Hold off on pushing until CI is green", "Holding steady on #9230, ready for review", "Stop at the first failure and report it",
    "Fix the stop button label", "hold the PR open for review", "HOLD: stopped with TaskStop; wait for the revert"]) {
    assert.equal(holdReminder({ to: "vibe-writer", message }), null, message);
  }
  assert.equal(holdReminder({ to: "lead", message: { type: "shutdown_response", request_id: "1", approve: true } }), null);
});

test("the SendMessage hook adds the reminder as context, never refuses, and is registered", () => {
  const run = (message) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: "SendMessage", tool_input: { to: "w", message } }), encoding: "utf8" });
  const output = JSON.parse(run("HOLD everything").stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "PreToolUse");
  assert.equal(output.additionalContext, TASKSTOP_REMINDER);
  assert.equal(output.permissionDecision, undefined);
  assert.equal(run("Push nothing more to the branch.").stdout, "");
  const hooks = JSON.parse(readFileSync(path.join(HERE, "hooks.json"), "utf8")).hooks.PreToolUse;
  assert.ok(hooks.some((entry) => entry.matcher === "SendMessage" && entry.hooks.some((hook) => hook.command.includes("hooks/pause-guard.mjs"))));
});
