// Verbatim entries from the ISS-13115 handoff body (ISS-14679): the orchestrator
// recorded an acceptance-criterion reading and an accepted cost as its own
// decisions, and both reached a pull request with no human ruling behind them.
// The designer's name is replaced with a role.

export const SETTLED_BY_ORCHESTRATOR = {
  optionC: "Decision (orchestrator, option C): second-level Owner rests on Custom order (A-Z, Unassigned last) only when Owner is newly set at level 2. Accepted cost: a grouping already stored as `owner:asc` on level 2 (remembered grouping, URL, saved view) keeps today's plain Ascending, because it cannot be told from an explicit choice, which AC-3 protects.",
  axis: "Decision (orchestrator, scope-collapse-axis-1, settles q-apply-collapse-1, from ISS-13117 AC-4 and AC-5): a saved view stores and applies only its own grouping axis's collapsed groups; a view with no collapse metadata leaves the reader's collapsed groups as they are.",
  acMet: "Decision (orchestrator): ISS-13117 AC-3 (saving an updated layout without altering unrelated views) is met on the list's existing save-as-new-view action.",
  lanes: "Decision (orchestrator, q-mention-only-lanes-1): the mention-only lanes `test:deploy`, `test:deploy-guards`, `test:deploy-harness` and `test:lint` were first not run to green because of load timeouts in `scripts/`, which this diff does not touch. Later superseded by the 2026-11-20 rerun ruling: they passed when rerun on the clean tree (see Handoff, Checks).",
};

/** The Engineering checklist item that repeats the option C trade. */
export const TRADE_TWIN = "[ ] Engineering decision: can the second-level Owner resting default be told apart from a chosen Ascending?; built: option C, `withOwnerSubgroupResting` in the list's one grouping setter turns Owner newly set at level 2 (Owner at neither level before) into Custom order; the Group menu writes the whole next grouping in one call through an optional `onGroupingChange`; evidence: `EMPTY_TABLE_GROUPING.secondary.order` is Ascending and remembered grouping, URL (`group=field&groupOrder=asc`) and saved views store only the order value, so a stored `owner:asc` on level 2 keeps plain Ascending (accepted cost)";

export const HUMAN_RULINGS = [
  '- Ruling 2026-11-19 (designer): "All shared lists (Recommended)"; amends: AC-1, AC-4',
  '- Ruling 2026-11-19 (designer): "Unassigned last too"; amends: AC-4',
];

/**
 * The ISS-13115 Scope section and Engineering checklist with the given entries
 * (`only` keeps just those keys of SETTLED_BY_ORCHESTRATOR plus `twin`).
 * `rulings` are added after the session's two real human rulings.
 */
export function settledTicket({ rulings = [], only, twin = TRADE_TWIN, ...entries } = {}) {
  const decisions = { ...SETTLED_BY_ORCHESTRATOR, ...entries };
  const keys = only ?? [...Object.keys(SETTLED_BY_ORCHESTRATOR), "twin"];
  return [
    "## Scope and acceptance criteria",
    "",
    "- Acceptance criteria:",
    "  - [x] An explicit user-selected group order, when supported, remains respected.",
    ...HUMAN_RULINGS,
    ...rulings,
    ...Object.keys(decisions).filter((key) => keys.includes(key)).map((key) => `- ${decisions[key]}`),
    "",
    "## Engineering checklist",
    "",
    ...(keys.includes("twin") ? [`- ${twin}`] : []),
    "",
  ].join("\n");
}
