/**
 * Build a route + chrome inventory for a Next.js web-ui repo.
 *
 * Scans a repository for Next.js app-router and pages-router page files, derives
 * their URL routes, extracts imported component names, and maps layout files to
 * route-prefix chrome entries. The result is written as a deterministic JSON
 * document suitable for the design-inventory skill's diff and report phases.
 *
 * Supports both routing styles:
 * - App router: page.tsx|page.jsx|page.ts|page.js under app/ directories.
 *   Route groups like (auth) are dropped; dynamic segments like [orgSlug] are kept.
 * - Pages router: *.tsx|*.jsx under pages/ directories, skipping _app,
 *   _document, _error and anything under api/.
 *
 * Chrome (shared layouts) is built from layout.tsx|layout.jsx files under
 * app/ directories using the same route-prefix derivation.
 *
 * Usage:
 *     node build-route-map.mjs <repo> [--out PATH]
 *
 * Prints the output path on success. Exit codes: 0 ok, 1 input error.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";

import { runWhenMain } from "./cli.js";

// Patterns for import extraction
const NAMED_IMPORT_RE = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
const DEFAULT_IMPORT_RE = /import\s+([A-Z][A-Za-z0-9_]*)\s+from\s+['"]([^'"]+)['"]/g;
const ALIAS_PART_RE = /\s+as\s+\S+/g;

// Excluded directory names encountered anywhere in the path
const EXCLUDED_PATH_PARTS = new Set(["node_modules", "dist", ".next", ".turbo"]);

// Route group: wrapped in parentheses, e.g. (auth)
const ROUTE_GROUP_RE = /^\(.*\)$/;

// Maximum shared_components kept per entry
const MAX_COMPONENTS = 20;

interface RouteEntry {
  paths: string[];
  shared_components: string[];
}

interface RouteMap {
  commit: string | null;
  routes: Record<string, RouteEntry>;
  chrome: Record<string, RouteEntry>;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Split an absolute path into its segments (platform-agnostic). */
function pathParts(absPath: string): string[] {
  // Split on both / and \ for cross-platform safety; filter empty strings
  return absPath.split(/[/\\]/).filter((p) => p.length > 0);
}

/**
 * Return true if any segment of path (relative to repo) is in the exclusion set.
 * Also returns true if path is not under repo at all.
 */
export function isExcluded(path: string, repo: string): boolean {
  const rel = relative(repo, path);
  // relative() returns something starting with ".." if path is not under repo
  if (rel.startsWith("..")) return true;
  const parts = rel.split(sep).filter((p) => p.length > 0);
  for (const part of parts) {
    if (EXCLUDED_PATH_PARTS.has(part)) return true;
  }
  return false;
}

/**
 * Walk up from path's directory and return the nearest ancestor directory
 * named "app", or null if none found.
 */
