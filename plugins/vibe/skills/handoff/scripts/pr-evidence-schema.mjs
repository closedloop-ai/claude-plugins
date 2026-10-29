// Canonical selection shape shared by the PR facts and comment gates. The
// verifier writes this evidence; neither consumer may reinterpret a path-only
// object as exact test coverage.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const TEST_SELECTORS = Object.freeze(["code_tests_for", "related", "e2e-reference"]);

/**
 * Read canonical per-source test selections without discarding malformed
 * evidence. Every problem blocks the PR, even when valid sibling rows remain.
 * A `code_tests_for` null list means the graph did not establish coverage and
 * requires a separate `related` row for that file.
 */
export function readTestSelection(evidence) {
  if (!Array.isArray(evidence?.testSelection)) {
    return { entries: [], problems: ["testSelection must be an array of {file, selector, tests} entries; rerun the verifier. A codeTestsFor object with basename tests cannot prove exact selected paths"] };
  }
  const problems = [];
  const entries = [];
  for (const [index, entry] of evidence.testSelection.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.file !== "string" || !entry.file.trim()) {
      problems.push(`testSelection entry ${index} needs a repo-relative file path`);
      continue;
    }
    if (!TEST_SELECTORS.includes(entry.selector)) {
      problems.push(`testSelection entry for ${entry.file} has selector ${JSON.stringify(entry.selector)}; use one of ${TEST_SELECTORS.join(", ")}`);
      continue;
    }
    if (!(Array.isArray(entry.tests) && entry.tests.every((test) => typeof test === "string" && test.trim()))
      && !(entry.selector === "code_tests_for" && entry.tests === null)) {
      problems.push(`testSelection entry for ${entry.file}: tests must be an array of exact repo-relative paths${entry.selector === "code_tests_for" ? " or null when the graph found none" : ""}`);
      continue;
    }
    entries.push(entry);
  }
  return { entries, problems };
}

/**
 * The current unversioned PR evidence document's required structural shape.
 * The Part B path-only object is not a documented older version: it lacks the
 * cases, commands, lane report and full test paths needed for safe conversion.
 */
export function prEvidenceShapeProblems(evidence) {
  const problems = [...readTestSelection(evidence).problems];
  const inventory = evidence?.targetedInventory;
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    problems.push("targeted inventory of the final committed diff is missing");
  } else {
    if (inventory.actor !== "read-only" || inventory.source !== "final-committed-diff" || !/^[a-f0-9]{40}$/.test(inventory.commit ?? "")) {
      problems.push("targetedInventory must identify a read-only actor, the final committed diff and its full commit SHA");
    }
    if (evidence?.qaImpact !== undefined
      && (!/^[a-f0-9]{16}$/.test(evidence.qaImpact?.laneKey ?? "") || inventory.impactKey !== evidence.qaImpact.laneKey)) {
      problems.push("targetedInventory must name qaImpact.laneKey as its changed-file scope");
    }
    if (inventory.laneReport?.command !== "pnpm test:lanes" || !Array.isArray(inventory.laneReport?.matches)) {
      problems.push("targetedInventory.laneReport needs pnpm test:lanes and exact matching lane commands");
    }
    if (!Array.isArray(inventory.entries) || (inventory.entries.length === 0 && !inventory.noTestsReason)) {
      problems.push("targetedInventory needs exact entries with paths, cases and commands, or a noTestsReason");
    } else for (const [index, entry] of inventory.entries.entries()) {
      if (!entry?.kind || !entry?.path || !entry?.command || !Array.isArray(entry?.cases) || entry.cases.length === 0) {
        problems.push(`targetedInventory entry ${index} needs kind, exact path, cases and command`);
      }
      if (entry?.coveredFiles !== undefined && !Array.isArray(entry.coveredFiles)) {
        problems.push(`targetedInventory entry ${index} coveredFiles must be an array`);
      }
    }
  }
  if (!Array.isArray(evidence?.testRuns)) problems.push("testRuns must be an array of exact runs");
  if (!Array.isArray(evidence?.rerunCycles)) problems.push("rerunCycles must record isolated reruns, or [] when none failed");
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { file: { type: "string" } } });
  if (!values.file) throw new Error("Usage: pr-evidence-schema.mjs --file <private vibe-pr-evidence.json>");
  const problems = prEvidenceShapeProblems(JSON.parse(readFileSync(values.file, "utf8")));
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems })}\n`);
  if (problems.length) process.exitCode = 1;
}
