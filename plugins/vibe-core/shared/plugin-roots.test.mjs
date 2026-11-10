import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { activeCodexVersion, comparePluginVersions, siblingPluginRoot, siblingPluginRootOrNull } from "./plugin-roots.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL = path.join(HERE, "plugin-roots.mjs");
const VIBE_COPY = path.join(HERE, "..", "..", "vibe", "shared", "plugin-roots.mjs");
const IMPORT = /^\s*import\s[^;]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*export\s[^;]*?from\s*["']([^"']+)["']/gm;

function base(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "plugin-roots-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A plugin at `root` named `name`, holding a copy of the resolver so the lookup runs from inside it. */
function plugin(root, name, version, manifest = ".claude-plugin") {
  mkdirSync(path.join(root, manifest), { recursive: true });
  writeFileSync(path.join(root, manifest, "plugin.json"), JSON.stringify({ name, version }));
  mkdirSync(path.join(root, "shared"), { recursive: true });
  cpSync(CANONICAL, path.join(root, "shared", "plugin-roots.mjs"));
  return root;
}

const from = (root) => pathToFileURL(path.join(root, "shared", "plugin-roots.mjs")).href;

test("the two copies of the resolver are byte-identical and import only node builtins", () => {
  assert.equal(readFileSync(VIBE_COPY, "utf8"), readFileSync(CANONICAL, "utf8"),
    "plugins/vibe/shared/plugin-roots.mjs must stay a byte-identical copy of plugins/vibe-core/shared/plugin-roots.mjs");
  for (const file of [CANONICAL, VIBE_COPY]) {
    const specifiers = [...readFileSync(file, "utf8").matchAll(IMPORT)].map((match) => match[1] ?? match[2] ?? match[3]);
    assert.ok(specifiers.length > 0, file);
    assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith("node:")), [], `${file} imports something that is not a node builtin`);
  }
});

test("repository checkout: the sibling is plugins/<name> beside the caller's plugin", (t) => {
  const plugins = path.join(base(t), "repo", "plugins");
  const vibe = plugin(path.join(plugins, "vibe"), "vibe", "1.1.69");
  const core = plugin(path.join(plugins, "vibe-core"), "vibe-core", "1.0.0");
  assert.equal(siblingPluginRoot("vibe-core", { from: from(vibe) }), core);
  assert.equal(siblingPluginRoot("vibe", { from: from(core) }), vibe);
  assert.equal(siblingPluginRoot("vibe-core", { from: path.join(vibe, ".claude-plugin", "plugin.json") }), core, "a path inside the plugin works too");
  rmSync(core, { recursive: true });
  assert.throws(() => siblingPluginRoot("vibe-core", { from: from(vibe) }),
    /^Error: vibe-core is not installed beside vibe \(checkout layout\); install it with `claude plugin install vibe-core@closedloop-ai` in Claude Code or `codex plugin add vibe-core@closedloop-ai` in Codex$/);
  assert.equal(siblingPluginRootOrNull("vibe-core", { from: from(vibe) }), null);
});

