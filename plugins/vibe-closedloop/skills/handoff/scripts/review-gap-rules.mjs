// Diff rules for two defects a fresh-context audit caught after a merge: a new
// sort comparator with no tie fixture (it was not a total order), and new
// exports nothing uses (left behind by descoped work). diff-rules.mjs runs them.

import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { SOURCE_FILE } from "./source-imports.mjs";
import { isGeneratedFile } from "./generated-files.mjs";

const COMPARATOR = /\.(?:sort|toSorted)\(\s*(?:\(\s*[\w$]+\s*,\s*[\w$]+\s*\)\s*=>|function\b)|\bconst\s+compare[A-Z]?\w*\s*=\s*\(\s*[\w$]+\s*,\s*[\w$]+\s*\)|\bfunction\s+compare[A-Z]?\w*\s*\(\s*(?:[\w$]+\s*(?::[^,()]+)?\s*,\s*[\w$]+\s*(?::[^,()]+)?\s*,?\s*\)|(?:[\w$]+\s*(?::[^,()]+)?\s*,?\s*)?$)/;
const NAMED_EXPORT = /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface)\s+([\w$]+)/;
// Names a framework reaches by convention rather than by import.
const CONVENTION_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "metadata", "generateMetadata", "generateStaticParams", "viewport", "config", "dynamic", "revalidate", "runtime", "loader", "action", "handler", "meta", "middleware"]);
// Build output says so on its first line, and a bundler labels each source it inlined with a comment line
// holding its path, `// ../../plugins/vibe/shared/owner.mjs`, above that source's code.
const GENERATED_BANNER = /^\/\/[^\n]*\bgenerated\b[^\n]*\bdo not edit\b/i;
const MODULE_LABEL = /^\/\/ (?:\.{1,2}\/)*((?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[cm]?[jt]sx?)$/;
const HELPER_DECL = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+([a-z]\w*)\s*\([^)]*\)(?:\s*:\s*[^\n{]+)?\s*\{\s*$/;

function sources(files) {
  return files.filter((file) => file.status !== "D" && SOURCE_FILE.test(file.path) && !isTestFile(file.path) && !/\.stories\.[jt]sx?$/.test(file.path));
}

/**
 * A new comparator needs `Comparator: <file>: tie test <test path>` naming a test that exists. Outside the
 * pull-request phase the session writes no tests, so there `Comparator: <file>: missing test listed`, with the
 * tie test on the Missing tests list, stands in for it.
 */
export function checkComparators(files, repo, logged, add, changeLog, phase = "pull-request") {
  const comparatorRecords = changeLog.split("\n").filter((line) => line.includes("Comparator:"));
  for (const file of sources(files)) {
    const entry = file.added.find((item) => isComparatorLine(item.text));
    if (!entry) continue;
    const lines = comparatorRecords.filter((line) => line.includes(file.path));
    const cited = lines.map((line) => /tie test\s+(\S+)/.exec(line)?.[1]).filter(Boolean);
    if (phase !== "pull-request" && lines.some((line) => /:\s*missing test listed\s*$/.test(line))) continue;
    if (!cited.some((test) => repo.head(test) !== null && repo.head(test) !== undefined)) {
      const record = phase === "pull-request" ? "add a fixture with a tie, and record `Comparator: <file>: tie test <test path>`"
        : "list the tie test under Missing tests, and record `Comparator: <file>: missing test listed`";
      add("comparator-tie", file.path, entry.line, "adds a sort comparator with no test that sorts two rows tied on the ranked key; a comparator that returns 0 for distinct rows is not a total order", `break ties on a unique key, ${record}`);
    }
  }
}

/** A named export new in this diff that no other file names is dead on arrival unless recorded. */
export function checkUnusedExports(files, repo, logged, add) {
  repo.prefetchWords?.(sources(files).flatMap((file) => file.added.map((entry) => NAMED_EXPORT.exec(entry.text)?.[1]).filter(Boolean)));
  for (const file of sources(files)) {
    for (const entry of file.added) {
      const name = NAMED_EXPORT.exec(entry.text)?.[1];
      if (!name || CONVENTION_EXPORTS.has(name) || logged(`Export: ${name}:`)) continue;
      if (new RegExp(`\\bexport\\b[^\\n]*\\b${name.replace(/\$/g, "\\$")}\\b`).test(repo.base(file.path) ?? "")) continue;
      if (repo.wordFiles(name).filter((other) => other !== file.path).length === 0) {
        add("unused-export", file.path, entry.line, `exports ${name}, which no other file uses`, `remove it (or the export keyword), or record \`Export: ${name}: <the consumer that will import it and its ticket>\``);
      }
    }
  }
}

/** Index the first closed declaration of each requested name using one split per file. */
function helperBodies(source, names) {
  const lines = source.split("\n");
  const closingByIndent = new Map();
  const bodies = new Map();
  for (let line = lines.length - 1; line >= 0; line -= 1) {
    const text = lines[line];
    if (/^\s*}$/.test(text)) closingByIndent.set(text.slice(0, -1), line);
    const declaration = HELPER_DECL.exec(text);
    if (!declaration || !names.has(declaration[2])) continue;
    const close = closingByIndent.get(declaration[1]);
    if (close === undefined) continue;
    bodies.set(declaration[2], lines.slice(line + 1, close).map((bodyLine) => bodyLine.trim()).join("\n"));
  }
  return bodies;
}

/** All simple named helpers, indexed once per current source file. */
function helperIndex(repo, names, textOf) {
  const index = new Map();
  for (const file of [...repo.headFiles].filter((entry) => SOURCE_FILE.test(entry) && !isTestFile(entry) && !/\.stories\.[jt]sx?$/.test(entry)
    && !isGeneratedFile(repo, entry, { header: false })).sort()) {
    const source = textOf(file);
    if (typeof source !== "string") continue;
    for (const [name, body] of helperBodies(source, names)) {
      const entries = index.get(name) ?? [];
      entries.push({ file, body });
      index.set(name, entries);
    }
  }
  return index;
}

/**
 * In build output (a generated banner on its first line), the module label of the section that defines
 * helper `name`: the nearest label line above its declaration. Null for a hand-written file. A `dist/`
 * path proves nothing, so it exempts nothing.
 */
function bundledFrom(output, name) {
  if (!GENERATED_BANNER.test(output ?? "")) return null;
  const lines = output.split("\n");
  const at = lines.findIndex((line) => HELPER_DECL.exec(line)?.[2] === name);
  for (let index = at - 1; index > 0; index -= 1) {
    const label = MODULE_LABEL.exec(lines[index])?.[1];
    if (label) return label;
  }
  return null;
}

/** True when a module label names `source`: the whole repo path, or its tail from a directory boundary on, never a bare file name. */
function labels(label, source) {
  return label === source || (label.includes("/") && source.endsWith(`/${label}`));
}

/**
 * True when a bundle whose module label is `label` inlined `file`: the label names the file, or names the source
 * the file is a built copy of under a build marker (a launcher bundle against the built copy of its own source).
 */
function inlines(label, file, sourceOf) {
  if (labels(label, file)) return true;
  const source = sourceOf(file);
  return source !== null && labels(label, source);
}

/** True when `file`'s helper and `other`'s (whose head text is `otherText`) are one definition: either bundle inlined the other file, or both bundles inlined one source. */
function oneBundledDefinition(name, file, ownSource, otherText, other, sourceOf) {
  const otherSource = bundledFrom(otherText, name);
  if (ownSource && inlines(ownSource, other, sourceOf)) return true;
  if (otherSource && inlines(otherSource, file, sourceOf)) return true;
  return Boolean(ownSource && otherSource && ownSource === otherSource);
}

/**
 * A newly added helper must not copy an identical existing or fellow-diff helper. A bundle and the
 * source it inlined are one definition, whichever of the two the diff adds, and so are two bundles that
 * inlined it from the same source.
 */
export function checkDuplicateHelpers(files, repo, add) {
  const declarations = sources(files).flatMap((file) => file.added.flatMap((entry) => {
    const name = HELPER_DECL.exec(entry.text)?.[2];
    return name ? [{ name, file: file.path, line: entry.line }] : [];
  }));
  if (declarations.length === 0) return;
  const changed = new Set(files.map((file) => file.path));
  const texts = new Map();
  const textOf = (file) => {
    if (!texts.has(file)) texts.set(file, repo.head(file));
    return texts.get(file);
  };
  const indexed = helperIndex(repo, new Set(declarations.map(({ name }) => name)), textOf);
  const markerPaths = new Set([...repo.headFiles, ...(repo.baseFiles ?? [])]
    .filter((file) => file.endsWith(`/${BUILD_MARKER}`)));
  const mirrorSources = new Map();
  const sourceOf = (file) => {
    if (!mirrorSources.has(file)) mirrorSources.set(file, builtSource(file, repo, markerPaths));
    return mirrorSources.get(file);
  };
  for (const { name, file, line } of declarations) {
    const candidates = indexed.get(name) ?? [];
    const body = candidates.find((candidate) => candidate.file === file)?.body;
    if (!body || body.length < 16) continue;
    const ownSource = bundledFrom(textOf(file), name);
    const duplicate = candidates.find((candidate) => candidate.file !== file
      && (!changed.has(candidate.file) || candidate.file < file) && candidate.body === body
      && sourceOf(file) !== candidate.file && sourceOf(candidate.file) !== file
      && !oneBundledDefinition(name, file, ownSource, textOf(candidate.file), candidate.file, sourceOf))?.file;
    if (duplicate) add("duplicate-helper", file, line,
      `new helper ${name} duplicates ${duplicate}`,
      `move the shared behavior to one owner and import it from ${duplicate}`);
  }
}

// The generated file a build writes at the root of its output, `{"builtFrom": "<source dir from the repo root>"}`.
const BUILD_MARKER = ".vibe-build.json";

/** The source path of a built file, from the nearest build marker above it; null when there is none or it proves nothing. */
function builtSource(file, repo, markerPaths) {
  const parts = file.split("/");
  for (let depth = parts.length - 1; depth > 0; depth -= 1) {
    const marker = `${parts.slice(0, depth).join("/")}/${BUILD_MARKER}`;
    if (!markerPaths.has(marker)) continue;
    const text = repo.head(marker) ?? repo.base(marker);
    if (text == null) continue;
    let builtFrom;
    try { builtFrom = JSON.parse(text)?.builtFrom; } catch { return null; }
    if (typeof builtFrom !== "string" || !/^[^/]/.test(builtFrom) || builtFrom.split("/").some((part) => !part || part === "." || part === "..")) return null;
    const source = `${builtFrom}/${parts.slice(depth).join("/")}`;
    return (repo.head(source) ?? repo.base(source)) == null ? null : source;
  }
  return null;
}

/** Whether an added line declares a sort comparator: a two-parameter sort callback or `const compare* = (a, b)`, or a `compare*` function with two typed or untyped parameters or a parameter list wrapped onto later lines. */
export function isComparatorLine(text) {
  return COMPARATOR.test(text);
}
