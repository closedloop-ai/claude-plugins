// Checks observable PR body claims against the session's source and recorded evidence.
import { readGitInventory } from "../../../lib/vibe/scripts/git-inventory.mjs";
import { execFileSync } from "node:child_process";
import { currentStorybookRelease } from "./story-coverage-rules.mjs";

const CI_CLAIM = /\b(?:CI\s+(?:covers?|runs?)|covered\s+by\s+CI)\b/i;
const CI_NEGATION = /\b(?:no\s+CI\s+runs?|CI\s+(?:does\s+not|doesn't|will\s+not|won't)\s+run|not\s+covered\s+by\s+CI)\b/i;
const OTHER_TEST_FAMILY = /\b(?:unit|integration|contract|component|storybook|lint|typecheck|build|api)\s+(?:tests?|checks?|suites?|lanes?)\b/i;
const E2E_TERM = /e2e|e-2-e|end.to.end/i;
const PENDING_HOST = /\b(?:web|browser|desktop|electron)\b/i;
const UNRESOLVED_PRONOUN = /\b(?:it|them|these|those)\b/i;
const UNIVERSAL = /\b(?:every|all|each)\b/i;
const ALL_TESTS_PASSED = /\b(?:all|every)\s+(?:affected\s+)?tests?\s+(?:pass(?:ed)?|succeeded|green)\b/i;
const SUMMARY_BULLET = /^\s*[-*]\s+/;
const FILE_LINE = /\b(?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,12}:\d+\b/;

/** Return the E2E host kinds a lane record or prose line names. */
function laneKinds(value, unnamed = []) {
  const text = String(value).toLowerCase();
  if (!E2E_TERM.test(text)) return unnamed;
  const kinds = [];
  if (/\bweb\b|\bbrowser\b/.test(text)) kinds.push("web");
  if (/\bdesktop\b|\belectron\b/.test(text)) kinds.push("Desktop");
  return kinds.length ? kinds : unnamed;
}

/** The host kinds of exact E2E records the verifier says did not run. */
function notRunKinds(runs) {
  const rows = [...(runs?.testRuns ?? []), ...(runs?.runs ?? [])];
  return new Set(rows.filter((row) => row?.status === "not-run")
    .flatMap((row) => {
      const description = [row.lane, row.command, row.path].filter(Boolean).join(" ");
      return E2E_TERM.test(description) ? laneKinds(description, ["web"]) : [];
    }));
}

