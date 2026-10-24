import assert from "node:assert/strict";
import test from "node:test";
import { idlePrepDispatches } from "./parallel-prep.mjs";

test("a running persistent writer dispatches every independent pre-PR prep lane", () => {
  const dispatches = idlePrepDispatches({ writerState: "running", pullRequestRequested: true });
  assert.deepEqual(dispatches.map((entry) => entry.id), [
    "draft-targeted-inventory",
    "prepare-e2e-runner",
    "run-stable-test-lanes",
    "prepare-local-qa",
    "draft-pr-evidence",
  ]);
  assert.ok(dispatches.every((entry) => entry.productSourceWrites === false));
  assert.ok(dispatches.every((entry) => entry.agent !== "vibe-change-worker"));
  assert.deepEqual(idlePrepDispatches({ writerState: "idle", pullRequestRequested: true }), []);
  assert.deepEqual(idlePrepDispatches({ writerState: "running", pullRequestRequested: false }), []);
});

test("human QA comes up with pnpm vibe up and is ready only past the org picker (ISS-13043)", () => {
  const qa = idlePrepDispatches({ writerState: "running", pullRequestRequested: true }).find((entry) => entry.id === "prepare-local-qa");
  assert.equal(qa.command, "pnpm vibe up");
  assert.match(qa.readyCheck, /past the org picker/);
});
