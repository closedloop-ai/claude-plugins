// Select and validate the local E2E execution tier recorded in
// vibe-pr-evidence.json. Repository-owned lane tooling supplies the probe;
// this module only applies its documented thresholds and operator override.

// symphony-alpha e2e/CONTAINERIZED.md and run-containerized.sh require these
// three authenticated E2E inputs. LIVEBLOCKS_SECRET is optional there.
export const REQUIRED_CONTAINER_IDENTITY = Object.freeze([
  "CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "DEVOPS_CLOSEDLOOP_APP_PWD",
]);
export const NO_DISPLAYLESS_ELECTRON = "no supported displayless Linux Electron harness";

/** Return the strongest available E2E tier, or null when CI must cover it. */
export function selectE2eTier(capability = {}) {
  const container = capability.container ?? {};
  const finite = (...values) => values.every(Number.isFinite);
  const containerReady = container.dockerPresent === true && container.dockerReachable === true
    && finite(container.memoryGiB, container.diskGiB, container.minimumMemoryGiB, container.minimumDiskGiB)
    && container.memoryGiB >= container.minimumMemoryGiB && container.diskGiB >= container.minimumDiskGiB;
  if (containerReady) return { tier: "A", reason: "the repository capability probe passed" };
  if (capability.native?.available === true && capability.native?.forbidden !== true) {
    return { tier: "B", reason: "the container probe failed and native headless E2E is allowed" };
  }
  if (capability.remote?.available === true) return { tier: "C", reason: "a configured remote runner is available" };
  return { tier: null, reason: "no permitted local or remote E2E tier is available" };
}

/**
 * Why one spec cannot execute on the selected runtime tier. Runtime presence
 * (Docker, memory and disk) is distinct from the secrets or display harness
 * that an authenticated scenario consumes. Returns null when execution is
 * possible or the claimed limitation has no complete probe evidence.
 */
export function specExecutionLimitation(capability, spec, commit) {
  if (!capability || capability.selectedTier !== selectE2eTier(capability).tier) return null;
  if (capability.selectedTier === null) return { tier: null, kind: "no-tier" };
  if (capability.selectedTier !== "A" || capability.probedCommit !== commit
    || typeof capability.container?.command !== "string" || !capability.container.command.trim()) return null;
  if (spec.startsWith("apps/desktop/") && capability.desktopHarness?.available === false
    && capability.desktopHarness.reason === NO_DISPLAYLESS_ELECTRON
    && typeof capability.desktopHarness.probe === "string" && capability.desktopHarness.probe.trim()) {
    return { tier: "A", kind: "displayless", displaylessLimitation: NO_DISPLAYLESS_ELECTRON };
  }
  const container = capability.container;
  const secrets = container?.secretsSet;
  if (container?.runnable !== false || !secrets || !REQUIRED_CONTAINER_IDENTITY.every((key) => typeof secrets[key] === "boolean")) return null;
  const missingPrerequisites = REQUIRED_CONTAINER_IDENTITY.filter((key) => secrets[key] === false);
  if (missingPrerequisites.length === 0 || typeof container.notRunnableReason !== "string"
    || !missingPrerequisites.every((key) => container.notRunnableReason.includes(key))) return null;
  return { tier: "A", kind: "missing-prerequisites", missingPrerequisites };
}

/** Problems in the recorded capability probe and chosen tier. */
export function tierEvidenceProblems(capability, e2eSpecs = []) {
  if (!capability || typeof capability !== "object") return ["E2E capability probe and tier are missing"];
  const problems = [];
  const container = capability.container ?? {};
  for (const key of ["dockerPresent", "dockerReachable", "memoryGiB", "diskGiB", "minimumMemoryGiB", "minimumDiskGiB", "command"]) {
    if (container[key] === undefined || container[key] === "") problems.push(`E2E container probe is missing ${key}`);
  }
  const expected = selectE2eTier(capability).tier;
  if ((capability.selectedTier ?? null) !== expected) {
    problems.push(`E2E tier ${capability.selectedTier ?? "none"} does not match selected tier ${expected ?? "none"}`);
  }
  if (expected === "B") {
    if (capability.native?.headless !== true || capability.native?.localStack !== true) problems.push("native E2E must be headless against the local stack");
    if (capability.native?.retries !== 0) problems.push("native E2E must run with retries off");
    if (capability.native?.quarantineExcluded !== true) problems.push("native E2E must record the CI quarantine exclusion");
    if (!capability.native?.sandboxIdentity && !capability.native?.sandboxIdentityNotRequired) {
      problems.push("native E2E must name the CI sandbox identity or why the repository needs none");
    }
    const visual = e2eSpecs.filter((spec) => /visual[-_.]?regression|screenshots?/i.test(spec));
    const held = new Set(capability.notRunLocally ?? []);
    for (const spec of visual.filter((spec) => !held.has(spec))) {
      problems.push(`${spec}: visual-regression coverage must be listed as not run locally, covered by CI`);
    }
    if (visual.length > 0 && (!Array.isArray(capability.ciCoverage) || capability.ciCoverage.length === 0)) problems.push("native visual-regression gaps need the CI job that covers them");
  }
  if (capability.native?.forbidden === true && !capability.native?.forbiddenSource) problems.push("the native E2E operator override needs its configured source");
  if (expected === "C" && !capability.remote?.command) problems.push("remote E2E tier needs its configured runner command");
  if (expected === null && e2eSpecs.length > 0) {
    const unavailable = new Set(capability.unavailableSpecs ?? []);
    for (const spec of e2eSpecs.filter((spec) => !unavailable.has(spec))) problems.push(`${spec}: unavailable E2E spec is not left explicitly for CI`);
    if (!Array.isArray(capability.ciCoverage) || capability.ciCoverage.length === 0) problems.push("unavailable E2E needs the CI jobs that cover it");
  }
  if (expected === "A" && Array.isArray(capability.unavailableSpecs)) {
    for (const spec of e2eSpecs.filter((file) => capability.unavailableSpecs.includes(file))) {
      if (!specExecutionLimitation(capability, spec, capability.probedCommit)) {
        problems.push(`${spec}: Tier A is selected but no exact prerequisite or displayless limitation proves it cannot run`);
      }
    }
  }
  return problems;
}
