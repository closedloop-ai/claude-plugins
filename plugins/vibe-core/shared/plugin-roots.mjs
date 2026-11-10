// Finds a sibling closedloop-ai plugin's root from the plugin a module lives
// in (ISS-13869). vibe loads vibe-core's code through it, and vibe-core's
// guards find vibe's install through it to read that install as data.
//
// The canonical copy is plugins/vibe-core/shared/plugin-roots.mjs. vibe ships
// a byte-identical copy at plugins/vibe/shared/plugin-roots.mjs because it has
// to find vibe-core before it can load anything from it, and vibe-core never
// loads vibe's code. plugin-roots.test.mjs fails when the copies differ or when
// either imports anything but a node: builtin.
//
// Three layouts, decided from the caller's own plugin root R:
// - a repository checkout (or a plugin loaded in place): R is plugins/<self>
//   and the sibling is plugins/<name> beside it;
// - Claude Code: R is <config>/plugins/cache/<marketplace>/<self>/<version>
//   and <config>/plugins/installed_plugins.json names the sibling's install,
//   the one a session in the given cwd loads (its project's, else the user's);
// - Codex: the same cache shape with no installed_plugins.json; the sibling's
//   version is the one Codex itself treats as active (rust-v0.167.0,
//   core-plugin-common/src/installed.rs `active_plugin_version`).
// There is deliberately no environment override: nothing outside these files
// can point a hook at code somewhere else.

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFESTS = Object.freeze([".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]);
export const Layout = Object.freeze({ Checkout: "checkout", Claude: "claude", Codex: "codex" });

const CODEX_LOCAL_VERSION = "local";
const VERSION_SEGMENT = /^[A-Za-z0-9_.+-]+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC = /^\d+$/;
const SCOPE_FALLBACK = "user";
/** Claude Code scopes tied to a project, nearest first. */
const PROJECT_SCOPES = Object.freeze(["local", "project"]);

/** The `name` and `version` a plugin root's manifest declares, or null when it has none. */
export function pluginManifest(root) {
  for (const relative of MANIFESTS) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(root, relative), "utf8"));
      if (typeof manifest?.name === "string") {
        return { name: manifest.name, version: typeof manifest.version === "string" ? manifest.version : null };
      }
    } catch {
      // Try the other harness's manifest.
    }
  }
  return null;
}

/** The plugin root holding `from` (a file URL or path): the nearest ancestor directory with a plugin manifest. */
export function ownPluginRoot(from) {
  const file = String(from).startsWith("file:") ? fileURLToPath(from) : String(from);
  let dir = path.dirname(realpathSync(file));
  for (;;) {
    const manifest = pluginManifest(dir);
    if (manifest) return { root: dir, name: manifest.name, version: manifest.version };
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`${file} is not inside a plugin`);
    dir = parent;
  }
}

/**
 * Codex's version order (semver crate precedence, build metadata last, then
 * plain string order when either side is not semver): negative, zero or positive.
 */
export function comparePluginVersions(left, right) {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) return compareText(left, right);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a[4] === undefined || b[4] === undefined) {
    if (a[4] !== b[4]) return a[4] === undefined ? 1 : -1;
  } else {
    const order = compareIdentifiers(a[4], b[4]);
    if (order !== 0) return order;
  }
  if (a[5] === b[5]) return 0;
  if (a[5] === undefined || b[5] === undefined) return a[5] === undefined ? -1 : 1;
  return compareIdentifiers(a[5], b[5]);
}

/** The version Codex treats as active among `versions` (directory names), or null when none is valid. */
export function activeCodexVersion(versions) {
  const valid = versions.filter((version) => VERSION_SEGMENT.test(version) && version !== "." && version !== "..");
  if (valid.length === 0) return null;
  if (valid.includes(CODEX_LOCAL_VERSION)) return CODEX_LOCAL_VERSION;
  return [...valid].sort(comparePluginVersions).at(-1);
}

/**
 * Where the plugin holding `from` (a file URL or path) is installed: its root, name and version, its
 * layout (null when it is in none of the three), and for an install the harness home (Claude Code's
 * config folder or CODEX_HOME), the marketplace and the cache folder.
 */
