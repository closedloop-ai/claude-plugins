// Every guard resolves the vibe install the event's session uses, the same one the stand-down judged:
// in Claude Code a project install wins inside its project, so process.cwd() alone could pick another.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A Claude Code install: vibe for one project and for the user, beside a runnable copy of vibe-core. */
function claudeInstall(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "vibe-guard-install-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "claude");
  const cache = path.join(home, "plugins", "cache", "closedloop-ai");
  const vibe = (version) => {
    const dir = path.join(cache, "vibe", version);
    for (const manifest of [".claude-plugin", ".codex-plugin"]) {
      mkdirSync(path.join(dir, manifest), { recursive: true });
      writeFileSync(path.join(dir, manifest, "plugin.json"), JSON.stringify({ name: "vibe", version }));
    }
    for (const skill of ["vibe", "fleet-orchestrator"]) {
      mkdirSync(path.join(dir, "skills", skill), { recursive: true });
      writeFileSync(path.join(dir, "skills", skill, "SKILL.md"), `${skill} ${version}\n`);
    }
    return dir;
  };
  const projectVibe = vibe("1.1.72");
  const userVibe = vibe("1.1.71");
  const core = path.join(cache, "vibe-core", "1.0.0");
  cpSync(CORE, core, { recursive: true, filter: (file) => !file.endsWith(".test.mjs") });
  const project = path.join(root, "project");
  const elsewhere = path.join(root, "elsewhere");
  mkdirSync(path.join(project, "src"), { recursive: true });
  mkdirSync(elsewhere);
  writeFileSync(path.join(home, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "vibe@closedloop-ai": [{ scope: "project", projectPath: project, installPath: projectVibe }, { scope: "user", installPath: userVibe }],
    "vibe-core@closedloop-ai": [{ scope: "user", installPath: core }],
  } }));
  const run = (body) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", body], { encoding: "utf8", cwd: root, env: { ...process.env, HOME: root } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const module = (relative) => JSON.stringify(pathToFileURL(path.join(core, relative)).href);
  return { root, project, elsewhere, projectVibe, userVibe, run, module };
}

test("the Skill hook records load evidence from the vibe the event's directory uses", (t) => {
  const f = claudeInstall(t);
  const record = (cwd) => f.run(`import { recordHookSkill, readHookSkillRecord } from ${f.module("hooks/hook-session-scope.mjs")};
recordHookSkill("session-1", "vibe:vibe", ${JSON.stringify(f.root)}, new Date(), "claude", ${JSON.stringify(cwd)});
process.stdout.write(JSON.stringify(readHookSkillRecord("session-1", ${JSON.stringify(f.root)}).loadedSkill));`);
  assert.equal(record(path.join(f.project, "src")).pluginRoot, f.projectVibe);
  assert.equal(record(f.elsewhere).pluginRoot, f.userVibe);
});

test("the version guard and skill freshness judge evidence against the vibe the event's directory or worktree uses", (t) => {
  const f = claudeInstall(t);
  const verdicts = f.run(`import { versionProblem } from ${f.module("hooks/plugin-version-guard.mjs")};
import { skillFreshnessProblem } from ${f.module("lib/fleet-orchestrator/scripts/skill-freshness.mjs")};
import { LoadBasis, loadedSkillEvidence } from ${f.module("lib/vibe/scripts/loaded-skill.mjs")};
import { mkdirSync, writeFileSync } from "node:fs";
const home = ${JSON.stringify(f.root)};
const loadedSkill = loadedSkillEvidence("session-1", "claude", ${JSON.stringify(f.projectVibe)}, "vibe", LoadBasis.HookObserved);
const record = { conversation: "session-1", status: "current", loadedSkill };
mkdirSync(home + "/.codex/vibe/plugin-version", { recursive: true });
writeFileSync(home + "/.codex/vibe/plugin-version/session-1.json", JSON.stringify(record));
process.stdout.write(JSON.stringify({
  guardInProject: versionProblem("session-1", home, ${JSON.stringify(path.join(f.project, "src"))}),
  guardElsewhere: versionProblem("session-1", home, ${JSON.stringify(f.elsewhere)}),
  freshInProject: skillFreshnessProblem(record, { worktree: ${JSON.stringify(f.project)} }),
  freshElsewhere: skillFreshnessProblem(record, { worktree: ${JSON.stringify(f.elsewhere)} }),
}));`);
  assert.equal(verdicts.guardInProject, null, "the project's own vibe loaded the evidence");
  assert.match(verdicts.guardElsewhere, /loaded 1\.1\.72 from another skill definition/);
  assert.equal(verdicts.freshInProject, null);
  assert.match(verdicts.freshElsewhere, /loaded 1\.1\.72 from another skill definition/);
});
