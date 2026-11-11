import assert from "node:assert/strict";
import test, { after } from "node:test";
import { classifyHandoffPath, PathDisposition } from "./path-classifier.mjs";
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";

// Tracker checks run only with a tracker bound, so these run bound to the ClosedLoop provider (spawned scripts inherit it).
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
