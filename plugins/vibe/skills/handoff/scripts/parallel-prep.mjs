// Read-only and operational work the orchestrator dispatches while the sole
// product-source writer owns a requested pull-request turn.

import { parseArgs } from "node:util";

const PREP = Object.freeze([
  { id: "draft-targeted-inventory", agent: "vibe-verify-worker", timing: "now", kind: "read-only",
    purpose: "inventory the current diff now and add only its committed delta later" },
  { id: "prepare-e2e-runner", agent: "vibe-setup-worker", timing: "now", kind: "operational",
    purpose: "transport a fresh ref, install, bootstrap and prebuild without running final-SHA E2E" },
  { id: "run-stable-test-lanes", agent: "vibe-verify-worker", timing: "now", kind: "read-only",
    purpose: "run finished lanes and bind results to their SHA and covered-file hashes" },
  { id: "prepare-local-qa", agent: "vibe-setup-worker", timing: "writer-turn-ended", kind: "operational",
    purpose: "bring up the hidden local QA environment as soon as the writer stops" },
  { id: "draft-pr-evidence", agent: "vibe-environment-worker", timing: "now", kind: "read-only",
    purpose: "draft the PR body and targeted-test comment, filling results as they land" },
].map((entry) => Object.freeze({ ...entry, productSourceWrites: false })));

/** Prep dispatches for an otherwise idle orchestrator. */
export function idlePrepDispatches({ writerState, pullRequestRequested }) {
  return writerState === "running" && pullRequestRequested === true ? PREP.map((entry) => ({ ...entry })) : [];
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { "writer-state": { type: "string" }, "pull-request": { type: "boolean" } } });
  process.stdout.write(`${JSON.stringify({ dispatches: idlePrepDispatches({ writerState: values["writer-state"], pullRequestRequested: values["pull-request"] === true }) }, null, 2)}\n`);
}
