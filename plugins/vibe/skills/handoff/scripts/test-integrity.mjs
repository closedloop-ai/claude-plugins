// Mechanical evidence gate for tests whose setup can make them pass without
// exercising the behavior they claim. The verifier records a failing mutation
// for each changed responsive, absence, or card-layout assertion. PR facts
// recomputes the candidates from the final diff, so prose cannot waive one.

import { isTestFile } from "../../vibe/scripts/test-files.mjs";

const STORY_FILE = /\.stories\.[cm]?[jt]sx?$/;
const CHECKER_FIXTURE = "plugins/vibe/skills/handoff/scripts/test-integrity.test.mjs";
const RESPONSIVE_NAME = /\b(?:narrow|mobile)\b/i;
const RESPONSIVE_EVIDENCE = /\b(?:setViewportSize|viewport\s*:|matchMedia\s*\(|innerWidth|screen\.width|(?:sm|md|lg):(?:hidden|block|flex|grid)\b)|@media\b/i;
const ABSENCE_ASSERTION = /toHaveCount\(\s*0\s*\)|\.not\s*\.\s*(?:toBeInTheDocument|toBeVisible|toBeAttached|toExist)\s*\(|\.\s*(?:toBeNull|toBeHidden)\s*\(/;
const ABSENCE_MATCHER = /^\s*(\.not\s*)?\.\s*(toHaveCount|toBeInTheDocument|toBeVisible|toBeAttached|toExist|toBeNull|toBeHidden)\s*\(/;
const ASSERTION_FAILURE = /\bAssertionError\b|\bexpect\s*\(|\bExpected(?: count)?:|\bReceived(?: count)?:/i;
const DIAGNOSTIC_LOCATION = /[A-Za-z0-9_./\\-]+\.(?:test|spec)\.[cm]?[jt]sx?:\d+(?::\d+)?/;
const SETUP_FAILURE = /^\s*(?:Error:\s*)?(?:TypeError|ReferenceError|SyntaxError|Cannot read properties|setup (?:failed|crashed)|module not found|failed to (?:load|import))\b/i;
const QUERY_ASSERTION = /queryBy(?:Role|Text|LabelText|TestId|PlaceholderText|DisplayValue|AltText|Title)\b/;
const COUNT_ONE = /(?:toHaveCount|toHaveLength)\(\s*1\s*\)/;
const LAYOUT_SURFACE = /\b(?:card|metric|summary)\b/i;
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

/** Discover complete expect assertions, including multiple assertions on one line. */
function absenceAssertions(source, changedLines) {
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
    if (method === "toHaveCount" ? negative || argument !== "0"
      : ["toBeNull", "toBeHidden"].includes(method) ? negative : !negative) continue;
    const line = lineNumberAt(source, match.index);
    const endLine = lineNumberAt(source, matcherClose);
    if (!changedLines.some((entry) => entry.line >= line && entry.line <= endLine)) continue;
    const column = match.index - source.lastIndexOf("\n", match.index);
    matches.push({ line, column, endLine, text: source.slice(match.index, matcherClose + 1).replace(/\s+/g, " ") });
  }
  return matches;
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
  for (const file of files.filter((entry) => entry.status !== "D" && entry.path !== CHECKER_FIXTURE
    && (isTestFile(entry.path) || STORY_FILE.test(entry.path)))) {
    const source = read(file.path) ?? "";
    const sourceLines = source.split("\n");
    const changedLines = addedLines(file);
    found.push(...responsiveStoryCandidates(file, source, changedLines));
    const absenceMatches = absenceAssertions(source, changedLines);
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
      if (!STORY_FILE.test(file.path) && (RESPONSIVE_NAME.test(caseName) || RESPONSIVE_EVIDENCE.test(entry.text))
        && /\b(?:it|test)\b/.test(nearby(sourceLines, entry.line))) {
        found.push(candidate("responsive", file.path, entry.line, caseName,
          "changed test covers a narrow or mobile state"));
      }
      const inParsedAssertion = absenceMatches.some((match) => entry.line >= match.line && entry.line <= match.endLine);
      if (!inParsedAssertion && (ABSENCE_ASSERTION.test(entry.text)
        || (QUERY_ASSERTION.test(entry.text) && /(?:toBeNull|not\.toBe|toHaveCount\(\s*0)/.test(context)))) {
        found.push(candidate("absence", file.path, entry.line, caseName,
          "changed assertion claims an element is absent", entry.text.trim(), "",
          `${file.path}:${entry.line}:${entry.text.search(/\S/) + 1}`));
      }
      if (COUNT_ONE.test(entry.text) && LAYOUT_SURFACE.test(`${file.path}\n${nearby(sourceLines, entry.line, 16)}`)) {
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

function exactAssertionFailure(proof) {
  const failure = proof?.mutationRun?.assertionFailure;
  if (!text(failure) || SETUP_FAILURE.test(failure) || !ASSERTION_FAILURE.test(failure)) return false;
  const firstLocation = DIAGNOSTIC_LOCATION.exec(failure)?.[0]?.match(/^(.*?):(\d+)(?::(\d+))?$/);
  const expected = proof.assertionLocation?.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!firstLocation || !expected) return false;
  const [, actualPath, actualLine, actualColumn] = firstLocation;
  const [, expectedPath, expectedLine, expectedColumn] = expected;
  return (actualPath === expectedPath || actualPath.endsWith(`/${expectedPath}`))
    && actualLine === expectedLine
    && (expectedColumn === undefined || actualColumn === expectedColumn);
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
export function testIntegrityProofShapeProblems(evidence) {
  if (evidence?.testIntegrityProofs === undefined) return [];
  if (!Array.isArray(evidence.testIntegrityProofs)) return ["testIntegrityProofs must be an array"];
  const problems = [];
  for (const [index, proof] of evidence.testIntegrityProofs.entries()) {
    const label = `testIntegrityProofs entry ${index}`;
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
      if (!exactAssertionFailure(proof)) {
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
export function testIntegrityProblems(evidence, files, read, commit) {
  const candidates = testIntegrityCandidates(files, read);
  if (candidates.length === 0) return [];
  const problems = [...testIntegrityProofShapeProblems(evidence)];
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
