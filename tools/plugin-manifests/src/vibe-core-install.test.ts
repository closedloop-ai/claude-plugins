// How vibe-core's loader finds the vibe a session uses (plugins/vibe-core/shared/vibe-install.mjs): found, absent,
// or there but unresolvable, and when a found vibe stands the hooks down.
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HookStandDown, hookStandDown, VibeProblem, vibeLookup } from "../../../plugins/vibe-core/shared/vibe-install.mjs";
import { REPO_ROOT, VIBE_CORE_DIR } from "./vibe-core-bundle.js";

type Entry = { name: string; version: string; hooks?: boolean };

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function base(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vibe-install-")));
  roots.push(root);
  return root;
}

/** A plugin root named `name` at `root`, with a copy of vibe-core's shared modules when it is vibe-core. */
function plugin(root: string, { name, version, hooks }: Entry): string {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version }));
  if (hooks) {
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "hooks.json"), "{}");
  }
  if (name === "vibe-core") cpSync(join(VIBE_CORE_DIR, "shared"), join(root, "shared"), { recursive: true });
  return root;
}

/** A Claude Code or Codex install of `entries` under `home`, keyed `<name>@<version>`. */
function install(home: string, entries: Entry[]): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [`${entry.name}@${entry.version}`,
    plugin(join(home, "plugins", "cache", "closedloop-ai", entry.name, entry.version), entry)]));
}

