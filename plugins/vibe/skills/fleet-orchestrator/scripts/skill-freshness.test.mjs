import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pluginScriptProblems, promptProblems, skillFreshnessProblem } from "./skill-freshness.mjs";
import { loadedSkillEvidence } from "../../vibe/scripts/loaded-skill.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-freshness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(root, "skills", "handoff", "scripts"), { recursive: true });
  mkdirSync(path.join(root, "skills", "fleet-orchestrator"), { recursive: true });
  writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "1.1.21" }));
  writeFileSync(path.join(root, "skills", "handoff", "scripts", "handoff-gate.mjs"), "export {};\n");
  writeFileSync(path.join(root, "skills", "fleet-orchestrator", "SKILL.md"), "# fleet\n");
  return root;
}

const record = (root, version = "1.1.21") => {
  const loadedSkill = loadedSkillEvidence("actor-1", "codex", root, "fleet-orchestrator");
  return { runtime: "codex", loadedSkill: { ...loadedSkill, version }, harnesses: [] };
};

test("a newer installed release blocks stale loaded instructions until the current skill is recorded", (t) => {
  const root = fixture(t);
  assert.match(skillFreshnessProblem(record(root, "1.0.85"), { pluginRoot: root }), /loaded 1\.0\.85|another skill definition/);
  assert.equal(skillFreshnessProblem(record(root), { pluginRoot: root }), null);
  assert.equal(promptProblems(record(root), "continue", { pluginRoot: root }).length, 0, "the reloaded version proceeds");
  assert.match(skillFreshnessProblem({ loadedSkill: { version: "1.1.21" } }, { pluginRoot: root }), /no machine-observed/);
});

test("a brief refuses a deleted installed plugin script but accepts a real one", (t) => {
  const root = fixture(t);
  assert.deepEqual(pluginScriptProblems("run handoff/scripts/handoff-gate.mjs", root), []);
  assert.match(pluginScriptProblems("run handoff/scripts/qa-merge-order.mjs", root)[0], /does not exist/);
  assert.deepEqual(pluginScriptProblems("repo/scripts/qa-merge-order.mjs is a repository path", root), [], "unknown repo paths are not guessed to be plugin paths");
});

test("legacy shorthand resolves to the target repository before the plugin", (t) => {
  const root = fixture(t);
  const worktree = path.join(root, "repo");
  mkdirSync(path.join(worktree, "handoff", "scripts"), { recursive: true });
  writeFileSync(path.join(worktree, "handoff", "scripts", "repo-tool.mjs"), "export {};\n");
  assert.deepEqual(pluginScriptProblems("run handoff/scripts/repo-tool.mjs", root, worktree), []);
  assert.match(pluginScriptProblems("run skills/handoff/scripts/missing.mjs", root, worktree)[0], /does not exist/);
});

test("explicit plugin paths cannot escape or resolve to a directory", (t) => {
  const root = fixture(t);
  assert.match(pluginScriptProblems("run skills/handoff/scripts/../secret.mjs", root)[0], /escapes/);
  assert.match(pluginScriptProblems("run skills/handoff/scripts", root).join("\n"), /^$/, "non-script prose is ignored");
  assert.match(pluginScriptProblems("run skills/handoff/scripts/missing.py", root)[0], /does not exist/);
});

test("vibe and fleet both record the release loaded by the current conversation", () => {
  const fleet = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  const vibe = readFileSync(new URL("../../vibe/SKILL.md", import.meta.url), "utf8");
  assert.match(fleet, /plugin-version\.mjs loaded --runtime codex\|claude/);
  assert.match(vibe, /plugin-version\.mjs loaded --runtime codex/);
  assert.match(vibe, /plugin script the installed release no longer has/);
});
