// vibe's own text for the protected-write guard vibe-core runs for its headless Claude writer
// (moved from vibe-core's protected-write-guard.test.mjs: the words it pins are vibe's).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readAssembled } from "./skill-split.mjs";

test("writer refusal and internal preflight routing name the protected-write policy", () => {
  const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const writer = readFileSync(path.join(plugin, "agents", "vibe-change-worker.md"), "utf8");
  const skill = readAssembled(path.join(plugin, "skills", "vibe", "SKILL.md"));
  const preflight = readFileSync(path.join(plugin, "skills", "vibe", "references", "preflight.md"), "utf8");
  assert.match(writer, /After any native edit refusal,[\s\S]*return `BLOCKED`/);
  assert.match(writer, /Never retry the[\s\S]*through Bash, Python, Node, tee, redirection/);
  assert.match(skill, /`PROTECTED_PATH_HOOK_UNAVAILABLE`:[\s\S]*dispatch `vibe-setup-worker`/);
  assert.match(preflight, /`claude-protected-hook-version`[\s\S]*2\.1\.295/);
});
