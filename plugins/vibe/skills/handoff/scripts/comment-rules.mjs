// Comment and leftover checks for what the PR #9732 takeover review found
// after vibe's own review passed.
//
// Blocking rules, which diff-rules.mjs runs (checkCommentRules):
// - excuse-comment: an added comment excusing a deviation ("a pre-existing
//   defect on main") cites no ticket; the repository's workaround gate misses
//   it because it matches other words.
// - guarded-constant: a value used only where `C` holds reads `!C`, which is
//   then always false (`readOnly={!editMode.isEditing}` once the only
//   unguarded use, the historical edit row, was removed).
//
// Candidates for the guardrails reviewer to judge (commentCandidates, and the
// CLI below), because on 40 recent main commits of one repository these fired
// on 13 with mostly legitimate comments:
// - stale-citation: the diff replaced a citation in one comment and other
//   comments in the same file still cite it (DI-13 left at :51 and :93).
// - removed-name-comment: a comment still names an identifier the diff
//   removed from the file's code.
//
// Usage: comment-rules.mjs --worktree <path> --base <sha>
//   Prints {"blocking":[...],"candidates":[...]} for the tracked diff of the
//   worktree against <sha>.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { localPlanPrefix } from "../../vibe/scripts/local-plans.mjs";
import { parseUnifiedDiff } from "./diff-rules.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { providerDataOr, sessionBinding, ticketReference } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { exitOnProviderBroken } = await vibeCore("lib/vibe/scripts/provider.mjs");

