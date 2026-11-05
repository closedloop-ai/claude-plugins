import assert from "node:assert/strict";
import test from "node:test";
import { renderEvidenceComment } from "./pr-evidence-comment.mjs";

test("the PR comment lists the final SHA, exact cases, command, tier and result SHA", () => {
  const commit = "f".repeat(40);
  const command = "pnpm --filter app exec vitest run src/list.test.ts -t search";
  const evidence = {
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit,
      laneReport: { command: "pnpm test:lanes", matches: [{ name: "Browser E2E", command: "pnpm test:browser-e2e" }] },
      entries: [{ kind: "vitest", path: "src/list.test.ts", cases: ["search"], command }] },
    testRuns: [{ path: "src/list.test.ts", cases: ["search"], command, status: "passed", commit },
      { lane: "Browser E2E", command: "pnpm test:browser-e2e", status: "passed", commit }],
    testSelection: [{ file: "src/list.ts", selector: "code_tests_for", tests: ["src/list.test.ts"] }],
    testIntegrityProofs: [{ candidate: "absence:src/list.test.ts:4", path: "src/list.test.ts", case: "does not render stale rows",
      class: "absence", mutation: "restore the stale row", command, observedFailure: "the absence assertion failed",
      restoredPass: true, commit, ownerBoundary: "production", mountedSignal: "the list heading is visible",
      assertionLine: 'expect(screen.queryByRole("row")).toBeNull();', assertionLocation: "src/list.test.ts:4:1",
      presentState: "the stale row is present in the asserted list",
      mutationRun: { command, exitCode: 1, assertionFailure: "AssertionError: expect(screen.queryByRole).toBeNull failed at src/list.test.ts:4:1; Expected null but found the stale row" } }],
    rerunCycles: [],
    e2eCapability: { selectedTier: "A", container: { dockerPresent: true, dockerReachable: true, memoryGiB: 24, diskGiB: 80,
      minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "repo probe" }, native: { available: true, forbidden: false }, remote: { available: false } },
  };
  const comment = renderEvidenceComment(evidence);
  for (const value of [commit, "src/list.test.ts", "search", command, "E2E tier: A", `passed at \`${commit}\``, "Browser E2E", "pnpm test:browser-e2e", "Test integrity mutations", "restore the stale row", "Expected null but found the stale row (exit 1)"]) assert.ok(comment.includes(value), value);
  assert.throws(() => renderEvidenceComment({}), /targeted inventory/);
  assert.throws(() => renderEvidenceComment({
    ...evidence,
    testIntegrityProofs: [{ ...evidence.testIntegrityProofs[0], mutationRun: undefined }],
  }), /absence proof needs a mutation run/);
  const multiline = renderEvidenceComment({
    ...evidence,
    testIntegrityProofs: [{ ...evidence.testIntegrityProofs[0],
      mutationRun: { command, exitCode: 1,
        assertionFailure: "AssertionError: expect(screen.queryByRole).toBeNull failed at src/list.test.ts:4:1\nExpected: null | Received: row" } }],
  });
  assert.ok(multiline.includes("src/list.test.ts:4:1<br>Expected: null \\| Received: row"));
  assert.equal(multiline.split("\n").filter((line) => line.startsWith("| absence |")).length, 1);
  assert.throws(() => renderEvidenceComment({
    ...evidence,
    testSelection: { codeTestsFor: { "src/list.ts": ["list.test.ts"] } },
  }), /testSelection must be an array/);
});