const registry = (home: string, plugins: Record<string, unknown[]>) =>
  writeFileSync(join(home, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
const user = (installPath: string) => [{ scope: "user", installPath }];
const coreFile = (core: string) => pathToFileURL(join(core, "shared", "vibe-install.mjs")).href;
/** The lookup, then the stand-down, as the vibe-core at `core` computes them for a session in `cwd`. */
function verdict(core: string, cwd: string) {
  const lookup = vibeLookup(cwd, coreFile(core));
  return "install" in lookup && lookup.install ? { root: lookup.install.root, name: lookup.install.name, standDown: hookStandDown(lookup.install, cwd) } : lookup;
}

describe("vibeLookup", () => {
  it("finds vibe's checkout beside this vibe-core", () => {
    expect(vibeLookup(REPO_ROOT, coreFile(VIBE_CORE_DIR))).toMatchObject({ install: { root: realpathSync(join(REPO_ROOT, "plugins", "vibe")) } });
  });

  it("is absent with no vibe, and for a vibe installed only for another project", () => {
    const root = base();
    const home = join(root, "claude");
    const project = join(root, "project");
    mkdirSync(project);
    const roots = install(home, [{ name: "vibe", version: "1.1.80" }, { name: "vibe-core", version: "1.0.15" }]);
    const core = roots["vibe-core@1.0.15"] as string;
    registry(home, { "vibe-core@closedloop-ai": user(core) });
    expect(verdict(core, root)).toEqual({ absent: true });
    registry(home, { "vibe@closedloop-ai": [{ scope: "project", projectPath: project, installPath: roots["vibe@1.1.80"] }], "vibe-core@closedloop-ai": user(core) });
    expect(verdict(core, root)).toEqual({ absent: true });
    expect(verdict(core, project)).toMatchObject({ root: roots["vibe@1.1.80"], standDown: null });
    const codexHome = join(root, "codex");
    const codexCore = install(codexHome, [{ name: "vibe-core", version: "1.0.15" }])["vibe-core@1.0.15"] as string;
    expect(verdict(codexCore, root)).toEqual({ absent: true });
  });

  it("is unresolved when vibe is there but cannot be resolved", () => {
    const root = base();
    const home = join(root, "claude");
    const roots = install(home, [{ name: "vibe", version: "1.1.80" }, { name: "vibe", version: "1.1.81" }, { name: "vibe-core", version: "1.0.15" }]);
    const core = roots["vibe-core@1.0.15"] as string;
    const unresolved = { unresolved: VibeProblem.Unresolved };
    writeFileSync(join(home, "plugins", "installed_plugins.json"), "{ not json");
    expect(verdict(core, root), "an unreadable Claude Code plugin list").toEqual(unresolved);
    registry(home, { "vibe@closedloop-ai": [...user(roots["vibe@1.1.80"] as string), ...user(roots["vibe@1.1.81"] as string)], "vibe-core@closedloop-ai": user(core) });
    expect(verdict(core, root), "two user installs").toEqual(unresolved);
    registry(home, { "vibe@closedloop-ai": user(join(home, "plugins", "cache", "closedloop-ai", "vibe", "9.9.9")), "vibe-core@closedloop-ai": user(core) });
    expect(verdict(core, root), "a recorded install that is gone").toEqual(unresolved);
    const codexHome = join(root, "codex");
    const codexCore = install(codexHome, [{ name: "vibe-core", version: "1.0.15" }])["vibe-core@1.0.15"] as string;
    mkdirSync(join(codexHome, "plugins", "cache", "closedloop-ai", "vibe", "bad version"), { recursive: true });
    expect(verdict(codexCore, root), "a Codex cache folder with no valid version").toEqual(unresolved);
    const loose = plugin(join(root, "loose", "vibe-core"), { name: "vibe-core", version: "1.0.15" });
    expect(verdict(loose, root), "a vibe-core outside every layout").toEqual(unresolved);
  });

  it("prefers an enabled vibe over an unresolved one, and an unresolved one over a disabled one", () => {
    const root = base();
    const home = join(root, "claude");
    const roots = install(home, [{ name: "vibe", version: "1.1.80" }, { name: "vibe", version: "1.1.81" }, { name: "vibe-generic", version: "1.1.80" },
      { name: "vibe-core", version: "1.0.15" }]);
    const core = roots["vibe-core@1.0.15"] as string;
    registry(home, { "vibe@closedloop-ai": [...user(roots["vibe@1.1.80"] as string), ...user(roots["vibe@1.1.81"] as string)],
      "vibe-generic@closedloop-ai": user(roots["vibe-generic@1.1.80"] as string), "vibe-core@closedloop-ai": user(core) });
    expect(verdict(core, root)).toMatchObject({ name: "vibe-generic", standDown: null });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "vibe-generic@closedloop-ai": false } }));
    expect(verdict(core, root)).toEqual({ unresolved: VibeProblem.Unresolved });
  });

  it("finds vibe under either name; with both installed, vibe wins unless it is disabled", () => {
    const root = base();
    const home = join(root, "claude");
    const roots = install(home, [{ name: "vibe", version: "1.1.88" }, { name: "vibe-generic", version: "1.1.88" }, { name: "vibe-core", version: "1.0.15" }]);
    const core = roots["vibe-core@1.0.15"] as string;
    const entry = (name: string) => [`${name}@closedloop-ai`, user(roots[`${name}@1.1.88`] as string)];
    registry(home, Object.fromEntries([entry("vibe-generic"), ["vibe-core@closedloop-ai", user(core)]]));
    expect(verdict(core, root)).toMatchObject({ name: "vibe-generic", root: roots["vibe-generic@1.1.88"] });
    for (const order of [["vibe", "vibe-generic"], ["vibe-generic", "vibe"]]) {
      registry(home, Object.fromEntries([...order.map(entry), ["vibe-core@closedloop-ai", user(core)]]));
      expect(verdict(core, root), order.join(" then ")).toMatchObject({ name: "vibe", root: roots["vibe@1.1.88"] });
    }
    writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "vibe@closedloop-ai": false } }));
    expect(verdict(core, root), "a disabled vibe is passed over").toMatchObject({ name: "vibe-generic" });
    for (const first of ["vibe", "vibe-generic"]) {
      const second = first === "vibe" ? "vibe-generic" : "vibe";
      const codex = install(join(root, `codex-${first}`), [{ name: first, version: "1.1.88" }, { name: second, version: "1.1.88" }, { name: "vibe-core", version: "1.0.15" }]);
      expect(verdict(codex["vibe-core@1.0.15"] as string, root), `codex, ${first} first`).toMatchObject({ name: "vibe", root: codex["vibe@1.1.88"] });
    }
  });

  it("a checkout with both resolves the generic source, plugins/vibe, first", () => {
    const plugins = join(base(), "plugins");
    const core = plugin(join(plugins, "vibe-core"), { name: "vibe-core", version: "1.0.15" });
    plugin(join(plugins, "vibe"), { name: "vibe-generic", version: "1.1.88" });
    plugin(join(plugins, "vibe-closedloop"), { name: "vibe", version: "1.1.88" });
    expect(verdict(core, plugins)).toEqual({ name: "vibe-generic", root: join(plugins, "vibe"), standDown: null });
  });
});

