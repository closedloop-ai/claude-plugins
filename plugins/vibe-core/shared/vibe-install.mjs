// Which vibe install a session uses, as vibe-core's loader (hooks/vibe-runtime.mjs) reads it: data only (its
// name, its version, whether the harness has it enabled, whether it still registers its own hooks). The loader
// then imports that install's hooks/runtime.mjs, so vibe's guard code runs from vibe's install. Codex's hook
// approval covers vibe-core's files, the loader; it does not cover the guard code the loader runs from vibe.
// vibe is published as vibe-generic and as the build of it named vibe; whichever is installed is vibe here.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDirectory, Layout, pluginInstall, realOrSame, siblingPluginInstall, vibeLookupOrder } from "./plugin-roots.mjs";

/** Why vibe-core's hooks stand down, or null when they should run. */
export const HookStandDown = Object.freeze({
  VibeDisabled: "the installed vibe is disabled",
  VibeOwnsHooks: "the installed vibe still registers its own hooks",
});

/** The reasons the loader names when vibe's guards cannot run: short phrases for the degraded notice. */
export const VibeProblem = Object.freeze({
  Older: "vibe is older than vibe-core",
  Newer: "vibe is newer than this vibe-core",
  Incomplete: "vibe's files are incomplete",
  Unresolved: "vibe's install couldn't be read",
  Failed: "vibe stopped with an error",
});

const CODEX_SECTION = /^\s*\[\s*plugins\s*\.\s*(?:"([^"]+)"|'([^']+)')\s*\]\s*(?:#.*)?$/;
const ANY_SECTION = /^\s*\[/;
const CODEX_ENABLED = /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/;
const PROJECT_SCOPES = Object.freeze(["local", "project"]);

/**
 * The vibe install a session in `cwd` uses beside the vibe-core holding `from`: `{ install }` (with its plugin
 * `name`), `{ absent: true }` when no vibe is installed for this session, or `{ unresolved: reason }` when one is
 * there but cannot be resolved (an unreadable Claude Code plugin list, two user installs, a recorded install or
 * Codex cache folder that holds no matching plugin, or a vibe-core outside every layout). With both names found,
 * the first enabled one in vibeLookupOrder wins; with none enabled, an unresolved name outranks a disabled one.
 */
export function vibeLookup(cwd = process.cwd(), from = import.meta.url) {
  let self;
  try {
    self = pluginInstall(from);
  } catch {
    return { unresolved: VibeProblem.Unresolved };
  }
  if (self.layout === null) return { unresolved: VibeProblem.Unresolved };
  const found = [];
  let unresolved = false;
  for (const name of vibeLookupOrder(self.layout)) {
    try {
      found.push({ ...siblingPluginInstall(name, { from, cwd }), name });
    } catch {
      unresolved ||= isPresent(self, name, cwd);
    }
  }
  const enabled = found.find((install) => pluginEnabled(install.name, install, cwd));
  if (enabled) return { install: enabled };
  if (unresolved) return { unresolved: VibeProblem.Unresolved };
  return found.length > 0 ? { install: found[0] } : { absent: true };
}

/**
 * Whether the harness has `name` (installed as `install`, from vibe's marketplace) enabled, read from its own
 * settings files: false only when one says so. Claude Code: `enabledPlugins["<name>@<marketplace>"]` in the user
 * settings, then each `.claude/settings.json` and `.claude/settings.local.json` from the filesystem root down to
 * `cwd`, the nearer one winning (managed settings and a `--settings` flag are not visible here). Codex:
 * `[plugins."<name>@<marketplace>"] enabled` in CODEX_HOME's config.toml (a `-c` override or a project config
 * layer is not visible here). A checkout is enabled.
 */
export function pluginEnabled(name, install, cwd = process.cwd()) {
  const id = `${name}@${install?.marketplace}`;
  if (install?.layout === Layout.Claude) {
    let enabled = true;
    for (const file of claudeSettingsFiles(install.home, cwd)) {
      const value = readJson(file)?.enabledPlugins?.[id];
      if (typeof value === "boolean") enabled = value;
    }
    return enabled;
  }
  if (install?.layout === Layout.Codex) return codexEnabled(path.join(install.home, "config.toml"), id) !== false;
  return true;
}

/**
 * Why vibe-core's hooks should stand down for the found `install`, or null when they should run: a disabled vibe
 * has nothing to guard, and a vibe from before the split (1.1.70 or older) still runs its own copy of these hooks,
 * so running both would apply every guard twice.
 */
export function hookStandDown(install, cwd = process.cwd()) {
  if (!pluginEnabled(install.name ?? "vibe", install, cwd)) return HookStandDown.VibeDisabled;
  return existsSync(path.join(install.root, "hooks", "hooks.json")) ? HookStandDown.VibeOwnsHooks : null;
}

/**
 * Whether plugin `name`, which siblingPluginInstall could not resolve, is installed for a session in `cwd` all the
 * same: a Claude Code plugin list that cannot be read, or one with an entry this session would load; a Codex cache
 * folder for it. A checkout lookup fails only when no folder holds it.
 */
function isPresent(self, name, cwd) {
  if (self.layout === Layout.Codex) return isDirectory(path.join(self.cacheDir, self.marketplace, name));
  if (self.layout !== Layout.Claude) return false;
  let registry;
  try {
    registry = JSON.parse(readFileSync(self.registry, "utf8"));
  } catch {
    return true;
  }
  const entries = registry?.plugins?.[`${name}@${self.marketplace}`];
  if (!Array.isArray(entries)) return false;
  const here = realOrSame(path.resolve(cwd));
  const holds = (project) => typeof project === "string" && (here === realOrSame(project) || here.startsWith(`${realOrSame(project)}${path.sep}`));
  return entries.some((entry) => entry?.scope === "user" || (PROJECT_SCOPES.includes(entry?.scope) && holds(entry.projectPath)));
}

function claudeSettingsFiles(home, cwd) {
  const projects = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    projects.unshift(path.join(dir, ".claude", "settings.json"), path.join(dir, ".claude", "settings.local.json"));
    if (path.dirname(dir) === dir) break;
  }
  return [...new Set([path.join(home, "settings.json"), ...projects])];
}

function codexEnabled(file, id) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let inSection = false;
  for (const line of text.split("\n")) {
    const section = CODEX_SECTION.exec(line);
    if (section) {
      inSection = (section[1] ?? section[2]) === id;
      continue;
    }
    if (ANY_SECTION.test(line)) {
      inSection = false;
      continue;
    }
    const enabled = inSection ? CODEX_ENABLED.exec(line) : null;
    if (enabled) return enabled[1] === "true";
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
