// Mechanical evidence gate for tests whose setup can make them pass without
// exercising the behavior they claim. The verifier records a failing mutation
// for each changed responsive, absence, or card-layout assertion. PR facts
// recomputes the candidates from the final diff, so prose cannot waive one.

import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const STORY_FILE = /\.stories\.[cm]?[jt]sx?$/;
const RESPONSIVE_NAME = /(?:narrow|mobile)/i;
const ABSENCE_ASSERTION = /toHaveCount\(\s*0\s*\)|\.not\s*\.\s*(?:toBeInTheDocument|toBeVisible|toBeAttached|toExist)\s*\(|\.\s*(?:toBeNull|toBeHidden)\s*\(/;
const ABSENCE_MATCHER = /^\s*(\.not\s*)?\.\s*(toHaveCount|toBeInTheDocument|toBeVisible|toBeAttached|toExist|toBeNull|toBeHidden)\s*\(/;
const ASSERTION_FAILURE = /\bAssertionError\b|\bexpect\s*\(|\bExpected(?: count)?:|\bReceived(?: count)?:/i;
const DIAGNOSTIC_LOCATION = /[A-Za-z0-9_./\\-]+\.(?:test|spec|stories)\.[cm]?[jt]sx?:\d+(?::\d+)?/;
const SETUP_FAILURE = /^\s*(?:Error:\s*)?(?:TypeError|ReferenceError|SyntaxError|Cannot read properties|setup (?:failed|crashed)|module not found|failed to (?:load|import))\b/i;
const QUERY_ASSERTION = /queryBy(?:Role|Text|LabelText|TestId|PlaceholderText|DisplayValue|AltText|Title)\b/;
const COUNT_ONE = /(?:toHaveCount|toHaveLength)\(\s*1\s*\)/;
const LAYOUT_SURFACE = /\b(?:card|metric|summary)\b/i;
// A busy or loading count is state, not card layout (PC-2, accepted 2026-11-09).
const BUSY_STATE = /aria-busy|\bbusy\b|\bloading\b/i;
// A negated busy or loading predicate selects ordinary elements, so it keeps the layout check: an option
// (`busy: false`), an attribute (`aria-busy="false"`, `:not([aria-busy])`), a negated property
// (`!card.loading`, `!isBusy`) or a comparison (`card.loading === false`, `card.busy !== true`).
const NOT_BUSY = new RegExp([
  String.raw`\bbusy\s*:\s*false\b`,
  String.raw`aria-busy\s*=\s*["']?false["']?`,
  String.raw`:not\(\s*\[\s*aria-busy(?:\s*=\s*["']?true["']?)?\s*\]\s*\)`,
  String.raw`!\s*(?:[A-Za-z_$][\w$]*\??\.)*(?:is)?(?:busy|loading)\b`,
  String.raw`(?:[A-Za-z_$][\w$]*\??\.)*(?:is)?(?:busy|loading)\s*(?:===?\s*false|!==?\s*true)\b`,
].join("|"), "i");
// Any other negation in a busy-state count (`:not(...)`, `hasNot`, `hasNotText`) also keeps the layout check.
const BUSY_NEGATION = /:not\(|\bhasNot(?:Text)?\b/i;
const PROOF_CLASSES = new Set(["responsive", "absence", "layout"]);
const SHA = /^[a-f0-9]{40}$/;

function addedLines(file) {
  if (Array.isArray(file?.added)) return file.added;
  return Array.isArray(file?.hunks) ? file.hunks.flatMap((hunk) => hunk.added ?? []) : [];
}

function lineNumberAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function matchingBrace(source, open) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return source.length - 1;
}

function matchingParenthesis(source, open) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index;
  }
  return -1;
}

function responsiveStoryCandidates(file, source, changedLines) {
  if (!STORY_FILE.test(file.path)) return [];
  const candidates = [];
  const exported = /\bexport\s+const\s+([A-Z][\w$]*)[^=]*=\s*\{/g;
  for (const match of source.matchAll(exported)) {
    const name = match[1];
    if (!RESPONSIVE_NAME.test(name)) continue;
    const open = source.indexOf("{", match.index);
    const close = matchingBrace(source, open);
    const block = source.slice(open, close + 1);
    if (!/\bplay\s*:/.test(block)) continue;
    const start = lineNumberAt(source, match.index);
    const end = lineNumberAt(source, close);
    if (!changedLines.some((line) => line.line >= start && line.line <= end)) continue;
    candidates.push(candidate("responsive", file.path, start, name,
      `responsive story ${name} has a changed play`));
  }
  return candidates;
}

function nearby(sourceLines, line, radius = 12) {
  return sourceLines.slice(Math.max(0, line - radius - 1), line + radius).join("\n");
}

/** Discover complete expect assertions, including positive ones that must not fall through as absence candidates. */
function parsedAssertions(source, changedLines) {
  const matches = [];
  for (const match of source.matchAll(/\bexpect(?:\s*\.\s*soft)?\s*\(/g)) {
    const open = source.indexOf("(", match.index);
    const close = matchingParenthesis(source, open);
    if (close < 0) continue;
    const matcher = ABSENCE_MATCHER.exec(source.slice(close + 1));
    if (!matcher) continue;
    const matcherOpen = close + 1 + matcher[0].length - 1;
    const matcherClose = matchingParenthesis(source, matcherOpen);
    if (matcherClose < 0) continue;
    const negative = Boolean(matcher[1]);
    const method = matcher[2];
    const argument = source.slice(matcherOpen + 1, matcherClose).trim();
    const absence = method === "toHaveCount" ? !negative && argument === "0"
      : ["toBeNull", "toBeHidden"].includes(method) ? !negative : negative;
    const line = lineNumberAt(source, match.index);
    const endLine = lineNumberAt(source, matcherClose);
    if (!changedLines.some((entry) => entry.line >= line && entry.line <= endLine)) continue;
    const column = match.index - source.lastIndexOf("\n", match.index);
    matches.push({ line, column, endLine, absence, text: source.slice(match.index, matcherClose + 1).replace(/\s+/g, " ") });
  }
  return matches;
}

function absenceAssertions(source, changedLines) {
  return parsedAssertions(source, changedLines).filter((match) => match.absence);
}

function nearestCase(sourceLines, line) {
  const before = sourceLines.slice(Math.max(0, line - 20), line).join("\n");
  const matches = [...before.matchAll(/\b(?:it|test)(?:\.each\([\s\S]*?\))?\s*\(\s*["'`]([^"'`]+)["'`]/g)];
  return matches.at(-1)?.[1] ?? `line ${line}`;
}

function candidate(kind, path, line, caseName, claim, assertionLine, suffix = "", assertionLocation) {
  return { id: `${kind}:${path}:${line}${suffix}`, kind, path, line, case: caseName, claim,
    ...(assertionLine === undefined ? {} : { assertionLine }),
    ...(assertionLocation === undefined ? {} : { assertionLocation }) };
}

/** Candidates in changed test/story code that need failing-mutation proof. */
export function testIntegrityCandidates(files, read) {
  const found = [];
  for (const file of files.filter((entry) => entry.status !== "D" && (isTestFile(entry.path) || STORY_FILE.test(entry.path)))) {
    const source = read(file.path) ?? "";
    const sourceLines = source.split("\n");
    const changedLines = addedLines(file);
    found.push(...responsiveStoryCandidates(file, source, changedLines));
    const parsedMatches = parsedAssertions(source, changedLines);
    const absenceMatches = parsedMatches.filter((match) => match.absence);
    const perLineCount = new Map();
    for (const match of absenceMatches) perLineCount.set(match.line, (perLineCount.get(match.line) ?? 0) + 1);
    const perLineOrdinal = new Map();
    for (const match of absenceMatches) {
      const ordinal = (perLineOrdinal.get(match.line) ?? 0) + 1;
      perLineOrdinal.set(match.line, ordinal);
      found.push(candidate("absence", file.path, match.line, nearestCase(sourceLines, match.line),
        "changed assertion claims an element is absent", match.text,
        perLineCount.get(match.line) > 1 ? `:${ordinal}` : "",
        `${file.path}:${match.line}:${match.column}`));
    }
    for (const entry of changedLines) {
      const context = nearby(sourceLines, entry.line, 4);
      const caseName = nearestCase(sourceLines, entry.line);
      if (!STORY_FILE.test(file.path) && RESPONSIVE_NAME.test(entry.text) && /\b(?:it|test)\b/.test(nearby(sourceLines, entry.line))) {
        found.push(candidate("responsive", file.path, entry.line, caseName,
          "changed test names a narrow or mobile state"));
      }
      const inParsedAssertion = parsedMatches.some((match) => entry.line >= match.line && entry.line <= match.endLine);
      if (!inParsedAssertion && (ABSENCE_ASSERTION.test(entry.text)
        || (QUERY_ASSERTION.test(entry.text) && /(?:toBeNull|not\.toBe|toHaveCount\(\s*0)/.test(context)))) {
        found.push(candidate("absence", file.path, entry.line, caseName,
          "changed assertion claims an element is absent", entry.text.trim(), "",
          `${file.path}:${entry.line}:${entry.text.search(/\S/) + 1}`));
      }
      if (COUNT_ONE.test(entry.text) && !busyStateCount(entry.text)
        && LAYOUT_SURFACE.test(`${file.path}\n${nearby(sourceLines, entry.line, 16)}`)) {
        found.push(candidate("layout", file.path, entry.line, caseName,
          "card, metric, or summary coverage asserts only one element"));
      }
    }
  }
  return [...new Map(found.map((entry) => [entry.id, entry])).values()];
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeProofPath(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value)
    && !/[\\\x00-\x1f]/.test(value) && value.split("/").every(part => part && ![".", "..", ".git"].includes(part));
}

/** Read a proof source only when its repo-relative path resolves to a bounded regular file in the worktree. */
export function proofSourceAt(worktree, file) {
  if (!safeProofPath(file)) return null;
  try {
    const root = realpathSync(worktree);
    const target = path.join(root, file);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.size > 2_000_000) return null;
    const resolved = realpathSync(target);
    if (!resolved.startsWith(`${root}${path.sep}`)) return null;
    return readFileSync(resolved, "utf8");
  } catch { return null; }
}

function diagnosticPathMatches(actual, expected) {
  const normalized = actual.replaceAll("\\", "/").replace(/^file:\/\//, "");
  if (normalized === expected || normalized.endsWith(`/${expected}`)) return true;
  for (const root of ["packages/app/", "apps/storybook/", "apps/desktop/"]) {
    if (expected.startsWith(root) && normalized === expected.slice(root.length)) return true;
  }
  return false;
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Vitest prints the matcher or multiline closing line; the source excerpt must still name the candidate assertion. */
function runnerAssertionAt(failure, actualLine, actualColumn, expectedLine, expectedColumn, assertionLine, source) {
  const vitest = /\bFAIL\s+.+\.(?:test|spec|stories)\.[cm]?[jt]sx?/m.test(failure)
    && /^\s*❯\s+.+\.(?:test|spec|stories)\.[cm]?[jt]sx?:\d+:\d+/m.test(failure);
  const playwright = /^\s*\d+\)\s+\[[^\]]+\]\s+›\s+.+\.spec\.[cm]?[jt]sx?/m.test(failure)
    && /^\s*>\s*\d+\s*\|/m.test(failure);
  if (!vitest && !playwright) return false;
  const snippets = [...failure.matchAll(/^\s*>?\s*(\d+)\s*\|\s?(.*)$/gm)];
  const at = snippets.find((match) => Number(match[1]) === actualLine)?.[2]?.trim();
  if (!at) return false;
  const snippet = at.replace(/…$/, "").trim().replace(/;$/, "");
  if (source) {
    const candidate = absenceAssertions(source, [{ line: expectedLine }]).find((match) =>
      match.line === expectedLine && match.column === expectedColumn && match.text === assertionLine);
    const lines = source.split("\n");
    const sourceLine = lines[actualLine - 1];
    const sameLineFallback = actualLine === expectedLine
      && lines[expectedLine - 1]?.slice(expectedColumn - 1).replace(/\s+/g, " ").includes(assertionLine);
    if ((!candidate && !sameLineFallback) || candidate && actualLine > candidate.endLine
      || !sourceLine?.trim().startsWith(snippet) || actualColumn > sourceLine.length + 1) return false;
  } else if (!assertionLine.includes(snippet) && !snippets.map((match) => match[2]).join(" ").replace(/\s+/g, " ").includes(assertionLine)) return false;
  if (actualLine < expectedLine) return false;
  if (actualLine === expectedLine) return actualColumn >= expectedColumn
    && actualColumn <= expectedColumn + assertionLine.length;
  return true;
}

/** Storybook's instrumenter can map a matcher to the story object or helper call; a verified adjacent mutation restores identity. */
function instrumentedStoryAssertion(failure, proof, source, receipt) {
  // The edit is positioned against this story's source, so it must mutate this story file.
  if (!STORY_FILE.test(proof.path) || !source || !receipt.mutationEditVerified || receipt.target !== proof.path) return false;
  // Storybook's proxy stack has no assertion coordinate. A role query can
  // target several scopes with the same role, so its proxy trace alone cannot
  // establish which query executed. Require the runner's source coordinate.
  if (/\bqueryByRole\s*\(/.test(proof.assertionLine)) return false;
  const edit = receipt.mutationEdit;
  const editStart = source.indexOf(edit.old);
  let commonPrefix = 0;
  while (commonPrefix < edit.old.length && commonPrefix < edit.new.length
    && edit.old[commonPrefix] === edit.new[commonPrefix]) commonPrefix += 1;
  const location = /:(\d+):(\d+)$/.exec(proof.assertionLocation);
  if (!location) return false;
  const assertionStart = source.split("\n").slice(0, Number(location[1]) - 1).join("\n").length
    + (Number(location[1]) > 1 ? 1 : 0) + Number(location[2]) - 1;
  if (editStart < 0 || editStart + commonPrefix >= assertionStart) return false;
  // A failure before this assertion can have the same proxy matcher and even
  // the same queried text. An inserted mutation must execute after every
  // preceding same-matcher assertion in the enclosing play/helper block.
  const matcher = [...proof.assertionLine.matchAll(/\.([A-Za-z][A-Za-z0-9]*)\s*\(/g)].at(-1)?.[1];
  const insertion = editStart + commonPrefix;
  const precedingMatcher = matcher && [...source.slice(0, assertionStart).matchAll(new RegExp(`\\.${matcher}\\s*\\(`, "g"))]
    .at(-1);
  if (precedingMatcher && insertion <= precedingMatcher.index) return false;
  const queriedText = /\bqueryByText\(\s*([^)]+)\)/.exec(proof.assertionLine)?.[1]?.trim();
  const directValue = /^expect\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(proof.assertionLine)?.[1];
  if (queriedText && !edit.new.includes(queriedText) || directValue && !edit.new.includes(directValue)) return false;
  // Any other same-matcher assertion that runs after the mutation in this block, or after a call to
  // this candidate's helper, could be the one that failed; the instrumenter cannot tell them apart.
  const ambiguity = matcher && {
    query: queriedText === undefined ? undefined : queryKey(queriedText), variable: directValue,
    inserted: edit.new.slice(commonPrefix, edit.new.length - commonSuffixLength(edit.old, edit.new, commonPrefix)),
  };
  const region = `${source.slice(insertion, assertionStart)}\n${source.slice(assertionStart + proof.assertionLine.length, blockEndAt(source, assertionStart))}`;
  if (matcher && laterAssertionCouldFail(source, region, matcher, ambiguity)) return false;
  const directMatcher = matcher && new RegExp(`^\\s*❯\\s+${matcher}\\s+[^\\n]+\\.stories\\.[cm]?[jt]sx?:\\d+:\\d+`, "m").test(failure);
  const instrumentedMatcher = matcher && new RegExp(`^\\s*❯\\s+Proxy\\.${matcher}\\s+node_modules/`, "m").test(failure);
  if ((!directMatcher && !instrumentedMatcher)
    || !/^\s*FAIL\s+[^\n]+\.stories\.[cm]?[jt]sx?\s+>\s+\S/m.test(failure)
    || !/Failed Tests\s+[1-9]\d*\b/.test(failure)) return false;
  const line = Number(proof.assertionLocation.match(/:(\d+):\d+$/)?.[1]);
  if (!Number.isInteger(line)) return false;
  // A direct frame on another assertion's line means that assertion failed, not this candidate.
  // With a Proxy instrumenter frame, the direct frame is the instrumenter's source map, which can
  // land on an unrelated multiline assertion (ISS-13699's real runs all framed one line), so only
  // a runner-owned frame is checked against other assertions' spans.
  const frameLine = Number(new RegExp(`^\\s*❯\\s+${matcher}\\s+[^\\n]+\\.stories\\.[cm]?[jt]sx?:(\\d+):\\d+`, "m").exec(failure)?.[1]);
  const runnerFrame = !new RegExp(`^\\s*❯\\s+Proxy\\.${matcher}\\s`, "m").test(failure);
  if (Number.isInteger(frameLine) && frameLine !== line && (/\bexpect\s*\(/.test(source.split("\n")[frameLine - 1] ?? "")
    || runnerFrame && parsedAssertions(source, [{ line: frameLine }]).some((other) => other.line !== line))) return false;
  let story = null;
  let helper = null;
  for (const declaration of source.matchAll(/^\s*(?:export\s+const\s+([A-Z][\w$]*)|(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*))/gm)) {
    if (lineNumberAt(source, declaration.index) > line) break;
    story = declaration[1] ?? null;
    helper = declaration[2] ?? null;
  }
  if (!story && helper) {
    // A helper candidate runs inside its calling stories: each must name the run, and nothing a
    // caller asserts after the call may share the ambiguity.
    const callers = helperCallerStories(source, helper);
    if (callers.some(({ after }) => matcher && laterAssertionCouldFail(source, after, matcher, ambiguity))) return false;
    return callers.some(({ name }) => storyHeader(name).test(failure));
  }
  // The header names exactly this story, never a sibling whose name it prefixes.
  return Boolean(story) && storyHeader(story).test(failure);
}

function exactAssertionFailure(proof, source, receipt = {}) {
  const failure = typeof proof?.mutationRun?.assertionFailure === "string"
    ? stripAnsi(proof.mutationRun.assertionFailure) : null;
  if (!text(failure) || SETUP_FAILURE.test(failure) || !ASSERTION_FAILURE.test(failure)) return false;
  const firstError = /^[ \t]*(?:AssertionError|TypeError|ReferenceError|SyntaxError|Error):/m.exec(failure);
  const firstErrorLine = firstError ? failure.slice(firstError.index).split("\n")[0].trim() : "";
  if (!/^AssertionError:|^Error:\s*expect\s*\(/.test(firstErrorLine)) return false;
  const runner = /\bFAIL\s+.+\.(?:test|spec|stories)\.[cm]?[jt]sx?/m.test(failure)
    || /^\s*\d+\)\s+\[[^\]]+\]\s+›\s+.+\.spec\.[cm]?[jt]sx?/m.test(failure);
  const firstLocation = DIAGNOSTIC_LOCATION.exec(failure.slice(firstError.index))?.[0]?.match(/^(.*?):(\d+)(?::(\d+))?$/);
  const expected = proof.assertionLocation?.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!firstLocation || !expected) return false;
  const [, actualPath, actualLine, actualColumn] = firstLocation;
  const [, expectedPath, expectedLine, expectedColumn] = expected;
  if (!diagnosticPathMatches(actualPath, expectedPath)) return false;
  // Only the runner's own failure frame binds the assertion; authored text that
  // merely names the coordinate is not proof (ISS-13846 AC-1, AC-5).
  return runner && (runnerAssertionAt(failure, Number(actualLine), Number(actualColumn), Number(expectedLine), Number(expectedColumn), proof.assertionLine, source)
    || instrumentedStoryAssertion(failure, proof, source, receipt));
}

/** Resolve a private immutable runner receipt; a summary alone cannot prove a Storybook mutation ran. */
function rawProofReceipt(proof, receiptDir, readSource) {
  const required = proof?.class === "absence";
  if (!proof?.rawReceipt && !required) return { output: null, problems: [] };
  const label = `testIntegrityProofs ${proof?.candidate ?? "entry"}`;
  if (typeof proof?.rawReceipt !== "string" || !/^[A-Za-z0-9_.-]+\.json$/.test(proof.rawReceipt)
    || !/^[a-f0-9]{64}$/.test(proof.rawReceiptSha256 ?? "") || !receiptDir) {
    return { output: null, problems: [`${label} needs a private raw runner receipt and SHA-256`] };
  }
  try {
    const file = path.join(receiptDir, proof.rawReceipt);
    if (!lstatSync(file).isFile()) throw new Error("receipt is not a regular file");
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== proof.rawReceiptSha256) throw new Error("receipt hash differs");
    const receipt = JSON.parse(bytes.toString("utf8"));
    const headMatches = Array.isArray(receipt.head) ? receipt.head.includes(proof.commit) : receipt.head === proof.commit;
    if (receipt.candidate !== proof.candidate || receipt.command !== proof.command || !headMatches
      || receipt.mutationExit !== proof.mutationRun?.exitCode || receipt.mutationExit <= 0
      || receipt.restoredExit !== 0 || typeof receipt.mutationOutput !== "string"
      || typeof receipt.restoredOutput !== "string"
      || !/\b(?:Test Files?\s+\d+\s+passed|\d+\s+passed)\b/i.test(stripAnsi(receipt.restoredOutput))
      || !/^[a-f0-9]{64}$/.test(receipt.beforeSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(receipt.mutatedSha256 ?? "")
      || receipt.beforeSha256 === receipt.mutatedSha256
      || createHash("sha256").update(receipt.restoredOutput).digest("hex") !== proof.restoredOutputSha256) {
      throw new Error("receipt candidate, source, command, mutation or restored pass differs");
    }
    let mutationEditVerified = false;
    if (readSource) {
      const targetSource = safeProofPath(receipt.target) ? readSource(receipt.target) : null;
      if (typeof targetSource !== "string"
        || createHash("sha256").update(targetSource).digest("hex") !== receipt.beforeSha256) {
        throw new Error("receipt before hash does not match the tested source");
      }
      const edit = receipt.mutationEdit;
      if (!edit || typeof edit.old !== "string" || !edit.old
        || typeof edit.new !== "string" || edit.new === edit.old || targetSource.split(edit.old).length !== 2
        || ((STORY_FILE.test(proof.path) || receipt.target === proof.path)
          && (edit.old.match(/\n/g) ?? []).length !== (edit.new.match(/\n/g) ?? []).length)) {
        throw new Error("absence receipt needs verifiable mutation bytes via one edit and restored source bytes");
      }
      if (executableSource(edit.old) === executableSource(edit.new)) {
        throw new Error("absence receipt mutation must change executable source, not only comments or whitespace");
      }
      if (edit) {
        const changed = targetSource.replace(edit.old, edit.new);
        const candidateLine = Number(proof.assertionLocation?.match(/:(\d+):\d+$/)?.[1]);
        const editLine = lineNumberAt(targetSource, targetSource.indexOf(edit.old));
        const column = Number(proof.assertionLocation?.match(/:(\d+)$/)?.[1]);
        const assertionOffset = changed.split("\n").slice(0, candidateLine - 1).join("\n").length
          + (candidateLine > 1 ? 1 : 0) + column - 1;
        const stillAsserted = receipt.target !== proof.path || changed.slice(assertionOffset)
          .replace(/\s+/g, " ").startsWith(proof.assertionLine);
        if (createHash("sha256").update(changed).digest("hex") !== receipt.mutatedSha256
          || STORY_FILE.test(proof.path) && Math.abs(editLine - candidateLine) > 4 || !stillAsserted) {
          throw new Error("receipt mutation bytes do not bind the unchanged primary assertion and source");
        }
        mutationEditVerified = true;
      }
    }
    const outputHash = createHash("sha256").update(receipt.mutationOutput).digest("hex");
    if (proof.mutationRun.assertionFailure !== receipt.mutationOutput
      && !proof.mutationRun.assertionFailure.includes(`raw output SHA-256 ${outputHash}`)) {
      throw new Error("authored failure text is not bound to raw runner output");
    }
    return { output: receipt.mutationOutput, mutationEditVerified, mutationEdit: receipt.mutationEdit, target: receipt.target, problems: [] };
  } catch (error) {
    return { output: null, problems: [`${label} raw runner receipt is invalid: ${error.message}`] };
  }
}

function validAssertionLocation(proof) {
  if (!text(proof?.path) || !text(proof?.candidate) || !text(proof?.assertionLocation)) return false;
  const prefix = `absence:${proof.path}:`;
  if (!proof.candidate.startsWith(prefix)) return false;
  const identity = /^(\d+)(?::(\d+))?$/.exec(proof.candidate.slice(prefix.length));
  if (!identity) return false;
  const location = `${proof.path}:${identity[1]}`;
  return proof.assertionLocation.startsWith(`${location}:`)
    && /^\d+$/.test(proof.assertionLocation.slice(location.length + 1));
}

/** Structural problems in the verifier's optional test-integrity proof list. */
export function testIntegrityProofShapeProblems(evidence, receiptDir, readSource) {
  if (evidence?.testIntegrityProofs === undefined) return [];
  if (!Array.isArray(evidence.testIntegrityProofs)) return ["testIntegrityProofs must be an array"];
  const problems = [];
  for (const [index, proof] of evidence.testIntegrityProofs.entries()) {
    const label = `testIntegrityProofs entry ${index}`;
    const pathSafe = safeProofPath(proof?.path);
    if (!pathSafe) problems.push(`${label} path must be a repo-relative source file`);
    if (!text(proof?.candidate) || !text(proof?.path) || !text(proof?.case) || !PROOF_CLASSES.has(proof?.class)) {
      problems.push(`${label} needs candidate, path, case and class (responsive, absence, or layout)`);
    }
    for (const field of ["mutation", "command", "observedFailure"]) {
      if (!text(proof?.[field])) problems.push(`${label} needs ${field}`);
    }
    if (proof?.restoredPass !== true) problems.push(`${label} must record restoredPass: true`);
    if (!SHA.test(proof?.commit ?? "")) problems.push(`${label} needs the tested 40-character commit SHA`);
    if (proof?.class === "responsive" && (proof.viewportSource !== "registered" || !text(proof.desktopWidthMutation))) {
      problems.push(`${label} responsive proof needs viewportSource: "registered" and desktopWidthMutation`);
    }
    if (proof?.class === "absence") {
      const receipt = rawProofReceipt(proof, receiptDir, pathSafe ? readSource : undefined);
      problems.push(...receipt.problems);
      if (proof.ownerBoundary !== "production" || !text(proof.mountedSignal)) {
        problems.push(`${label} absence proof needs ownerBoundary: "production" and mountedSignal`);
      }
      if (!text(proof.presentState) || !text(proof.assertionLine)) {
        problems.push(`${label} absence proof needs presentState and assertionLine`);
      }
      if (!validAssertionLocation(proof)) {
        problems.push(`${label} assertionLocation must name the candidate path, line and column`);
      }
      if (proof.mutationRun?.command !== proof.command
        || !Number.isInteger(proof.mutationRun?.exitCode)
        || proof.mutationRun.exitCode <= 0
        || !text(proof.mutationRun.assertionFailure)) {
        problems.push(`${label} absence proof needs a mutation run with the exact command, nonzero exitCode and assertionFailure`);
      }
      if (!receipt.problems.length && !exactAssertionFailure(receipt.output === null ? proof : {
        ...proof, mutationRun: { ...proof.mutationRun, assertionFailure: receipt.output },
      }, pathSafe ? readSource?.(proof.path) : null, receipt)) {
        problems.push(`${label} absence proof needs the exact assertion failure at the primary assertion location, not a setup or runtime error`);
      }
    }
    if (proof?.class === "layout" && (!text(proof.baseline) || !text(proof.layoutAssertion))) {
      problems.push(`${label} layout proof needs baseline and layoutAssertion`);
    }
  }
  return problems;
}

/** Missing, stale, or mismatched proof for candidates recomputed from the final diff. */
export function testIntegrityProblems(evidence, files, read, commit, receiptDir) {
  const candidates = testIntegrityCandidates(files, read);
  if (candidates.length === 0) return [];
  const problems = [...testIntegrityProofShapeProblems(evidence, receiptDir, read)];
  const proofs = Array.isArray(evidence?.testIntegrityProofs) ? evidence.testIntegrityProofs : [];
  if (!Array.isArray(evidence?.testIntegrityProofs)) {
    problems.push("changed responsive, absence, or card-layout tests need testIntegrityProofs failing-mutation evidence");
  }
  for (const item of candidates) {
    const matches = proofs.filter((proof) => proof?.candidate === item.id);
    if (matches.length !== 1) {
      problems.push(`${item.id}: needs exactly one failing-mutation proof (${item.claim})`);
      continue;
    }
    const proof = matches[0];
    if (proof.path !== item.path || proof.case !== item.case || proof.class !== item.kind) {
      problems.push(`${item.id}: proof path, case and class must match the recomputed candidate`);
    }
    if (item.kind === "absence" && proof.assertionLine !== item.assertionLine) {
      problems.push(`${item.id}: proof assertionLine must match the changed absence assertion`);
    }
    if (item.kind === "absence" && proof.assertionLocation !== item.assertionLocation) {
      problems.push(`${item.id}: proof assertionLocation must match the changed absence assertion`);
    }
    if (commit && proof.commit !== commit) problems.push(`${item.id}: proof covers ${proof.commit ?? "no commit"}, not ${commit}`);
  }
  return problems;
}

/** Source with comments and whitespace removed, so a comment-only edit cannot pose as a mutation. */
function executableSource(value) {
  return value.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1").replace(/\s+/g, "");
}

function commonSuffixLength(before, after, prefix) {
  let length = 0;
  while (length < before.length - prefix && length < after.length - prefix
    && before[before.length - 1 - length] === after[after.length - 1 - length]) length += 1;
  return length;
}

/** The text a query matches: a string literal's content in any quote style, or a regular expression. */
function queryKey(expression) {
  const literal = /^\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(expression);
  if (literal) return { text: literal[2] };
  const pattern = /^\s*\/((?:\\.|[^/\\])+)\/([a-z]*)/.exec(expression);
  if (pattern) { try { return { regex: new RegExp(pattern[1], pattern[2].replace(/[gy]/g, "")) }; } catch { return undefined; } }
  return undefined;
}

/**
 * Whether another same-matcher assertion that runs after the mutation could also see it, so an
 * instrumented failure cannot say which one failed: the same variable, a query equal to the candidate's or
 * found in the inserted text (directly or through a variable holding it), a composed `play`, or such an
 * assertion inside a helper this code calls.
 */
function laterAssertionCouldFail(source, following, matcher, ambiguity, depth = 0) {
  const { query, variable, inserted } = ambiguity;
  if (/\.\s*play\s*\(/.test(following)) return true;
  for (const later of following.matchAll(new RegExp(`\\bexpect(?:\\s*\\.\\s*soft)?\\s*\\(([^;]*?)\\)\\s*\\.\\s*(?:not\\s*\\.\\s*)?${matcher}\\s*\\(`, "g"))) {
    let argument = later[1].trim();
    if (variable && new RegExp(`^${escapeRegExp(variable)}(?![\\w$])`).test(argument)) return true;
    // A variable argument is checked through the query it holds.
    const held = /^[A-Za-z_$][\w$]*$/.test(argument)
      && new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(argument)}\\s*=\\s*([^;]+)`).exec(source);
    if (held) argument = held[1];
    const call = /\b(?:query|get|find)(?:All)?By[A-Za-z]+\(\s*([^)]*)/.exec(argument);
    const key = call ? queryKey(call[1]) : undefined;
    if (!key) continue;
    if (key.text !== undefined && (query?.text === key.text || inserted.includes(key.text))) return true;
    if (key.regex && ((query?.text !== undefined && key.regex.test(query.text)) || key.regex.test(inserted))) return true;
  }
  for (const call of following.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = escapeRegExp(call[1]);
    const helper = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>))`).exec(source);
    if (!helper) continue;
    const open = source.indexOf("{", helper.index);
    const close = open < 0 ? -1 : matchingBrace(source, open);
    // A called helper is ambiguous only when one of its own assertions could see this mutation.
    if (close > open && depth < 2 && laterAssertionCouldFail(source, source.slice(open, close), matcher, ambiguity, depth + 1)) return true;
  }
  return false;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DECLARATION = /^\s*(?:export\s+const\s|(?:export\s+)?(?:async\s+)?function\s)/m;

/** Where the top-level declaration holding `offset` ends: the next declaration, or the file end. */
function blockEndAt(source, offset) {
  const next = source.slice(offset + 1).search(DECLARATION);
  return next < 0 ? source.length : offset + 1 + next;
}

/** The runner header that names exactly this story, never a sibling whose name it prefixes. */
function storyHeader(story) {
  const spaced = escapeRegExp(story.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
  return new RegExp(`^\\s*FAIL\\s+[^\\n]+\\.stories\\.[cm]?[jt]sx?\\s+>\\s+${spaced}\\s*(?:>|$)`, "m");
}

/** Stories that run a helper, directly or through one other helper, with the code each runs after the call. */
function helperCallerStories(source, helper) {
  const callers = [];
  const visit = (name, depth) => {
    for (const call of source.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g"))) {
      const before = source.slice(0, call.index);
      if (new RegExp(`function\\s+${escapeRegExp(name)}\\s*$`).test(before)) continue;
      const declarations = [...before.matchAll(/^\s*(?:export\s+const\s+([A-Z][\w$]*)|(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*))/gm)];
      const owner = declarations.at(-1);
      if (!owner) continue;
      const after = source.slice(call.index + call[0].length, blockEndAt(source, call.index));
      if (owner[1]) callers.push({ name: owner[1], after });
      else if (owner[2] && owner[2] !== name && depth < 1) visit(owner[2], depth + 1);
    }
  };
  visit(helper, 0);
  return callers;
}

/**
 * A count that PC-2 exempts: it names a busy or loading state and negates none, so a filter that
 * excludes busy or loading items (any negation form) and a word in a comment keep the layout check.
 */
function busyStateCount(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  return BUSY_STATE.test(code) && !NOT_BUSY.test(code) && !BUSY_NEGATION.test(code);
}
