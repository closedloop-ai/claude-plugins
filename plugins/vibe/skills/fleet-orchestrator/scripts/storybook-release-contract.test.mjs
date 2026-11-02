import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Rung 4 (advisory) prose pin: these assertions read skill text and fail only when the named
// sentences change, so they prove no runtime behavior. The repository's own story-rules CI gate
// enforces the release artifacts.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fleet = readFileSync(path.join(root, "fleet-orchestrator/SKILL.md"), "utf8");
const handoff = readFileSync(path.join(root, "handoff/SKILL.md"), "utf8");

test("rung 4 prose pin: Storybook release timing lets the PR story-rules lane pass before enqueue", () => {
  assert.match(fleet, /includes them in the reviewed pre-PR candidate/);
  assert.match(handoff, /Before the first commit, verify the bump, single release-history/);
  assert.doesNotMatch(fleet, /release-version bump .* made only at enqueue time/);
  assert.match(fleet, /settle a version-only conflict once at enqueue/);
});
