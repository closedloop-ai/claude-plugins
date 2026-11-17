import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { reusableReviewRoles } from "./review-impact.mjs";
import { git, makeCheckout, makeHome } from "../../vibe/scripts/test-fixtures.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { sourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const roles = ["vibe-guardrails-reviewer", "vibe-adversarial-reviewer", "vibe-storybook-decomposer", "vibe-verify-worker"];

function scenario(t, changedFile, before, after) {
  const fixture = makeHome("review-impact-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "repo");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout: worktree, files: {
    [changedFile]: before,
    "src/control.ts": "export const control = 1;\n",
  } });
  const boundary = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  const source = sourceIdentity(worktree);
  writeFileSync(path.join(worktree, changedFile), after);
  git(worktree, ["add", changedFile], fixture.home);
  git(worktree, ["commit", "--quiet", "-m", "later change"], fixture.home);
  const request = { lastQa: { boundary }, evidence: { screens: [] }, graphImporters: { importers: { [changedFile]: [] } },
    featureMap: { entries: [] }, laneSelections: { files: { [changedFile]: ["unit"] } }, config: { docs: [] } };
  return { worktree, source, request, receipts: roles.map((role) => ({ role, source })) };
}

test("ISS-14163 reuses only review domains that qa-impact proves unaffected", (t) => {
  const comments = scenario(t, "README.md", "before\n", "after\n");
  assert.deepEqual([...reusableReviewRoles(comments.worktree, comments.receipts, comments.request)].sort(), [...roles].sort(),
    "a safe root documentation delta reuses all reviews");

  const server = scenario(t, "src/service.ts", "export const value = 1;\n", "export const value = 2;\n");
  assert.deepEqual([...reusableReviewRoles(server.worktree, server.receipts, server.request)], ["vibe-storybook-decomposer"],
    "a non-visual source delta retains only the Storybook domain");

  const ui = scenario(t, "src/card.tsx", "export const card = 1;\n", "export const card = 2;\n");
  assert.deepEqual([...reusableReviewRoles(ui.worktree, ui.receipts, ui.request)], [],
    "a UI-capable delta reruns every review domain");

  const dirtyBaseline = server.receipts.map((receipt) => ({ ...receipt,
    source: { ...receipt.source, diffSha256: "f".repeat(64) } }));
  assert.deepEqual([...reusableReviewRoles(server.worktree, dirtyBaseline, server.request)], [],
    "an uncommitted review baseline is never reconstructed from its HEAD alone");
});
