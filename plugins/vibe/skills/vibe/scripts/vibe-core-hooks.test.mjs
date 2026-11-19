import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { vibeCoreRoot } from "../../../shared/vibe-core.mjs";
import { APPROVE_HOOKS, approveHooksStep, HookApproval, hookApprovalLine } from "./vibe-core-hooks.mjs";

const displayName = JSON.parse(readFileSync(path.join(vibeCoreRoot(), ".codex-plugin", "plugin.json"), "utf8")).interface.displayName;

test("ISS-14116 item 67: the approval step names the ChatGPT app's settings path, the plugin Codex shows, and a new session", () => {
  assert.equal(APPROVE_HOOKS, approveHooksStep(displayName));
  assert.ok(APPROVE_HOOKS.includes(`in the ChatGPT app, open Settings > Hooks > From Plugins > ${displayName}, trust each of its hooks, then start a new session`), APPROVE_HOOKS);
  // /hooks does nothing in the ChatGPT app's Codex, so it is named only as the Codex CLI's command.
  assert.equal(APPROVE_HOOKS.split("/hooks").length - 1, 1);
  assert.ok(APPROVE_HOOKS.includes("(in the Codex CLI, run /hooks instead)"), APPROVE_HOOKS);
});

test("ISS-14116 item 67: the setup check's hook line carries the whole approval step to the person", () => {
  for (const approval of [{ state: HookApproval.Needed, blocked: ["vibe-core@market:hooks/hooks.json:pre_tool_use:0:0 is untrusted"] }, { state: HookApproval.Missing }]) {
    assert.ok(hookApprovalLine(approval).endsWith(APPROVE_HOOKS), approval.state);
  }
});