/** Body claims that contradict a not-run lane or state an uncited universal Summary behavior. */
export function prBodyClaimProblems(body, runs, tree = null) {
  const pending = notRunKinds(runs);
  const problems = prTreeClaimProblems(body, tree);
  const failed = (runs?.testRuns ?? []).filter((record) => record?.status === "failed"
    && (!tree?.head || !record.commit || record.commit === tree.head));
  let inSummary = false;
  let fenced = false;
  for (const [index, line] of body.split("\n").entries()) {
    if (/^```/.test(line.trim())) fenced = !fenced;
    if (fenced) continue;
    if (/^##\s+Summary\s*$/i.test(line.trim())) {
      inSummary = true;
      continue;
    }
    if (/^##\s+/.test(line.trim())) inSummary = false;
    if (inSummary && SUMMARY_BULLET.test(line) && UNIVERSAL.test(line) && !FILE_LINE.test(line)) {
      problems.push(`Summary line ${index + 1}: ${line.trim().slice(0, 80)} needs a changed file:line citation`);
    }
    if (failed.length && ALL_TESTS_PASSED.test(line) && !HISTORICAL.test(line)) {
      problems.push("body line " + (index + 1) + ": says all tests passed with a failed test receipt on the same source");
    }
    if (!pending.size) continue;
    const lineHosts = laneKinds(line, [...pending]);
    for (const clause of line.split(/[,;.!?]\s*|\s+\b(?:but|while|and)\s+(?=(?:no\s+)?CI\b)/i)) {
      if (!CI_CLAIM.test(clause) || CI_NEGATION.test(clause)) continue;
      if (!E2E_TERM.test(clause) && OTHER_TEST_FAMILY.test(clause)) continue;
      if (![E2E_TERM, PENDING_HOST, UNRESOLVED_PRONOUN].some((signal) => signal.test(clause))) continue;
      const named = laneKinds(clause, lineHosts);
      const affected = named.filter((kind) => pending.has(kind));
      if (affected.length) {
        problems.push(`body line ${index + 1}: CI coverage claim for not-run ${affected.join(" and ")} E2E lane`);
      }
    }
  }
  if (pending.size) {
    const sentences = body.split(/(?<=[.!?])\s+|\n/);
    for (const kind of pending) {
      const stated = sentences.some((sentence) => /\bnot[ -]run\b/i.test(sentence)
        && laneKinds(sentence, pending.size === 1 ? [kind] : []).includes(kind));
      if (!stated) problems.push(`${kind} E2E has no plain statement that it has not run`);
    }
    if (!/\bno\s+CI\s+runs?\b[^.\n]*\bbefore\s+merge\b/i.test(body)) {
      problems.push("not-run E2E lanes need a plain statement that no CI runs them before merge");
    }
  }
  return problems;
}

const STORYBOOK_VERSION = /\bStorybook(?:\s+(?:version|release))?(?:\s*[:=])?\s*[\x60(]?v?(\d+\.\d+\.\d+)\b/gi;
const STORYBOOK_COUNT = /\b(Primitives|Composites|Patterns|Surfaces)\s*(?::|\(|=)?\s*([\d,]+)\s*(entries|stories)?\b/gi;
const CURRENT_SHA = /\b(?:(current|published|final|tested)\s+)?(head|base)(?:\s+(?:SHA|commit))?\s*(?:[:=]\s*|\s+)[\x60]?([0-9a-f]{7,40})\b/gi;
const FILE_COUNT = /\b(?:changed\s+files:\s*)([\d,]+)\b|\b([\d,]+)\s+changed\s+files\b/gi;
const HISTORICAL = /\b(?:previous(?:ly)?|before|older|original(?:ly)?|at the time|was at|from version)\b/i;

function gitRead(worktree, args) {
  try { return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
}

/** Head-bound values used by both the body validator and the final metadata preflight. */
export function currentPrTreeFacts(worktree, base, sourceHead) {
  const head = sourceHead ?? gitRead(worktree, ["rev-parse", "HEAD"])?.trim();
  if (!head) return null;
  const compare = base
    ? gitRead(worktree, ["rev-parse", "--verify", base + "^{commit}"])?.trim()
    : gitRead(worktree, ["merge-base", head, "refs/remotes/origin/main"])?.trim();
  const files = compare ? gitRead(worktree, ["diff", "--name-only", "-z", "-M", compare, head, "--"]) : null;
  const read = (file) => gitRead(worktree, ["show", head + ":" + file]);
  let storybookPaths = [];
  if (read(".vibe/storybook-rules.json") !== null) {
    try { storybookPaths = readGitInventory(worktree, ["ls-tree", "-r", "--name-only", "-z", head], { timeout: 10_000 }).split("\0").filter(Boolean); }
    catch { /* Leave optional Storybook facts unavailable on a read failure. */ }
  }
  return {
    head,
    base: compare,
    fileCount: files === null ? null : files.split("\0").filter(Boolean).length,
    storybook: storybookPaths.length ? currentStorybookRelease(read, storybookPaths) : null,
  };
}

function liveClaim(line, match) {
  const start = Math.max(line.lastIndexOf(";", match.index), line.lastIndexOf(". ", match.index));
  return !HISTORICAL.test(line.slice(start + 1, match.index));
}

function decimal(text) {
  return Number(text.replaceAll(",", ""));
}

/** Explicit present-tense tree claims that disagree with Git or the configured Storybook release. */
export function prTreeClaimProblems(body, facts) {
  if (!facts) return [];
  const problems = [];
  let fenced = false;
  for (const [index, line] of body.split("\n").entries()) {
    if (/^\s*\x60\x60\x60/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const report = (description) => problems.push("body line " + (index + 1) + ": " + description);
    for (const match of line.matchAll(CURRENT_SHA)) {
      const [, qualifier, kind, sha] = match;
      const expected = facts[kind.toLowerCase()];
      // Leave an unqualified historical or main-citation SHA to testedCommitProblems.
      if (!expected || (!qualifier && (!liveClaim(line, match) || !/[:=]/.test(match[0]))) || expected.startsWith(sha)) continue;
      report(kind + " " + sha + " disagrees with " + expected);
    }
    // GitHub overlap disclosures report counts for the named sibling PR.
    const overlap = /^Overlap unavailable: #\d+ \(GitHub file API exposes [\d,]+ of [\d,]+ changed files\)\s*$/i.test(line.trim());
    for (const match of overlap ? [] : line.matchAll(FILE_COUNT)) {
      const count = decimal(match[1] ?? match[2]);
      if (facts.fileCount === null || !liveClaim(line, match) || count === facts.fileCount) continue;
      report("claims " + count + " changed files, but the committed comparison has " + facts.fileCount);
    }
    if (!facts.storybook) continue;
    for (const match of line.matchAll(STORYBOOK_VERSION)) {
      if (liveClaim(line, match) && match[1] !== facts.storybook.version) {
        report("claims Storybook " + match[1] + ", but the committed release is " + facts.storybook.version);
      }
    }
    for (const match of line.matchAll(STORYBOOK_COUNT)) {
      const [, level, countText, unit = "stories"] = match;
      const actual = facts.storybook.counts.get(level.toLowerCase())?.[unit.toLowerCase()];
      if (actual === undefined || !liveClaim(line, match) || decimal(countText) === actual) continue;
      report("claims " + level + " has " + countText + " " + unit + ", but the committed release records " + actual);
    }
  }
  return problems;
}