export function pluginInstall(from) {
  const self = ownPluginRoot(from);
  const parent = path.dirname(self.root);
  if (path.basename(parent) === "plugins") return { ...self, layout: Layout.Checkout, plugins: parent };
  const marketplaceDir = path.dirname(parent);
  const cacheDir = path.dirname(marketplaceDir);
  const pluginsDir = path.dirname(cacheDir);
  if (path.basename(cacheDir) !== "cache" || path.basename(pluginsDir) !== "plugins") return { ...self, layout: null };
  const registry = path.join(pluginsDir, "installed_plugins.json");
  return { ...self, layout: isFile(registry) ? Layout.Claude : Layout.Codex, home: path.dirname(pluginsDir),
    marketplace: path.basename(marketplaceDir), cacheDir, registry };
}

/**
 * The install of sibling plugin `name` that a session in `cwd` uses, found from the plugin that holds `from`:
 * { root, layout, home?, marketplace?, scope?, projectPath? }. In Claude Code a local or project install whose
 * project holds `cwd` wins (local first, then the deepest project), else the one user install, as Claude Code
 * loads them. Throws with the plugin's name and install commands when there is none.
 */
export function siblingPluginInstall(name, { from, cwd = process.cwd() }) {
  const self = pluginInstall(from);
  if (self.layout === Layout.Checkout) {
    const candidate = path.join(self.plugins, name);
    if (pluginManifest(candidate)?.name === name) return { root: realpathSync(candidate), layout: Layout.Checkout };
    throw missing(name, self, Layout.Checkout);
  }
  if (self.layout === null) {
    throw new Error(`${self.name} at ${self.root} is not in a checkout, Claude Code or Codex plugin layout, so ${name} cannot be found`);
  }
  const found = self.layout === Layout.Claude
    ? claudeEntry(readRegistry(self.registry), name, self, cwd)
    : { installPath: codexRoot(path.join(self.cacheDir, self.marketplace, name), name, self) };
  if (pluginManifest(found.installPath)?.name !== name) throw missing(name, self, self.layout);
  return { root: realpathSync(found.installPath), layout: self.layout, home: self.home, marketplace: self.marketplace,
    ...(found.scope ? { scope: found.scope } : {}), ...(found.projectPath ? { projectPath: found.projectPath } : {}) };
}

/** The absolute root of sibling plugin `name` (`siblingPluginInstall`'s root). */
export function siblingPluginRoot(name, options) {
  return siblingPluginInstall(name, options).root;
}

/** `siblingPluginRoot`, or null when the sibling cannot be found. */
export function siblingPluginRootOrNull(name, options) {
  try {
    return siblingPluginRoot(name, options);
  } catch {
    return null;
  }
}

function claudeEntry(registry, name, self, cwd) {
  const candidates = (registry?.plugins?.[`${name}@${self.marketplace}`] ?? [])
    .filter((entry) => typeof entry?.installPath === "string" && path.isAbsolute(entry.installPath));
  const here = realOrSame(path.resolve(cwd));
  const holds = (project) => {
    if (typeof project !== "string" || !path.isAbsolute(project)) return false;
    const root = realOrSame(project);
    return here === root || here.startsWith(`${root}${path.sep}`);
  };
  for (const scope of PROJECT_SCOPES) {
    const matching = candidates.filter((entry) => entry.scope === scope && holds(entry.projectPath))
      .sort((left, right) => realOrSame(right.projectPath).length - realOrSame(left.projectPath).length);
    if (matching.length > 0) return matching[0];
  }
  const user = candidates.filter((entry) => entry.scope === SCOPE_FALLBACK);
  if (user.length === 1) return user[0];
  if (user.length > 1) throw new Error(`${name} has more than one Claude Code user install; keep one`);
  throw missing(name, self, Layout.Claude);
}

function codexRoot(base, name, self) {
  let versions;
  try {
    versions = readdirSync(base).filter((entry) => isDirectory(path.join(base, entry)));
  } catch {
    throw missing(name, self, Layout.Codex);
  }
  const version = activeCodexVersion(versions);
  if (!version) throw missing(name, self, Layout.Codex);
  return path.join(base, version);
}

function missing(name, self, layout) {
  return new Error(`${name} is not installed beside ${self.name} (${layout} layout); install it with `
    + `\`claude plugin install ${name}@closedloop-ai\` in Claude Code or \`codex plugin add ${name}@closedloop-ai\` in Codex`);
}

function readRegistry(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function realOrSame(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareIdentifiers(left, right) {
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = compareIdentifier(a[index], b[index]);
    if (order !== 0) return order;
  }
  return Math.sign(a.length - b.length);
}

function compareIdentifier(left, right) {
  const leftNumeric = NUMERIC.test(left);
  const rightNumeric = NUMERIC.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right)) || compareText(left, right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return compareText(left, right);
}
