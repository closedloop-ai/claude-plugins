import assert from "node:assert/strict";
import test from "node:test";
import { selectE2eTier, tierEvidenceProblems } from "./e2e-tier.mjs";

const container = {
  dockerPresent: true,
  dockerReachable: true,
  memoryGiB: 24,
  diskGiB: 80,
  minimumMemoryGiB: 20,
  minimumDiskGiB: 64,
  command: "pnpm prepush --all --probe",
};

test("tier selection prefers capable containers, then native, then a configured remote", () => {
  const base = { container, native: { available: true, forbidden: false }, remote: { available: true } };
  assert.equal(selectE2eTier(base).tier, "A");
  assert.equal(selectE2eTier({ ...base, container: { ...container, memoryGiB: 12 } }).tier, "B");
  assert.equal(selectE2eTier({ ...base, container: { ...container, dockerReachable: false }, native: { available: true, forbidden: true } }).tier, "C");
  assert.equal(selectE2eTier({ ...base, container: { ...container, dockerPresent: false }, native: { available: true, forbidden: true }, remote: { available: false } }).tier, null);
});

test("the evidence records the probe, selected tier and honest no-tier or native visual gaps", () => {
  const base = { container, native: { available: true, forbidden: false }, remote: { available: true }, selectedTier: "A" };
  assert.deepEqual(tierEvidenceProblems(base, ["e2e/sessions.spec.ts"]), []);
  const native = { ...base, container: { ...container, dockerReachable: false }, selectedTier: "B",
    native: { available: true, forbidden: false, headless: true, localStack: true, retries: 0, quarantineExcluded: true, sandboxIdentityNotRequired: "fixture" } };
  assert.match(tierEvidenceProblems(native, ["e2e/visual-regression.spec.ts"]).join(), /visual-regression.*covered by CI/);
  assert.deepEqual(tierEvidenceProblems({ ...native, notRunLocally: ["e2e/visual-regression.spec.ts"], ciCoverage: ["visual regression"] }, ["e2e/visual-regression.spec.ts"]), []);
  assert.deepEqual(tierEvidenceProblems({ ...base, container: { ...container, dockerPresent: false }, native: { available: true, forbidden: true, forbiddenSource: "git config vibe.noNativeE2e" }, remote: { available: false }, selectedTier: null, unavailableSpecs: ["e2e/sessions.spec.ts"], ciCoverage: ["Browser E2E"] }, ["e2e/sessions.spec.ts"]), []);
});
