// The vibe install a session uses, as vibe's own hooks and scripts name it: data only (its root, name and version,
// which of its skills and scripts exist). In Claude Code a project install wins inside its project, so the lookup
// takes the session's directory, as vibe-core's loader does when it picks which vibe's hooks/runtime.mjs to run.
// With no install found in this plugin's layout, it is this plugin itself.

import { readFileSync } from "node:fs";
import path from "node:path";
import { isVibePlugin, Layout, pluginInstall, siblingInstalls, vibeLookupOrder } from "./plugin-roots.mjs";

const CODEX_SECTION = /^\s*\[\s*plugins\s*\.\s*(?:"([^"]+)"|'([^']+)')\s*\]\s*(?:#.*)?$/;
const ANY_SECTION = /^\s*\[/;
const CODEX_ENABLED = /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/;

/**
 * The vibe install a session in `cwd` uses, with its plugin `name`: with both names installed, the first enabled one
 * in the lookup order of this plugin's layout (vibe in an install, vibe-generic in a checkout), as vibe-core's loader
 * picks it; with none found, this plugin when it is a vibe, else null.
 */
export function vibeInstall(cwd = process.cwd(), from = import.meta.url) {
  const own = pluginInstall(from);
  const found = siblingInstalls(vibeLookupOrder(own.layout), { from, cwd });
  return found.find((install) => pluginEnabled(install.name, install, cwd)) ?? found[0] ?? (isVibePlugin(own.name) ? own : null);
}

/** That vibe's root; throws when there is none. */
export function vibeRoot(cwd = process.cwd(), from = import.meta.url) {
  const install = vibeInstall(cwd, from);
  if (!install) throw new Error(`no vibe install is found from ${from}`);
  return install.root;
}

/** `<that vibe's name>:<skill>`, the id a harness gives `skill`. */
export function vibeSkill(skill, cwd = process.cwd()) {
  return `${vibeInstall(cwd)?.name ?? "vibe"}:${skill}`;
}

/** That vibe's root, or null when there is none. */
export function vibeRootOrNull(cwd = process.cwd()) {
  return vibeInstall(cwd)?.root ?? null;
}

/** The path of vibe script `relative` (for example "skills/vibe/scripts/plugin-version.mjs") to print in a command, never to run. */
export function vibeScriptPath(relative, cwd = process.cwd()) {
  return path.join(vibeRootOrNull(cwd) ?? "<vibe plugin root>", relative);
}

/**
 * Whether the harness has plugin `name` (installed as `install`) enabled, read from its own settings files: false only
 * when one says so. Claude Code: `enabledPlugins["<name>@<marketplace>"]` in the user settings, then each project's
 * `.claude/settings.json` and `.claude/settings.local.json` down to `cwd`, the nearer winning. Codex:
 * `[plugins."<name>@<marketplace>"] enabled` in CODEX_HOME's config.toml. A checkout is enabled.
 */
function pluginEnabled(name, install, cwd = process.cwd()) {
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
