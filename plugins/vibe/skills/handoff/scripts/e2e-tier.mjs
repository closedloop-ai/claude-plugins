// Select and validate the local E2E execution tier recorded in
// vibe-pr-evidence.json. Repository-owned lane tooling supplies the probe;
// this module only applies its documented thresholds and operator override.

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
  return problems;
}
