// Import resolution shared by the diff rules: the frozen-story render closure
// and the route rule's e2e import graph. Text reads only.

import path from "node:path";

export const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
export const IMPORT_SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];

/** An import specifier resolved to a file in `files` (relative or `@repo/`), or undefined. */
export function resolveImport(from, specifier, files) {
  let stem;
  if (specifier.startsWith(".")) {
    stem = path.posix.join(path.posix.dirname(from), specifier);
  } else if (specifier.startsWith("@repo/")) {
    stem = `packages/${specifier.slice("@repo/".length)}`;
  } else {
    return undefined;
  }
  stem = stem.replace(/\.js$/, "");
  return SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`).find((candidate) => files.has(candidate) && SOURCE_FILE.test(candidate));
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
