// vibe's own skill text for the loaded-release check vibe-core's skill-freshness.mjs enforces
// (moved from vibe-core's skill-freshness.test.mjs: the words it pins are vibe's).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("vibe and fleet both record the release loaded by the current conversation", () => {
  const fleet = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  const vibe = readFileSync(new URL("../../vibe/SKILL.md", import.meta.url), "utf8");
  assert.match(fleet, /plugin-version\.mjs loaded --runtime codex\|claude/);
  assert.match(vibe, /plugin-version\.mjs loaded --runtime codex/);
  assert.match(vibe, /plugin script the installed release no longer has/);
});
