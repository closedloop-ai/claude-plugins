// The surface decisions of the criteria audit and the unit review, and the "no surface" mark that
// overrides both (ISS-14136). criteria-audit.mjs asks needsRunningSurface and unit-review.mjs asks
// namedSurfaces; an unmarked criterion keeps each script's existing rule. This module also owns the
// evidence point (EvidenceAt): whether a test file exists there, and its text for a mark's test name.
//
// A criterion's own words name a surface or a page ("on Desktop", "every list page"). Some such
// criteria have no screen: a contract, a command, a statement that nothing is added. The reviewer
// marks one in the audit file with the line
//   No surface: <criterion id>: <reason>
// and a row that names the test which proves it:
//   | <criterion id> | MET | test | <test file>::<test name> |
// A line that starts like a mark but is not one in that exact form is reported, never dropped.
// The mark is accepted only with a reason and a test that exists: the file is in the worktree (or at
// HEAD), and holds an `it(` or `test(` call (or a Python `def`) whose title is that name, on one line,
// outside a comment, and not a skipped or todo form (`it.skip`, `test.todo`, `xit`). Not seen: a title
// split over lines or built from a template, a test inside a skipped `describe`, a skip decorator. An accepted mark removes the demand for an app
// run or a capture for that criterion and nothing else; a refused one leaves the criterion unmarked.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { escapeRegExp } from "./source-imports.mjs";

const RUNTIME_CRITERION = /\b(?:web|desktop|electron|browser)\b|\brunning (?:app|product)\b/i;
export const ACROSS_PAGES = /\b(?:every|each|all|across)(?: the| all)?(?: \w+)? pages?\b|\bwhere(?:ver)? (?:it is |they are )?available\b/i;
export const ACROSS_SURFACES = /\bboth (?:surfaces|hosts|shells|platforms|apps)\b|\b(?:every|each|all) (?:surfaces?|hosts?|shells?|platforms?)\b/i;
export const KNOWN_SURFACES = Object.freeze(["Web", "Desktop"]);

const AUDIT_ROW = /^\|\s*((?:[A-Z]+-\d+:)?AC-\d+)\s*\|\s*(MET|PARTIAL|MISSED)\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$/gm;
const MARK_LINE = /^No surface:[ \t]*((?:[A-Z]+-\d+:)?AC-\d+)\b[ \t]*(?::[ \t]*(.*))?$/;
const MARK_LIKE = /^\s*(?:[-*+>]\s*)*no[\s_-]*surface\s*:/i;

export const EvidenceAt = Object.freeze({ Worktree: "worktree", Head: "head" });
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/;

/** Names from `names` that `text` mentions as a word, singular or plural. */
export function namesIn(text, names) {
  return names.filter((name) => {
    const variants = [name, name.replace(/e?s$/i, ""), name.replace(/s$/i, "")].filter(Boolean).map(escapeRegExp);
    return new RegExp(`(^|[^A-Za-z0-9])(?:${[...new Set(variants)].join("|")})s?(?![A-Za-z0-9])`, "i").test(text);
  });
}

/** The audit table's rows: `| AC-n | MET|PARTIAL|MISSED | <type> | <ref> |`. */
export function auditRows(audit) {
  return [...audit.matchAll(AUDIT_ROW)].map((match) => ({ criterion: match[1], verdict: match[2], type: match[3], ref: match[4] }));
}

