// Render the validated targeted-test artifact as the PR comment reviewers see.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { prEvidenceValidationProblems } from "./pr-facts.mjs";
import { laneReportLabel } from "./ci-job-shape.mjs";
import { withStableSource } from "../../vibe/scripts/tested-head.mjs";

function tableCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r\n?|\n/g, "<br>");
}

/** Render a reviewable comment only from complete pre-PR evidence. */
export function renderEvidenceComment(evidence, worktree, options = {}) {
  return worktree ? withStableSource(worktree, current => ({ comment: renderValidatedComment(evidence, worktree, options, current.head) })).comment
    : renderValidatedComment(evidence, worktree, options, null);
}

function renderValidatedComment(evidence, worktree, options, publishedHead) {
  const commit = evidence?.targetedInventory?.commit;
  const problems = prEvidenceValidationProblems(evidence, commit, { ...options, worktree });
  if (problems.length) throw new Error(`pre-PR evidence is incomplete:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  const capability = evidence.e2eCapability;
  const probe = capability.container;
  const lines = [
    "## Targeted pre-PR evidence",
    "",
    `Published HEAD: ${publishedHead ? `\`${publishedHead}\`` : "unverified (no worktree)"}`,
    `Tested inventory commit: \`${commit}\``,
    `Inventory: read-only worker using \`${laneReportLabel(evidence.targetedInventory.laneReport)}\``,
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
  if ((evidence.testIntegrityProofs ?? []).length) {
    lines.push("", "## Test integrity mutations", "", "| Class | Test | Intentional regression | Observed result |", "| --- | --- | --- | --- |");
    for (const proof of evidence.testIntegrityProofs) {
      const failure = proof.class === "absence"
        ? `${proof.mutationRun.assertionFailure} (exit ${proof.mutationRun.exitCode})`
        : proof.observedFailure;
      lines.push(`| ${tableCell(proof.class)} | \`${tableCell(proof.path)}\`: ${tableCell(proof.case)} | ${tableCell(proof.mutation)} | ${tableCell(failure)}; passed after restore with \`${tableCell(proof.command)}\` at \`${tableCell(proof.commit)}\` |`);
    }
  }
  if ((capability.unavailableSpecs ?? []).length) lines.push("", `Left for CI: ${capability.unavailableSpecs.map((spec) => `\`${spec}\``).join(", ")} via ${(capability.ciCoverage ?? []).join(", ")}.`);
  if ((capability.notRunLocally ?? []).length) lines.push("", `Host-incompatible visual baselines left for CI: ${capability.notRunLocally.map((spec) => `\`${spec}\``).join(", ")}.`);
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { evidence: { type: "string" }, output: { type: "string" }, worktree: { type: "string" } } });
  if (!values.evidence || !values.output) throw new Error("--evidence and --output are required");
  writeFileSync(values.output, renderEvidenceComment(JSON.parse(readFileSync(values.evidence, "utf8")), values.worktree));
}
