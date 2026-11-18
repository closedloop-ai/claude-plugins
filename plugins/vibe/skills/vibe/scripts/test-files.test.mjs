import assert from "node:assert/strict";
import test from "node:test";
import { isCollectedTestFile, isTestFile } from "./test-files.mjs";

test("ISS-14136 AC-1: a collected test file is a node or vitest spec or a pytest module, never a support file or a plain module", () => {
  for (const file of ["checks/contract.test.mjs", "src/a.spec.ts", "tools/python/test_contract.py", "pkg/contract_test.py"]) {
    assert.equal(isCollectedTestFile(file), true, file);
  }
  for (const file of ["checks/contract.mjs", "evals/codex/run.py", "src/fixtures/data.mjs", "src/__snapshots__/a.snap", "tests/helpers.py"]) {
    assert.equal(isCollectedTestFile(file), false, file);
  }
  // isTestFile keeps its wider meaning (support folders and snapshots count) for its other callers.
  assert.equal(isTestFile("src/fixtures/data.mjs"), true);
});
