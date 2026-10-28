// M1: picks the replay corpus from merged tickets with a linked pull request.
// Tickets come from the caller (ClosedLoop `query_shipped` rows joined to their
// pull request, then `enrichFromGit`), so selection is offline and deterministic.
//
// A ticket is `{slug, title, description, acceptanceCriteria: string[], mergedAt,
//   pr: {number, mergeBaseSha, files: [{path, additions, deletions}], testFiles: string[],
//        needsFlag?: boolean} | null}`.
// `needsFlag` is true when the change only works behind a feature flag the replay
// checkout cannot provide; when the caller does not know, it leaves it out and the
// ticket is not excluded for it.

import { classifyFiles, TaskClass } from "./classes.mjs";

export const Exclusion = {
  NoLinkedPr: "no-linked-pr",
  WeakCriteria: "weak-acceptance-criteria",
  NeedsMigration: "needs-later-migration",
  NeedsFlag: "needs-feature-flag",
  NoOracle: "no-test-oracle",
  Unclassifiable: "unclassifiable",
};

export const MIN_CRITERIA = 2;
export const MIN_CRITERIA_CHARS = 40;
const MIGRATION = /(^|\/)(prisma\/)?migrations\/|migration\.sql$/;

/** Reasons a ticket cannot be replayed fairly; an empty list means it qualifies. */
export function exclusionReasons(ticket) {
  if (!ticket.pr?.mergeBaseSha || !Array.isArray(ticket.pr.files)) return [Exclusion.NoLinkedPr];
  const reasons = [];
  const criteria = (ticket.acceptanceCriteria ?? []).filter((item) => typeof item === "string" && item.trim());
  if (criteria.length < MIN_CRITERIA || criteria.join("").length < MIN_CRITERIA_CHARS) reasons.push(Exclusion.WeakCriteria);
  if (ticket.pr.files.some((file) => MIGRATION.test(file.path))) reasons.push(Exclusion.NeedsMigration);
  if (ticket.pr.needsFlag === true) reasons.push(Exclusion.NeedsFlag);
  const taskClass = classifyFiles(ticket.pr.files);
  if (taskClass === null) reasons.push(Exclusion.Unclassifiable);
  else if (taskClass === TaskClass.Backend && (ticket.pr.testFiles ?? []).length === 0) reasons.push(Exclusion.NoOracle);
  return reasons;
}

/** The oracle a ticket will be scored by: the human change's tests, or criteria graders for work without any (noisier). */
export function oracleFor(ticket) {
  return (ticket.pr?.testFiles ?? []).length > 0 ? "tests" : "graders";
}

/**
 * Selects up to `perClass` tickets in every class, newest merge first with the
 * slug as tiebreak, so the same input always gives the same corpus.
 */
export function selectCorpus(tickets, { perClass = 3 } = {}) {
  if (!Number.isInteger(perClass) || perClass < 1) throw new Error("perClass must be a positive integer.");
  const excluded = [];
  const byClass = Object.fromEntries(Object.values(TaskClass).map((name) => [name, []]));
  for (const ticket of tickets) {
    const reasons = exclusionReasons(ticket);
    if (reasons.length > 0) {
      excluded.push({ slug: ticket.slug, reasons });
      continue;
    }
    byClass[classifyFiles(ticket.pr.files)].push(ticket);
  }
  const selected = [];
  const shortfall = {};
  for (const [taskClass, candidates] of Object.entries(byClass)) {
    candidates.sort(newestFirst);
    const picked = candidates.slice(0, perClass);
    selected.push(...picked.map((ticket) => ({ ...ticket, taskClass, oracle: oracleFor(ticket) })));
    if (picked.length < perClass) shortfall[taskClass] = perClass - picked.length;
  }
  return { selected, excluded, shortfall };
}

/** Newest merge first; a missing or unparseable date sorts after every real one, and the slug breaks every tie. */
function newestFirst(a, b) {
  const aTime = Date.parse(a.mergedAt ?? "");
  const bTime = Date.parse(b.mergedAt ?? "");
  const aKnown = Number.isFinite(aTime);
  const bKnown = Number.isFinite(bTime);
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (aKnown && aTime !== bTime) return bTime - aTime;
  if (a.slug === b.slug) return 0;
  return a.slug < b.slug ? -1 : 1;
}
