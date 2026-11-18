import assert from "node:assert/strict";
import test from "node:test";
import { isCollectedTestFile, isE2eTestSupport, isTestFile } from "./test-files.mjs";

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

test("ISS-13724: e2e test support is a non-spec module in a folder under a suite root, never the suite root's harness", () => {
  for (const file of ["e2e/helpers/cart.ts", "apps/widget/test/e2e/helpers/cart.ts", "e2e/perf/wall.perf.ts",
    "e2e-web-smoke/support/login.ts", "desktop-e2e/fixtures/seed.ts"]) {
    assert.equal(isE2eTestSupport(file), true, file);
  }
  // The suite root holds the harness, a spec is not support, and a snapshot is neither.
  for (const file of ["e2e/playwright.config.ts", "e2e/auth.setup.ts", "e2e/compose.yml",
    "e2e/checkout/cart.spec.ts", "e2e/checkout/__snapshots__/cart.spec.ts.snap", "src/widgets/cart.ts"]) {
    assert.equal(isE2eTestSupport(file), false, file);
  }
});
