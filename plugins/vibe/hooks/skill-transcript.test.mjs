import assert from "node:assert/strict";
import test from "node:test";
import { latestSkill, loadsSkill } from "./skill-transcript.mjs";

const base = (dir) => `Base directory for this skill: ${dir}\n`;

test("a skill load counts under either vibe name: its cache folder, Skill call or Codex skill block", () => {
  for (const name of ["vibe", "vibe-generic"]) {
    const cache = `/home/x/.claude/plugins/cache/closedloop-ai/${name}/1.1.88/skills`;
    assert.equal(loadsSkill(base(`${cache}/handoff`), "vibe-plugin"), true, name);
    assert.equal(loadsSkill(`"skill": "${name}:handoff"`, "vibe-plugin"), true, name);
    assert.equal(loadsSkill(`<name>${name}:pr-takeover</name>`, "vibe-plugin"), true, name);
    assert.equal(loadsSkill(`"skill": "${name}:vibe"`, "vibe"), true, name);
    assert.equal(loadsSkill(`<name>${name}:fleet-orchestrator</name>`, "fleet-orchestrator"), true, name);
    assert.equal(latestSkill(`${base(`${cache}/vibe`)}"skill": "${name}:fleet-orchestrator"`, ["vibe", "fleet-orchestrator"]), "fleet-orchestrator", name);
  }
  assert.equal(loadsSkill(base("/repo/plugins/vibe/skills/handoff"), "vibe-plugin"), true, "a checkout's plugins/vibe");
});

test("another plugin's skills and a mention of vibe's files are no load", () => {
  for (const text of [base("/home/x/.claude/plugins/cache/closedloop-ai/vibe-core/1.0.10/skills/handoff"), `"skill": "vibe-core:handoff"`,
    `<name>other:vibe</name>`, "Read plugins/vibe/skills/vibe/SKILL.md"]) {
    assert.equal(loadsSkill(text, "vibe-plugin") || loadsSkill(text, "vibe"), false, text);
  }
});
