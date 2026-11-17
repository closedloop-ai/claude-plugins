import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decisionTableProblems } from "./decision-table-gate.mjs";
import { localPlanPaths } from "../../vibe/scripts/local-plans.mjs";

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
  writeFileSync(file, "# Session\n\n## Acceptance Criteria\n\n- AC-1 met\n\n| DT-1 | built without a test |\n\n## Final Alignment Status\n\nNot aligned\n");
  assert.deepEqual(decisionTableProblems(root), [
    `${name}: Final Alignment Status is still Not aligned`,
    `${name}: DT-1 is built without a test and is absent from Missing tests`,
  ]);
  writeFileSync(file, "# Session\n\n## Missing tests\n\n- DT-1 needs coverage\n\n| DT-1 | built without a test |\n\n## Final Alignment Status\n\nAligned\n");
  assert.deepEqual(decisionTableProblems(root), [`${name}: Frozen Behavior is missing from the aligned table`]);
  writeFileSync(file, "# Session\n\n## Missing tests\n\n- DT-1 needs coverage\n\n| DT-1 | built without a test |\n\n## Frozen Behavior\n\n- DT-2\n\n## Final Alignment Status\n\nAligned\n");
  assert.deepEqual(decisionTableProblems(root), []);
  writeFileSync(file, "# Session\n\n## Missing tests\n\n- DT-10 needs coverage\n\n| DT-1 | built without a test |\n\n## Frozen Behavior\n\n- DT-1\n\n## Final Alignment Status\n\nAligned\n");
  assert.deepEqual(decisionTableProblems(root), [`${name}: DT-1 is built without a test and is absent from Missing tests`]);
});
