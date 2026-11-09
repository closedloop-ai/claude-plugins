import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { renderEvidenceComment } from "./pr-evidence-comment.mjs";
import { prEvidenceValidationProblems, proofCorpusBase, selectionProblems, targetedEvidenceProblems } from "./pr-facts.mjs";
import { NOT_RUN_NO_DESKTOP_HARNESS, NOT_RUN_NO_IDENTITY } from "../../vibe/scripts/pre-pr-lanes.mjs";
import { git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";
import { sourceIdentity } from "../../vibe/scripts/tested-head.mjs";

test("the PR comment lists the final SHA, exact cases, command, tier and result SHA", t => {
  const receiptDir = mkdtempSync(path.join(tmpdir(), "comment-proof-receipts-"));
  t.after(() => rmSync(receiptDir, { recursive: true, force: true }));
  const hash = value => createHash("sha256").update(value).digest("hex");
  const bind = (proof, name) => {
    const summary = proof.mutationRun.assertionFailure;
    const [, line] = proof.assertionLocation.match(/:(\d+):\d+$/);
    const raw = [` FAIL  ${proof.path} > ${proof.case}`, summary, ` ❯ ${proof.assertionLocation}`,
      `  > ${line}| ${proof.assertionLine}`, "     | ^"].join("\n");
    const receipt = { candidate: proof.candidate, target: proof.path, command: proof.command,
      mutationExit: proof.mutationRun.exitCode, mutationOutput: raw,
      restoredExit: 0, restoredOutput: "Test Files 1 passed", head: proof.commit,
      beforeSha256: hash("original source"), mutatedSha256: hash("mutated source") };
    const bytes = JSON.stringify(receipt);
    writeFileSync(path.join(receiptDir, name), bytes);
    return { ...proof, mutationRun: { ...proof.mutationRun, assertionFailure: `raw output SHA-256 ${hash(raw)}\n${summary}` },
      rawReceipt: name, rawReceiptSha256: hash(bytes), restoredOutputSha256: hash(receipt.restoredOutput) };
  };
  const options = { candidateFiles: [], receiptDir };
  const commit = "f".repeat(40);
  const command = "pnpm --filter app exec vitest run src/list.test.ts -t search";
  const evidence = {
    touchFlows: [], touchFlowsReason: "fixture", runs: [],
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
  evidence.testIntegrityProofs = [bind(evidence.testIntegrityProofs[0], "base.json")];
  const comment = renderEvidenceComment(evidence, undefined, options);
  for (const value of [commit, "src/list.test.ts", "search", command, "E2E tier: A", `passed at \`${commit}\``, "Browser E2E", "pnpm test:browser-e2e", "Test integrity mutations", "restore the stale row", "Expected null but found the stale row (exit 1)"]) assert.ok(comment.includes(value), value);
  assert.throws(() => renderEvidenceComment({}), /targeted inventory/);
  assert.throws(() => renderEvidenceComment({
    ...evidence,
    testIntegrityProofs: [{ ...evidence.testIntegrityProofs[0], mutationRun: undefined }],
  }, undefined, options), /absence proof needs a mutation run/);
  const multiline = renderEvidenceComment({
    ...evidence,
    testIntegrityProofs: [bind({ ...evidence.testIntegrityProofs[0],
      mutationRun: { command, exitCode: 1,
        assertionFailure: "AssertionError: expect(screen.queryByRole).toBeNull failed at src/list.test.ts:4:1\nExpected: null | Received: row" } }, "multiline.json")],
  }, undefined, options);
  assert.ok(multiline.includes("src/list.test.ts:4:1<br>Expected: null \\| Received: row"));
  assert.equal(multiline.split("\n").filter((line) => line.startsWith("| absence |")).length, 1);
  assert.throws(() => renderEvidenceComment({
    ...evidence,
    testSelection: { codeTestsFor: { "src/list.ts": ["list.test.ts"] } },
  }, undefined, options), /testSelection must be an array/);
});


test("the production environment worker passes its exact worktree to evidence-comment validation", () => {
  const worker = readFileSync(new URL("../../../agents/vibe-environment-worker.md", import.meta.url), "utf8");
  const command = worker.match(/`node \.\.\/skills\/handoff\/scripts\/pr-evidence-comment\.mjs[^`]+`/);
  assert.ok(command, "actual production invocation");
  assert.match(command[0], /--worktree "<wt>"/);
});

test("ISS-13846 review DT-24 comment rejects a changed absence assertion with no proof", () => {
  const commit = "f".repeat(40);
  const source = ['test("absence", () => {', '  expect(screen.queryByText("stale")).toBeNull();', '});'].join("\n");
  const file = { path: "src/list.test.ts", status: "M", added: [{ line: 2, text: source.split("\n")[1] }] };
  const evidence = { touchFlows: [], touchFlowsReason: "fixture", runs: [],
    testSelection: [], testRuns: [], rerunCycles: [], testIntegrityProofs: [],
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit,
      laneReport: { command: "pnpm test:lanes", matches: [] }, entries: [], noTestsReason: "fixture" },
    e2eCapability: { selectedTier: "A", container: { dockerPresent: true, dockerReachable: true,
      memoryGiB: 24, diskGiB: 80, minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "repo probe" },
      native: { available: false }, remote: { available: false } } };
  assert.throws(() => renderEvidenceComment(evidence, undefined, { candidateFiles: [file],
    readSource: path => path === file.path ? source : null }), /absence|failing-mutation|proof/i);
});

test("ISS-13846 review DT-29 comment rejects evidence for old A on current HEAD B", () => {
  const oldHead = "a".repeat(40);
  const newHead = "b".repeat(40);
  const source = { head: oldHead, diffSha256: "c".repeat(64), treeSha256: "d".repeat(64) };
  const evidence = { source, touchFlows: [], touchFlowsReason: "fixture", runs: [],
    testSelection: [], testRuns: [], rerunCycles: [], testIntegrityProofs: [],
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit: oldHead,
      laneReport: { command: "pnpm test:lanes", matches: [] }, entries: [], noTestsReason: "fixture" },
    e2eCapability: { selectedTier: "A", container: { dockerPresent: true, dockerReachable: true,
      memoryGiB: 24, diskGiB: 80, minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "repo probe" },
      native: { available: false }, remote: { available: false } } };
  assert.throws(() => renderEvidenceComment(evidence, undefined, { candidateFiles: [],
    currentSource: { ...source, head: newHead } }), /current.*(?:HEAD|source)|source.*(?:changed|match)/i);
  assert.throws(() => renderEvidenceComment({ ...evidence, source: undefined }, undefined, {
    candidateFiles: [], currentSource: { ...source, head: newHead } }), /current.*(?:HEAD|source)|source.*(?:changed|match)/i,
  "removing the source identity cannot bypass the current worktree binding");
});

test("ISS-13846 review DT-29 reads the actual worktree identity before rendering", t => {
  const wt = mkdtempSync(path.join(tmpdir(), "comment-current-head-"));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", wt]);
  writeFileSync(path.join(wt, "note.txt"), "A\n");
  execFileSync("git", ["-C", wt, "add", "."]);
  execFileSync("git", ["-C", wt, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "A"]);
  const source = sourceIdentity(wt);
  execFileSync("git", ["-C", wt, "update-ref", "refs/remotes/origin/main", source.head]);
  writeFileSync(path.join(wt, "note.txt"), "B\n");
  execFileSync("git", ["-C", wt, "add", "."]);
  execFileSync("git", ["-C", wt, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "B"]);
  assert.throws(() => renderEvidenceComment({ source,
    targetedInventory: { commit: source.head, actor: "read-only", source: "final-committed-diff",
      entries: [], laneReport: { command: "pnpm test:lanes", matches: [] }, noTestsReason: "fixture" },
    touchFlows: [], touchFlowsReason: "fixture", runs: [], testRuns: [], testSelection: [],
    rerunCycles: [], e2eCapability: { selectedTier: "A", container: { dockerPresent: true,
      dockerReachable: true, memoryGiB: 24, diskGiB: 80, minimumMemoryGiB: 20,
      minimumDiskGiB: 64, command: "repo probe" }, native: { available: false }, remote: { available: false } },
  }, wt, { currentSource: source }), /source does not match the current worktree HEAD/i);
  assert.throws(() => renderEvidenceComment({ source,
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit: source.head,
      laneReport: { command: "pnpm test:lanes", matches: [] }, entries: [], noTestsReason: "fixture" },
    touchFlows: [], touchFlowsReason: "fixture", runs: [], testRuns: [], testSelection: [],
    rerunCycles: [], e2eCapability: { selectedTier: "A", container: { dockerPresent: true,
      dockerReachable: true, memoryGiB: 24, diskGiB: 80, minimumMemoryGiB: 20,
      minimumDiskGiB: 64, command: "repo probe" }, native: { available: false }, remote: { available: false } },
  }, wt, { worktree: undefined, currentSource: source, candidateFiles: [] }),
  /source does not match the current worktree HEAD/i,
  "options cannot replace the actual comment worktree with an authored source");
});

test("ISS-13846 review DT-33 comment accepts authenticated ancestor equal-tree carry only", t => {
  const wt = mkdtempSync(path.join(tmpdir(), "comment-ancestor-carry-"));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", wt]);
  writeFileSync(path.join(wt, "note.txt"), "A\n");
  execFileSync("git", ["-C", wt, "add", "."]);
  const commit = message => execFileSync("git", ["-C", wt, "-c", "user.email=test@example.com",
    "-c", "user.name=Test", "commit", "-qm", message]);
  commit("A");
  const source = sourceIdentity(wt);
  execFileSync("git", ["-C", wt, "update-ref", "refs/remotes/origin/main", source.head]);
  const evidence = { source, touchFlows: [], touchFlowsReason: "fixture", runs: [],
    testSelection: [], testRuns: [], rerunCycles: [], testIntegrityProofs: [],
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit: source.head,
      laneReport: { command: "pnpm test:lanes", matches: [] }, entries: [], noTestsReason: "fixture" },
    e2eCapability: { selectedTier: "A", container: { dockerPresent: true, dockerReachable: true,
      memoryGiB: 24, diskGiB: 80, minimumMemoryGiB: 20, minimumDiskGiB: 64,
      command: "repo probe" }, native: { available: false }, remote: { available: false } } };
  execFileSync("git", ["-C", wt, "-c", "user.email=test@example.com", "-c", "user.name=Test",
    "commit", "-q", "--allow-empty", "-m", "B equal tree"]);
  const published = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const comment = renderEvidenceComment(evidence, wt);
  assert.match(comment, /Targeted pre-PR evidence/);
  assert.ok(comment.includes(`Published HEAD: \`${published}\``), "review DT-36: the actual descendant B is labeled as published");
  assert.ok(comment.includes(`Tested inventory commit: \`${source.head}\``),
    "review DT-36: tested ancestor A remains visible as separate provenance");
  assert.ok(!comment.includes(`Final committed diff: \`${source.head}\``),
    "the ancestor A must not be called the final published diff");
  writeFileSync(path.join(wt, "note.txt"), "C changed tree\n");
  execFileSync("git", ["-C", wt, "add", "."]);
  commit("C changed tree");
  assert.throws(() => renderEvidenceComment(evidence, wt), /source|tree|ancestor/i);
});

