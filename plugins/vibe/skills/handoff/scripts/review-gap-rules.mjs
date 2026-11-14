// Diff rules for two defects a fresh-context audit caught after a merge: a new
// sort comparator with no tie fixture (it was not a total order), and new
// exports nothing uses (left behind by descoped work). diff-rules.mjs runs them.

import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { SOURCE_FILE } from "./source-imports.mjs";

const COMPARATOR = /\.(?:sort|toSorted)\(\s*(?:\(\s*[\w$]+\s*,\s*[\w$]+\s*\)\s*=>|function\b)|\b(?:const|function)\s+compare[A-Z]?\w*\s*(?:=\s*\(\s*[\w$]+\s*,\s*[\w$]+|\()/;
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
 * tie test on the Missing tests list, stands in for it (ISS-13321).
 */
export function checkComparators(files, repo, logged, add, changeLog, phase = "pull-request") {
  for (const file of sources(files)) {
    const entry = file.added.find((item) => COMPARATOR.test(item.text));
    if (!entry) continue;
    const lines = changeLog.split("\n").filter((line) => line.includes("Comparator:") && line.includes(file.path));
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

/** Body of a simple named helper; same-indent closure keeps nested blocks intact. */
function helperBody(source, name) {
  const lines = (source ?? "").split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    const match = HELPER_DECL.exec(lines[start]);
    if (match?.[2] !== name) continue;
    const close = `${match[1]}}`;
    for (let end = start + 1; end < lines.length; end += 1) {
      if (lines[end] !== close) continue;
      return lines.slice(start + 1, end).map((line) => line.trim()).join("\n");
    }
  }
  return null;
}

/**
 * In build output (a generated banner on its first line), the module label of the section that defines
 * helper `name`: the nearest label line above its declaration. Null for a hand-written file. A `dist/`
 * path proves nothing, so it exempts nothing (ISS-14127).
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
 * A newly added helper must not copy an identical existing or fellow-diff helper. A bundle and the
 * source it inlined are one definition, whichever of the two the diff adds, and so are two bundles that
 * inlined it from the same source.
 */
export function checkDuplicateHelpers(files, repo, add) {
  const changed = new Set(files.map((file) => file.path));
  for (const file of sources(files)) {
    for (const entry of file.added) {
      const name = HELPER_DECL.exec(entry.text)?.[2];
      if (!name) continue;
      const own = repo.head(file.path);
      const body = helperBody(own, name);
      if (!body || body.length < 16) continue;
      const duplicate = repo.wordFiles(name).filter((other) => other !== file.path && SOURCE_FILE.test(other)
        && !isTestFile(other) && !/\.stories\.[jt]sx?$/.test(other))
        .sort().find((other) => {
          if (changed.has(other) && other > file.path) return false;
          const text = repo.head(other) ?? repo.base(other);
          if (helperBody(text, name) !== body) return false;
          const ownSource = bundledFrom(own, name);
          const otherSource = bundledFrom(text, name);
          if (ownSource && labels(ownSource, other)) return false;
          if (otherSource && labels(otherSource, file.path)) return false;
          return !(ownSource && otherSource && ownSource === otherSource);
        });
      if (duplicate) add("duplicate-helper", file.path, entry.line,
        `new helper ${name} duplicates ${duplicate}`,
        `move the shared behavior to one owner and import it from ${duplicate}`);
    }
  }
}
