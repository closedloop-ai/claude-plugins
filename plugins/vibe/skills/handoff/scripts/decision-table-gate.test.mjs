import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localPlanPaths } from "../../vibe/scripts/local-plans.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { decisionTableProblems } = await vibeCore("lib/handoff/scripts/decision-table-gate.mjs");

const REVIEWED = "## Verification Findings\n\n- Checked live callers.\n\n## Adversarial Review\n\n- Checked competing inputs.\n\n## Fixes Applied\n\n- None required by the review.\n\n";

test("stale alignment, frozen behavior, and uncovered built rows stop handoff early", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "decision-table-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const dir = path.dirname(localPlanPaths(root).decisionTable);
  assert.deepEqual(decisionTableProblems(root), [`${path.basename(localPlanPaths(root).decisionTable)}: the session decision table is missing`]);
  mkdirSync(dir, { recursive: true });
  assert.deepEqual(decisionTableProblems(root), [`${path.basename(localPlanPaths(root).decisionTable)}: the session decision table is missing`]);
  const file = localPlanPaths(root).decisionTable;
  const name = path.basename(file);
  writeFileSync(file, `# Session\n\n## Acceptance Criteria\n\n- AC-1 met\n\n| DT-1 | built without a test |\n\n${REVIEWED}## Final Alignment Status\n\nNot aligned\n`);
  assert.deepEqual(decisionTableProblems(root), [
    `${name}: Final Alignment Status is still Not aligned`,
    `${name}: DT-1 is built without a test and is absent from Missing tests`,
  ]);
  writeFileSync(file, `# Session\n\n## Missing tests\n\n- DT-1 needs coverage\n\n| DT-1 | built without a test |\n\n${REVIEWED}## Final Alignment Status\n\nAligned\n`);
  assert.deepEqual(decisionTableProblems(root), [`${name}: Frozen Behavior is missing from the aligned table`]);
  writeFileSync(file, `# Session\n\n## Missing tests\n\n- DT-1 needs coverage\n\n| DT-1 | built without a test |\n\n## Frozen Behavior\n\n- DT-2\n\n${REVIEWED}## Final Alignment Status\n\nAligned\n`);
  assert.deepEqual(decisionTableProblems(root), []);
  writeFileSync(file, `# Session\n\n## Missing tests\n\n- DT-10 needs coverage\n\n| DT-1 | built without a test |\n\n## Frozen Behavior\n\n- DT-1\n\n${REVIEWED}## Final Alignment Status\n\nAligned\n`);
  assert.deepEqual(decisionTableProblems(root), [`${name}: DT-1 is built without a test and is absent from Missing tests`]);
});

test("AC-019 a stale decision table cannot hand off under an Aligned label", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "decision-table-stale-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const { decisionTable: file } = localPlanPaths(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const accepted = `# Session\n\n## Inputs\n\n- Ruling confirmed in review.\n\n## Evidence Artifacts\n\n| Claim | Evidence | Disposition |\n| --- | --- | --- |\n| DT-1 | Scenario uses the literal status \`pending\` | Covered |\n\n${REVIEWED}## Frozen Behavior\n\n- DT-1\n\n## Final Alignment Status\n\nAligned\n`;
  writeFileSync(file, accepted);
  assert.deepEqual(decisionTableProblems(root), []);
  for (const [change, expected] of [
    [accepted.replace("- Checked live callers.", "(append-only after implementation)"), /Verification Findings is empty/],
    [accepted.replace("- Checked competing inputs.", ""), /Adversarial Review is empty/],
    [accepted.replace("- None required by the review.", "(post-implementation)"), /Fixes Applied is empty/],
    [accepted.replace("| Covered |", "| pending |"), /pending evidence.*DT-1/],
    [accepted.replace("Ruling confirmed in review.", "Pending operator; later note records the operator's decision."), /pending ruling/],
    [`${accepted}\n## Final Alignment Status\n\nNot aligned\n`, /still Not aligned/],
    [`${accepted}\n### Continuation\n\n- Final Alignment Status for the continuation: Not aligned.\n`, /still Not aligned/],
    [`${accepted}\n### Resumed\n\n- Current conclusion for the resumed work is \`Not aligned\` pending review.\n`, /still Not aligned/],
    [`${accepted}\n### Final Alignment Status\n\nNot aligned\n`, /still Not aligned/],
  ]) {
    writeFileSync(file, change);
    assert.match(decisionTableProblems(root).join("\n"), expected);
  }
  const superseded = accepted.replace("## Frozen Behavior", "### Earlier\n\n- Final Alignment Status remains `Not aligned` until review.\n\n## Frozen Behavior");
  writeFileSync(file, superseded);
  assert.deepEqual(decisionTableProblems(root), [], "a Not aligned statement before the latest Aligned section is superseded");
  writeFileSync(file, `${accepted}\n## Notes\n\n| DT-9 | A later Final Alignment Status that says Not aligned holds the table. | Covered |\n`);
  assert.deepEqual(decisionTableProblems(root), [], "a table row that quotes the rule is not the table's status");
});