const ISS13846_TEST = "packages/api/src/links.test.ts";
const ISS13846_SELECTED = { targetedInventory: { actor: "read-only", source: "final-committed-diff",
  laneReport: { command: "pnpm test:lanes", matches: [] }, entries: [] } };

function iss13846Session(t) {
  const fixture = makeHome("pr-facts-iss13846-");
  t.after(fixture.cleanup);
  const wt = path.join(fixture.root, "repo");
  mkdirSync(path.dirname(path.join(wt, ISS13846_TEST)), { recursive: true });
  git(wt, ["init", "--quiet", "--initial-branch=main"], fixture.home);
  writeFileSync(path.join(wt, ISS13846_TEST), 'test("base", () => { expect(1).toBe(1); });\n');
  git(wt, ["add", "."], fixture.home);
  git(wt, ["commit", "--quiet", "-m", "base"], fixture.home);
  git(wt, ["update-ref", "refs/remotes/origin/main", "HEAD"], fixture.home);
  const recordFile = path.join(git(wt, ["rev-parse", "--absolute-git-dir"], fixture.home), "vibe-session.json");
  writeFileSync(recordFile, JSON.stringify({ status: "fixture", localFixes: [] }));
  return { wt };
}

test("ISS-13846 review DT-30 shared validator honors authenticated scoped files", t => {
  const { wt } = iss13846Session(t);
  writeFileSync(path.join(wt, ISS13846_TEST), 'test("excluded", () => { expect(screen.queryByText("stale")).toBeNull(); });\n');
  const recordFile = path.join(git(wt, ["rev-parse", "--absolute-git-dir"]), "vibe-session.json");
  const record = JSON.parse(readFileSync(recordFile, "utf8"));
  writeFileSync(recordFile, JSON.stringify({ ...record, localFixes: [{ ticket: "ISS-99999", paths: [ISS13846_TEST] }] }));
  const commit = git(wt, ["rev-parse", "HEAD"]);
  const evidence = { ...ISS13846_SELECTED, targetedInventory: { ...ISS13846_SELECTED.targetedInventory, commit },
    testIntegrityProofs: [], testRuns: [], touchFlows: [], touchFlowsReason: "fixture" };
  const problems = prEvidenceValidationProblems(evidence, commit, { worktree: wt, files: [],
    readSource: file => readFileSync(path.join(wt, file), "utf8") });
  assert.doesNotMatch(problems.join("\n"), /failing-mutation proof|changed responsive, absence/i);
});


