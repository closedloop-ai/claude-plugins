// vibe's install as vibe-core reads it: data only (its name, its version, its skill
// definitions, which of its scripts exist, whether the harness has it enabled).
// vibe-core never imports or runs a file under vibe's root. vibe is published as
// vibe-generic and as the build of it named vibe; whichever is installed is vibe here.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Layout, pluginInstall, siblingInstalls, siblingPluginInstall, vibeLookupOrder } from "./plugin-roots.mjs";

/** Why vibe-core's hooks stand down, or null when they should run. */
export const HookStandDown = Object.freeze({
  NoVibe: "vibe is not installed",
  VibeDisabled: "the installed vibe is disabled",
  VibeOwnsHooks: "the installed vibe still registers its own hooks",
});

const CODEX_SECTION = /^\s*\[\s*plugins\s*\.\s*(?:"([^"]+)"|'([^']+)')\s*\]\s*(?:#.*)?$/;
const ANY_SECTION = /^\s*\[/;
const CODEX_ENABLED = /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/;

/**
 * The vibe install a session in `cwd` uses beside the vibe-core holding `from`, with its plugin `name`, or null when
 * there is none. With both names installed, the first enabled one in vibeLookupOrder: vibe in an install, vibe-generic
 * in a checkout.
 */
export function vibeInstall(cwd = process.cwd(), from = import.meta.url) {
  const found = siblingInstalls(vibeLookupOrder(pluginInstall(from).layout), { from, cwd });
  return found.find((install) => pluginEnabled(install.name, install, cwd)) ?? found[0] ?? null;
}

/** vibe's install root beside this vibe-core; throws with the fix when vibe is not installed. */
export function vibeRoot(cwd = process.cwd(), from = import.meta.url) {
  // With neither installed, the lookup of the build's name, vibe, throws the install commands.
  return vibeInstall(cwd, from)?.root ?? siblingPluginInstall("vibe", { from, cwd }).root;
}

/** `<installed vibe's name>:<skill>`, the id a harness gives `skill` of the vibe beside this vibe-core. */
export function vibeSkill(skill, cwd = process.cwd()) {
  return `${vibeInstall(cwd)?.name ?? "vibe"}:${skill}`;
}

/** vibe's install root, or null when vibe is not installed beside this vibe-core. */
export function vibeRootOrNull(cwd = process.cwd()) {
  return vibeInstall(cwd)?.root ?? null;
}

/** The path of vibe script `relative` (for example "skills/vibe/scripts/plugin-version.mjs") to print in a command, never to run. */
export function vibeScriptPath(relative, cwd = process.cwd()) {
  return path.join(vibeRootOrNull(cwd) ?? "<vibe plugin root>", relative);
}

/**
 * Whether the harness has vibe enabled (under the name `install` carries), read from its own settings files: false
 * only when one says so. Claude Code: `enabledPlugins["vibe@<marketplace>"]` in the user settings, then each `.claude/settings.json`
 * and `.claude/settings.local.json` from the filesystem root down to `cwd`, the nearer one winning (managed
 * settings and a `--settings` flag are not visible here). Codex: `[plugins."vibe@<marketplace>"] enabled` in
 * CODEX_HOME's config.toml (a `-c` override or a project config layer is not visible here). A checkout is enabled.
 */
export function vibeEnabled(install, cwd = process.cwd()) {
  return pluginEnabled(install?.name ?? "vibe", install, cwd);
}

/** `vibeEnabled` for any plugin `name` installed (as `install`) in vibe's marketplace. */
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
 * Why vibe-core's hooks should stand down for `install` (vibe's, or null), or null when they should run:
 * with no vibe, or a disabled one, there is nothing to guard, and a vibe from before the split (1.1.70 or
 * older) still runs its own copy of these hooks, so running both would apply every guard twice.
 */
export function hookStandDown(install = vibeInstall(), cwd = process.cwd()) {
  if (!install) return HookStandDown.NoVibe;
  if (!vibeEnabled(install, cwd)) return HookStandDown.VibeDisabled;
  return existsSync(path.join(install.root, "hooks", "hooks.json")) ? HookStandDown.VibeOwnsHooks : null;
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
