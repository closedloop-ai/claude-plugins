import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { collectClaudeEval } from "./eval-collector.ts";
import { applyClaudeReplyCheckers, deterministicClaudeRecord,
  validateReplyCheckerInstallation } from "./reply-checker.ts";

const caseId = "pm-prd-children-are-scope";
const vibeRoot = join(import.meta.dirname, "../../../plugins/vibe");
const coreRoot = join(import.meta.dirname, "../../../plugins/closedloop-core");
const goodReply = "CLAIM: ISS-9001; ASSIGN: operator-1; STATUS: IN_PROGRESS; " +
  "LINK: ISS-9000; COMMENT:ISS-9000_COORDINATOR\n" +
  "REPORT: ISS-9002; ACTION:EXCLUDE; REASON:ACTIVE_OTHER_OWNER\n" +
  "UNCOVERED: ISS-9003; ACTION:LEAVE_UNCOVERED\n" +
  "SUPERSEDE: None\n\nGraph:\n" +
  "- ticket_detail ISS-9002: ISS-9002 active by another person";

function native(passed: boolean, vibePath = vibeRoot, vibeVersion = "1.1.49") {
  return {
    schemaVersion: 1, claudeVersion: "2.1.316", durationSeconds: 1, costUsd: 0,
    partial: false, suite: { ablation: "none", modelOverride: "claude-sonnet-5-5",
      plugins: [{ name: "vibe", version: vibeVersion, path: vibePath },
        { name: "closedloop-core", version: "1.6.2", path: coreRoot }] },
    cases: [{ name: caseId, runsPerCase: 1, arms: { with: [{ passed, error: null,
      costUsd: 0, judgeCostUsd: 0, skippedPaidGraders: false, graders: [
        { name: "claims-untouched", passed, scored: true },
        { name: "no-supersession", passed, scored: true },
        { name: "reports-active", passed: true, scored: true },
      ] }] } }], aggregates: { casesTotal: 1, casesPassed: passed ? 1 : 0 },
  };
}

const expected = { version: "1.1.49", coreVersion: "1.6.2", cliVersion: "2.1.316",
  vibePath: vibeRoot, corePath: coreRoot, model: "claude-sonnet-5-5", runs: 1 };

function checkerDriverFixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "vibe-checker-driver-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".claude-plugin"));
  mkdirSync(join(root, "evals/checkers"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ version: "1.1.49" }));
  for (const file of ["manifest.json", "iss-13760-reply-format.mjs"]) {
    cpSync(join(vibeRoot, "evals/checkers", file), join(root, "evals/checkers", file));
  }
  return root;
}