describe("hookStandDown", () => {
  it("stands down while the installed vibe still registers its own hooks", () => {
    const root = base();
    const checkout = { root, layout: "checkout", name: "vibe" };
    expect(hookStandDown(checkout, root), "a vibe without hooks/hooks.json leaves the hooks to vibe-core").toBeNull();
    mkdirSync(join(root, "hooks"));
    writeFileSync(join(root, "hooks", "hooks.json"), "{}");
    expect(hookStandDown(checkout, root)).toBe(HookStandDown.VibeOwnsHooks);
  });

  it("Claude Code: an old project vibe keeps its own hooks there, a disabled vibe stands down, and a project's setting wins", () => {
    const root = base();
    const home = join(root, "claude");
    const project = join(root, "old-project");
    const other = join(root, "other");
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(other);
    const roots = install(home, [{ name: "vibe", version: "1.1.70", hooks: true }, { name: "vibe", version: "1.1.71" }, { name: "vibe-core", version: "1.0.15" }]);
    const core = roots["vibe-core@1.0.15"] as string;
    registry(home, {
      "vibe@closedloop-ai": [{ scope: "project", projectPath: project, installPath: roots["vibe@1.1.70"] }, ...user(roots["vibe@1.1.71"] as string)],
      "vibe-core@closedloop-ai": user(core),
    });
    expect(verdict(core, join(project, "src")), "the old vibe runs these guards in its project").toMatchObject({ standDown: HookStandDown.VibeOwnsHooks });
    expect(verdict(core, other), "elsewhere the new vibe's hooks are vibe-core's").toMatchObject({ standDown: null });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "vibe@closedloop-ai": false } }));
    expect(verdict(core, other)).toMatchObject({ standDown: HookStandDown.VibeDisabled });
    mkdirSync(join(other, ".claude"));
    writeFileSync(join(other, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "vibe@closedloop-ai": true } }));
    expect(verdict(core, other), "a project's own setting wins over the user's").toMatchObject({ standDown: null });
  });

  it("Codex: a vibe disabled in config.toml stands down; another plugin's setting does not", () => {
    const root = base();
    const home = join(root, "codex");
    const core = install(home, [{ name: "vibe", version: "1.1.71" }, { name: "vibe-core", version: "1.0.15" }])["vibe-core@1.0.15"] as string;
    expect(verdict(core, root), "no config.toml: enabled").toMatchObject({ standDown: null });
    writeFileSync(join(home, "config.toml"), '[plugins."vibe-core@closedloop-ai"]\nenabled = false\n\n[plugins."vibe@closedloop-ai"]\nenabled = true\n');
    expect(verdict(core, root)).toMatchObject({ standDown: null });
    writeFileSync(join(home, "config.toml"), 'model = "m"\n[plugins."vibe@closedloop-ai"]  # vibe\nenabled = false\n[other]\nenabled = true\n');
    expect(verdict(core, root)).toMatchObject({ standDown: HookStandDown.VibeDisabled });
    writeFileSync(join(home, "config.toml"), "[plugins.'vibe@closedloop-ai']\nenabled = false\n");
    expect(verdict(core, root), "a single-quoted key names the same plugin").toMatchObject({ standDown: HookStandDown.VibeDisabled });
  });
});
