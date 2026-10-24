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
    rerunCycles: [],
    e2eCapability: { selectedTier: "A", container: { dockerPresent: true, dockerReachable: true, memoryGiB: 24, diskGiB: 80,
      minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "repo probe" }, native: { available: true, forbidden: false }, remote: { available: false } },
  };
  const comment = renderEvidenceComment(evidence);
  for (const value of [commit, "src/list.test.ts", "search", command, "E2E tier: A", `passed at \`${commit}\``, "Browser E2E", "pnpm test:browser-e2e"]) assert.ok(comment.includes(value), value);
  assert.throws(() => renderEvidenceComment({}), /targeted inventory/);
});
