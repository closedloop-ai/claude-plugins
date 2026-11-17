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
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.md");
  writeFileSync(file, "# Session\n\n## Acceptance Criteria\n\n- AC-1 met\n\n| DT-1 | built without a test |\n\n## Final Alignment Status\n\nNot aligned\n");
  assert.deepEqual(decisionTableProblems(root), [
    "session.md: Final Alignment Status is still Not aligned",
    "session.md: DT-1 is built without a test and is absent from Missing tests",
  ]);
  writeFileSync(file, "# Session\n\n## Missing tests\n\n- DT-1 needs coverage\n\n| DT-1 | built without a test |\n\n## Final Alignment Status\n\nAligned\n");
  assert.deepEqual(decisionTableProblems(root), ["session.md: Frozen Behavior is missing from the aligned table"]);
  writeFileSync(file, "# Session\n\n## Missing tests\n\n- DT-1 needs coverage\n\n| DT-1 | built without a test |\n\n## Frozen Behavior\n\n- DT-2\n\n## Final Alignment Status\n\nAligned\n");
  assert.deepEqual(decisionTableProblems(root), []);
});
