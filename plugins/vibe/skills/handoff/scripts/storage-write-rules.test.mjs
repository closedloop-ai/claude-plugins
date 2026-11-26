import assert from "node:assert/strict";
import test from "node:test";
import { transactionBodies } from "./storage-write-rules.mjs";

// Moved unchanged from diff-rules.test.mjs with the rule module (GR11-B3); diff-rules.test.mjs keeps the rules'
// end-to-end cases through runDiffRules.
test("finds transaction bodies", () => {
  assert.deepEqual(transactionBodies("x\nwithDb.tx(async (tx) => {\n  a();\n});\n"), [[2, 4]]);
});
