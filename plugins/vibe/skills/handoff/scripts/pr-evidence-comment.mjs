// Render the validated targeted-test artifact as the PR comment reviewers see.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { tierEvidenceProblems } from "./e2e-tier.mjs";
import { targetedEvidenceProblems } from "./pr-facts.mjs";
import { testIntegrityProofShapeProblems } from "./test-integrity.mjs";
import { sameSource, sourceIdentity, validSourceIdentity } from "../../vibe/scripts/tested-head.mjs";

function tableCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r\n?|\n/g, "<br>");
}

/** Render verified evidence only for the owned worktree's current published source. */
export function renderEvidenceComment(evidence, worktree) {
  if (!worktree) throw new Error("pre-PR evidence comment needs the target worktree");
  if (execFileSync("git", ["-C", worktree, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim()) {
    throw new Error("pre-PR evidence comment needs a clean published worktree");
  }
  const current = sourceIdentity(worktree);
  const commit = current.head;
  const e2eSpecs = (Array.isArray(evidence?.targetedInventory?.entries) ? evidence.targetedInventory.entries : []).filter((entry) => entry?.kind === "e2e").map((entry) => entry.path);
  const problems = [
    ...(!validSourceIdentity(evidence?.source) || !sameSource(evidence.source, current) ? ["evidence source differs from the current published worktree"] : []),
    ...(evidence?.targetedInventory?.commit !== commit ? ["targeted inventory commit differs from the current published worktree"] : []),
    ...targetedEvidenceProblems(evidence, commit, worktree),
    ...tierEvidenceProblems(evidence?.e2eCapability, e2eSpecs),
    ...testIntegrityProofShapeProblems(evidence),
  ];
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