test("Claude Code: installed_plugins.json picks the version, never the cache's directory listing", (t) => {
  const config = path.join(base(t), "claude");
  const cache = path.join(config, "plugins", "cache", "closedloop-ai");
  const vibe = plugin(path.join(cache, "vibe", "1.1.69"), "vibe", "1.1.69");
  plugin(path.join(cache, "vibe", "1.1.68"), "vibe", "1.1.68");
  const installedCore = plugin(path.join(cache, "vibe-core", "1.0.0"), "vibe-core", "1.0.0");
  // Newer and lexically later versions sit in the cache too (left behind, or not yet active).
  plugin(path.join(cache, "vibe-core", "1.0.1"), "vibe-core", "1.0.1");
  plugin(path.join(cache, "vibe-core", "2.0.0"), "vibe-core", "2.0.0");
  const registry = (entries) => writeFileSync(path.join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: entries }));
  registry({
    "vibe@closedloop-ai": [{ scope: "user", installPath: vibe, version: "1.1.69" }],
    "vibe-core@closedloop-ai": [{ scope: "user", installPath: installedCore, version: "1.0.0" }],
  });
  assert.equal(siblingPluginRoot("vibe-core", { from: from(vibe) }), installedCore);
  assert.equal(siblingPluginRoot("vibe", { from: from(installedCore) }), vibe, "vibe-core finds vibe's install the same way");

  // Several scopes: the one matching the caller's own entry wins, then the user scope.
  const projectCore = path.join(cache, "vibe-core", "1.0.1");
  registry({
    "vibe@closedloop-ai": [{ scope: "project", projectPath: "/work/app", installPath: vibe, version: "1.1.69" }],
    "vibe-core@closedloop-ai": [
      { scope: "user", installPath: installedCore, version: "1.0.0" },
      { scope: "project", projectPath: "/work/app", installPath: projectCore, version: "1.0.1" },
      { scope: "project", projectPath: "/work/other", installPath: path.join(cache, "vibe-core", "2.0.0"), version: "2.0.0" },
    ],
  });
  assert.equal(siblingPluginRoot("vibe-core", { from: from(vibe) }), projectCore);
  registry({
    "vibe@closedloop-ai": [{ scope: "local", projectPath: "/work/app", installPath: vibe, version: "1.1.69" }],
    "vibe-core@closedloop-ai": [{ scope: "user", installPath: installedCore }, { scope: "project", projectPath: "/work/other", installPath: projectCore }],
  });
  assert.equal(siblingPluginRoot("vibe-core", { from: from(vibe) }), installedCore);
  registry({
    "vibe@closedloop-ai": [{ scope: "local", projectPath: "/work/app", installPath: vibe }],
    "vibe-core@closedloop-ai": [{ scope: "project", projectPath: "/work/a", installPath: installedCore }, { scope: "project", projectPath: "/work/b", installPath: projectCore }],
  });
  assert.throws(() => siblingPluginRoot("vibe-core", { from: from(vibe) }), /vibe-core is installed in more than one Claude Code scope \(project, project\)/);

  registry({ "vibe@closedloop-ai": [{ scope: "user", installPath: vibe }] });
  assert.throws(() => siblingPluginRoot("vibe-core", { from: from(vibe) }), /vibe-core is not installed beside vibe \(claude layout\)/);
  registry({ "vibe@closedloop-ai": [{ scope: "user", installPath: vibe }], "vibe-core@closedloop-ai": [{ scope: "user", installPath: path.join(cache, "vibe-core", "9.9.9") }] });
  assert.throws(() => siblingPluginRoot("vibe-core", { from: from(vibe) }), /vibe-core is not installed beside vibe \(claude layout\)/, "a recorded path that is gone");
});

test("Codex: the active version is the one Codex itself picks", (t) => {
  const cache = path.join(base(t), "codex", "plugins", "cache", "closedloop-ai");
  const vibe = plugin(path.join(cache, "vibe", "1.1.69"), "vibe", "1.1.69", ".codex-plugin");
  for (const version of ["1.0.9", "1.0.10", "1.0.10-beta.2"]) plugin(path.join(cache, "vibe-core", version), "vibe-core", version, ".codex-plugin");
  writeFileSync(path.join(cache, "vibe-core", "2.0.0"), "a file, not a version directory");
  mkdirSync(path.join(cache, "vibe-core", "bad version"));
  assert.equal(siblingPluginRoot("vibe-core", { from: from(vibe) }), path.join(cache, "vibe-core", "1.0.10"), "semver order, not listing order");
  assert.equal(siblingPluginRoot("vibe", { from: from(path.join(cache, "vibe-core", "1.0.10")) }), vibe);
  plugin(path.join(cache, "vibe-core", "local"), "vibe-core", "0.0.1", ".codex-plugin");
  assert.equal(siblingPluginRoot("vibe-core", { from: from(vibe) }), path.join(cache, "vibe-core", "local"), "a local install wins");
  rmSync(path.join(cache, "vibe-core"), { recursive: true });
  assert.throws(() => siblingPluginRoot("vibe-core", { from: from(vibe) }), /vibe-core is not installed beside vibe \(codex layout\)/);
});

test("a plugin outside every known layout names where it is", (t) => {
  const vibe = plugin(path.join(base(t), "loose", "vibe"), "vibe", "1.1.69");
  assert.throws(() => siblingPluginRoot("vibe-core", { from: from(vibe) }), /is not in a checkout, Claude Code or Codex plugin layout, so vibe-core cannot be found/);
});

test("Codex's version order: semver precedence, prereleases below releases, build metadata last, then plain text", () => {
  const sorted = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.0+build.1", "1.0.1", "1.10.0"];
  assert.deepEqual([...sorted].reverse().sort(comparePluginVersions), sorted);
  assert.equal(comparePluginVersions("abc", "abd"), -1);
  assert.equal(activeCodexVersion([]), null);
  assert.equal(activeCodexVersion(["1.2.3", "..", "local"]), "local");
  assert.equal(activeCodexVersion(["9", "10"]), "9", "non-semver names compare as text, as Codex does");
});
