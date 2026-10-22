import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AWAY_CHECKLIST, BACK_CHECKLIST, checklistFor } from "./away-protocol.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "away-protocol.mjs");

test("away and back phrases bring the checklist; ordinary prompts do not (brb with no away protocol)", () => {
  for (const prompt of ["stepping away. brb.", "brb", "afk for 20", "going to bed, see you tomorrow", "heading out for lunch", "back in 30", "back in a few", "ok I need to step out"]) {
    assert.equal(checklistFor(prompt), AWAY_CHECKLIST, prompt);
  }
  for (const prompt of ["I'm back", "im back, what happened?", "back now", "back.", "Okay, back. Status?"]) {
    assert.equal(checklistFor(prompt), BACK_CHECKLIST, prompt);
  }
  for (const prompt of ["go back to the PR and fix the thread", "roll back the migration", "the back button is broken", "write it back to the ticket", "feedback on the board", "bring back the legacy list"]) {
    assert.equal(checklistFor(prompt), null, prompt);
  }
});

test("the hook adds the checklist as context and stays silent otherwise", () => {
  const run = (prompt) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }), encoding: "utf8" }).stdout;
  const away = JSON.parse(run("stepping away. brb.")).hookSpecificOutput;
  assert.equal(away.hookEventName, "UserPromptSubmit");
  assert.match(away.additionalContext, /attention\.md/);
  assert.match(away.additionalContext, /every 20 to 30 minutes/);
  assert.match(JSON.parse(run("I'm back")).hookSpecificOutput.additionalContext, /Delete the away schedule/);
  assert.equal(run("go back to the PR"), "");
});
