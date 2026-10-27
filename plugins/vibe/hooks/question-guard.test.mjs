import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";
import { questionGuard } from "./question-guard.mjs";

const PRE_TOOL_USE = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-tool-use.mjs");
const BACKUP = "Some files in your copy are not part of this work. May I move them to a backup folder so the pull request can be made?";

function transcript(t, ...entries) {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-question-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "transcript.jsonl");
  writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return file;
}
const vibeSkill = { type: "user", message: { content: "Base directory for this skill: /cache/vibe/1.0.85/skills/vibe" } };
const fleetSkill = { type: "user", message: { content: "Base directory for this skill: /cache/vibe/1.0.85/skills/fleet-orchestrator" } };
const recorded = (question) => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash",
  input: { command: `node scripts/session-questions.mjs ask --key backup --question "${question}" --default "leave them" --deadline-minutes 30` } }] } });
const ask = (file, question, toolName = "AskUserQuestion") => questionGuard({ tool_name: toolName, transcript_path: file,
  tool_input: { questions: [{ question, header: "Files", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }] } });

// A vibe session asked the person about their own files without session-questions.mjs (2026-10-26).
test("in a vibe session a question reaches the person only after session-questions.mjs recorded it", (t) => {
  assert.equal(ask(transcript(t, vibeSkill), BACKUP)?.decision, "deny");
  assert.match(ask(transcript(t, vibeSkill), BACKUP).reason, /session-questions\.mjs ask/);
  assert.equal(ask(transcript(t, vibeSkill, recorded(BACKUP)), BACKUP), null);
  assert.equal(ask(transcript(t, vibeSkill, recorded("Which words should the page use?")), BACKUP)?.decision, "deny", "another question's record does not count");
  assert.equal(ask(transcript(t, vibeSkill), BACKUP, "request_user_input")?.decision, "deny", "the Codex question tool is held to the same path");
  assert.equal(ask(transcript(t, vibeSkill), "A newer version of vibe is available (vibe: you have 1.0.85, the latest is 1.1.0). Do you want me to update it now, or keep going with this one? Keeping going with an older version could give worse results."), null,
    "the startup version question runs once per conversation outside session-questions.mjs");
  assert.equal(ask(transcript(t, fleetSkill), "A newer version of the plugins is available (vibe: you have 1.0.85, the latest is 1.1.0). Update now, or proceed on this version? Proceeding on an outdated plugin could give worse results."), null,
    "the fleet startup version question is about the install, so it names no code");
  assert.equal(ask(transcript(t, fleetSkill), BACKUP)?.decision, "deny", "every other orchestrator question still names the code");
});

test("an orchestrator's question to the operator names where it checked the code", (t) => {
  const file = transcript(t, fleetSkill);
  assert.equal(ask(file, "The installed commit helper stages all files and has no ownership-exclusion option. Move them?")?.decision, "deny");
  assert.match(ask(file, "Move them?").reason, /checked in code: <file>:<line>/);
  assert.equal(ask(file, "The commit helper stages every file (checked in code: skills/vibe/scripts/commit-worktree.mjs:73). Move them?"), null);
});

test("other sessions and tools are untouched, and the PreToolUse hook routes the question tools", (t) => {
  assert.equal(ask(transcript(t, { type: "user", message: { content: "fix the table" } }), BACKUP), null);
  assert.equal(ask(undefined, BACKUP), null);
  for (const tool of ["AskUserQuestion", "request_user_input"]) {
    assert.ok(PRE_TOOL_USE_ROUTES[tool].some((guard) => guard.run === questionGuard), tool);
  }
  const result = spawnSync(process.execPath, [PRE_TOOL_USE], { encoding: "utf8",
    input: JSON.stringify({ tool_name: "AskUserQuestion", transcript_path: transcript(t, vibeSkill), tool_input: { questions: [{ question: BACKUP }] } }) });
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});
