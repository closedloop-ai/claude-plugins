import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROGRAM_CHANGE_REMINDER, programChange } from "./program-change.mjs";
import { USER_PROMPT_SUBMIT_GUARDS } from "./user-prompt-submit.mjs";
import { recordHookSkill } from "./hook-session-scope.mjs";

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
    "I don't want to look at the design of #802. Let's go back and look at #800",
    "I want to start from scratch. We are going to build a domain model iteratively.",
    "Drop #802 and switch to #800 instead",
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

test("a recorded fleet skill preserves the program-change reminder without a transcript", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "program-change-marker-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  recordHookSkill("fleet-session", "vibe:fleet-orchestrator", home);
  assert.equal(programChange({ session_id: "fleet-session", prompt: "start from scratch", transcript_path: null }, home)?.context, PROGRAM_CHANGE_REMINDER);
  assert.equal(programChange({ session_id: "other-session", prompt: "start from scratch", transcript_path: null }, home), null);
});

test("a move between work items is named the way the session's tracker references one", (t) => {
  const file = transcript(t, "Base directory for this skill: /cache/vibe/1.0.72/skills/fleet-orchestrator");
  const home = mkdtempSync(path.join(tmpdir(), "program-change-tracker-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const event = (prompt, session_id = "generic-chat") => ({ prompt, transcript_path: file, session_id, cwd: home });
  assert.equal(programChange(event("Drop #802 and switch to #800"), home)?.context, PROGRAM_CHANGE_REMINDER);
  assert.equal(programChange(event("Park https://github.com/acme/widgets/issues/802 for now"), home)?.context, PROGRAM_CHANGE_REMINDER);
  assert.equal(programChange(event("Drop PRD-802 and switch to PRD-800"), home), null, "with no tracker bound, a tracker-style key names nothing");
  const records = path.join(home, ".codex", "vibe", "plugin-version");
  mkdirSync(records, { recursive: true });
  writeFileSync(path.join(records, "bound-chat.json"), JSON.stringify({ conversation: "bound-chat", status: "current",
    provider: { state: "bound", name: "vibe-closedloop-provider", capabilities: ["tickets", "plans", "graph", "memory", "recipes"],
      root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../vibe-closedloop-provider") } }));
  assert.equal(programChange(event("Drop PRD-802 and switch to PRD-800", "bound-chat"), home)?.context, PROGRAM_CHANGE_REMINDER);
  assert.equal(programChange(event("Why is PRD-802 so large?", "bound-chat"), home), null);
});

test("a broken bound provider warns the person and the reminder still runs on the generic references", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "program-change-broken-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  recordHookSkill("fleet-broken", "vibe:fleet-orchestrator", home);
  const record = path.join(home, ".codex", "vibe", "plugin-version", "fleet-broken.json");
  mkdirSync(path.dirname(record), { recursive: true });
  writeFileSync(record, JSON.stringify({ conversation: "fleet-broken",
    provider: { state: "bound", name: "acme-provider", root: path.join(home, "gone"), capabilities: ["tickets"] } }));
  const event = (prompt) => ({ session_id: "fleet-broken", prompt, transcript_path: null, cwd: home });
  const moved = programChange(event("Drop #802 and switch to #800 instead"), home);
  assert.equal(moved.context, PROGRAM_CHANGE_REMINDER, "the generic GitHub references still match");
  assert.match(moved.systemMessage, /^vibe program-change: provider-broken: the provider acme-provider .*no longer installed.*Fix: reinstall or update/);
  assert.deepEqual(programChange(event("What is the kernel?"), home), { systemMessage: moved.systemMessage }, "it warns even when nothing fires");
});
