// Which script paths in prompt or brief text name a vibe plugin script, and
// which of those the installed release no longer has. Shared by the
// PreToolUse version guard, fleet prompt preflight and the Claude worker
// launcher, so all three classify a path the same way (PR #371 review: a
// repository's own `.claude/skills/control/scripts/app.mjs` was refused as a
// missing vibe script).

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const TOKEN = /[^\s'"`()<>=]+/g;
const SCRIPT_PATH = /^(.*?)(?:^|\/)(?:(skills)\/)?([a-z0-9][a-z0-9-]*)\/scripts\/([a-z0-9_./-]+\.(?:mjs|js|cjs|ts|py|sh))$/i;
const TRAILING = /(?::\d+){1,2}$|[),:.;\]]+$/;

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return null; }
}

function isDirectory(dir) {
  try { return statSync(dir).isDirectory(); }
  catch { return false; }
}

/** Installed vibe manifest version at one exact plugin root. */
export function installedPluginVersion(pluginRoot) {
  for (const relative of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
    const version = readJson(path.join(pluginRoot, relative))?.version;
    if (typeof version === "string") return version;
  }
  return null;
}

/** Whether `dir` is a vibe plugin root of any release (an installed cache, a source checkout). */
export function isVibePluginRoot(dir) {
  return [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"].some((relative) => readJson(path.join(dir, relative))?.name === "vibe");
}

function trimToken(token) {
  let value = token;
  for (let previous = ""; previous !== value;) {
    previous = value;
    value = value.replace(TRAILING, "");
  }
  return value;
}

/** A prefix of only `.` and `..` segments is how skill files reference a sibling skill's scripts. */
function relativeOnly(prefix) {
  return prefix === "" || prefix.split("/").every((segment) => segment === "." || segment === "..");
}

/**
 * Vibe plugin script references in `text`, normalized to `skills/<skill>/scripts/<file>`.
 * A path counts only when <skill> is a skill of the installed plugin and either it has no
 * directory prefix (or only `./`/`../`) and does not exist in the target repository, or its
 * prefix is itself a vibe plugin root. A repository path such as
 * `.claude/skills/control/scripts/app.mjs` is never a plugin reference.
 */
export function pluginScriptReferences(text, pluginRoot, worktree = null) {
  const refs = [];
  for (const [token] of String(text ?? "").matchAll(TOKEN)) {
    const match = SCRIPT_PATH.exec(trimToken(token));
    if (!match) continue;
    const [candidate, prefix, explicit, skill, rest] = match;
    if (!isDirectory(path.join(pluginRoot, "skills", skill))) continue;
    if (relativeOnly(prefix)) {
      if (worktree && existsSync(path.resolve(worktree, candidate))) continue;
    } else {
      const base = path.resolve(worktree ?? "/", prefix);
      if (!explicit || !isVibePluginRoot(base)) continue;
    }
    const relative = `skills/${skill}/scripts/${rest}`;
    if (!refs.includes(relative)) refs.push(relative);
  }
  return refs;
}

/** Missing, unsafe or non-file vibe plugin script references in `text`. */
export function pluginScriptProblems(text, pluginRoot, worktree = null) {
  const root = realpathSync(pluginRoot);
  const problems = [];
  for (const relative of pluginScriptReferences(text, root, worktree)) {
    if (relative.split("/").includes("..")) {
      problems.push(`${relative}: plugin script path escapes its installed root`);
      continue;
    }
    const candidate = path.resolve(root, relative);
    if (candidate === root || !candidate.startsWith(`${root}${path.sep}`) || !existsSync(candidate)) {
      problems.push(`${relative}: plugin script does not exist in installed vibe ${installedPluginVersion(root) ?? "unknown"}`);
      continue;
    }
    try {
      const canonical = realpathSync(candidate);
      if (!canonical.startsWith(`${root}${path.sep}`) || !lstatSync(canonical).isFile()) problems.push(`${relative}: plugin script is not a contained regular file`);
    } catch {
      problems.push(`${relative}: plugin script cannot be verified`);
    }
  }
  return problems;
}
