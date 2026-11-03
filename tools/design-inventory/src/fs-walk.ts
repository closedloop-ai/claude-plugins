/**
 * Shared filesystem walker for design-inventory tools.
 *
 * Pruning excluded and dot-prefixed directories AT DESCENT TIME matters:
 * monorepos carry node_modules trees large enough that even one recursive
 * walk through them dominates the runtime. Skipping per-file after the fact
 * is not sufficient -- every stat call inside an excluded tree still costs
 * time.
 *
 * Symlinked directories are treated as non-traversable: `dirent.isDirectory()`
 * returns false for symlinks (without followSymlinks), so dangling symlinks
 * are silently skipped rather than throwing.
 *
 * Each readdir call is wrapped in try/catch so a single unreadable directory
 * cannot abort an otherwise successful walk.
 */

import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

const DEFAULT_EXCLUDE_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage"]);

export interface WalkOptions {
  excludeDirs?: ReadonlySet<string>;
}

/**
 * Recursively collect all files under `root`, returning absolute paths.
 *
 * Pruning rules (applied at descent time):
 * - Any directory whose name is in `excludeDirs` (default: node_modules,
 *   dist, build, out, coverage).
 * - Any directory whose name starts with "." (covers .git, .next, .turbo,
 *   .pnpm-store, etc.).
 *
 * Symlinks are not followed (dirent.isDirectory() is false for symlinks).
 */
export function walkFiles(root: string, opts?: WalkOptions): string[] {
  const excludeDirs = opts?.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
  const files: string[] = [];

  function recurse(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of entries) {
      const name = dirent.name;
      // Prune excluded and dot-prefixed directories before entering them
      if (dirent.isDirectory()) {
        if (excludeDirs.has(name) || name.startsWith(".")) continue;
        recurse(join(dir, name));
      } else {
        // isDirectory() is false for symlinks, so dangling symlinks fall here
        // but are never followed. We only push actual files (or symlinks to
        // files, which is harmless -- readFile handles them fine).
        files.push(join(dir, name));
      }
    }
  }

  recurse(root);
  return files;
}
