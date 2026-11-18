import assert from "node:assert/strict";
import test, { after } from "node:test";
import { classifyHandoffPath, PathDisposition } from "./path-classifier.mjs";
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";

// Tracker checks run only with a tracker bound, so these run bound to the provider this repository ships (spawned scripts inherit it).
bindProviderInProcess(after);

const policy = {
  version: 1,
  allowedPrefixes: ["packages/app/"],
  allowedFiles: [],
  forbiddenPrefixes: [".github/"],
  forbiddenBasenames: ["AGENTS.md"],
  rootTests: true,
};
const classify = (path, status, phase = "build", extra = {}) => classifyHandoffPath({
  file: { path, status }, phase, policy, prototype: { owned: false, slug: null }, ...extra,
});

test("one classifier owns source, test-repair, pull-request test, and forbidden path decisions", () => {
  assert.deepEqual(classify("packages/app/page.tsx", "A"),
    { disposition: PathDisposition.Allowed, reason: "allowed-path" });
  assert.deepEqual(classify("packages/app/page.test.tsx", "A"),
    { disposition: PathDisposition.Outside, reason: "test-not-admitted" });
  assert.deepEqual(classify("packages/app/page.test.tsx", "M"),
    { disposition: PathDisposition.Allowed, reason: "test-repair" });
  assert.deepEqual(classify("packages/app/page.test.tsx", "A", "pull-request"),
    { disposition: PathDisposition.Allowed, reason: "pull-request-test" });
  assert.equal(classify(".github/workflows/release.yml", "A").disposition, PathDisposition.Forbidden);
});

test("owned prototype paths use the same portable checker decision as handoff", () => {
  const prototype = { owned: true, slug: "board-mockup" };
  const input = { file: { path: "apps/prototypes/scripts/check-catalog-imports.mjs", status: "M" },
    phase: "build", policy, prototype };
  assert.equal(classifyHandoffPath({ ...input, portableSurfaceAllowed: false }).disposition, PathDisposition.Outside);
  assert.equal(classifyHandoffPath({ ...input, portableSurfaceAllowed: true }).disposition, PathDisposition.Allowed);
  assert.equal(classifyHandoffPath({ ...input,
    file: { path: "apps/prototypes/app/p/board-mockup/page.tsx", status: "A" } }).disposition, PathDisposition.Allowed);
  assert.equal(classifyHandoffPath({ ...input,
    file: { path: "apps/prototypes/app/p/other/page.tsx", status: "A" } }).disposition, PathDisposition.Outside);
});

test("an e2e suite's support module is classified with the spec that imports it", () => {
  // Admitted together, in the phase the spec is admitted in: a suite's helper is reached only through its specs.
  assert.deepEqual(classify("e2e/checkout/cart.spec.ts", "A", "pull-request"),
    { disposition: PathDisposition.Allowed, reason: "pull-request-test" });
  assert.deepEqual(classify("e2e/checkout/helpers/cart-fixture.ts", "A", "pull-request"),
    { disposition: PathDisposition.Allowed, reason: "pull-request-test" });
  assert.deepEqual(classify("apps/widget/test/e2e/helpers/cart-fixture.ts", "A", "pull-request"),
    { disposition: PathDisposition.Allowed, reason: "pull-request-test" });
  // And refused together outside it, so one phase cannot admit a helper whose spec it would reject.
  assert.deepEqual(classify("e2e/checkout/cart.spec.ts", "A"),
    { disposition: PathDisposition.Outside, reason: "test-not-admitted" });
  assert.deepEqual(classify("e2e/checkout/helpers/cart-fixture.ts", "A"),
    { disposition: PathDisposition.Outside, reason: "test-not-admitted" });
});

test("support is read from the e2e suite root, and neither outranks a forbidden prefix nor covers snapshots", () => {
  // A module outside every e2e suite root is the session's source, admitted only by an allowed prefix.
  assert.deepEqual(classify("src/widgets/cart-fixture.ts", "A", "pull-request"),
    { disposition: PathDisposition.Outside, reason: "outside-allowed" });
  assert.equal(classify(".github/e2e/helpers/cart-fixture.ts", "A", "pull-request").disposition,
    PathDisposition.Forbidden);
  // A snapshot is not support, so it stays out of the pull-request admission a helper now gets.
  assert.deepEqual(classify("e2e/checkout/__snapshots__/cart.spec.ts.snap", "A", "pull-request"),
    { disposition: PathDisposition.Outside, reason: "test-not-admitted" });
  // The suite root holds the harness, so a file sitting in it is never support, edited or added.
  assert.deepEqual(classify("e2e/playwright.config.ts", "M"),
    { disposition: PathDisposition.Outside, reason: "outside-allowed" });
  assert.deepEqual(classify("e2e/auth.setup.ts", "A", "pull-request"),
    { disposition: PathDisposition.Outside, reason: "outside-allowed" });
});
