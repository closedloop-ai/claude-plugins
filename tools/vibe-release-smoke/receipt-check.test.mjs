import assert from "node:assert/strict";
import test from "node:test";
import { receiptProblem } from "./receipt-check.mjs";

const trees = { vibe: "aaa", "closedloop-core": "bbb" };
const receipt = { result: "pass", plugins: { vibe: { version: "1.1.13", tree: "aaa" }, "closedloop-core": { version: "1.5.3", tree: "bbb" } } };

test("a vibe change needs a passing receipt for exactly the trees being merged", () => {
  assert.equal(receiptProblem({ vibeChanged: true, receipt, trees }), null);
  assert.match(receiptProblem({ vibeChanged: true, receipt: null, trees }), /is missing/);
  assert.match(receiptProblem({ vibeChanged: true, receipt: { ...receipt, result: "fail" }, trees }), /passing smoke/);
  assert.match(receiptProblem({ vibeChanged: true, receipt, trees: { ...trees, vibe: "ccc" } }), /other plugins\/vibe contents/);
  assert.match(receiptProblem({ vibeChanged: true, receipt, trees: { ...trees, "closedloop-core": "ddd" } }), /other plugins\/closedloop-core contents/);
});

test("no vibe change needs no receipt", () => {
  assert.equal(receiptProblem({ vibeChanged: false, receipt: null, trees }), null);
});
