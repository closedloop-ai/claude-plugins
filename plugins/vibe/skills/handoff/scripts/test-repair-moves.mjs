import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { topLevelTestCases } from "../../vibe/scripts/dist/qa-impact-parser.mjs";

const ASSERTION = /\b(?:expect|assert)\s*[.(]|\.(?:toBe|toEqual|toStrictEqual|toMatch|toThrow|toContain|toHave\w*)\b/;
const SKIP = /\b(?:it|test|describe)\.(?:skip|todo|only)\s*\(/;

const squash = (text) => text.replace(/\s+/g, " ").replace(/,\s*([)\]}])/g, "$1").replace(/\s*([()[\]{},;])\s*/g, "$1").replace(/;$/, "").trim();
const ASSERTION_START = /\b(?:expect|assert[\w.]*)\s*[.(]/g;

/** The assertion statements of `source` (`expect(...)...;` across lines), each with its starting line and whitespace-free form. */
export function assertionStatements(source) {
  const found = [];
  let resume = 0;
  for (const match of source.matchAll(ASSERTION_START)) {
    if (match.index < resume) continue;
    let depth = 0;
    let quote = null;
    let end = source.length;
    for (let at = match.index; at < source.length; at += 1) {
      const char = source[at];
      if (quote) {
        if (char === "\\") at += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if ("([{".includes(char)) depth += 1;
      else if (")]}".includes(char)) depth -= 1;
      else if (depth === 0 && (char === ";" || (char === "\n" && /[)\]}]\s*$/.test(source.slice(match.index, at))))) { end = at; break; }
      if (depth < 0) { end = at; break; }
    }
    const raw = source.slice(match.index, end);
    found.push({ line: source.slice(0, match.index).split("\n").length, raw: raw.replace(/\s+/g, " ").trim(), norm: squash(raw) });
    resume = end;
  }
  return found;
}

/** Runnable TS/JS tests and their individually addressable assertions from the existing case parser. */
export function testAssertionCases(file, source) {
  if (typeof source !== "string") return [];
  return (topLevelTestCases(file, source) ?? []).map((entry) => {
    const body = source.slice(entry.start, entry.end);
    return { name: entry.name, body, assertions: assertionStatements(body) };
  });
}

/** A responsibility split may add a same-directory sibling with the same test suffix. */
function splitTestSibling(source, destination) {
  const suffix = /\.(?:test|spec)\.[^.]+$/.exec(source)?.[0];
  if (!suffix || path.posix.dirname(source) !== path.posix.dirname(destination) || !destination.endsWith(suffix)) return false;
  const prefix = `${source.slice(0, -suffix.length)}-`;
  return destination.startsWith(prefix) && /^[a-z0-9][a-z0-9-]*$/i.test(destination.slice(prefix.length, -suffix.length));
}

/** Exact whole-line spans of uniquely moved, byte-identical runnable cases. */
export function movedTestCases(file, before, after, files, readHead) {
  if (file.status !== "M") return [];
  const modified = files.filter((candidate) => candidate.status === "M");
  const added = files.filter((candidate) => candidate.status === "A");
  const siblings = added.filter((candidate) => splitTestSibling(file.path, candidate.path)
    && modified.filter((entry) => splitTestSibling(entry.path, candidate.path)).length === 1);
  if (siblings.length === 0) return [];
  if (typeof before !== "string" || typeof after !== "string") return [];
  const beforeCases = topLevelTestCases(file.path, before);
  const afterCases = topLevelTestCases(file.path, after);
  if (!beforeCases || !afterCases) return [];
  const afterNames = new Set(afterCases.map((entry) => entry.name));
  const destinations = [];
  for (const entry of siblings) {
    const text = readHead(entry.path);
    const cases = typeof text === "string" ? topLevelTestCases(entry.path, text) : null;
    if (!cases) return [];
    destinations.push(...cases.map((item) => ({ ...item, text })));
  }
  const moves = [];
  for (const entry of beforeCases) {
    if (afterNames.has(entry.name) || beforeCases.filter((item) => item.name === entry.name).length !== 1) continue;
    const candidates = destinations.filter((item) => item.name === entry.name);
    if (candidates.length !== 1) continue;
    const [candidate] = candidates;
    const body = before.slice(entry.start, entry.end);
    if (entry.runner !== candidate.runner || body !== candidate.text.slice(candidate.start, candidate.end)) continue;
    const first = before.lastIndexOf("\n", entry.start - 1) + 1;
    const endLine = before.indexOf("\n", entry.end);
    const last = endLine < 0 ? before.length : endLine;
    if (before.slice(first, entry.start).trim() || before.slice(entry.end, last).trim()) continue;
    moves.push({ start: entry.start, end: entry.end, firstLine: before.slice(0, first).split("\n").length,
      lastLine: before.slice(0, last).split("\n").length });
  }
  return moves;
}

/** Read an actual in-worktree test file; symlinks cannot serve as move evidence. */
export function regularTestText(worktree, file) {
  try {
    const root = realpathSync(worktree);
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(root + path.sep) || !lstatSync(absolute).isFile() || realpathSync(absolute) !== absolute) return undefined;
    return readFileSync(absolute, "utf8");
  } catch {
    return undefined;
  }
}

function movedDiffCases(file, tests, { readBase, readHead }) {
  if (file.status !== "M" || !tests.some((test) => test.status === "A" && splitTestSibling(file.path, test.path))) return [];
  try {
    return movedTestCases(file, readBase(file.path), readHead(file.path), tests, readHead);
  } catch {
    // Without the exact source on both sides, keep every removal finding.
    return [];
  }
}

/** Flipped and removed assertions, added skips and deleted test files. */
export function assertionChanges(files, readers = null) {
  const tests = files.filter((file) => isTestFile(file.path));
  return tests.flatMap((file) => {
    if (file.status === "D") {
      return [{ kind: "deleted-test-file", path: file.path }];
    }
    const moves = readers ? movedDiffCases(file, tests, readers) : [];
    return file.hunks.flatMap((hunk) => {
      const added = hunk.added.filter((line) => ASSERTION.test(line.text));
      return [
        ...hunk.removed.filter((line) => ASSERTION.test(line.text)
          && !moves.some(({ firstLine, lastLine }) => line.line >= firstLine && line.line <= lastLine)).map((line, i) => (added[i]
          ? { kind: "flipped", path: file.path, line: added[i].line, before: line.text.trim(), after: added[i].text.trim() }
          : { kind: "removed", path: file.path, line: hunk.newStart, before: line.text.trim() })),
        ...hunk.added.filter((line) => SKIP.test(line.text)).map((line) => ({ kind: "skip-added", path: file.path, line: line.line })),
      ];
    });
  });
}
