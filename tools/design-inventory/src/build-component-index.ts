/**
 * Build an enriched Storybook component index for a web-ui repo.
 *
 * Walks the repository tree looking for *.stories.* files (excluding
 * node_modules and dist), extracts component names and import paths,
 * then enriches each entry with source-file location, prop names, and CVA
 * variant keys when they can be resolved.
 *
 * Usage:
 *     node build-component-index.mjs <repo> --out PATH
 *
 * --out is REQUIRED. Prints the output path on success.
 * Exit codes: 0 ok, 1 bad repo path or missing --out.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";

import { runWhenMain } from "./cli.js";
import { walkFiles } from "./fs-walk.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_MODULES_PREFIX = "@storybook";
const SKIP_NAMES = new Set(["Meta", "StoryObj", "StoryFn"]);

// Match:  import { A, B as C } from "mod";
// Group 1: brace contents, Group 2: module path
const NAMED_IMPORT_RE = /^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/;
// Match:  import Foo from "mod";
const DEFAULT_IMPORT_RE = /^import\s+([A-Z][A-Za-z0-9_]*)\s+from\s+["']([^"']+)["']/;
// Match:  import type { ... } from "mod";
const TYPE_IMPORT_RE = /^import\s+type\s+\{/;

const CVA_RE = /\bcva\(/;
const CVA_VARIANTS_RE = /variants\s*:\s*\{/;

const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];
const MAX_PROPS = 30;
const MAX_VARIANTS = 15;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ComponentEntry {
  component: string;
  import_path: string;
  story: string;
  source_path?: string;
  props?: string[];
  variants?: string[];
}

interface ComponentIndex {
  commit: string | null;
  components: ComponentEntry[];
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Return (component_name, module) pairs from a story file's import lines.
 *
 * Skips `import type` lines entirely, skips `@storybook` modules, and
 * skips names that are not uppercase-initial or are in SKIP_NAMES.
 */
