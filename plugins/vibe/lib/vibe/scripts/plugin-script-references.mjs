// Which script paths in prompt or brief text name a vibe plugin script, and
// which of those the installed release no longer has. Shared by the
// PreToolUse version guard, fleet prompt preflight and the Claude worker
// launcher, so all three classify a path the same way (PR #371 review: a
// repository's own `.claude/skills/control/scripts/app.mjs` was refused as a
// missing vibe script).

import { readGitInventory } from "./git-inventory.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isVibePlugin } from "../../../shared/plugin-roots.mjs";

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
  return [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"].some((relative) => isVibePlugin(readJson(path.join(dir, relative))?.name));
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

function repositoryScope(worktree) {
  if (!worktree) return null;
  let cwd;
  try { cwd = realpathSync(worktree); }
  catch { return null; }
  try {
    const root = realpathSync(gitScope(cwd, ["rev-parse", "--show-toplevel"]).trim());
    return { cwd, root, git: true };
  } catch { return { cwd, root: cwd, git: false }; }
}

function gitScope(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 2500,
    maxBuffer: 512 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

function containedFile(absolute, root) {
  try {
    const resolved = realpathSync(absolute);
    return resolved.startsWith(`${root}${path.sep}`) && lstatSync(resolved).isFile();
  } catch { return false; }
}

/** A path can be relative to the dispatch cwd or to its verified Git root. */
function existsInWorktree(candidate, scope) {
  return scope && [scope.cwd, scope.root].some((directory) => containedFile(path.resolve(directory, candidate), scope.root));
}

/** Only a unique, contained repository suffix can resolve an otherwise missing script shorthand. */
function uniqueRepositoryShorthand(scope, suffix) {
  if (!scope?.git || suffix.split("/").some((segment) => !segment || segment === "." || segment === "..")) return false;
  try {
    const matches = readGitInventory(scope.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", `:(glob)**/${suffix}`], { timeout: 2500 });
    const existing = new Set(matches.split("\0").filter((file) => file && containedFile(path.resolve(scope.root, file), scope.root)));
    return existing.size === 1;
  } catch { return false; }
}

/** Whether a vibe plugin root lies inside the session worktree's verified Git checkout. */
function ownSourceRoot(base, scope) {
  if (!scope?.git) return false;
  try {
    const resolved = realpathSync(base);
    return resolved === scope.root || resolved.startsWith(`${scope.root}${path.sep}`);
  } catch { return false; }
}

/** A repository-qualified path names the reviewed source even when the installed plugin has the same skill. */
function sourceScriptPaths(text, scope, mustExist) {
  if (!scope?.git) return [];
  return [...new Set([...String(text ?? "").matchAll(TOKEN)].flatMap(([token]) => {
    const candidate = trimToken(token);
    const match = SCRIPT_PATH.exec(candidate);
    if (!match || !match[2]) return [];
    const [, , , , rest] = match;
    const source = /^(?:\.\/)?plugins\/([^/]+)\/skills\//.exec(candidate);
    if (!source || !isVibePluginRoot(path.join(scope.root, "plugins", source[1]))) return [];
    const unsafe = rest.split("/").includes("..");
    const present = lstatSync(path.resolve(scope.root, candidate), { throwIfNoEntry: false });
    return unsafe || ((mustExist || present) && !existsInWorktree(candidate, scope))
      ? [`${candidate}: plugin script is not a contained regular file in the review worktree`] : [];
  }))];
}

/**
 * Vibe plugin script references in `text`, normalized to `skills/<skill>/scripts/<file>`.
 * A path counts only when <skill> is a skill of the installed plugin and either it has no
 * directory prefix (or only `./`/`../`) and has no exact or unambiguous repository match, or its
 * prefix is itself a vibe plugin root outside the session worktree's checkout. A repository path such as
 * `.claude/skills/control/scripts/app.mjs` is never a plugin reference.
 */
export function pluginScriptReferences(text, pluginRoot, worktree = null) {
  return installedReferences(text, pluginRoot, worktree);
}

function installedReferences(text, pluginRoot, worktree, scope) {
  const refs = [];
  for (const [token] of String(text ?? "").matchAll(TOKEN)) {
    const match = SCRIPT_PATH.exec(trimToken(token));
    if (!match) continue;
    const [candidate, prefix, explicit, skill, rest] = match;
    if (!isDirectory(path.join(pluginRoot, "skills", skill))) continue;
    if (scope === undefined) scope = repositoryScope(worktree);
    if (existsInWorktree(candidate, scope)) continue;
    const relative = `skills/${skill}/scripts/${rest}`;
    if (relativeOnly(prefix)) {
      if (!existsSync(path.join(pluginRoot, relative)) && uniqueRepositoryShorthand(scope, `${skill}/scripts/${rest}`)) continue;
    } else {
      const base = path.resolve(worktree ?? "/", prefix);
      if (!explicit || !isVibePluginRoot(base)) continue;
      // A plugin root inside the session's own checkout is that checkout's source (a claude-plugins worktree naming
      // its plugins/vibe/... scripts), not a reference to the installed release; another checkout's root still is.
      if (ownSourceRoot(base, scope)) continue;
    }
    if (!refs.includes(relative)) refs.push(relative);
  }
  return refs;
}

/** Missing, unsafe or non-file vibe plugin script references in `text`. */
export function pluginScriptProblems(text, pluginRoot, worktree = null, { reviewSource = true } = {}) {
  const root = realpathSync(pluginRoot);
  const scope = repositoryScope(worktree);
  const problems = sourceScriptPaths(text, scope, reviewSource);
  for (const relative of installedReferences(text, root, worktree, scope)) {
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
