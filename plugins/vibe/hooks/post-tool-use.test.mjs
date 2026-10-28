import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { POST_TOOL_USE_ROUTES, postToolUse } from "./post-tool-use.mjs";
import { telemetryLaunch } from "./telemetry-launch.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "post-tool-use.mjs");

function sessionDir(t, { record = true } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vibe-post-tool-use-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  const file = path.join(execFileSync("git", ["-C", dir, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim(), "vibe-session.json");
  if (record) writeFileSync(file, `${JSON.stringify({ slug: "board-chips", status: "active" })}\n`);
  return { dir, file };
}

const runHook = (dir, subagentType) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ tool_name: "Agent", cwd: dir, tool_input: { subagent_type: subagentType, prompt: "x" } }),
  encoding: "utf8",
});

test("each Agent call in a vibe session counts one launch and keeps the rest of the record", (t) => {
  const { dir, file } = sessionDir(t);
  for (const worker of ["vibe:vibe-change-worker", "vibe:vibe-verify-worker", "vibe:vibe-change-worker"]) {
    const result = runHook(dir, worker);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "", "the telemetry guard never speaks to the model");
  }
  const record = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(record.slug, "board-chips");
  assert.equal(record.telemetry.workerLaunches, 3);
  assert.deepEqual(record.telemetry.workers, { "vibe:vibe-change-worker": 2, "vibe:vibe-verify-worker": 1 });
  assert.equal(record.telemetry.tokens, null);
  assert.equal(record.telemetry.slotWaitMs, null);
});

test("an Agent call without a subagent type counts as general-purpose", (t) => {
  const { dir, file } = sessionDir(t);
  telemetryLaunch({ cwd: dir, tool_input: { prompt: "x" } });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).telemetry.workers, { "general-purpose": 1 });
});

test("outside a vibe session nothing is written, and other tools are not routed", (t) => {
  const { dir } = sessionDir(t, { record: false });
  assert.equal(runHook(dir, "vibe:vibe-change-worker").status, 0);
  assert.equal(telemetryLaunch({ cwd: dir, tool_input: {} }), null);
  assert.equal(postToolUse({ tool_name: "Bash", cwd: dir }, () => {}), null);
  assert.deepEqual(Object.keys(POST_TOOL_USE_ROUTES), ["Agent"]);
});
