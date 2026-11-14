import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HookStandDown, hookStandDown, vibeRoot } from "./vibe-install.mjs";
import { recordHookSkill } from "../hooks/hook-session-scope.mjs";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT = /(?:^|[^\w.])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|[^\w.])import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
// A force push is refused in every session, so its deny shows whether the hook ran.
const FORCE_PUSH = ["git", "push", "-f", "origin", "fix/x"].join(" ");

function modules(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) modules(file, found);
    else if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) found.push(file);
  }
  return found;
}

// AC3 (ISS-13869): vibe-core never loads code from vibe's install, so Codex's review of vibe-core's
// bundle covers every line its hooks run.
test("no vibe-core module imports anything outside vibe-core except node builtins", () => {
  const files = modules(CORE);
  assert.ok(files.length > 50, `found only ${files.length} modules`);
  const escapes = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier.startsWith("node:")) continue;
      const target = specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : null;
      if (!target || !target.startsWith(`${CORE}${path.sep}`)) escapes.push(`${path.relative(CORE, file)} imports ${specifier}`);
    }
    if (/\bvibeCore\(|shared\/vibe-core\.mjs/.test(source)) escapes.push(`${path.relative(CORE, file)} uses vibe's loader`);
  }
  assert.deepEqual(escapes, []);
});

test("vibe-core finds vibe's install beside it in a checkout", () => {
  assert.equal(vibeRoot(), realpathSync(path.join(CORE, "..", "vibe")));
});

test("the hooks stand down with no vibe, and while the installed vibe still registers its own", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "vibe-stand-down-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(hookStandDown(null), HookStandDown.NoVibe);
  const checkout = { root, layout: "checkout" };
  assert.equal(hookStandDown(checkout, root), null, "a vibe without hooks/hooks.json leaves the hooks to vibe-core");
  mkdirSync(path.join(root, "hooks"));
  writeFileSync(path.join(root, "hooks", "hooks.json"), "{}");
  assert.equal(hookStandDown(checkout, root), HookStandDown.VibeOwnsHooks);
});

/** A Claude Code or Codex install of vibe and vibe-core under `home`, with a runnable copy of vibe-core's shared modules. */
function install(home, entries) {
  const cache = path.join(home, "plugins", "cache", "closedloop-ai");
  const roots = {};
  for (const { name, version, hooks } of entries) {
    const root = path.join(cache, name, version);
    mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version }));
    if (hooks) {
      mkdirSync(path.join(root, "hooks"), { recursive: true });
      writeFileSync(path.join(root, "hooks", "hooks.json"), "{}");
    }
    if (name === "vibe-core") cpSync(path.join(CORE, "shared"), path.join(root, "shared"), { recursive: true, filter: (file) => !file.endsWith(".test.mjs") });
    roots[`${name}@${version}`] = root;
  }
  return roots;
}

/** hookStandDown as the vibe-core copy at `core` computes it for a session in `cwd`. */
function standDown(core, cwd) {
  const script = `import { hookStandDown, vibeInstall } from ${JSON.stringify(pathToFileURL(path.join(core, "shared", "vibe-install.mjs")).href)};
process.stdout.write(JSON.stringify(hookStandDown(vibeInstall(process.argv[1]), process.argv[1])));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, cwd], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Claude Code: an old project-scope vibe beside a new user-scope vibe and vibe-core keeps its own hooks there, and a disabled vibe stands the hooks down", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "vibe-stand-down-claude-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "claude");
  const project = path.join(root, "old-project");
  const other = path.join(root, "other");
  mkdirSync(path.join(project, "src"), { recursive: true });
  mkdirSync(other);
  const roots = install(home, [{ name: "vibe", version: "1.1.70", hooks: true }, { name: "vibe", version: "1.1.71" }, { name: "vibe-core", version: "1.0.0" }]);
  const write = (plugins) => writeFileSync(path.join(home, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
  write({
    "vibe@closedloop-ai": [{ scope: "project", projectPath: project, installPath: roots["vibe@1.1.70"] }, { scope: "user", installPath: roots["vibe@1.1.71"] }],
    "vibe-core@closedloop-ai": [{ scope: "user", installPath: roots["vibe-core@1.0.0"] }],
  });
  const core = roots["vibe-core@1.0.0"];
  assert.equal(standDown(core, path.join(project, "src")), HookStandDown.VibeOwnsHooks, "the old vibe runs these guards in its project");
  assert.equal(standDown(core, other), null, "elsewhere the new vibe's hooks are vibe-core's");
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "vibe@closedloop-ai": false } }));
  assert.equal(standDown(core, other), HookStandDown.VibeDisabled);
  mkdirSync(path.join(other, ".claude"));
  writeFileSync(path.join(other, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "vibe@closedloop-ai": true } }));
  assert.equal(standDown(core, other), null, "a project's own setting wins over the user's");
});

test("Codex: a vibe disabled in config.toml stands the hooks down; another plugin's setting does not", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "vibe-stand-down-codex-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "codex");
  const roots = install(home, [{ name: "vibe", version: "1.1.71" }, { name: "vibe-core", version: "1.0.0" }]);
  const core = roots["vibe-core@1.0.0"];
  assert.equal(standDown(core, root), null, "no config.toml: enabled");
  writeFileSync(path.join(home, "config.toml"), '[plugins."vibe-core@closedloop-ai"]\nenabled = false\n\n[plugins."vibe@closedloop-ai"]\nenabled = true\n');
  assert.equal(standDown(core, root), null);
  writeFileSync(path.join(home, "config.toml"), 'model = "m"\n[plugins."vibe@closedloop-ai"]  # vibe\nenabled = false\n[other]\nenabled = true\n');
  assert.equal(standDown(core, root), HookStandDown.VibeDisabled);
  writeFileSync(path.join(home, "config.toml"), "[plugins.'vibe@closedloop-ai']\nenabled = false\n");
  assert.equal(standDown(core, root), HookStandDown.VibeDisabled, "a single-quoted key names the same plugin");
});

test("a hook entry point runs once: never beside a vibe that still runs its own hooks, nor with no vibe", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "vibe-stand-down-run-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugins = path.join(root, "plugins");
  cpSync(CORE, path.join(plugins, "vibe-core"), { recursive: true, filter: (file) => !file.endsWith(".test.mjs") });
  const vibe = path.join(plugins, "vibe");
  mkdirSync(path.join(vibe, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(vibe, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "1.1.71" }));
  const hook = path.join(plugins, "vibe-core", "hooks", "pre-tool-use.mjs");
  // The force-push refusal acts only in a chat that activated vibe (hooks/activation.mjs).
  recordHookSkill("stand-down-chat", "vibe:vibe", root);
  const run = () => spawnSync(process.execPath, [hook], { encoding: "utf8", env: { ...process.env, HOME: root },
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "stand-down-chat", cwd: root, tool_input: { command: FORCE_PUSH } }) });
  const decision = (result) => (result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : null);
  assert.equal(decision(run()), "deny", "beside a split vibe the hook runs");
  mkdirSync(path.join(vibe, "hooks"));
  writeFileSync(path.join(vibe, "hooks", "hooks.json"), "{}");
  const standing = run();
  assert.deepEqual([standing.status, standing.stdout, standing.stderr], [0, "", ""], "an older vibe runs this guard itself");
  rmSync(vibe, { recursive: true });
  const alone = run();
  assert.deepEqual([alone.status, alone.stdout, alone.stderr], [0, "", ""], "with no vibe there is nothing to guard");
});
