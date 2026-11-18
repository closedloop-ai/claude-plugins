// Diff rules for two defects a fresh-context audit caught after a merge: a new
// sort comparator with no tie fixture (it was not a total order), and new
// exports nothing uses (left behind by descoped work). diff-rules.mjs runs them.

import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { SOURCE_FILE } from "./source-imports.mjs";

const COMPARATOR = /\.(?:sort|toSorted)\(\s*(?:\(\s*[\w$]+\s*,\s*[\w$]+\s*\)\s*=>|function\b)|\b(?:const|function)\s+compare[A-Z]?\w*\s*(?:=\s*\(\s*[\w$]+\s*,\s*[\w$]+|\()/;
const NAMED_EXPORT = /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface)\s+([\w$]+)/;
// Names a framework reaches by convention rather than by import.
const CONVENTION_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "metadata", "generateMetadata", "generateStaticParams", "viewport", "config", "dynamic", "revalidate", "runtime", "loader", "action", "handler", "meta", "middleware"]);
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
    const entry = file.added.find((item) => COMPARATOR.test(item.text));
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
function helperIndex(repo, names) {
  const index = new Map();
  for (const file of [...repo.headFiles].filter((entry) => SOURCE_FILE.test(entry) && !isTestFile(entry) && !/\.stories\.[jt]sx?$/.test(entry)
    && !repo.generatedFiles?.has(entry)).sort()) {
    const source = repo.head(file);
    if (typeof source !== "string") continue;
    for (const [name, body] of helperBodies(source, names)) {
      const entries = index.get(name) ?? [];
      entries.push({ file, body });
      index.set(name, entries);
    }
  }
  return index;
}

/** A newly added helper must not copy an identical existing or fellow-diff helper. */
export function checkDuplicateHelpers(files, repo, add) {
  const declarations = sources(files).flatMap((file) => file.added.flatMap((entry) => {
    const name = HELPER_DECL.exec(entry.text)?.[2];
    return name ? [{ name, file: file.path, line: entry.line }] : [];
  }));
  if (declarations.length === 0) return;
  const changed = new Set(files.map((file) => file.path));
  const indexed = helperIndex(repo, new Set(declarations.map(({ name }) => name)));
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
    const duplicate = candidates.find((candidate) => candidate.file !== file
      && (!changed.has(candidate.file) || candidate.file < file) && candidate.body === body
      && sourceOf(file) !== candidate.file && sourceOf(candidate.file) !== file)?.file;
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
