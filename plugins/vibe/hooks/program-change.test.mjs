import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROGRAM_CHANGE_REMINDER, programChange } from "./program-change.mjs";
import { USER_PROMPT_SUBMIT_GUARDS } from "./user-prompt-submit.mjs";

const USER_PROMPT_SUBMIT = path.join(path.dirname(fileURLToPath(import.meta.url)), "user-prompt-submit.mjs");

function transcript(t, content) {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-program-change-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "transcript.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "user", message: { content } })}\n`);
  return file;
}

// Three program changes in one session never reached the resume log, which kept "Pending: operator ruling on how
// to proceed" for four hours (2026-10-22).
test("an operator prompt that changes the program gets the record-it-first reminder in an orchestrator session", (t) => {
  const file = transcript(t, "Base directory for this skill: /cache/vibe/1.0.72/skills/fleet-orchestrator");
  for (const prompt of [
    "I don't want to build anything yet. I want to come up with a design. We may end up taking it over",
    "I don't want to look at the design of PRD-802. Let's go back and look at PRD-800",
    "I want to start from scratch. We are going to build a domain model iteratively.",
    "Drop PRD-802 and switch to PRD-800 instead",
    "Stop building, design only for now",
  ]) {
    assert.equal(programChange({ prompt, transcript_path: file })?.context, PROGRAM_CHANGE_REMINDER, prompt);
  }
  for (const prompt of ["What is the kernel?", "Why is #9058 so large?", "brb", "Looks good, ship the QA plan"]) {
    assert.equal(programChange({ prompt, transcript_path: file }), null, prompt);
  }
  assert.match(PROGRAM_CHANGE_REMINDER, /rulings\.md/);
  assert.match(PROGRAM_CHANGE_REMINDER, /resume-log\.md/);
});

test("outside an orchestrator session it says nothing, and the UserPromptSubmit hook routes it", (t) => {
  const worker = transcript(t, "Base directory for this skill: /cache/vibe/1.0.85/skills/vibe");
  assert.equal(programChange({ prompt: "I want to start from scratch", transcript_path: worker }), null);
  assert.ok(USER_PROMPT_SUBMIT_GUARDS.some((guard) => guard.run === programChange));
  const file = transcript(t, "Base directory for this skill: /cache/vibe/1.0.72/skills/fleet-orchestrator");
  const result = spawnSync(process.execPath, [USER_PROMPT_SUBMIT], { encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "I want to start from scratch", transcript_path: file }) });
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, PROGRAM_CHANGE_REMINDER);
});
