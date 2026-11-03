// Mechanical evidence gate for tests whose setup can make them pass without
// exercising the behavior they claim. The verifier records a failing mutation
// for each changed responsive, absence, or card-layout assertion. PR facts
// recomputes the candidates from the final diff, so prose cannot waive one.

import { isTestFile } from "../../vibe/scripts/test-files.mjs";

const STORY_FILE = /\.stories\.[cm]?[jt]sx?$/;
const RESPONSIVE_NAME = /(?:narrow|mobile)/i;
const ABSENCE_ASSERTION = /toHaveCount\(\s*0\s*\)|\.not\.toBeInTheDocument\(|\.toBeNull\(|\.not\.toBeVisible\(|\.not\.toExist\(/;
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

function nearestCase(sourceLines, line) {
  const before = sourceLines.slice(Math.max(0, line - 20), line).join("\n");
  const matches = [...before.matchAll(/\b(?:it|test)(?:\.each\([\s\S]*?\))?\s*\(\s*["'`]([^"'`]+)["'`]/g)];
  return matches.at(-1)?.[1] ?? `line ${line}`;
}

function candidate(kind, path, line, caseName, claim) {
  return { id: `${kind}:${path}:${line}`, kind, path, line, case: caseName, claim };
}

/** Candidates in changed test/story code that need failing-mutation proof. */
export function testIntegrityCandidates(files, read) {
  const found = [];
  for (const file of files.filter((entry) => entry.status !== "D" && (isTestFile(entry.path) || STORY_FILE.test(entry.path)))) {
    const source = read(file.path) ?? "";
    const sourceLines = source.split("\n");
    const changedLines = addedLines(file);
    found.push(...responsiveStoryCandidates(file, source, changedLines));
    for (const entry of changedLines) {
      const context = nearby(sourceLines, entry.line, 4);
      const caseName = nearestCase(sourceLines, entry.line);
      if (!STORY_FILE.test(file.path) && RESPONSIVE_NAME.test(entry.text) && /\b(?:it|test)\b/.test(nearby(sourceLines, entry.line))) {
        found.push(candidate("responsive", file.path, entry.line, caseName,
          "changed test names a narrow or mobile state"));
      }
      if (ABSENCE_ASSERTION.test(entry.text)
        || (QUERY_ASSERTION.test(entry.text) && /(?:toBeNull|not\.toBe|toHaveCount\(\s*0)/.test(context))) {
        found.push(candidate("absence", file.path, entry.line, caseName,
          "changed assertion claims an element is absent"));
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
    if (proof?.class === "absence" && (proof.ownerBoundary !== "production" || !text(proof.mountedSignal))) {
      problems.push(`${label} absence proof needs ownerBoundary: "production" and mountedSignal`);
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
    if (commit && proof.commit !== commit) problems.push(`${item.id}: proof covers ${proof.commit ?? "no commit"}, not ${commit}`);
  }
  return problems;
}