const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|\{\s*\/\*)/;
// "bug" and "regression" alone fired on ten legitimate comments in 40 main commits (feature names, story descriptions).
const EXCUSE = /\b(?:pre-?existing|defects?|on main|work(?:s|ing)?[ -]?around|known (?:issue|bug|failure|problem|defect)s?)\b/i;
const COMPOUND_NAME = /\b(?:[a-z][a-z0-9]*[A-Z]|[A-Z][a-z0-9]+[A-Z])[A-Za-z0-9]*\b/g;
const DEFINITION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*/g;
const NEGATED_CONDITION = /!\s*([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\b(?!\s*\()/g;
const OPEN = { "(": ")", "{": "}", "[": "]" };

function codeFiles(files) {
  return files.filter((file) => file.status !== "D" && CODE_FILE.test(file.path) && !isTestFile(file.path));
}

/** Contiguous runs of added comment lines, as {line, text} blocks. */
function addedCommentBlocks(file) {
  const blocks = [];
  for (const entry of file.added.filter((item) => COMMENT_LINE.test(item.text))) {
    const last = blocks.at(-1);
    if (last && last.at(-1).line === entry.line - 1) last.push(entry);
    else blocks.push([entry]);
  }
  return blocks;
}

/** The head file's comment lines, with their line numbers. */
function headComments(text) {
  return text.split("\n").map((line, index) => ({ line: index + 1, text: line })).filter((entry) => COMMENT_LINE.test(entry.text));
}

/**
 * An added comment that excuses a deviation must name the ticket that retires it: `ticketed`, the session's
 * ticket reference (provider.mjs ticketReference).
 */
export function checkExcuseComments(files, add, ticketed = ticketReference(null)) {
  for (const file of codeFiles(files)) {
    for (const block of addedCommentBlocks(file)) {
      const text = block.map((entry) => entry.text).join(" ");
      const excuse = EXCUSE.exec(text);
      if (excuse && !ticketed.test(text)) {
        add("excuse-comment", file.path, block[0].line, `adds a comment excusing a deviation ("${excuse[0]}") that cites no ticket; "on main" and "pre-existing" go stale at merge`, "file the ticket for the defect and cite it (its tracker slug, issue number or the upstream issue URL) in the comment");
      }
    }
  }
}

/** A citation the diff replaced in one comment that the file's other comments still cite. */
export function checkStaleCitations(files, repo, add) {
  for (const file of codeFiles(files)) {
    const removed = new Set(file.removed.filter((entry) => COMMENT_LINE.test(entry.text)).flatMap((entry) => entry.text.match(citations(repo)) ?? []));
    if (!removed.size) continue;
    const kept = new Set(file.added.filter((entry) => COMMENT_LINE.test(entry.text)).flatMap((entry) => entry.text.match(citations(repo)) ?? []));
    const comments = headComments(repo.head(file.path) ?? "");
    for (const token of [...removed].filter((item) => !kept.has(item))) {
      const still = comments.filter((entry) => (entry.text.match(citations(repo)) ?? []).includes(token));
      if (still.length) {
        add("stale-citation", file.path, still[0].line, `the diff replaced the citation ${token} in one comment, but line${still.length === 1 ? "" : "s"} ${still.map((entry) => entry.line).join(", ")} still cite${still.length === 1 ? "s" : ""} it`, "check each still names the right source; correct the ones the change made wrong");
      }
    }
  }
}

/** A comment must not name an identifier the diff removed from the file's code. */
export function checkRemovedNameComments(files, repo, add) {
  for (const file of codeFiles(files)) {
    const head = repo.head(file.path) ?? "";
    const lines = head.split("\n");
    const code = lines.filter((line) => !COMMENT_LINE.test(line)).join("\n");
    const removed = new Set(file.removed.filter((entry) => !COMMENT_LINE.test(entry.text)).flatMap((entry) => entry.text.match(COMPOUND_NAME) ?? []));
    for (const name of removed) {
      if (new RegExp(`\\b${name}\\b`).test(code)) continue;
      const comment = headComments(head).find((entry) => new RegExp(`\\b${name}\\b`).test(entry.text));
      if (comment) {
        add("removed-name-comment", file.path, comment.line, `the comment still names \`${name}\`, which the diff removed from this file's code`, "rewrite the comment for the code that replaced it, or delete it");
      }
    }
  }
}

/**
 * A value whose every use sits behind `C ? value` or `C && value` and that reads `!C` itself
 * carries a constant false. Reported only when the diff touches the value or one of its uses.
 */
export function checkGuardedConstants(files, repo, add) {
  for (const file of codeFiles(files)) {
    const head = repo.head(file.path) ?? "";
    const touched = new Set(file.added.map((entry) => entry.line));
    for (const definition of head.matchAll(DEFINITION)) {
      const name = definition[1];
      const start = definition.index + definition[0].length;
      const end = initializerEnd(head, start);
      const initializer = head.slice(start, end);
      const uses = [...head.matchAll(new RegExp(`(?<![\\w$.])${escape(name)}\\b(?!\\s*(?:=(?![=>])|\\())`, "g"))]
        .filter((use) => (use.index < definition.index || use.index >= end) && !isObjectKey(head, use.index, name));
      if (!uses.length) continue;
      const lineOf = (offset) => head.slice(0, offset).split("\n").length;
      const span = [lineOf(definition.index), lineOf(end)];
      const reached = uses.some((use) => touched.has(lineOf(use.index))) || [...touched].some((line) => line >= span[0] && line <= span[1]);
      if (!reached) continue;
      for (const negated of initializer.matchAll(NEGATED_CONDITION)) {
        const condition = negated[1];
        const guard = new RegExp(`(?<![\\w$.])${escape(condition)}\\s*(?:\\?|&&)\\s*\\(?\\s*$`);
        if (uses.every((use) => guard.test(head.slice(Math.max(0, use.index - 200), use.index)))) {
          add("guarded-constant", file.path, lineOf(start + negated.index), `\`${name}\` is used only where \`${condition}\` is true, so \`!${condition}\` inside it is always false`, "remove the dead expression (or the dead branch it guards), or restore the use that needed it");
        }
      }
    }
  }
}

/** The blocking comment rules, for diff-rules.mjs. */
export function checkCommentRules(files, repo, add) {
  checkExcuseComments(files, add, repo.rules?.ticketed);
  checkGuardedConstants(files, repo, add);
}

/** Findings that need the reviewer's judgment, as {rule, file, line, problem, fix}. */
export function commentCandidates(files, repo) {
  const found = [];
  const add = (rule, file, line, problem, fix) => found.push({ rule, file, line, problem, fix });
  checkStaleCitations(files, repo, add);
  checkRemovedNameComments(files, repo, add);
  return found;
}

/** End offset of an initializer: its balanced bracket group, else the end of its statement line. */
function initializerEnd(text, start) {
  let index = start;
  while (/\s/.test(text[index] ?? "")) index += 1;
  if (!OPEN[text[index]]) {
    const newline = text.indexOf("\n", index);
    return newline === -1 ? text.length : newline;
  }
  const stack = [];
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (OPEN[char]) stack.push(OPEN[char]);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return index + 1;
    }
  }
  return text.length;
}

/** Whether `name` at `offset` is a key in an object literal (`{ name: value }`), not a read. */
function isObjectKey(text, offset, name) {
  return /[{,]\s*$/.test(text.slice(Math.max(0, offset - 200), offset)) && /^\s*:/.test(text.slice(offset + name.length));
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  exitOnProviderBroken();
  const { values } = parseArgs({ options: { worktree: { type: "string" }, base: { type: "string" } } });
  if (!values.worktree || !values.base) {
    process.stderr.write("Usage: comment-rules.mjs --worktree <path> --base <sha>\n");
    process.exit(2);
  }
  const files = parseUnifiedDiff(execFileSync("git", ["-C", values.worktree, "diff", "--no-color", "--unified=0", "-M", values.base], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }), localPlanPrefix(sessionBinding(values.worktree)));
  const binding = sessionBinding(values.worktree);
  const repo = { head: (file) => { try { return readFileSync(path.join(values.worktree, file), "utf8"); } catch { return null; } },
    rules: { ticketed: ticketReference(binding), citations: citationPattern(binding) } };
  const blocking = [];
  checkCommentRules(files, repo, (rule, file, line, problem, fix) => blocking.push({ rule, file, line, problem, fix }));
  process.stdout.write(`${JSON.stringify({ blocking, candidates: commentCandidates(files, repo) }, null, 2)}\n`);
}

/**
 * What a comment cites, as a global RegExp: the bound tracker's `citationPattern`, else the session's ticket
 * reference.
 */
export function citationPattern(binding) {
  return new RegExp(providerDataOr(binding, "tickets", "citationPattern", null) ?? ticketReference(binding).source, "g");
}

function citations(repo) {
  const pattern = repo.rules?.citations ?? citationPattern(null);
  pattern.lastIndex = 0;
  return pattern;
}
