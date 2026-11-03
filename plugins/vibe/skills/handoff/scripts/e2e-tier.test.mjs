import assert from "node:assert/strict";
import test from "node:test";
import { NO_DISPLAYLESS_ELECTRON, selectE2eTier, specExecutionLimitation, tierEvidenceProblems } from "./e2e-tier.mjs";

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

test("container runtime readiness and spec execution prerequisites are separate", () => {
  const commit = "f".repeat(40);
  const capability = { selectedTier: "A", probedCommit: commit,
    container: { ...container, runnable: false, notRunnableReason: "CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY absent",
      secretsSet: { CLERK_SECRET_KEY: false, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: false, DEVOPS_CLOSEDLOOP_APP_PWD: true } },
    desktopHarness: { available: false, reason: NO_DISPLAYLESS_ELECTRON, probe: "macOS has no Linux Xvfb/dbus/keyring harness" },
    native: { available: false }, remote: { available: false } };
  assert.equal(selectE2eTier(capability).tier, "A");
  assert.deepEqual(specExecutionLimitation(capability, "e2e/org-issues-list.spec.ts", commit),
    { tier: "A", kind: "missing-prerequisites", missingPrerequisites: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] });
  assert.deepEqual(specExecutionLimitation(capability, "apps/desktop/test/e2e/issues-list.spec.ts", commit),
    { tier: "A", kind: "displayless", displaylessLimitation: NO_DISPLAYLESS_ELECTRON });
  assert.equal(specExecutionLimitation({ ...capability, probedCommit: "a".repeat(40) }, "e2e/org-issues-list.spec.ts", commit), null);
  assert.equal(specExecutionLimitation({ ...capability, container: { ...capability.container, runnable: true } }, "e2e/org-issues-list.spec.ts", commit), null);
});
