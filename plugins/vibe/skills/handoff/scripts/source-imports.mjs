// Import resolution shared by the diff rules: the frozen-story render closure
// and the route rule's e2e import graph. Text reads only.

import path from "node:path";

export const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot)$/;
export const IMPORT_SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", ".css", ".scss", ".sass", ".less", ".json", ".svg",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".eot", "/index.ts", "/index.tsx"];

/** An import specifier resolved to a file in `files` (relative or `@repo/`), or undefined. */
export function resolveImport(from, specifier, files) {
  let stems;
  if (specifier.startsWith(".")) {
    stems = [path.posix.join(path.posix.dirname(from), specifier)];
  } else if (specifier.startsWith("@repo/")) {
    stems = [`packages/${specifier.slice("@repo/".length)}`];
  } else if (specifier.startsWith("@/")) {
    const suffix = specifier.slice(2);
    const appRoot = /^(apps\/[^/]+)\//.exec(from)?.[1];
    stems = [...(appRoot ? [`${appRoot}/src/${suffix}`, `${appRoot}/${suffix}`] : []), suffix];
  } else {
    return undefined;
  }
  return stems.map((stem) => stem.replace(/\.js$/, "")).flatMap((stem) => SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`))
    .find((candidate) => files.has(candidate) && SOURCE_FILE.test(candidate));
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
