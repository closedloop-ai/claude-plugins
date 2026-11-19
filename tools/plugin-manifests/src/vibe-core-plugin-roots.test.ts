// vibe-core's plugin-roots.mjs is pinned with its bundle; vibe's copy may change with vibe. Both must resolve
// the same layouts, so every layout case runs against each copy.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as coreRoots from "../../../plugins/vibe-core/shared/plugin-roots.mjs";
import * as vibeRoots from "../../../plugins/vibe/shared/plugin-roots.mjs";
import { REPO_ROOT } from "./vibe-core-bundle.js";

type Resolver = Pick<typeof vibeRoots, "activeCodexVersion" | "comparePluginVersions" | "DEFAULT_MARKETPLACE" | "isEntryPoint"
  | "isVibePlugin" | "pluginInstall" | "pluginMarketplace" | "siblingPluginRoot" | "siblingPluginRootOrNull" | "vibeSkillOf"
  | "vibeSkillPattern">;

const COPIES: Array<[string, string, Resolver]> = [
  ["vibe-core", join(REPO_ROOT, "plugins", "vibe-core", "shared", "plugin-roots.mjs"), coreRoots],
  ["vibe", join(REPO_ROOT, "plugins", "vibe", "shared", "plugin-roots.mjs"), vibeRoots],
];
const IMPORT = /^\s*import\s[^;]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*export\s[^;]*?from\s*["']([^"']+)["']/gm;

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function base(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plugin-roots-")));
  roots.push(root);
  return root;
}

const registry = (config: string, plugins: Record<string, unknown[]>) => {
  mkdirSync(join(config, "plugins"), { recursive: true });
  writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
};

