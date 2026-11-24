import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, makeCheckout, makeHome, PROVIDER_BINDING, SYMPHONY_PATH_POLICY } from "../../vibe/scripts/test-fixtures.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { prRulesFor, selectionProblems } from "./pr-facts.mjs";
import { workflowLaneDefinitions } from "./ci-job-shape.mjs";
import { qaImpact } from "./qa-impact.mjs";

const { sourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");

export const PLAYS = 'pnpm --filter storybook test:branches-plays';
export const PLAYS_WORKFLOW = `name: Branches Story Plays\non:\n  pull_request:\n    paths:\n      - 'notes.md'\njobs:\n  plays:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: ${PLAYS}\n`;

export const ROUTE = "apps/api/app/links/route.ts";
export const TEST = "packages/api/src/links.test.ts";
export const SOURCES = [ROUTE, "packages/api/src/types/links.ts", "packages/api/src/service.ts"];
export const SELECTED = {
  testSelection: SOURCES.flatMap((file) => [{ file, selector: "change-tests", tests: [TEST] }, { file, selector: "e2e-reference", tests: [] }]),
  targetedInventory: {
    actor: "read-only", source: "final-committed-diff", commit: "a".repeat(40), laneReport: { command: "pnpm test:lanes", matches: [] },
    entries: [{ kind: "vitest", path: TEST, cases: ["limits"], command: "vitest run" }],
  },
  rerunCycles: [],
  e2eCapability: {
    selectedTier: "A",
    container: { dockerPresent: true, dockerReachable: true, memoryGiB: 24, diskGiB: 80, minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "repo probe" },
    native: { available: true, forbidden: false }, remote: { available: false },
  },
  testRuns: [{ path: TEST, cases: ["limits"], status: "passed", commit: "a".repeat(40), command: "vitest run" }],
};

export const selectionProblemsBound = (runsFile, files, required, commit, worktree) => selectionProblems(runsFile, files, required, commit, prRulesFor(PROVIDER_BINDING), null, worktree);

export function siblingCarry(t, extraJob = "", laterBoundary = false) {
  const f = makeHome("sibling-lane-carry-"); t.after(f.cleanup);
  const wt = path.join(f.root, "wt");
  const workflowPath = ".github/workflows/ci.yml";
  const workflow = "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test fixture.test.mjs\n" + extraJob;
  const command = workflowLaneDefinitions(workflow)[0].command;
  makeCheckout({ ...f, checkout: wt, files: { "service.mjs": "export const value = 1;\n",
    [workflowPath]: workflow, "vibe-handoff-paths.json": JSON.stringify({ ...JSON.parse(SYMPHONY_PATH_POLICY),
      laneSource: { kind: "github-workflow", path: workflowPath } }) } });
  const g = (...args) => git(wt, args, f.home);
  const base = g("rev-parse", "HEAD");
  g("commit", "--quiet", "--allow-empty", "-m", "QA snapshot");
  const earliest = g("rev-parse", "HEAD");
  if (laterBoundary) g("commit", "--quiet", "--allow-empty", "-m", "later QA milestone");
  const boundary = g("rev-parse", "HEAD");
  writeFileSync(path.join(wt, "service.mjs"), "export const value = 2;\n");
  g("commit", "--quiet", "-am", "repaired proof");
  const proof = g("rev-parse", "HEAD"); const tree = g("rev-parse", "HEAD^{tree}");
  const proofSource = sourceIdentity(wt);
  const proofRef = "refs/heads/proof/snapshot-1"; g("update-ref", proofRef, proof);
  const published = g("commit-tree", tree, "-p", base, "-m", "publication");
  g("reset", "--hard", published);
  const publishedSource = sourceIdentity(wt);
  const request = { lastQa: { boundary }, evidence: { screens: [] }, graphImporters: { importers: {} },
    featureMap: { entries: [] }, laneSelections: { files: { "service.mjs": ["test"] } }, config: { docs: [] } };
  // The ordinary classifier supplies fixture scope; expected gate verdicts below remain literal.
  const impact = qaImpact({ worktree: wt, since: boundary, ...request });
  const laneKey = impact.laneKey;
  const result = { lane: "test", command, status: "passed", exitCode: 0, commit: proof, laneKey };
  const coveredFiles = ["service.mjs", workflowPath, "vibe-handoff-paths.json"].map(file => ({ path: file,
    sha256: createHash("sha256").update(readFileSync(path.join(wt, file))).digest("hex") }));
  const receiptText = JSON.stringify({ version: 1, source: proofSource, result, coveredFiles });
  const receiptFile = path.join(g("rev-parse", "--absolute-git-dir"), "lane-result.json");
  writeFileSync(receiptFile, receiptText);
  const carry = { kind: "tree-equivalent", version: 1,
    proof: { ref: proofRef, commit: proof, gitTree: tree, source: proofSource },
    published: { ref: "refs/heads/main", commit: published, gitTree: tree, source: publishedSource }, laneKey,
    runs: [{ scopeKey: laneKey, result: structuredClone(result), coveredFiles, receipt: { path: "lane-result.json",
      sha256: createHash("sha256").update(receiptText).digest("hex") } }] };
  const evidence = { source: publishedSource, testSelection: [], qaImpact: impact, qaImpactRequest: request,
    treeEquivalentCarry: carry, targetedInventory: { actor: "read-only", source: "final-committed-diff", commit: published, impactKey: laneKey,
      laneReport: { source: { kind: "github-workflow", path: workflowPath, commit: published,
        sha256: createHash("sha256").update(workflow).digest("hex") }, matches: [{ name: "test", command }] },
      entries: [], noTestsReason: "workflow lane" }, testRuns: [result], rerunCycles: [] };
  return { wt, g, evidence: JSON.parse(JSON.stringify(evidence)), published, proof, boundary, earliest, receiptFile, base };
}

/** Exact branch and captured-main entries for the same existing failing assertion. */
export const pairedMainFailure = {
  failures: [{ id: "fixture case still red on main", assertion: "the guarded legacy value is unchanged" }],
  mainFailures: [{ id: "fixture case still red on main", assertion: "the guarded legacy value is unchanged" }],
};