test("ISS-13760 Claude overrides are mapped-only and preserve native provenance", (t) => {
  const checkerDriver = checkerDriverFixture(t);
  const original = native(true);
  const badReply = goodReply.replace("ISS-9000_COORDINATOR", "ISS-9000_COORDINATOR_EXTRA");
  const nativeCollected = collectClaudeEval(original, [caseId], expected);
  const overridden = applyClaudeReplyCheckers(original, [caseId],
    new Map([[caseId, badReply]]), checkerDriver);
  assert.equal(overridden.changed, true);
  assert.deepEqual(original, native(true), "native aggregate remains immutable");
  const semantic = collectClaudeEval(overridden.raw, [caseId], expected);
  const record = deterministicClaudeRecord({ runtime: "claude", exitCode: 0,
    result: nativeCollected, invalidReason: null }, semantic, overridden);
  assert.equal(record.exitCode, 1);
  assert.equal(record.result?.nativeHash, nativeCollected.nativeHash);
  assert.match(record.result?.deterministicOverride?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(record.result?.deterministicOverride?.checkerVersion, "1.1.49");
  assert.match(record.result?.deterministicOverride?.checkerSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(record.result?.deterministicOverride?.graders, [
    "pm-prd-children-are-scope/claims-untouched",
    "pm-prd-children-are-scope/no-supersession",
  ]);
  assert.equal(record.result?.cases[0]?.failedGraders.includes("reports-active"), false);

  const unrelated = native(true);
  const untouched = applyClaudeReplyCheckers(unrelated, ["pm-other"],
    new Map());
  assert.equal(untouched.changed, false);
  assert.equal(untouched.raw, unrelated);
  assert.throws(() => deterministicClaudeRecord({ runtime: "claude", exitCode: 1,
    result: nativeCollected, invalidReason: null }, semantic, overridden), /native-provenance-invalid/);
});

test("ISS-13760 old subject snapshots use the driver checker revision", (t) => {
  const checkerDriver = checkerDriverFixture(t);
  const oldSubject = "/released/vibe/1.1.45-without-checkers";
  const raw = native(true, oldSubject, "1.1.45");
  const oldExpected = { ...expected, version: "1.1.45", vibePath: oldSubject };
  const nativeCollected = collectClaudeEval(raw, [caseId], oldExpected);
  const overridden = applyClaudeReplyCheckers(raw, [caseId],
    new Map([[caseId, goodReply]]), checkerDriver);
  const semantic = collectClaudeEval(overridden.raw, [caseId], oldExpected);
  const record = deterministicClaudeRecord({ runtime: "claude", exitCode: 0,
    result: nativeCollected, invalidReason: null }, semantic, overridden);
  assert.equal(record.result?.deterministicOverride?.checkerVersion, "1.1.49");
  assert.equal(record.result?.deterministicOverride?.checkerSha256,
    validateReplyCheckerInstallation(vibeRoot, [caseId]).sha256);
  assert.equal(record.result?.cases[0]?.passed, true);
});

test("ISS-13760 production default records current driver provenance", () => {
  const currentVersion = "1.1.59";
  const raw = native(true, vibeRoot, currentVersion);
  const currentExpected = { ...expected, version: currentVersion };
  const nativeCollected = collectClaudeEval(raw, [caseId], currentExpected);
  const overridden = applyClaudeReplyCheckers(raw, [caseId],
    new Map([[caseId, goodReply]]));
  const semantic = collectClaudeEval(overridden.raw, [caseId], currentExpected);
  const record = deterministicClaudeRecord({ runtime: "claude", exitCode: 0,
    result: nativeCollected, invalidReason: null }, semantic, overridden);
  const installation = validateReplyCheckerInstallation(vibeRoot, [caseId]);
  assert.equal(record.result?.deterministicOverride?.checkerVersion, currentVersion);
  assert.equal(record.result?.deterministicOverride?.checkerSha256, installation.sha256);
});

test("ISS-13760 Claude checker manifest and module boundaries fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-checker-boundary-"));
  try {
    const checkers = join(root, "evals/checkers");
    mkdirSync(checkers, { recursive: true });
    const realChecker = readFileSync(join(vibeRoot, "evals/checkers/iss-13760-reply-format.mjs"));
    writeFileSync(join(checkers, "iss-13760-reply-format.mjs"), realChecker);
    const oneEntry = { schemaVersion: 1, entries: [
      { caseId, graderName: "claims-untouched", checker: "iss-13760-reply-format.mjs" },
    ] };
    writeFileSync(join(checkers, "manifest.json"), JSON.stringify(oneEntry));
    assert.throws(() => validateReplyCheckerInstallation(root, [caseId]), /manifest-invalid/);
    oneEntry.entries.push({ caseId, graderName: "no-supersession",
      checker: "iss-13760-reply-format.mjs" });
    oneEntry.entries.push({ caseId, graderName: "claims-untouched",
      checker: "iss-13760-reply-format.mjs" });
    writeFileSync(join(checkers, "manifest.json"), JSON.stringify(oneEntry));
    assert.throws(() => validateReplyCheckerInstallation(root, [caseId]), /manifest-invalid/);
    oneEntry.entries.pop();
    oneEntry.entries.push({ caseId: "extra", graderName: "extra",
      checker: "iss-13760-reply-format.mjs" });
    writeFileSync(join(checkers, "manifest.json"), JSON.stringify(oneEntry));
    assert.throws(() => validateReplyCheckerInstallation(root, [caseId]), /manifest-invalid/);

    const linked = join(root, "linked");
    mkdirSync(join(linked, "evals"), { recursive: true });
    symlinkSync(checkers, join(linked, "evals/checkers"));
    assert.throws(() => validateReplyCheckerInstallation(linked, [caseId]), /root-invalid/);

    const evalsLinked = join(root, "evals-linked");
    mkdirSync(evalsLinked);
    symlinkSync(join(root, "evals"), join(evalsLinked, "evals"));
    assert.throws(() => validateReplyCheckerInstallation(evalsLinked, [caseId]), /root-invalid/);

    const moduleLinked = join(root, "module-linked");
    mkdirSync(join(moduleLinked, "evals/checkers"), { recursive: true });
    writeFileSync(join(moduleLinked, "evals/checkers/manifest.json"),
      readFileSync(join(vibeRoot, "evals/checkers/manifest.json")));
    symlinkSync(join(checkers, "iss-13760-reply-format.mjs"),
      join(moduleLinked, "evals/checkers/iss-13760-reply-format.mjs"));
    assert.throws(() => validateReplyCheckerInstallation(moduleLinked, [caseId]), /module-invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
