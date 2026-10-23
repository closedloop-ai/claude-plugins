// Render the validated targeted-test artifact as the PR comment reviewers see.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { tierEvidenceProblems } from "./e2e-tier.mjs";
import { targetedEvidenceProblems } from "./pr-facts.mjs";

/** Render a reviewable comment only from complete pre-PR evidence. */
export function renderEvidenceComment(evidence) {
  const commit = evidence?.targetedInventory?.commit;
  const e2eSpecs = (evidence?.targetedInventory?.entries ?? []).filter((entry) => entry?.kind === "e2e").map((entry) => entry.path);
  const problems = [...targetedEvidenceProblems(evidence, commit), ...tierEvidenceProblems(evidence?.e2eCapability, e2eSpecs)];
  if (problems.length) throw new Error(`pre-PR evidence is incomplete:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  const capability = evidence.e2eCapability;
  const probe = capability.container;
  const lines = [
    "## Targeted pre-PR evidence",
    "",
    `Final committed diff: \`${commit}\``,
    `Inventory: read-only worker using \`${evidence.targetedInventory.laneReport.command}\``,
    `E2E tier: ${capability.selectedTier ?? "none"}`,
    `Capability probe: \`${probe.command}\` (Docker present ${probe.dockerPresent}, reachable ${probe.dockerReachable}, memory ${probe.memoryGiB}/${probe.minimumMemoryGiB} GiB, disk ${probe.diskGiB}/${probe.minimumDiskGiB} GiB)`,
    "",
    "| Kind | File and cases | Command | Result |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of evidence.targetedInventory.entries) {
    const run = (evidence.testRuns ?? []).find((candidate) => candidate.path === entry.path && candidate.command === entry.command && candidate.status === "passed");
    const result = run ? `passed at \`${run.commit}\`` : `not run locally, covered by CI`;
    lines.push(`| ${entry.kind} | \`${entry.path}\`: ${entry.cases.join(", ")} | \`${entry.command}\` | ${result} |`);
  }
  if (evidence.targetedInventory.laneReport.matches.length) {
    lines.push("", `Matching post-merge lanes: ${evidence.targetedInventory.laneReport.matches.map((lane) => `${lane.name}: \`${lane.command}\``).join("; ")}.`);
  }
  if ((capability.unavailableSpecs ?? []).length) lines.push("", `Left for CI: ${capability.unavailableSpecs.map((spec) => `\`${spec}\``).join(", ")} via ${(capability.ciCoverage ?? []).join(", ")}.`);
  if ((capability.notRunLocally ?? []).length) lines.push("", `Host-incompatible visual baselines left for CI: ${capability.notRunLocally.map((spec) => `\`${spec}\``).join(", ")}.`);
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { evidence: { type: "string" }, output: { type: "string" } } });
  if (!values.evidence || !values.output) throw new Error("--evidence and --output are required");
  writeFileSync(values.output, renderEvidenceComment(JSON.parse(readFileSync(values.evidence, "utf8"))));
}
