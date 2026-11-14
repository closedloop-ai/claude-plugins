// Read-only and operational work the orchestrator dispatches while the sole
// product-source writer owns a requested pull-request turn.

import { parseArgs } from "node:util";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");

const PREP = Object.freeze([
  { id: "draft-targeted-inventory", agent: "vibe-verify-worker", timing: "now", kind: "read-only",
    purpose: "inventory the current diff now and add only its committed delta later" },
  { id: "prepare-e2e-runner", agent: "vibe-setup-worker", timing: "now", kind: "operational",
    purpose: "transport a fresh ref, install, bootstrap and prebuild without running final-SHA E2E" },
  { id: "run-stable-test-lanes", agent: "vibe-verify-worker", timing: "now", kind: "read-only",
    purpose: "run finished lanes and bind results to their SHA and covered-file hashes" },
  // The command is the provider recipe's (`recipes.localQa`): an isolated control stack signed in the e2e org,
  // so its org lookup refused and the org picker hung for the person.
  { id: "prepare-local-qa", agent: "vibe-setup-worker", timing: "writer-turn-ended", kind: "operational",
    purpose: "bring up the hidden local QA environment as soon as the writer stops",
    readyCheck: "a page loads past the org picker, signed in as the seeded vibe user, before anyone hears it is ready" },
  { id: "draft-pr-evidence", agent: "vibe-environment-worker", timing: "now", kind: "read-only",
    purpose: "draft the PR body and targeted-test comment, filling results as they land" },
].map((entry) => Object.freeze({ ...entry, productSourceWrites: false })));

/** Prep dispatches for an otherwise idle orchestrator. */
export function idlePrepDispatches({ writerState, pullRequestRequested, localQa = providerDataOr(sessionBinding(), "recipes", "localQa", null) }) {
  if (writerState !== "running" || pullRequestRequested !== true) return [];
  return PREP.map((entry) => (entry.id === "prepare-local-qa" && localQa?.command ? { ...entry, command: localQa.command } : { ...entry }));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { "writer-state": { type: "string" }, "pull-request": { type: "boolean" } } });
  process.stdout.write(`${JSON.stringify({ dispatches: idlePrepDispatches({ writerState: values["writer-state"], pullRequestRequested: values["pull-request"] === true }) }, null, 2)}\n`);
}
