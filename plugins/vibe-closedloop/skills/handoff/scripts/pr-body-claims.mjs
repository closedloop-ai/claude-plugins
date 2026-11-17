// Checks two observable PR body claims against the session's recorded evidence.

const CI_CLAIM = /\b(?:CI\s+(?:covers?|runs?)|covered\s+by\s+CI)\b/i;
const CI_NEGATION = /\b(?:no\s+CI\s+runs?|CI\s+(?:does\s+not|doesn't|will\s+not|won't)\s+run|not\s+covered\s+by\s+CI)\b/i;
const OTHER_TEST_FAMILY = /\b(?:unit|integration|contract|component|storybook|lint|typecheck|build|api)\s+(?:tests?|checks?|suites?|lanes?)\b/i;
const E2E_TERM = /e2e|e-2-e|end.to.end/i;
const PENDING_HOST = /\b(?:web|browser|desktop|electron)\b/i;
const UNRESOLVED_PRONOUN = /\b(?:it|them|these|those)\b/i;
const UNIVERSAL = /\b(?:every|all|each)\b/i;
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
export function prBodyClaimProblems(body, runs) {
  const pending = notRunKinds(runs);
  const problems = [];
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