test("ISS-13846 AC-3 tier-C Desktop carry agrees in inventory and comment renderer", t => {
  const commit = "5afa61faa88a057e2f67df4da923a7be6e46adf5";
  const spec = "apps/desktop/test/e2e/shared-paged-source-documents.spec.ts";
  const lane = { name: "desktop-e2e", command: "DESKTOP_E2E_SMOKE_TAG='' pnpm --dir apps/desktop test:e2e" };
  const reason = NOT_RUN_NO_DESKTOP_HARNESS;
  const ciOwner = "desktop-e2e-validation.yml:desktop-e2e/validated";
  const evidence = { touchFlows: [], touchFlowsReason: "fixture", runs: [],
    testSelection: [{ file: spec, selector: "e2e-reference", tests: [spec] }], rerunCycles: [],
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit,
      laneReport: { command: "pnpm test:lanes", matches: [lane] },
      entries: [{ kind: "e2e", path: spec, cases: ["changed assertion"], command: "not run locally" }] },
    e2eCapability: { probedCommit: commit, selectedTier: "C",
      container: { dockerPresent: true, dockerReachable: false, memoryGiB: 0, diskGiB: 334.3,
        minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "docker --version; docker info",
        runnable: false, notRunnableReason: "identity absent",
        secretsSet: { CLERK_SECRET_KEY: false, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: false, DEVOPS_CLOSEDLOOP_APP_PWD: false } },
      native: { available: false }, remote: { available: true, command: `~/vibe-remote/e2e-slot.sh --head ${commit} proof-owner <command...>`,
        runnerHost: "selected-second-laptop", runnerWorktree: "/selected/iss-13699",
        probeOwner: "proof-owner", source: "SSH exact-head probe passed",
        desktopHarness: { available: false, reason: "no supported displayless Linux Electron harness", probe: "remote selected-tier displayless probe failed", probedCommit: commit } },
      desktopHarness: { available: false, reason: "no supported displayless Linux Electron harness",
        probe: "darwin; dbus-run-session=false, xvfb-run=false, gnome-keyring-daemon=false" },
      unavailableSpecs: [spec], ciCoverage: [ciOwner] },
    testRuns: [
      { path: spec, status: "not-run", commit, reason, ciOwner, selectedTier: "C",
        displaylessLimitation: "no supported displayless Linux Electron harness",
        selectionSource: "e2e-reference", laneReportSource: "pnpm test:lanes" },
      { lane: lane.name, command: lane.command, status: "not-run", commit, reason },
    ] };
  const fixture = makeHome("tier-c-probe-receipt-");
  t.after(fixture.cleanup);
  const receiptDir = fixture.root;
  const bin = path.join(fixture.root, "bin");
  mkdirSync(bin);
  const ssh = path.join(bin, "ssh");
  writeFileSync(ssh, `#!/bin/sh\ncase "$*" in\n  *"/selected/iss-13699"*"--head ${commit} --native-desktop proof-owner"*"node -e"*) echo 'Usage: e2e-slot.sh [--head <sha>] <owner-label> <command...>' >&2; exit 2;;\n  *"/selected/iss-13699"*"--head ${commit} proof-owner"*"node -e"*) echo '{"kind":"selected-runner-desktop-capability/v2","head":"${commit}","worktree":"/selected/iss-13699","platform":"darwin","linuxHarness":false}'; exit 0;;\n  *) exit 1;;\nesac\n`);
  chmodSync(ssh, 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const receipt = { kind: "selected-runner-desktop-probe/v1", head: commit, selectedTier: "C",
    runnerCommand: evidence.e2eCapability.remote.command,
    probe: { command: `zsh -lic '~/vibe-remote/e2e-slot.sh --head ${commit} --native-desktop owner probe'`,
      exitCode: 0, output: "no supported displayless Linux Electron harness" },
    desktopHarness: { available: false, reason: "no supported displayless Linux Electron harness",
      probe: evidence.e2eCapability.remote.desktopHarness.probe, probedCommit: commit } };
  const bytes = JSON.stringify(receipt);
  writeFileSync(path.join(receiptDir, "probe.json"), bytes);
  evidence.e2eCapability.remote.desktopHarness.receipt = { path: "probe.json", sha256: createHash("sha256").update(bytes).digest("hex") };
  assert.deepEqual(selectionProblems(evidence, [{ path: spec, status: "M" }], [], commit), []);
  assert.deepEqual(targetedEvidenceProblems(evidence, commit, undefined, receiptDir), []);
  const commentOptions = { receiptDir, candidateFiles: [], probeCapability: () => evidence.e2eCapability };
  assert.match(renderEvidenceComment(evidence, undefined, commentOptions), /Left for CI:.*shared-paged-source-documents/);
  for (const mutation of [
    { ...evidence, e2eCapability: { ...evidence.e2eCapability, probedCommit: "a".repeat(40) } },
    { ...evidence, e2eCapability: { ...evidence.e2eCapability, remote: { ...evidence.e2eCapability.remote,
      desktopHarness: { ...evidence.e2eCapability.remote.desktopHarness, probe: "" } } } },
    { ...evidence, e2eCapability: { ...evidence.e2eCapability, remote: { ...evidence.e2eCapability.remote,
      desktopHarness: { available: true, probe: "e2e-slot.sh --native-desktop passed 302 tests" } } } },
    { ...evidence, e2eCapability: { ...evidence.e2eCapability, remote: { ...evidence.e2eCapability.remote,
      desktopHarness: { ...evidence.e2eCapability.remote.desktopHarness, probedCommit: "a".repeat(40) } } } },
    { ...evidence, e2eCapability: { ...evidence.e2eCapability, remote: { ...evidence.e2eCapability.remote,
      desktopHarness: undefined } } },
    { ...evidence, testRuns: evidence.testRuns.map(run => run.path === spec ? { ...run, ciOwner: "e2e-test.yml:e2e" } : run) },
    { ...evidence, targetedInventory: { ...evidence.targetedInventory, laneReport: { command: "pnpm test:lanes", matches: [] } } },
  ]) {
    assert.notDeepEqual(targetedEvidenceProblems(mutation, commit, undefined, receiptDir), []);
    assert.throws(() => renderEvidenceComment(mutation, undefined, commentOptions), /pre-PR evidence is incomplete/);
  }
});

