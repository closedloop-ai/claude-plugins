// Performance criteria for a unit's list queries, checked by unit-review.mjs.
// One list page timed out when grouped by owner in production: grouping
// shipped with no criterion about load time, so no review could catch it. Every
// grouped, sorted or paginated list query a unit touches is listed in
// review.json's `listQueries` ({"page", "kind": "grouped"|"sorted"|"paginated",
// "ref": "<file>:<line>"}, an empty list when there are none). Each needs a
// criterion in the ticket, a member, the PRD or the plan that names its page,
// its kind and a load time ("Grouping Issues by owner loads within 2 s at
// production scale"), and that criterion needs a `measured` row with the
// command run, the dataset's row count and the timing, within the stated time.

export const ListQueryKind = Object.freeze({ Grouped: "grouped", Sorted: "sorted", Paginated: "paginated" });

const KIND_WORDS = Object.freeze({
  [ListQueryKind.Grouped]: /\bgroup(?:s|ed|ing)?\b/i,
  [ListQueryKind.Sorted]: /\bsort(?:s|ed|ing)?\b/i,
  [ListQueryKind.Paginated]: /\bpag(?:e|es|ed|ing|inated|ination)\b/i,
});
const BUDGET = /\b(?:loads?|renders?|responds?|returns?|opens?|completes?|finishes)\b[^.;]*?\b(?:within|under|in|below|at most)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i;

/** The load time a criterion states, in milliseconds, or null when it states none. */
export function budgetMs(text) {
  const match = BUDGET.exec(text ?? "");
  if (!match) return null;
  return Number(match[1]) * (/^m/i.test(match[2]) ? 1 : 1000);
}

/** Problems with review.json's listQueries list. */
export function listQueryShapeProblems(listQueries) {
  if (!Array.isArray(listQueries)) return ["review.json needs listQueries: every grouped, sorted or paginated list query the unit touches, or an empty list when it touches none"];
  return listQueries.flatMap((query, index) => {
    const kinds = Object.values(ListQueryKind);
    if (typeof query?.page !== "string" || !query.page.trim() || !kinds.includes(query.kind) || typeof query.ref !== "string") {
      return [`review.json listQueries ${index + 1} needs page, kind (${kinds.join(", ")}) and ref <file>:<line>`];
    }
    return [];
  });
}

/** What a performance criterion's `measured` rows leave missing: none MET, an incomplete row, or a timing over the stated budget. */
export function measuredMissing(criterion, rows) {
  const budget = budgetMs(criterion.text);
  if (budget === null) return [];
  const measured = rows.filter((row) => row.part === "measured" && row.verdict === "MET");
  if (measured.length === 0) return [`no measured row (the command run, the dataset's row count and the timing) for its ${budget} ms load time`];
  const problems = measured.map((row) => {
    if (typeof row.command !== "string" || !row.command.trim()) return "a measured row needs the command it ran";
    if (!Number.isInteger(row.datasetRows) || row.datasetRows < 1) return "a measured row needs datasetRows, the dataset's row count";
    if (typeof row.timingMs !== "number" || !Number.isFinite(row.timingMs) || row.timingMs < 0) return "a measured row needs timingMs";
    return row.timingMs > budget ? `measured ${row.timingMs} ms on ${row.datasetRows} rows, over its ${budget} ms load time` : null;
  });
  return problems.every(Boolean) ? problems : [];
}

/** Each listed query with no in-scope criterion that names its page, its kind and a load time. */
export function listQueryGaps(listQueries, criteria, { anchor, namesPage, codeRef }) {
  return listQueries.map((query) => {
    const covered = criteria.some((criterion) => budgetMs(criterion.text) !== null && KIND_WORDS[query.kind].test(criterion.text) && namesPage(criterion.text, query.page));
    const missing = [
      ...(covered ? [] : [`no criterion names a load time for the ${query.kind} ${query.page} list query; add one to the plan or the ticket's criteria`]),
      ...[codeRef(query.ref)].filter(Boolean),
    ];
    return missing.length === 0 ? null : { ticket: anchor, criterion: `performance ${query.page} ${query.kind}`, missing };
  }).filter(Boolean);
}