export function extractImports(text: string): Array<[string, string]> {
  const results: Array<[string, string]> = [];

  for (const line of text.split("\n")) {
    const stripped = line.trim();

    // Skip type imports entirely
    if (TYPE_IMPORT_RE.test(stripped)) continue;

    // Named imports: import { A, B as C } from "mod"
    const namedMatch = NAMED_IMPORT_RE.exec(stripped);
    if (namedMatch) {
      const braceContent = namedMatch[1]!;
      const module = namedMatch[2]!;
      if (module.startsWith(SKIP_MODULES_PREFIX)) continue;
      for (const item of braceContent.split(",")) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        // Take the original name (before "as")
        const original = trimmed.split(" as ")[0]!.trim();
        if (original && /[A-Z]/.test(original[0]!) && !SKIP_NAMES.has(original)) {
          results.push([original, module]);
        }
      }
      continue;
    }

    // Default imports: import Foo from "mod"
    const defaultMatch = DEFAULT_IMPORT_RE.exec(stripped);
    if (defaultMatch) {
      const name = defaultMatch[1]!;
      const module = defaultMatch[2]!;
      if (module.startsWith(SKIP_MODULES_PREFIX)) continue;
      if (/[A-Z]/.test(name[0]!) && !SKIP_NAMES.has(name)) {
        results.push([name, module]);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Source file enrichment
// ---------------------------------------------------------------------------

/**
 * Find the closing brace matching the one at `start` (which must be '{').
 * Returns [closeIndex, depthAtClose]. Depth is 0 when matched.
 */
function countBraceDepth(text: string, start: number): [number, number] {
  let depth = 0;
  let i = start;
  for (i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return [i, 0];
    }
  }
  return [i, depth];
}

/** Return the text inside the outermost braces beginning at openBrace. */
function extractBlock(text: string, openBrace: number): string {
  const [close] = countBraceDepth(text, openBrace);
  return text.slice(openBrace + 1, close);
}

/**
 * Extract top-level identifier keys from an object literal block.
 *
 * Handles nested braces by skipping over inner blocks. Collects identifiers
 * matching `word?:` at depth-0. Depth is checked BEFORE processing the
 * brace counts for each line so that lines like `size: {` are captured
 * while at depth 0.
 */
function topLevelKeys(block: string): string[] {
  const keyRe = /^\s*(\w+)\s*\??:/;
  const keys: string[] = [];
  let depth = 0;
  for (const line of block.split("\n")) {
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (depth === 0) {
      const m = keyRe.exec(line);
      if (m) keys.push(m[1]!);
    }
    depth += opens - closes;
  }
  return keys;
}

/**
 * Find interface/type <Component>Props and return its field names (capped).
 * Matches both `interface FooProps {` and `type FooProps = {`.
 */
export function extractProps(text: string, component: string): string[] | null {
  const escaped = component.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:interface|type)\\s+${escaped}Props\\s*(?:=\\s*)?\\{`,
  );
  const m = pattern.exec(text);
  if (!m) return null;
  // Find the opening brace position within the match
  const matchEnd = m.index + m[0].length;
  const openBrace = text.lastIndexOf("{", matchEnd - 1);
  if (openBrace < 0) return null;
  const block = extractBlock(text, openBrace);
  const keys = topLevelKeys(block);
  return keys.length > 0 ? keys.slice(0, MAX_PROPS) : null;
}

/** Extract CVA variant key names if a cva() call is present. */
export function extractVariants(text: string): string[] | null {
  if (!CVA_RE.test(text)) return null;
  const m = CVA_VARIANTS_RE.exec(text);
  if (!m) return null;
  const openBrace = text.indexOf("{", m.index);
  if (openBrace < 0) return null;
  const block = extractBlock(text, openBrace);
  const keys = topLevelKeys(block);
  return keys.length > 0 ? keys.slice(0, MAX_VARIANTS) : null;
}

/**
 * Resolve a scoped import path against the prebuilt source-file list.
 *
 * Takes the path suffix after the first two segments (e.g.
 * `@repo/design-system/components/ui/card` -> `components/ui/card`)
 * and matches repo-relative source paths ending in `<suffix>.<ext>` or
 * `<suffix>/index.<ext>`.
 */
export function findSourceFile(sourceRelPaths: string[], importPath: string): string | null {
  const parts = importPath.replace(/^\//, "").split("/");
  if (parts.length <= 2) return null;
  const suffix = parts.slice(2).join("/"); // drop first two segments

  const wanted = new Set<string>();
  for (const ext of SOURCE_EXTENSIONS) {
    wanted.add(`${suffix}${ext}`);
    wanted.add(`${suffix}/index${ext}`);
  }
  const boundary = Array.from(wanted).map((w) => `/${w}`);

  const candidates = sourceRelPaths.filter(
    (rel) => wanted.has(rel) || boundary.some((b) => rel.endsWith(b)),
  );
  return candidates.length > 0 ? candidates.sort()[0]! : null;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function gitHead(repo: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

/** Scan repo stories and build the enriched component index (sorted list). */
export function buildIndex(repo: string): ComponentEntry[] {
  const seen = new Map<string, ComponentEntry>();

  const allFiles = walkFiles(repo);
  const storyFiles = allFiles.filter((p) => p.replace(/\\/g, "/").split("/").pop()!.includes(".stories."));
  const sourceRelPaths = allFiles
    .filter((p) => {
      const name = p.replace(/\\/g, "/").split("/").pop()!;
      return (
        SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.includes(".stories.")
      );
    })
    .map((p) => relative(repo, p).split(sep).join(posix.sep));

  for (const storyPath of storyFiles) {
    let text: string;
    try {
      text = readFileSync(storyPath, "utf-8");
    } catch {
      continue;
    }

    const relStory = relative(repo, storyPath).split(sep).join(posix.sep);
    const pairs = extractImports(text);

    for (const [name, module] of pairs) {
      const key = `${name}\0${module}`;
      if (seen.has(key)) continue;
      const entry: ComponentEntry = {
        component: name,
        import_path: module,
        story: relStory,
      };
      seen.set(key, entry);
    }
  }

  // Enrichment pass (best effort, never fatal)
  for (const entry of seen.values()) {
    const module = entry.import_path;
    const component = entry.component;
    if (!module.includes("/")) continue;
    try {
      const relSource = findSourceFile(sourceRelPaths, module);
      if (relSource === null) continue;
      const sourceText = readFileSync(join(repo, relSource), "utf-8");

      entry.source_path = relSource;

      const props = extractProps(sourceText, component);
      if (props !== null) entry.props = props;

      const variants = extractVariants(sourceText);
      if (variants !== null) entry.variants = variants;
    } catch {
      // enrichment is best-effort; never fatal
    }
  }

  const entries = Array.from(seen.values());
  entries.sort((a, b) => {
    if (a.component < b.component) return -1;
    if (a.component > b.component) return 1;
    if (a.import_path < b.import_path) return -1;
    if (a.import_path > b.import_path) return 1;
    return 0;
  });
  return entries;
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
    process.stderr.write(`error: repo not found or not a directory: ${repo}\n`);
    return 1;
  }

  if (typeof values.out !== "string" || values.out.length === 0) {
    process.stderr.write(
      "error: --out <path> is required\nusage: node build-component-index.mjs <repo> --out <path>\n",
    );
    return 1;
  }
  const outPath = values.out;

  mkdirSync(dirname(outPath), { recursive: true });

  const components = buildIndex(repo);
  const commit = gitHead(repo);
  const index: ComponentIndex = { commit, components };

  writeFileSync(outPath, JSON.stringify(index, null, 1), "utf-8");
  process.stdout.write(outPath + "\n");
  return 0;
}

runWhenMain(import.meta.url, main);
