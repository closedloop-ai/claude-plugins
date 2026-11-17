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

/** A newly added helper must not copy an identical existing or fellow-diff helper. */
export function checkDuplicateHelpers(files, repo, add) {
  const changed = new Set(files.map((file) => file.path));
  for (const file of sources(files)) {
    for (const entry of file.added) {
      const name = HELPER_DECL.exec(entry.text)?.[2];
      if (!name) continue;
      const body = helperBody(repo.head(file.path), name);
      if (!body || body.length < 16) continue;
      const duplicate = repo.wordFiles(name).filter((other) => other !== file.path && SOURCE_FILE.test(other)
        && !isTestFile(other) && !/\.stories\.[jt]sx?$/.test(other))
        .sort().find((other) => (!changed.has(other) || other < file.path)
          && helperBody(repo.head(other) ?? repo.base(other), name) === body);
      if (duplicate) add("duplicate-helper", file.path, entry.line,
        `new helper ${name} duplicates ${duplicate}`,
        `move the shared behavior to one owner and import it from ${duplicate}`);
    }
  }
}