export function nearestAppAncestor(filePath: string): string | null {
  let current = dirname(filePath);
  while (true) {
    const name = current.split(/[/\\]/).pop();
    if (name === "app") return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Walk up from path's directory and return the nearest ancestor directory
 * named "pages", or null if none found.
 */
function nearestPagesAncestor(filePath: string): string | null {
  let current = dirname(filePath);
  while (true) {
    const name = current.split(/[/\\]/).pop();
    if (name === "pages") return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Return a forward-slash repo-relative path string.
 */
function repoRelative(filePath: string, repo: string): string {
  return relative(repo, filePath).split(sep).join(posix.sep);
}

// ---------------------------------------------------------------------------
// Route derivation
// ---------------------------------------------------------------------------

/**
 * Derive the URL route for an app-router page file.
 * Groups like (auth) are dropped; other segments are kept.
 */
export function deriveAppRoute(pageFile: string): string {
  const ancestor = nearestAppAncestor(pageFile);
  if (ancestor === null) return "/";
  const rel = relative(ancestor, dirname(pageFile));
  if (!rel || rel === ".") return "/";
  const parts = rel
    .split(sep)
    .filter((p) => p.length > 0 && !ROUTE_GROUP_RE.test(p));
  return parts.length > 0 ? "/" + parts.join("/") : "/";
}

/**
 * Derive the route prefix for a layout file (same logic as deriveAppRoute).
 */
export function deriveLayoutPrefix(layoutFile: string): string {
  const ancestor = nearestAppAncestor(layoutFile);
  if (ancestor === null) return "/";
  const rel = relative(ancestor, dirname(layoutFile));
  if (!rel || rel === ".") return "/";
  const parts = rel
    .split(sep)
    .filter((p) => p.length > 0 && !ROUTE_GROUP_RE.test(p));
  return parts.length > 0 ? "/" + parts.join("/") : "/";
}

/**
 * Derive the URL route for a pages-router page file.
 * The "index" stem maps to the parent path.
 */
export function derivePagesRoute(pageFile: string): string {
  const ancestor = nearestPagesAncestor(pageFile);
  if (ancestor === null) return "/";
  const rel = relative(ancestor, pageFile);
  if (!rel) return "/";
  const rawParts = rel.split(sep).filter((p) => p.length > 0);
  if (rawParts.length === 0) return "/";

  // Strip extension from last segment
  const last = rawParts[rawParts.length - 1]!;
  const dotIdx = last.lastIndexOf(".");
  const stem = dotIdx > 0 ? last.slice(0, dotIdx) : last;
  const parts = [...rawParts.slice(0, -1), stem];

  // Map trailing "index" to nothing (parent path)
  const final = parts[parts.length - 1] === "index" ? parts.slice(0, -1) : parts;
  return final.length > 0 ? "/" + final.join("/") : "/";
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Extract uppercase-starting imported component names from source text.
 * Keeps named imports (original name, before "as") and default imports
 * where the name starts with an uppercase letter.
 * Skips any import whose module starts with "next" or "react".
 */
export function extractComponents(text: string): string[] {
  const names = new Set<string>();

  // Reset lastIndex since we reuse global regexes
  NAMED_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAMED_IMPORT_RE.exec(text)) !== null) {
    const module = m[2]!;
    if (module.startsWith("next") || module.startsWith("react")) continue;
    for (const raw of m[1]!.split(",")) {
      // Strip alias part (e.g. "Foo as Bar" -> "Foo")
      const name = raw.replace(ALIAS_PART_RE, "").trim();
      if (name && name[0]!.toUpperCase() === name[0] && /[A-Z]/.test(name[0]!)) {
        names.add(name);
      }
    }
  }

  DEFAULT_IMPORT_RE.lastIndex = 0;
  while ((m = DEFAULT_IMPORT_RE.exec(text)) !== null) {
    const module = m[2]!;
    if (module.startsWith("next") || module.startsWith("react")) continue;
    const name = m[1]!;
    if (/[A-Z]/.test(name[0]!)) {
      names.add(name);
    }
  }

  const result = Array.from(names).sort();
  return result.slice(0, MAX_COMPONENTS);
}

// ---------------------------------------------------------------------------
// Entry merging
// ---------------------------------------------------------------------------

function mergeEntry(
  store: Record<string, RouteEntry>,
  key: string,
  relPath: string,
  components: string[],
): void {
  if (!(key in store)) {
    store[key] = { paths: [], shared_components: [] };
  }
  const entry = store[key]!;
  if (!entry.paths.includes(relPath)) {
    entry.paths.push(relPath);
  }
  const existing = new Set(entry.shared_components);
  for (const c of components) existing.add(c);
  entry.shared_components = Array.from(existing).sort().slice(0, MAX_COMPONENTS);
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function getHeadCommit(repo: string): string | null {
  try {
    const out = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Filesystem walk (used for pages-router glob)
// ---------------------------------------------------------------------------

/** Recursively collect all files under dir. */
function walkFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir, { encoding: "utf-8" });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const f of walkFiles(full)) results.push(f);
    } else {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/** Read a source file as UTF-8, replacing errors. */
function readText(filePath: string): string {
  const buf = readFileSync(filePath);
  // Node doesn't have a direct "replace errors" option in readFileSync,
  // but latin1 -> utf8 conversion trick gives best-effort decoding.
  // Use latin1 for initial decode then re-interpret as UTF-8 compatible string.
  return buf.toString("utf8");
}

/** Process a potential pages-router file and add to routes if applicable. */
function handlePagesFile(
  filePath: string,
  repo: string,
  routes: Record<string, RouteEntry>,
): void {
  if (isExcluded(filePath, repo)) return;
  const ancestor = nearestPagesAncestor(filePath);
  if (ancestor === null) return;

  // Skip files in api/ subpaths
  const relFromPages = relative(ancestor, filePath);
  const relParts = relFromPages.split(sep);
  // Check intermediate directories (exclude last segment which is the filename)
  if (relParts.slice(0, -1).includes("api")) return;

  // Get the stem of the filename
  const filename = relParts[relParts.length - 1]!;
  const dotIdx = filename.lastIndexOf(".");
  const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;

  // Skip reserved filenames
  if (stem === "_app" || stem === "_document" || stem === "_error") return;

  // Skip app-router page files to avoid double-counting
  if (filename === "page.tsx" || filename === "page.jsx") return;

  const route = derivePagesRoute(filePath);
  const relPath = repoRelative(filePath, repo);
  const text = readText(filePath);
  const components = extractComponents(text);
  mergeEntry(routes, route, relPath, components);
}

/** Build and return the route-map data structure for repo. */
export function buildRouteMap(repo: string): RouteMap {
  const routes: Record<string, RouteEntry> = {};
  const chrome: Record<string, RouteEntry> = {};

  const allFiles = walkFiles(repo);

  // --- App router: page files ---
  const pageNames = new Set(["page.tsx", "page.jsx", "page.ts", "page.js"]);
  for (const f of allFiles) {
    const filename = f.split(/[/\\]/).pop()!;
    if (!pageNames.has(filename)) continue;
    if (isExcluded(f, repo)) continue;
    const ancestor = nearestAppAncestor(f);
    if (ancestor === null) continue;
    const route = deriveAppRoute(f);
    const relPath = repoRelative(f, repo);
    const text = readText(f);
    const components = extractComponents(text);
    mergeEntry(routes, route, relPath, components);
  }

  // --- App router: layout files (chrome) ---
  const layoutNames = new Set(["layout.tsx", "layout.jsx", "layout.ts", "layout.js"]);
  for (const f of allFiles) {
    const filename = f.split(/[/\\]/).pop()!;
    if (!layoutNames.has(filename)) continue;
    if (isExcluded(f, repo)) continue;
    const ancestor = nearestAppAncestor(f);
    if (ancestor === null) continue;
    const prefix = deriveLayoutPrefix(f);
    const relPath = repoRelative(f, repo);
    const text = readText(f);
    const components = extractComponents(text);
    mergeEntry(chrome, prefix, relPath, components);
  }

  // --- Pages router: page files (.tsx and .jsx) ---
  for (const f of allFiles) {
    const filename = f.split(/[/\\]/).pop()!;
    if (filename.endsWith(".tsx") || filename.endsWith(".jsx")) {
      handlePagesFile(f, repo, routes);
    }
  }

  // Sort routes and chrome by key
  const sortedRoutes: Record<string, RouteEntry> = {};
  for (const k of Object.keys(routes).sort()) {
    sortedRoutes[k] = routes[k]!;
  }
  const sortedChrome: Record<string, RouteEntry> = {};
  for (const k of Object.keys(chrome).sort()) {
    sortedChrome[k] = chrome[k]!;
  }

  const commit = getHeadCommit(repo);

  return {
    commit,
    routes: sortedRoutes,
    chrome: sortedChrome,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
    },
    strict: false,
  });

  const repo = positionals[0];
  if (!repo) {
    process.stderr.write("error: repo argument is required\n");
    return 1;
  }

  let isDir = false;
  try {
    isDir = statSync(repo).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    process.stderr.write(`error: not a directory: ${repo}\n`);
    return 1;
  }

  const outPath =
    typeof values.out === "string" && values.out.length > 0
      ? values.out
      : join(repo, ".closedloop-ai", "design-inventory", "route-map.json");

  mkdirSync(dirname(outPath), { recursive: true });

  const data = buildRouteMap(repo);
  writeFileSync(outPath, JSON.stringify(data, null, 1), "utf-8");
  process.stdout.write(outPath + "\n");
  return 0;
}

runWhenMain(import.meta.url, main);
