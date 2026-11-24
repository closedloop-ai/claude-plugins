#!/usr/bin/env node
// The mechanical checks of `vibe-guardrails-reviewer`, run before any model reads the diff, as one findings JSON the
// consolidated reviewer reads instead of re-deriving them. It WRAPS the
// target repository's own gates and `diff-rules.mjs`; it re-implements neither:
//
//   biome         `pnpm exec biome check` on the changed files
//   source-gates  the repository's source gates (the provider verify recipe's `source-gates` check)
//   diff-rules    `runDiffRules` (diff-rules.mjs), the same findings handoff-inventory reports
//
// and adds the added-line scans the reviewer's prose asked a model to do:
//
//   tokens            hardcoded hex colors, arbitrary pixel values and inline styles in UI and CSS
//   conventions       TypeScript `enum`, `as` casts, client `console` calls, raw internal `<a href>`,
//                     inline `import()`, files over 1,000 lines
//   test-repair       a changed or added assertion in an edited test file (word-level, whitespace ignored)
//   owner-duplicates  a new export whose name another file outside the change already exports
//
// The reviewer's judgment checks (copy provenance, accessibility, fake data,
// shared-owner red flags, placement, main-sync regressions) are not scripted:
// they are not in `checks_run`, and a check that could not run is in
// `checks_skipped` with its reason. An empty `findings` list with a skipped or
// absent check is never a clean pass: the exit code says which (below).
//
// Usage: guardrails-gate.mjs --worktree <path> [--base <sha>] [--out <file>]
// The findings file (default `<gitdir>/vibe-guardrails-findings.json`) is
// documented in `../../vibe/references/guardrails-findings.md` and has EXACTLY
// the shape of FINDINGS_SCHEMA below. Exit 0: no finding and every scriptable check ran;
// 1: at least one finding; 3: no finding, but a scriptable check was skipped
// (the reviewer's judgment checks are always listed as skipped and do not
// change the exit code; they are the reviewer's by design).

import { readGitInventory } from "../../../lib/vibe/scripts/git-inventory.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { execCommand, stdoutOf, tailLines, toolDidNotRun } from "../../vibe/scripts/ws3-exec.mjs";
import { localPlanPaths, sessionLocalPlanPrefix } from "../../vibe/scripts/local-plans.mjs";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { readRetiredTests } from "../../vibe/scripts/retired-tests.mjs";
import { assertionStatements, movedTestCases, regularTestText } from "./test-repair-moves.mjs";
import { supersededAssertionSpans, testSupersessionApprovals } from "./test-supersession-evidence.mjs";
import { isGeneratedFile, linguistGenerated } from "./generated-files.mjs";
import { LINE_CEILING, lineCeilingFailure, sourceLineCount } from "./source-line-ceiling.mjs";
import { parseUnifiedDiff, runDiffRules, untrackedAsAdded } from "./diff-rules.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

const { providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { failScript } = await vibeCore("lib/vibe/scripts/provider.mjs");

export const FINDINGS_SCHEMA = "vibe.guardrails-findings/1";
export const Severity = Object.freeze({ High: "high", Medium: "medium", Low: "low" });
export const Check = Object.freeze({
  Biome: "biome", SourceGates: "source-gates", DiffRules: "diff-rules", Tokens: "tokens", Conventions: "conventions",
  TestRepair: "test-repair", OwnerDuplicates: "owner-duplicates",
});
// Judgment checks that stay with the reviewer; listed as skipped so an absent check never reads as passed.
export const REVIEWER_CHECKS = Object.freeze([
  { name: "main-sync-regressions", reason: "needs the captured main's files and a judgment on what a removal took with it; the reviewer reads it" },
  { name: "copy-provenance", reason: "whether wording was given or invented needs the conversation; the reviewer reports it" },
  { name: "accessibility", reason: "a judgment over rendered states; the reviewer reads it" },
  { name: "shared-owner", reason: "shared-owner red flags need the import graph and the plan's owner inventory; the reviewer reads them" },
]);
const REVIEWER_CHECK_NAMES = new Set(REVIEWER_CHECKS.map((entry) => entry.name));
const UI_FILE = /\.(?:tsx|jsx|css|scss)$/;
const SOURCE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const TS_FILE = /\.tsx?$/;
const COMMENT = /^\s*(?:\/\/|\/\*|\*|\{\/\*)/;
const HEX_VALUE = String.raw`#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b(?![\w-])`;
const CSS_HEX_COLOR = new RegExp(String.raw`(?:^|[;{]\s*)[\w-]+\s*:\s*${HEX_VALUE}`);
const TAILWIND_HEX_COLOR = new RegExp(String.raw`\b(?:bg|text|border|outline|fill|stroke|shadow)-\[${HEX_VALUE}\]`);
const STYLE_HEX_COLOR = new RegExp(String.raw`(?:\bstyle\s*=\s*\{\{|\b(?:color|backgroundColor|borderColor|outlineColor|fill|stroke)\s*:)\s*["']?${HEX_VALUE}`);
const CUSTOM_PROPERTY = /^\s*--[\w-]+\s*:/;
const ARBITRARY_PIXEL = /\[-?\d+(?:\.\d+)?px\]/;
const INLINE_STYLE = /\bstyle=\{\{/;
const ENUM = /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+\w+/;
const AS_CAST = /\bas\s+(?!const\b)(?:[A-Z][\w.]*(?:<[^>]*>)?|\{|\[|unknown\b|any\b|string\b|number\b|boolean\b)/;
const SPECIFIER_LINE = /^\s*(?:type\s+)?[\w$]+\s+as\s+[\w$]+,?\s*$/;
// import / export-from / export-list statements, whose `as` renames a binding and never casts.
const RENAME_STATEMENT = /^[ \t]*(?:import\b[^;]*?(?:\bfrom\s*)?["'][^"']+["']|export\s*(?:type\s*)?\{[^}]*\}(?:\s*from\s*["'][^"']+["'])?|export\s*\*\s*as\s+[\w$]+\s+from\s*["'][^"']+["'])/gm;
const CONSOLE_CALL = /\bconsole\.(?:log|warn|error|debug|info)\(/;
const RAW_ANCHOR = /<a\s[^>]*href=["']\/(?!\/)/;
const INLINE_IMPORT = /(?<![\w.])import\(/;
const STORY_DEBT_REVIEW_START = Math.floor(LINE_CEILING * 0.9);
const STORY = /\.stories\.[jt]sx?$/;
const DEBT_LINE = /^\s*(?:[-*]\s+)?Debt: ([^;]+); added: ([^;]+); reused instead: ([^;]+); reason: (\S.+?)\s*$/;
const ASSERTION = /\b(?:expect|assert\w*|should)\b[.(]|\.(?:toBe|toEqual|toStrictEqual|toMatch|toContain|toHaveBeenCalled\w*|toHave\w+|toThrow\w*|toBeTruthy|toBeFalsy|toBeNull|toBeDefined|toBeUndefined)\(/;
const EXPORT_NAME = /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|function\*?|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const MIN_EXPORT_NAME = 4;
const MAX_OWNER_LOOKUPS = 60;
const EVIDENCE_LIMIT = 240;
const FILE_LINE = /(?:^|\s)((?:[\w@.-]+\/)+[\w@.-]+\.(?:tsx?|jsx?|mjs|cjs|json|jsonc|css|scss))(?::(\d+))?/;

/** A stable id for one finding: the same check, file, line and message always give the same id. */
export function findingId(check, file, line, message) {
  return `${check}:${createHash("sha1").update(`${check}\u0000${file}\u0000${line ?? ""}\u0000${message}`).digest("hex").slice(0, 10)}`;
}

function finding(check, file, line, severity, message, evidence) {
  return { id: findingId(check, file, line, message), check, file, line: Number.isInteger(line) ? line : null, severity, message, evidence: String(evidence ?? "").slice(0, EVIDENCE_LIMIT) };
}

/** The shape every consumer may rely on; used by the gate's own output and by tests. */
export function findingsProblems(report) {
  const problems = [];
  const keys = Object.keys(report ?? {}).sort().join(",");
  if (keys !== "base,checks_run,checks_skipped,findings,head,schema") problems.push(`top-level keys are ${keys}`);
  if (report?.schema !== FINDINGS_SCHEMA) problems.push("schema is not vibe.guardrails-findings/1");
  for (const field of ["head", "base"]) if (typeof report?.[field] !== "string" || report[field] === "") problems.push(`${field} is not a nonempty string`);
  if (!Array.isArray(report?.checks_run) || !report.checks_run.every((name) => typeof name === "string")) problems.push("checks_run is not a list of names");
  const skipped = report?.checks_skipped;
  if (!Array.isArray(skipped) || !skipped.every((entry) => typeof entry?.name === "string" && typeof entry?.reason === "string" && entry.reason !== "")) problems.push("checks_skipped needs a name and a reason each");
  const ids = new Set();
  for (const [index, item] of (Array.isArray(report?.findings) ? report.findings : []).entries()) {
    const label = `findings[${index}]`;
    if (Object.keys(item).sort().join(",") !== "check,evidence,file,id,line,message,severity") problems.push(`${label} has the wrong keys`);
    if (!Object.values(Severity).includes(item.severity)) problems.push(`${label}.severity is ${item.severity}`);
    if (!(item.line === null || Number.isInteger(item.line))) problems.push(`${label}.line is not an integer or null`);
    if (typeof item.file !== "string" || typeof item.message !== "string" || typeof item.evidence !== "string" || typeof item.check !== "string") problems.push(`${label} has a non-string field`);
    if (ids.has(item.id)) problems.push(`${label}.id repeats`);
    ids.add(item.id);
    const known = new Set([...(report.checks_run ?? []), ...(Array.isArray(skipped) ? skipped.map((entry) => entry.name) : [])]);
    if (!known.has(item.check)) problems.push(`${label}.check ${item.check} is in neither checks_run nor checks_skipped`);
  }
  return problems;
}

/** Findings from the added lines of changed UI and CSS files: hex colors, arbitrary pixels, inline styles. */
export function scanTokens(files) {
  const found = [];
  for (const file of files.filter((entry) => entry.status !== "D" && UI_FILE.test(entry.path))) {
    for (const { line, text } of file.added) {
      if (COMMENT.test(text) || CUSTOM_PROPERTY.test(text)) continue;
      const hardcodedColor = /\.(?:css|scss)$/.test(file.path) ? CSS_HEX_COLOR.test(text)
        : TAILWIND_HEX_COLOR.test(text) || STYLE_HEX_COLOR.test(text);
      if (hardcodedColor) found.push(finding(Check.Tokens, file.path, line, Severity.Medium, "hardcoded color; use the token the surface bundles", text.trim()));
      if (ARBITRARY_PIXEL.test(text)) found.push(finding(Check.Tokens, file.path, line, Severity.Medium, "arbitrary pixel value; use the spacing or sizing token", text.trim()));
      if (INLINE_STYLE.test(text)) found.push(finding(Check.Tokens, file.path, line, Severity.Medium, "inline style; use the token classes", text.trim()));
    }
  }
  return found;
}

/** Text with string, template and comment contents blanked, so a word inside prose or a title is never read as code. */
export function codeOnly(line) {
  return line.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (match) => match[0] + match[0]);
}

/** The 1-based lines of `text` inside an import statement, an export list or an export-from, where `as` renames. */
export function renameLines(text) {
  const lines = new Set();
  for (const match of text.matchAll(RENAME_STATEMENT)) {
    const first = text.slice(0, match.index).split("\n").length;
    const count = match[0].split("\n").length;
    for (let at = 0; at < count; at += 1) lines.add(first + at);
  }
  return lines;
}

function matchingCallEnd(source, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (["\"", "'", "`"].includes(char)) quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index;
  }
  return source.length - 1;
}

/** Lines inside Vitest mock factories, where a dynamic import is the supported way to read the real module. */
function mockFactoryLines(source) {
  const lines = new Set();
  for (const match of source.matchAll(/\bvi\.(?:doMock|mock)\s*\(/g)) {
    const open = source.indexOf("(", match.index);
    const close = matchingCallEnd(source, open);
    const first = source.slice(0, match.index).split("\n").length;
    const last = source.slice(0, close).split("\n").length;
    for (let line = first; line <= last; line += 1) lines.add(line);
  }
  return lines;
}

/** Findings from added lines in source files: enum, `as` casts, client `console`, raw internal anchors, inline imports. */
export function scanConventions(files, readHead = () => undefined, unread = []) {
  const found = [];
  for (const file of files.filter((entry) => entry.status !== "D" && SOURCE.test(entry.path) && !/\.(?:mjs|cjs)$/.test(entry.path))) {
    const head = TS_FILE.test(file.path) ? readHead(file.path) : "";
    if (typeof head !== "string") unread.push(file.path);
    const renames = renameLines(head ?? "");
    const mockLines = isTestFile(file.path) ? mockFactoryLines(head ?? "") : new Set();
    for (const { line, text } of file.added) {
      if (COMMENT.test(text)) continue;
      const code = codeOnly(text);
      if (TS_FILE.test(file.path) && ENUM.test(text)) found.push(finding(Check.Conventions, file.path, line, Severity.High, "TypeScript enum; use a PascalCase const object", text.trim()));
      if (TS_FILE.test(file.path) && AS_CAST.test(code) && !renames.has(line) && !SPECIFIER_LINE.test(text) && !/^\s*import\b/.test(text)) found.push(finding(Check.Conventions, file.path, line, Severity.Medium, "`as` cast; narrow or type it instead", text.trim()));
      if (CONSOLE_CALL.test(text) && !isTestFile(file.path)) found.push(finding(Check.Conventions, file.path, line, Severity.Medium, "console call in source", text.trim()));
      if (RAW_ANCHOR.test(text)) found.push(finding(Check.Conventions, file.path, line, Severity.Medium, "raw internal `<a href>`; use the navigation Link", text.trim()));
      if (INLINE_IMPORT.test(code) && !mockLines.has(line)) found.push(finding(Check.Conventions, file.path, line, Severity.Medium, "inline import(); imports belong at the top of the file", text.trim()));
    }
  }
  return found;
}

export { assertionStatements };

/** The words of `after` that are not in `before`, for the evidence of a changed assertion. */
function changedWords(before, after) {
  const had = new Set(before.split(/\s+/));
  return after.split(/\s+/).filter((word) => !had.has(word));
}

/**
 * An edited test file may only be repaired so it compiles. Assertion statements (not lines, so a call split
 * across lines is one statement) of the base and the head are compared, whitespace and trailing commas ignored:
 * a changed, removed or added assertion is reported with the words that differ. An exact complete case moved
 * to a unique added sibling is compared as a relocation. Unreadable base or head text is `unevaluated`.
 */
export function scanTestRepairs(files, readBase, readHead, readMoveHead = readHead, supersessions = {}) {
  const found = [];
  const unevaluated = [];
  const tests = files.filter((entry) => isTestFile(entry.path) && SOURCE.test(entry.path));
  for (const file of tests.filter((entry) => entry.status === "M" || entry.status === "R")) {
    const before = readBase(file.oldPath ?? file.path);
    const after = readHead(file.path);
    if (typeof before !== "string" || typeof after !== "string") { unevaluated.push(file.path); continue; }
    const moves = movedTestCases(file, before, readMoveHead(file.path), tests, readMoveHead);
    const changes = supersededAssertionSpans(file, before, after, supersessions);
    // Mask only exact proved spans without changing any surrounding assertion offsets.
    const mask = (text, spans) => spans.reduce((value, { start, end }) =>
      value.slice(0, start) + value.slice(start, end).replace(/[^\r\n]/g, " ") + value.slice(end), text);
    const base = assertionStatements(mask(before, [...moves, ...changes.map(({ prior }) => prior)]));
    const head = assertionStatements(mask(after, changes.map(({ current }) => current)));
    const claim = (list, other) => {
      const counts = new Map();
      for (const item of other) counts.set(item.norm, (counts.get(item.norm) ?? 0) + 1);
      return list.filter((item) => {
        const left = counts.get(item.norm) ?? 0;
        if (left > 0) { counts.set(item.norm, left - 1); return false; }
        return true;
      });
    };
    const lost = claim(base, head);
    const fresh = claim(head, base);
    const paired = new Set();
    for (const gone of lost) {
      const partner = fresh.filter((item) => !paired.has(item)).sort((a, b) => Math.abs(a.line - gone.line) - Math.abs(b.line - gone.line))[0];
      if (partner) {
        paired.add(partner);
        found.push(finding(Check.TestRepair, file.path, partner.line, Severity.High, "an assertion changed in a test that may only be repaired", `-${gone.raw} +${partner.raw} (changed words: ${changedWords(gone.raw, partner.raw).join(" ") || "none, removed only"})`));
      } else {
        found.push(finding(Check.TestRepair, file.path, gone.line, Severity.High, "an assertion was removed from a test that may only be repaired", `-${gone.raw}`));
      }
    }
    for (const extra of fresh.filter((item) => !paired.has(item))) {
      found.push(finding(Check.TestRepair, file.path, extra.line, Severity.High, "an assertion was added to a test that may only be repaired", `+${extra.raw}`));
    }
  }
  return { findings: found, unevaluated };
}

/** A diff-rules finding as a guardrails finding; the rule keeps its own name in the message. */
export function fromDiffRule(entry) {
  return finding(Check.DiffRules, entry.file ?? ".", entry.line, Severity.High, `${entry.rule}: ${entry.problem}`, entry.fix ?? "");
}

/** Findings parsed from a failing wrapped gate: one per `file:line` its output names, else one for the whole run. */
export function fromGateOutput(check, output, changed) {
  const seen = new Set();
  const found = [];
  for (const line of output.split("\n")) {
    const match = FILE_LINE.exec(line);
    if (!match || (changed.size > 0 && !changed.has(match[1]))) continue;
    const key = `${match[1]}:${match[2] ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(finding(check, match[1], match[2] ? Number(match[2]) : null, Severity.High, `${check} reported a problem here`, line.trim()));
  }
  if (found.length === 0) found.push(finding(check, ".", null, Severity.High, `${check} failed`, tailLines(output, 4)));
  return found;
}

/** Builds the gate over its reads; tests inject `run`, `diffRulesFn`, `exists`, `read`. */
export function createGuardrailsGate({
  run = execCommand,
  diffRulesFn = runDiffRules,
  exists = existsSync,
  read = (file) => readFileSync(file, "utf8"),
} = {}) {
  const git = (worktree, args) => run("git", ["-C", worktree, ...args]);

  function wrappedGate({ name, script, program = "pnpm", args, worktree, changed, scripts, report }) {
    if (script && !(script in scripts)) return report.skip(name, `the repository defines no "${script}" script`);
    if (!exists(path.join(worktree, "node_modules"))) return report.skip(name, "dependencies are not installed in the worktree (no node_modules), so the repository's gate cannot run");
    const result = run(program, args, { cwd: worktree, timeoutMs: 600_000 });
    if (result.status === 124) return report.skip(name, "stopped after 600s on this machine");
    const missing = toolDidNotRun(result);
    if (missing) return report.skip(name, missing);
    report.ran(name);
    if (result.status !== 0) report.add(fromGateOutput(name, `${result.stdout}\n${result.stderr}`, changed));
  }

  function ownerDuplicates({ files, worktree, changedPaths, failed }) {
    const names = new Map();
    for (const file of files.filter((entry) => entry.status !== "D" && SOURCE.test(entry.path) && !isTestFile(entry.path))) {
      for (const { line, text } of file.added) {
        const name = EXPORT_NAME.exec(text)?.[1];
        if (name && name.length >= MIN_EXPORT_NAME && !names.has(name)) names.set(name, { file: file.path, line, text: text.trim() });
      }
    }
    const found = [];
    for (const [name, origin] of [...names].slice(0, MAX_OWNER_LOOKUPS)) {
      const pattern = String.raw`^\s*export\s+(declare\s+)?(default\s+)?(async\s+)?(const|let|function\*?|class|type|interface|enum)\s+${name}\b`;
      const grepped = git(worktree, ["grep", "-nE", pattern, "--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs"]);
      if (grepped.status > 1) { failed.push(name); continue; }
      const other = grepped.stdout.split("\n").filter(Boolean).map((hit) => /^([^:]+):(\d+):/.exec(hit)).filter(Boolean)
        .find((hit) => !changedPaths.has(hit[1]) && !isTestFile(hit[1]));
      if (other) found.push(finding(Check.OwnerDuplicates, origin.file, origin.line, Severity.Medium, `\`${name}\` is already exported by ${other[1]}:${other[2]}; reuse that owner`, origin.text));
    }
    return found;
  }

  /** Measure new storyboard growth before the existing hard ceiling. */
  function sizeFindings({ files, worktree, base, readHead, readBase }) {
    const found = [];
    const evidence = () => {
      const queried = git(worktree, ["rev-parse", "--absolute-git-dir"]);
      const ledger = path.join(queried.stdout.trim(), "vibe-changes.md");
      return queried.status === 0 && exists(ledger) ? read(ledger).split("\n").map((line) => DEBT_LINE.exec(line)).filter(Boolean) : [];
    };
    let debt;
    const sources = files.filter((entry) => entry.status !== "D" && SOURCE.test(entry.path));
    const generatedFiles = linguistGenerated(worktree, sources.map((file) => file.path), base);
    const reader = { generatedFiles, head: readHead, base: readBase };
    for (const file of sources) {
      if (isGeneratedFile(reader, file.path)) continue;
      const current = readHead(file.path);
      if (current === undefined) continue;
      const lines = sourceLineCount(current);
      const prior = sourceLineCount(readBase(file.oldPath ?? file.path));
      const ceiling = lineCeilingFailure(prior, lines);
      if (ceiling) {
        found.push(finding(Check.Conventions, file.path, null, Severity.High, ceiling, `${prior} → ${lines} lines`));
        continue;
      }
      if (lines >= STORY_DEBT_REVIEW_START && STORY.test(file.path)) {
        if (lines <= prior) continue;
        debt ??= evidence();
        const recorded = debt.some(([, kind, added, reused, reason]) => kind.trim() && added.includes(file.path) && reused.trim()
          && !/^(?:\(?orchestrator|agent|writer)\b/i.test(reason));
        if (!recorded) found.push(finding(Check.Conventions, file.path, null, Severity.High,
          `story grew from ${prior} to ${lines} lines near the ${LINE_CEILING}-line ceiling; split it or record the exact Debt line`, `${prior} → ${lines} lines`));
      }
    }
    return found;
  }

  /** Runs every check and returns the findings report. */
  function gate({ worktree, base }) {
    const head = git(worktree, ["rev-parse", "HEAD"]).stdout.trim();
    const baseSha = base ?? git(worktree, ["merge-base", "HEAD", "origin/main"]).stdout.trim();
    const report = {
      schema: FINDINGS_SCHEMA, head, base: baseSha, findings: [], checks_run: [], checks_skipped: [],
    };
    const handle = {
      ran: (name) => { if (!report.checks_run.includes(name)) report.checks_run.push(name); },
      skip: (name, reason) => report.checks_skipped.push({ name, reason }),
      add: (items) => addFindings(report.findings, items),
    };
    if (!head || !baseSha) {
      handle.skip("all", "could not read the head and base commits");
      return report;
    }
    const diffText = git(worktree, ["diff", "--no-color", "--unified=0", "-M", baseSha]).stdout;
    const planPrefix = sessionLocalPlanPrefix(worktree);
    const untracked = readGitInventory(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], { run });
    if (untracked.status !== 0) throw new Error("git could not enumerate new files for the guardrails gate");
    const files = [...parseUnifiedDiff(diffText, planPrefix),
      ...untrackedAsAdded(worktree, planPrefix, { files: untracked.stdout, read })];
    const changedPaths = new Set(files.filter((file) => file.status !== "D").map((file) => file.path));
    const scripts = exists(path.join(worktree, "package.json")) ? (JSON.parse(read(path.join(worktree, "package.json")))?.scripts ?? {}) : {};

    // The repository's formatter and source gates are its verify recipe's; without one neither runs here.
    const verify = providerDataOr(sessionBinding(worktree), "recipes", "verify", null);
    const formatter = verify?.formatter;
    const formatterTargets = formatter ? [...changedPaths].filter((file) => new RegExp(formatter.files).test(file)) : [];
    if (!formatter) handle.skip(Check.Biome, "the repository's recipe names no formatter");
    else if (formatterTargets.length === 0) handle.skip(Check.Biome, formatter.noFiles);
    else wrappedGate({ name: Check.Biome, program: formatter.command[0], args: [...formatter.command.slice(1), ...formatterTargets], worktree, changed: changedPaths, scripts, report: handle });
    const sourceGates = (verify?.checks ?? []).find((check) => check.name === Check.SourceGates);
    if (sourceGates) wrappedGate({ name: Check.SourceGates, script: sourceGates.script, args: [sourceGates.script], worktree, changed: new Set(), scripts, report: handle });
    else handle.skip(Check.SourceGates, "the repository's recipe names no source gates");

    try {
      const rules = diffRulesFn({ worktree, base: baseSha, phase: "handoff" });
      handle.ran(Check.DiffRules);
      handle.add(rules.blocking.map(fromDiffRule));
    } catch (error) {
      handle.skip(Check.DiffRules, `diff-rules could not run: ${String(error.message).split("\n")[0]}`);
    }

    handle.ran(Check.Tokens);
    handle.add(scanTokens(files));
    handle.ran(Check.Conventions);
    const readHead = (file) => (exists(path.join(worktree, file)) ? read(path.join(worktree, file)) : undefined);
    const readBase = (file) => {
      const shown = git(worktree, ["show", `${baseSha}:${file}`]);
      return shown.status === 0 ? shown.stdout : undefined;
    };
    const unreadConventions = [];
    handle.add([...scanConventions(files, readHead, unreadConventions), ...sizeFindings({ files, worktree, base: baseSha, readHead, readBase })]);
    if (unreadConventions.length > 0) { report.checks_run.splice(report.checks_run.indexOf(Check.Conventions), 1); handle.skip(Check.Conventions, `partial: could not read the head text of ${unreadConventions.join(", ")}`); }
    let supersessions;
    try {
      const records = readRetiredTests(worktree).filter((entry) => entry.supersession);
      if (records.length) supersessions = { records, base: baseSha, approvals: testSupersessionApprovals(read(localPlanPaths(worktree).decisionTable)) };
    } catch { /* Without both records, the ordinary assertion findings still apply. */ }
    const repairs = scanTestRepairs(files, readBase, readHead, (file) => regularTestText(worktree, file), supersessions);
    handle.add(repairs.findings);
    if (repairs.unevaluated.length > 0) handle.skip(Check.TestRepair, `partial: findings cover only the files it could read; could not read the base or head text of ${repairs.unevaluated.join(", ")}`);
    else handle.ran(Check.TestRepair);
    const failedLookups = [];
    handle.add(ownerDuplicates({ files, worktree, changedPaths, failed: failedLookups }));
    if (failedLookups.length > 0) handle.skip(Check.OwnerDuplicates, `partial: git grep failed for ${failedLookups.join(", ")}`);
    else handle.ran(Check.OwnerDuplicates);
    for (const entry of REVIEWER_CHECKS) handle.skip(entry.name, entry.reason);
    return report;
  }

  return { gate };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { worktree: { type: "string" }, base: { type: "string" }, out: { type: "string" } } });
  if (!values.worktree) throw new Error("--worktree is required.");
  const report = createGuardrailsGate().gate({ worktree: path.resolve(values.worktree), base: values.base });
  const problems = findingsProblems(report);
  if (problems.length > 0) throw new Error(`the findings report broke its own contract: ${problems.join("; ")}`);
  const gitDir = stdoutOf(execCommand("git", ["-C", values.worktree, "rev-parse", "--absolute-git-dir"]), "git rev-parse --absolute-git-dir").trim();
  const out = values.out ?? path.join(gitDir, "vibe-guardrails-findings.json");
  mkdirSync(path.dirname(out), { recursive: true });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(out, text);
  process.stdout.write(text);
  process.stderr.write(`guardrails-gate: ${report.findings.length} findings, ${report.checks_run.length} checks run, ${report.checks_skipped.length} skipped; written to ${out}\n`);
  return exitCodeFor(report);
}

/** 1 when there is a finding; 3 when none but a scriptable check was skipped; else 0 (the reviewer's judgment checks never change it). */
export function exitCodeFor(report) {
  if (report.findings.length > 0) return 1;
  return report.checks_skipped.some((entry) => !REVIEWER_CHECK_NAMES.has(entry.name)) ? 3 : 0;
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.exit(failScript(error, 2));
  }
}

/**
 * Appends `items` to `findings` with every id unique: an exact repeat (same id and evidence) is dropped, and a
 * finding whose id repeats with other evidence (two removed assertions paired with one line) gets an occurrence suffix.
 */
export function addFindings(findings, items) {
  for (const item of items) {
    if (findings.some((existing) => existing.id === item.id && existing.evidence === item.evidence)) continue;
    let id = item.id;
    for (let occurrence = 2; findings.some((existing) => existing.id === id); occurrence += 1) id = `${item.id}~${occurrence}`;
    findings.push({ ...item, id });
  }
}
