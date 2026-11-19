import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promptProblems, skillFreshnessProblem } from "./skill-freshness.mjs";
import { pluginScriptProblems } from "../../vibe/scripts/plugin-script-references.mjs";
import { LoadBasis, loadedSkillEvidence, compareSkillVersions } from "../../vibe/scripts/loaded-skill.mjs";

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
  const loadedSkill = loadedSkillEvidence("actor-1", "codex", root, "fleet-orchestrator", LoadBasis.HookObserved);
  return { runtime: "codex", loadedSkill: { ...loadedSkill, version }, harnesses: [] };
};

test("a newer installed release blocks stale loaded instructions until the current skill is recorded", (t) => {
  const root = fixture(t);
  assert.match(skillFreshnessProblem(record(root, "1.0.85"), { pluginRoot: root }), /loaded 1\.0\.85|another skill definition/);
  assert.equal(skillFreshnessProblem(record(root), { pluginRoot: root }), null);
  assert.equal(promptProblems(record(root), "continue", { pluginRoot: root }).length, 0, "the reloaded version proceeds");
  assert.match(skillFreshnessProblem({ loadedSkillRequired: true, loadedSkill: { version: "1.1.21" } }, { pluginRoot: root }), /no hook-observed/);
  // PR #371 review: with no hook evidence source (untrusted Codex hooks) the gate keeps its earlier behavior.
  assert.equal(skillFreshnessProblem({ status: "current", loadedSkillRequired: false }, { pluginRoot: root }), null);
  assert.equal(skillFreshnessProblem({ status: "current", loadedSkill: { version: "1.1.21" } }, { pluginRoot: root }), null);
  assert.match(skillFreshnessProblem({ status: "current" }, { pluginRoot: root, actorId: "helper-1" }), /no recorded loaded skill evidence/, "an explicit actor still needs evidence");
});

test("reload envelope is the only stale prompt exception and cannot carry another instruction", (t) => {
  const root = fixture(t);
  const stale = record(root, "1.0.85");
  const reload = 'VIBE_SKILL_RELOAD v1';
  assert.deepEqual(promptProblems(stale, reload, { pluginRoot: root }), []);
  for (const text of ['continue', `${reload}\ncontinue`, `continue\n${reload}`, `${reload} `,
    '{"type":"VIBE_SKILL_RELOAD","instruction":"continue"}', 'VIBE_SKILL_RELOAD v2']) {
    assert.match(promptProblems(stale, text, { pluginRoot: root }).join(';'), /loaded 1\.0\.85/, text);
  }
  assert.match(promptProblems({ loadedSkill: { ...stale.loadedSkill, actorId: 'other' } }, reload,
    { pluginRoot: root, actorId: 'actor-1' }).join(';'), /no recorded loaded skill evidence/);
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

// PR #371 review: a repository's own `.claude/skills/control/scripts/app.mjs` was refused as a missing vibe script.
test("repository skill scripts and other plugins' scripts are never vibe plugin references", (t) => {
  const root = fixture(t);
  const worktree = path.join(root, "repo");
  mkdirSync(path.join(worktree, ".claude", "skills", "control", "scripts"), { recursive: true });
  writeFileSync(path.join(worktree, ".claude", "skills", "control", "scripts", "app.mjs"), "export {};\n");
  mkdirSync(path.join(worktree, "skills", "handoff", "scripts"), { recursive: true });
  writeFileSync(path.join(worktree, "skills", "handoff", "scripts", "repo-only.mjs"), "export {};\n");
  for (const text of [
    "read .claude/skills/control/scripts/app.mjs",
    "read .claude/skills/control/scripts/missing.mjs",
    "read skills/control/scripts/app.mjs",
    `read ${path.join(worktree, ".claude", "skills", "handoff", "scripts", "x.mjs")}`,
    "run skills/handoff/scripts/repo-only.mjs",
  ]) assert.deepEqual(pluginScriptProblems(text, root, worktree), [], text);
  assert.match(pluginScriptProblems("run ../handoff/scripts/missing.mjs", root, worktree)[0] ?? "", /skills\/handoff\/scripts\/missing\.mjs: plugin script does not exist/);
  assert.match(pluginScriptProblems(`run ${path.join(root, "skills", "handoff", "scripts", "removed.mjs")}:12`, root, worktree)[0] ?? "", /removed\.mjs: plugin script does not exist/,
    "an absolute path into a vibe plugin root is still checked against the installed release");
  assert.deepEqual(pluginScriptProblems(`run ${path.join(root, "skills", "handoff", "scripts", "handoff-gate.mjs")}`, root, worktree), []);
});


test("release comparison keeps numeric precedence and orders distinct numeric ties consistently", () => {
  const tied = ['1.01.0', '1.1.0', '01.1.0'];
  const expected = ['01.1.0', '1.01.0', '1.1.0'];
  assert.deepEqual([...tied].sort(compareSkillVersions), expected);
  assert.deepEqual([...tied].reverse().sort(compareSkillVersions), expected);
  for (const left of tied) for (const right of tied) {
    assert.equal(compareSkillVersions(left, right) === 0, left === right);
    if (left !== right) assert.equal(compareSkillVersions(left, right), -compareSkillVersions(right, left));
  }
  assert.equal(compareSkillVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareSkillVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareSkillVersions('invalid', '1.0.0'), null);
});