describe.each(COPIES)("plugins/%s/shared/plugin-roots.mjs", (_name, source, r) => {
  /** A plugin at `root` named `name`, holding a copy of the resolver so the lookup runs from inside it. */
  function plugin(root: string, name: string, version: string, manifest = ".claude-plugin"): string {
    mkdirSync(join(root, manifest), { recursive: true });
    writeFileSync(join(root, manifest, "plugin.json"), JSON.stringify({ name, version }));
    mkdirSync(join(root, "shared"), { recursive: true });
    cpSync(source, join(root, "shared", "plugin-roots.mjs"));
    return root;
  }
  const from = (root: string) => pathToFileURL(join(root, "shared", "plugin-roots.mjs")).href;

  it("imports only node builtins", () => {
    const specifiers = [...readFileSync(source, "utf8").matchAll(IMPORT)].map((match) => match[1] ?? match[2] ?? match[3]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => !specifier?.startsWith("node:"))).toEqual([]);
  });

  it("repository checkout: the sibling is plugins/<name> beside the caller's plugin", () => {
    const plugins = join(base(), "repo", "plugins");
    const vibe = plugin(join(plugins, "vibe"), "vibe", "1.1.71");
    const core = plugin(join(plugins, "vibe-core"), "vibe-core", "1.0.0");
    expect(r.siblingPluginRoot("vibe-core", { from: from(vibe) })).toBe(core);
    expect(r.siblingPluginRoot("vibe", { from: from(core) })).toBe(vibe);
    expect(r.siblingPluginRoot("vibe-core", { from: join(vibe, ".claude-plugin", "plugin.json") }), "a path inside the plugin works too").toBe(core);
    rmSync(core, { recursive: true });
    expect(() => r.siblingPluginRoot("vibe-core", { from: from(vibe) })).toThrow(
      new RegExp("^vibe-core is not installed beside vibe \\(checkout layout\\); install it with "
        + "`claude plugin install vibe-core@closedloop-ai` in Claude Code or `codex plugin add vibe-core@closedloop-ai` in Codex$"));
    expect(r.siblingPluginRootOrNull("vibe-core", { from: from(vibe) })).toBeNull();
  });

  it("Claude Code: installed_plugins.json picks the version, never the cache's directory listing", () => {
    const config = join(base(), "claude");
    const cache = join(config, "plugins", "cache", "closedloop-ai");
    const vibe = plugin(join(cache, "vibe", "1.1.71"), "vibe", "1.1.71");
    plugin(join(cache, "vibe", "1.1.70"), "vibe", "1.1.70");
    const installedCore = plugin(join(cache, "vibe-core", "1.0.0"), "vibe-core", "1.0.0");
    // Newer and lexically later versions sit in the cache too (left behind, or not yet active).
    plugin(join(cache, "vibe-core", "1.0.1"), "vibe-core", "1.0.1");
    plugin(join(cache, "vibe-core", "2.0.0"), "vibe-core", "2.0.0");
    registry(config, {
      "vibe@closedloop-ai": [{ scope: "user", installPath: vibe, version: "1.1.71" }],
      "vibe-core@closedloop-ai": [{ scope: "user", installPath: installedCore, version: "1.0.0" }],
    });
    expect(r.siblingPluginRoot("vibe-core", { from: from(vibe) })).toBe(installedCore);
    expect(r.siblingPluginRoot("vibe", { from: from(installedCore) }), "vibe-core finds vibe's install the same way").toBe(vibe);
    registry(config, { "vibe@closedloop-ai": [{ scope: "user", installPath: vibe }] });
    expect(() => r.siblingPluginRoot("vibe-core", { from: from(vibe) })).toThrow(/vibe-core is not installed beside vibe \(claude layout\)/);
    registry(config, { "vibe@closedloop-ai": [{ scope: "user", installPath: vibe }], "vibe-core@closedloop-ai": [{ scope: "user", installPath: join(cache, "vibe-core", "9.9.9") }] });
    expect(() => r.siblingPluginRoot("vibe-core", { from: from(vibe) }), "a recorded path that is gone").toThrow(/vibe-core is not installed beside vibe \(claude layout\)/);
    registry(config, { "vibe-core@closedloop-ai": [{ scope: "user", installPath: installedCore }, { scope: "user", installPath: join(cache, "vibe-core", "1.0.1") }] });
    expect(() => r.siblingPluginRoot("vibe-core", { from: from(vibe) })).toThrow(/more than one Claude Code user install/);
  });

  it("Claude Code: the session's project decides, local before project before user", () => {
    const root = base();
    const config = join(root, "claude");
    const cache = join(config, "plugins", "cache", "closedloop-ai");
    const [p1, p2, elsewhere] = ["p1", "p2", "elsewhere"].map((name) => {
      mkdirSync(join(root, name, "src"), { recursive: true });
      return join(root, name);
    }) as [string, string, string];
    const vibeP1 = plugin(join(cache, "vibe", "1.1.72"), "vibe", "1.1.72");
    const vibeP2 = plugin(join(cache, "vibe", "1.1.71"), "vibe", "1.1.71");
    const core = plugin(join(cache, "vibe-core", "1.0.0"), "vibe-core", "1.0.0");
    registry(config, {
      "vibe@closedloop-ai": [{ scope: "project", projectPath: p1, installPath: vibeP1 }, { scope: "project", projectPath: p2, installPath: vibeP2 }],
      "vibe-core@closedloop-ai": [{ scope: "user", installPath: core }],
    });
    expect(r.siblingPluginRoot("vibe", { from: from(core), cwd: join(p1, "src") })).toBe(vibeP1);
    expect(r.siblingPluginRoot("vibe", { from: from(core), cwd: p2 })).toBe(vibeP2);
    expect(() => r.siblingPluginRoot("vibe", { from: from(core), cwd: elsewhere }), "vibe installed only for other projects is not this session's vibe")
      .toThrow(/vibe is not installed beside vibe-core \(claude layout\)/);
    expect(r.siblingPluginRoot("vibe-core", { from: from(vibeP1), cwd: join(p1, "src") }), "user vibe-core serves a project vibe").toBe(core);
    registry(config, { "vibe@closedloop-ai": [{ scope: "project", projectPath: p2, installPath: vibeP2 }], "vibe-core@closedloop-ai": [{ scope: "user", installPath: core }] });
    expect(r.siblingPluginRootOrNull("vibe", { from: from(core), cwd: elsewhere })).toBeNull();
    expect(r.siblingPluginRoot("vibe", { from: from(core), cwd: p2 })).toBe(vibeP2);
    const nested = join(p1, "src");
    registry(config, {
      "vibe@closedloop-ai": [{ scope: "user", installPath: vibeP2 }, { scope: "project", projectPath: p1, installPath: vibeP1 }],
      "vibe-core@closedloop-ai": [{ scope: "user", installPath: core }],
    });
    expect(r.siblingPluginRoot("vibe", { from: from(core), cwd: nested })).toBe(vibeP1);
    expect(r.siblingPluginRoot("vibe", { from: from(core), cwd: elsewhere })).toBe(vibeP2);
    registry(config, {
      "vibe@closedloop-ai": [{ scope: "project", projectPath: p1, installPath: vibeP2 }, { scope: "project", projectPath: nested, installPath: vibeP1 },
        { scope: "local", projectPath: p1, installPath: vibeP2 }],
      "vibe-core@closedloop-ai": [{ scope: "user", installPath: core }],
    });
    expect(r.siblingPluginRoot("vibe", { from: from(core), cwd: nested }), "local first").toBe(vibeP2);
    registry(config, {
      "vibe@closedloop-ai": [{ scope: "project", projectPath: p1, installPath: vibeP2 }, { scope: "project", projectPath: nested, installPath: vibeP1 }],
      "vibe-core@closedloop-ai": [{ scope: "user", installPath: core }],
    });
    expect(r.siblingPluginRoot("vibe", { from: from(core), cwd: nested }), "the deepest project").toBe(vibeP1);
  });

  it("Codex: the active version is the one Codex itself picks", () => {
    const cache = join(base(), "codex", "plugins", "cache", "closedloop-ai");
    const vibe = plugin(join(cache, "vibe", "1.1.71"), "vibe", "1.1.71", ".codex-plugin");
    for (const version of ["1.0.9", "1.0.10", "1.0.10-beta.2"]) plugin(join(cache, "vibe-core", version), "vibe-core", version, ".codex-plugin");
    writeFileSync(join(cache, "vibe-core", "2.0.0"), "a file, not a version directory");
    mkdirSync(join(cache, "vibe-core", "bad version"));
    expect(r.siblingPluginRoot("vibe-core", { from: from(vibe) }), "semver order, not listing order").toBe(join(cache, "vibe-core", "1.0.10"));
    expect(r.siblingPluginRoot("vibe", { from: from(join(cache, "vibe-core", "1.0.10")) })).toBe(vibe);
    plugin(join(cache, "vibe-core", "local"), "vibe-core", "0.0.1", ".codex-plugin");
    expect(r.siblingPluginRoot("vibe-core", { from: from(vibe) }), "a local install wins").toBe(join(cache, "vibe-core", "local"));
    rmSync(join(cache, "vibe-core"), { recursive: true });
    expect(() => r.siblingPluginRoot("vibe-core", { from: from(vibe) })).toThrow(/vibe-core is not installed beside vibe \(codex layout\)/);
  });

  it("a plugin outside every known layout names where it is", () => {
    const vibe = plugin(join(base(), "loose", "vibe"), "vibe", "1.1.71");
    expect(() => r.siblingPluginRoot("vibe-core", { from: from(vibe) })).toThrow(/is not in a checkout, Claude Code or Codex plugin layout, so vibe-core cannot be found/);
  });

  it("Codex's version order: semver precedence, prereleases below releases, build metadata last, then plain text", () => {
    const sorted = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.0+build.1", "1.0.1", "1.10.0"];
    expect([...sorted].reverse().sort(r.comparePluginVersions)).toEqual(sorted);
    expect(r.comparePluginVersions("abc", "abd")).toBe(-1);
    expect(r.activeCodexVersion([])).toBeNull();
    expect(r.activeCodexVersion(["1.2.3", "..", "local"])).toBe("local");
    expect(r.activeCodexVersion(["9", "10"]), "non-semver names compare as text, as Codex does").toBe("9");
  });

  it("a script is its own entry point by real path, through a symlinked directory too", () => {
    const root = base();
    mkdirSync(join(root, "real"));
    const script = join(root, "real", "script.mjs");
    writeFileSync(script, "");
    symlinkSync(join(root, "real"), join(root, "linked"));
    const url = pathToFileURL(script).href;
    expect(r.isEntryPoint(url, script)).toBe(true);
    expect(r.isEntryPoint(url, join(root, "linked", "script.mjs")), "node names the module by its real path, argv by the link").toBe(true);
    expect(r.isEntryPoint(url, relative(process.cwd(), script)), "a relative argv resolves against the working directory").toBe(true);
    expect(r.isEntryPoint(url, join(root, "real", "other.mjs"))).toBe(false);
    expect(r.isEntryPoint(url, join(root, "missing", "script.mjs")), "a path that does not exist is compared as written").toBe(false);
    expect(r.isEntryPoint(url, undefined)).toBe(false);
    expect(r.isEntryPoint(url, "")).toBe(false);
  });

  it("a checkout finds a sibling by its manifest name: plugins/vibe is vibe-generic, plugins/vibe-closedloop is vibe", () => {
    const plugins = join(base(), "repo", "plugins");
    const generic = plugin(join(plugins, "vibe"), "vibe-generic", "1.1.88");
    const built = plugin(join(plugins, "vibe-closedloop"), "vibe", "1.1.88");
    const core = plugin(join(plugins, "vibe-core"), "vibe-core", "1.0.10");
    expect(r.siblingPluginRoot("vibe-generic", { from: from(core) })).toBe(generic);
    expect(r.siblingPluginRoot("vibe", { from: from(core) }), "the folder named vibe holds vibe-generic, so vibe is the one whose manifest says so").toBe(built);
    expect(r.siblingPluginRoot("vibe-core", { from: from(generic) })).toBe(core);
    expect(r.siblingPluginRoot("vibe-core", { from: from(built) })).toBe(core);
    expect(r.pluginMarketplace(r.pluginInstall(from(generic))), "a checkout names no marketplace").toBe(r.DEFAULT_MARKETPLACE);
  });

  it("a cache install names its own marketplace, in its install hints too, for either vibe name", () => {
    for (const name of ["vibe", "vibe-generic"]) {
      const cache = join(base(), "codex", "plugins", "cache", "team-market");
      const vibe = plugin(join(cache, name, "1.1.88"), name, "1.1.88", ".codex-plugin");
      const self = r.pluginInstall(from(vibe));
      expect([self.name, r.pluginMarketplace(self)]).toEqual([name, "team-market"]);
      expect(() => r.siblingPluginRoot("vibe-core", { from: from(vibe) })).toThrow(new RegExp(`^vibe-core is not installed beside ${name} \\(codex layout\\); `
        + "install it with `claude plugin install vibe-core@team-market` in Claude Code or `codex plugin add vibe-core@team-market` in Codex$"));
    }
  });

  it("both vibe names are vibe: plugin names and skill ids", () => {
    expect(["vibe", "vibe-generic", "vibe-core", "vibe-closedloop", undefined].map(r.isVibePlugin)).toEqual([true, true, false, false, false]);
    expect(["vibe:handoff", "vibe-generic:vibe-change-worker", "vibe-core:handoff", "other:vibe", "vibe", null].map(r.vibeSkillOf))
      .toEqual(["handoff", "vibe-change-worker", null, null, null, null]);
    const starts = new RegExp(`^/${r.vibeSkillPattern("vibe")}$`);
    expect(["/vibe:vibe", "/vibe-generic:vibe", "/vibe-core:vibe", "/vibe:vibe-x"].map((text) => starts.test(text))).toEqual([true, true, false, false]);
  });
});
