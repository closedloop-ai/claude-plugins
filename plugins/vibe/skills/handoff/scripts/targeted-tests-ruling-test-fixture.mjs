// Verifier evidence for a UI change made under a recorded targeted-tests
// ruling: the one targeted test passed, and every other selected test, the
// matching lane and both host lanes are left on rows naming the ruling.

export const RULING_ID = "R-TARGETED-TESTS";
export const RULINGS = [
  "# Program rulings",
  "",
  "## R-REVERT-SORT (operator, 2026-10-23 ~03:36Z)",
  "- Revert the default sort change.",
  "",
  `## ${RULING_ID} (operator, 2026-10-23 ~03:58Z)`,
  "- Pre-merge runs use the subagent's TARGETED inventory first (not full suites).",
  "",
].join("\n");
export const TICKET = [
  "## Scope and acceptance criteria",
  `- Ruling ${RULING_ID} 2026-11-12 (operator): "where possible we should run targeted tests not full suites"; amends: none`,
  "",
].join("\n");
export const COMMIT = "e".repeat(40);
export const SOURCE = "packages/app/list.ts";
export const TARGET = "packages/app/list.test.ts";
export const SELECTED_ONLY = "packages/app/other.test.ts";
export const LANE = Object.freeze({ name: "@repo/app", command: "pnpm --filter @repo/app test" });
export const FILES = Object.freeze([{ path: SOURCE, status: "M", hunks: [] }]);
const TARGET_COMMAND = `pnpm --filter @repo/app exec vitest run ${TARGET} -t lists`;
const REASON = "left to CI under the targeted-tests ruling";

/** A complete evidence document citing the ruling from `source` ("rulings" or "ticket"). */
export function ruledEvidence(source = "rulings") {
  const ruled = { status: "not-run", ruling: RULING_ID, reason: REASON, commit: COMMIT };
  return {
    targetedTestsRuling: { id: RULING_ID, source },
    touchFlows: [], touchFlowsReason: "no touch flow changed",
    runs: [{ lane: "web-host", command: "control web", ...ruled }, { lane: "desktop-host", command: "control desktop", ...ruled }],
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit: COMMIT,
      laneReport: { command: "pnpm test:lanes", matches: [LANE] },
      entries: [{ kind: "vitest", path: TARGET, cases: ["lists"], command: TARGET_COMMAND }] },
    testSelection: [{ file: SOURCE, selector: "code_tests_for", tests: [TARGET, SELECTED_ONLY] },
      { file: SOURCE, selector: "e2e-reference", tests: [] }],
    testRuns: [{ path: TARGET, cases: ["lists"], command: TARGET_COMMAND, status: "passed", commit: COMMIT },
      { path: SELECTED_ONLY, command: `pnpm --filter @repo/app exec vitest run ${SELECTED_ONLY}`, ...ruled },
      { lane: LANE.name, command: LANE.command, ...ruled }],
    testIntegrityProofs: [], rerunCycles: [],
    e2eCapability: { selectedTier: "A", container: { dockerPresent: true, dockerReachable: true, memoryGiB: 24, diskGiB: 80,
      minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "repo probe" }, native: { available: true, forbidden: false }, remote: { available: false } },
  };
}