/** A test ref's file and test name: `<file>::<test name>` or `<file>#<test name>`. */
export function testRef(ref) {
  const [file, ...name] = String(ref ?? "").split(/::|#/);
  return { file: file.trim(), name: name.join("::").trim() };
}

/** The refusal for a test row whose file does not exist. */
export function missingTestProblem(id, file, at) {
  return `${id}: the test ${file} does not exist ${at === EvidenceAt.Head ? "at HEAD" : "in the worktree"}; a planned test is not evidence`;
}

/**
 * Whether a test ref exists at the evidence point: at HEAD with `EvidenceAt.Head`, else in the worktree
 * or, for a path only staged, the index. A directory counts, as it always has for an audit row.
 */
export function testFileExists(worktree, file, at = EvidenceAt.Worktree) {
  return at === EvidenceAt.Head ? inGit(worktree, `HEAD:${file}`) : existsSync(path.join(worktree, file)) || inGit(worktree, `:${file}`);
}

function inGit(worktree, object) {
  try {
    execFileSync("git", ["-C", worktree, "cat-file", "-e", object], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A test file's text at the evidence point, read only where a mark needs its test name; null when it cannot be read as a file. */
function testFileText(worktree, file, at) {
  try {
    if (at !== EvidenceAt.Head && existsSync(path.join(worktree, file))) return readFileSync(path.join(worktree, file), "utf8");
    return execFileSync("git", ["-C", worktree, "show", `${at === EvidenceAt.Head ? "HEAD" : ""}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** The operator's line for an accepted mark: `NO-SURFACE <ticket> <criterion>: <reason>`, the ticket from the id or `slug`. */
export function noSurfaceLine(id, reason, slug = null) {
  const at = id.indexOf(":");
  const where = at > 0 ? `${id.slice(0, at)} ${id.slice(at + 1)}` : [slug, id].filter(Boolean).join(" ");
  return `NO-SURFACE ${where}: ${reason}`;
}

/** True when `text` declares a live test titled `name`: not in a comment, not a skip or todo form. */
function declaresTest(text, name) {
  const title = escapeRegExp(name);
  const call = new RegExp(`(?:^|[^\\w.$])(?:it|test)(?:\\.only)?\\s*\\(\\s*(["'\`])${title}\\1`);
  const python = new RegExp(`^\\s*(?:async\\s+)?def\\s+${title}\\s*\\(`);
  return text.split("\n").some((line) => {
    if (COMMENT_LINE.test(line)) return false;
    const found = call.exec(line);
    return python.test(line) || (found !== null && !line.slice(0, found.index).includes("//"));
  });
}

/**
 * The accepted "no surface" marks of an audit, by criterion id, and the problems of the refused ones.
 * With no worktree (a caller that has only the text) the test file is not read. `rowsAudited` says the
 * caller already refuses a test row whose file is missing, so that is not reported twice.
 */
export function noSurfaceMarks(audit, criteria, { worktree = null, at = EvidenceAt.Worktree, rowsAudited = false } = {}) {
  const rows = auditRows(audit);
  const known = new Set(criteria.map(({ id }) => id));
  const marks = new Map();
  const problems = [];
  for (const line of audit.split("\n")) {
    if (!MARK_LIKE.test(line)) continue;
    const match = MARK_LINE.exec(line.trimEnd());
    if (!match) {
      problems.push(`${JSON.stringify(line.trim())}: a no-surface mark reads "No surface: <id>: <reason>"`);
      continue;
    }
    const [, id, rawReason = ""] = match;
    const reason = rawReason.trim();
    if (!known.has(id)) {
      problems.push(`${id}: no-surface mark for a criterion the ticket does not list`);
      continue;
    }
    if (!reason) {
      problems.push(`${id}: a no-surface mark needs its reason`);
      continue;
    }
    const tests = rows.filter((row) => row.criterion === id && row.verdict === "MET" && row.type === "test").map((row) => testRef(row.ref)).filter((test) => test.file && test.name);
    if (tests.length === 0) {
      problems.push(`${id}: a no-surface mark needs a MET test row that names the test: <file>::<test name>`);
      continue;
    }
    const refused = [];
    const accepted = tests.find((test) => {
      if (worktree === null) return true;
      if (!testFileExists(worktree, test.file, at)) {
        if (!rowsAudited) refused.push(missingTestProblem(id, test.file, at));
        return false;
      }
      const text = testFileText(worktree, test.file, at);
      if (text !== null && declaresTest(text, test.name)) return true;
      refused.push(`${id}: ${test.file} has no test named "${test.name}"`);
      return false;
    });
    if (accepted) marks.set(id, { reason, test: accepted });
    else problems.push(...refused);
  }
  return { marks, problems };
}

/** True when the criterion's words ask for the product running on a surface and no accepted mark says otherwise. */
export function needsRunningSurface(criterion, marks = new Map()) {
  return !marks.has(criterion.id) && RUNTIME_CRITERION.test(criterion.text ?? "");
}

/** The names from `names`, and the cross-page or cross-surface wording, that an unmarked criterion uses. */
export function namedSurfaces(criterion, names, marks = new Map()) {
  if (marks.has(criterion.id)) return [];
  const named = [...namesIn(criterion.text, names)];
  if (ACROSS_PAGES.test(criterion.text)) named.push("every page");
  if (ACROSS_SURFACES.test(criterion.text)) named.push("every surface");
  return named;
}
