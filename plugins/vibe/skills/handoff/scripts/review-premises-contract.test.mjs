import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Rung 4 (advisory) text pins: these read agent, skill and source text and fail when a named
// sentence or identifier is removed, not when the behavior is, so a comment or usage string can
// keep them green. Structured premise validation is proved at rung 3 by review-premises.test.mjs
// and review-receipts.test.mjs, which call the code.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const read = file => readFileSync(path.join(root, file), "utf8");

test("rung 4 text pin: every vibe and fleet review surface carries the premise and relay contract", () => {
  for (const file of [
    "plugins/vibe/agents/vibe-adversarial-reviewer.md",
    "plugins/vibe/agents/vibe-guardrails-reviewer.md",
    "plugins/vibe/agents/vibe-verify-worker.md",
    "plugins/vibe/agents/vibe-storybook-decomposer.md",
    "plugins/vibe/skills/handoff/SKILL.md",
    "plugins/vibe/skills/fleet-orchestrator/SKILL.md",
    "plugins/vibe/skills/fleet-orchestrator/references/templates.md",
  ]) assert.match(read(file), /review-premises\.md|premise verification contract/, file);
  assert.match(read("tools/vibe-workers/src/claude-worker.ts"), /verify each material premise/);
  assert.match(read("plugins/vibe/skills/handoff/scripts/review-receipts.mjs"), /premiseProblems/);
  assert.match(read("plugins/vibe/skills/handoff/scripts/review-receipts.mjs"), /"vibe-verify-worker"/);
  assert.match(read("plugins/vibe/skills/handoff/scripts/review-receipts.mjs"), /managed Codex App Server thread/);
  assert.match(read("plugins/vibe/skills/fleet-orchestrator/scripts/helpers.mjs"), /--kind <kind> --brief <file> --worktree <dir>/);
  assert.match(read("plugins/vibe/skills/vibe/references/review-premises.md"), /Before endorsing or forwarding/);
});

test("rung 4 text pin: handoff and PR worker agree on repeated reviewer receipt inputs", () => {
  const handoff = read("plugins/vibe/skills/handoff/SKILL.md");
  const worker = read("plugins/vibe/agents/vibe-environment-worker.md");
  const gate = read("plugins/vibe/skills/handoff/scripts/handoff-gate.mjs");
  assert.match(handoff, /four receipts \(guardrails, adversarial, Storybook/);
  assert.match(worker, /--receipt <guardrails receipt> --receipt/);
  assert.match(gate, /receipt: \{ type: "string", multiple: true \}/);
  assert.doesNotMatch(worker, /--findings <review findings file>/);
});