test("ISS-13846 review DT-23 comment refuses changed or malformed live capability", () => {
  const commit = "f".repeat(40);
  const spec = "e2e/org-issues-list.spec.ts";
  const missingPrerequisites = ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"];
  const capability = { probedCommit: commit, selectedTier: "A",
    container: { dockerPresent: true, dockerReachable: true, memoryGiB: 23.4, diskGiB: 936,
      minimumMemoryGiB: 20, minimumDiskGiB: 64, command: "docker version; docker info; dagger version; df",
      runnable: false, notRunnableReason: missingPrerequisites.join(", "),
      secretsSet: { CLERK_SECRET_KEY: false, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: false, DEVOPS_CLOSEDLOOP_APP_PWD: true } },
    native: { available: false }, remote: { available: false },
    desktopHarness: { available: false, reason: "no supported displayless Linux Electron harness", probe: "fixture" },
    unavailableSpecs: [spec], ciCoverage: ["e2e-test.yml:e2e"] };
  const evidence = { touchFlows: [], touchFlowsReason: "no changed touch flow", runs: [],
    testRuns: [{ path: spec, kind: "e2e", status: "not-run", commit, selectedTier: "A", missingPrerequisites,
      reason: NOT_RUN_NO_IDENTITY, ciOwner: "e2e-test.yml:e2e", selectionSource: "e2e-reference", laneReportSource: "pnpm test:lanes" }],
    testSelection: [{ file: "apps/api/app/links/route.ts", selector: "e2e-reference", tests: [spec] }],
    rerunCycles: [], targetedInventory: { actor: "read-only", source: "final-committed-diff",
      commit, laneReport: { command: "pnpm test:lanes", matches: [] },
      entries: [{ kind: "e2e", path: spec, cases: ["changed name"], command: "not run locally" }] },
    e2eCapability: capability };
  assert.doesNotThrow(() => renderEvidenceComment(evidence, undefined, { probeCapability: () => capability, candidateFiles: [] }));
  assert.throws(() => renderEvidenceComment(evidence, undefined, { probeCapability: () => ({
    ...capability, container: { ...capability.container, dockerReachable: false },
  }), candidateFiles: [] }), /capability|probe|Docker/i,
  "comment and inventory must reject the same changed live capability probe");
  assert.throws(() => renderEvidenceComment(evidence, undefined, { probeCapability: () => ({
    ...capability, container: { ...capability.container, secretsSet: undefined },
  }), candidateFiles: [] }), /pre-PR evidence is incomplete.*|identity-key presence/i,
  "a malformed live probe must fail as evidence, not crash the comment renderer");
});

test("ISS-13846 review F3 inventory and comment share one proof-candidate base", t => {
  const repo = mkdtempSync(path.join(tmpdir(), "proof-corpus-base-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const run = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const commit = (message) => { run("commit", "-q", "--allow-empty", "-m", message); return run("rev-parse", "HEAD"); };
  run("init", "-q", "-b", "work");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "test");
  const root = commit("root");
  run("update-ref", "refs/remotes/origin/main", commit("main only"));
  run("reset", "-q", "--hard", root);
  const preview = commit("preview");
  run("update-ref", "refs/remotes/origin/preview", preview);
  commit("work");
  assert.equal(proofCorpusBase(repo), root, "with no configured base or remote default, the corpus is diffed against origin/main");
  run("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/preview");
  assert.equal(proofCorpusBase(repo), preview, "the clone's recorded remote default replaces a hard-coded main");
  run("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  run("config", "vibe.baseRef", "preview");
  assert.equal(proofCorpusBase(repo), preview, "a configured vibe.baseRef wins, as in the inventory");
  assert.equal(proofCorpusBase(repo, () => "origin/main"), root, "the inventory's verified comparison is used when it supplies one");
});
