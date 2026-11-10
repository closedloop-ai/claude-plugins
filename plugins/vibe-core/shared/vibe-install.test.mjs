import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HookStandDown, hookStandDown, vibeRoot } from "./vibe-install.mjs";

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
  assert.equal(hookStandDown(root), null, "a vibe without hooks/hooks.json leaves the hooks to vibe-core");
  mkdirSync(path.join(root, "hooks"));
  writeFileSync(path.join(root, "hooks", "hooks.json"), "{}");
  assert.equal(hookStandDown(root), HookStandDown.VibeOwnsHooks);
});

test("a hook entry point runs once: never beside a vibe that still runs its own hooks, nor with no vibe", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "vibe-stand-down-run-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugins = path.join(root, "plugins");
  cpSync(CORE, path.join(plugins, "vibe-core"), { recursive: true, filter: (file) => !file.endsWith(".test.mjs") });
  const vibe = path.join(plugins, "vibe");
  mkdirSync(path.join(vibe, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(vibe, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "1.1.69" }));
  const hook = path.join(plugins, "vibe-core", "hooks", "pre-tool-use.mjs");
  const run = () => spawnSync(process.execPath, [hook], { encoding: "utf8", env: { ...process.env, HOME: root },
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: root, tool_input: { command: FORCE_PUSH } }) });
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
