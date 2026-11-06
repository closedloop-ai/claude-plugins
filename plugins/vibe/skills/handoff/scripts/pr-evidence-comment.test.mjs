import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderEvidenceComment } from "./pr-evidence-comment.mjs";
import { qaImpactRequest } from "./qa-impact.mjs";
import { git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";

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

test("qa-impact PR evidence comment needs the exact owned worktree", (t) => {
  const { root, home, cleanup } = makeHome("pr-evidence-comment-source-");
  t.after(cleanup);
  const worktree = path.join(root, "worktree");
  mkdirSync(worktree);
  git(worktree, ["init", "--quiet"], home);
  writeFileSync(path.join(worktree, "README.md"), "base\n");
  git(worktree, ["add", "."], home);
  git(worktree, ["commit", "--quiet", "-m", "base"], home);
  const boundary = git(worktree, ["rev-parse", "HEAD"], home);
  mkdirSync(path.join(worktree, "src"));
  const file = "src/check.mjs";
  writeFileSync(path.join(worktree, file), "export const checked = true;\n");
  git(worktree, ["add", file], home);
  git(worktree, ["commit", "--quiet", "-m", "checked"], home);
  const commit = git(worktree, ["rev-parse", "HEAD"], home);
  const command = "node --test plugins/vibe/skills/handoff/scripts/pr-facts.test.mjs";
  const request = { lastQa: { boundary }, evidence: { screens: [] }, graphImporters: { importers: { [file]: [] } },
    featureMap: { entries: [] }, laneSelections: { files: { [file]: [command] } } };
  const impact = qaImpactRequest(worktree, request);
  const evidence = { qaImpactRequest: request, testSelection: [], testIntegrityProofs: [], rerunCycles: [],
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit, impactKey: impact.laneKey,
      laneReport: { command: "qa-impact.mjs", matches: [{ name: "node", command, reason: impact.reason }] },
      entries: [], noTestsReason: "lane only" },
    testRuns: [{ lane: "node", command, status: "passed", commit, laneKey: impact.laneKey }],
    e2eCapability: { selectedTier: "A", container: { dockerPresent: true, dockerReachable: true, memoryGiB: 24, diskGiB: 80,
      minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "repo probe" }, native: { available: true, forbidden: false }, remote: { available: false } } };
  assert.match(renderEvidenceComment(evidence, worktree), /Matching post-merge lanes: node:/);
  assert.throws(() => renderEvidenceComment(evidence), /target worktree/);
  const wrong = path.join(root, "wrong");
  mkdirSync(wrong);
  git(wrong, ["init", "--quiet"], home);
  assert.throws(() => renderEvidenceComment(evidence, wrong), /could not be recomputed/);
  const input = path.join(root, "evidence.json");
  const output = path.join(root, "comment.md");
  writeFileSync(input, JSON.stringify(evidence));
  const cli = fileURLToPath(new URL("./pr-evidence-comment.mjs", import.meta.url));
  const run = (args) => spawnSync(process.execPath, [cli, "--evidence", input, "--output", output, ...args], { encoding: "utf8" });
  assert.equal(run(["--worktree", worktree]).status, 0);
  assert.match(readFileSync(output, "utf8"), /Matching post-merge lanes: node:/);
  assert.notEqual(run([]).status, 0, "the CLI cannot publish qa-impact evidence without a worktree");
});
