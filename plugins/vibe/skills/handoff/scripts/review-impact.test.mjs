import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { reusableReviewRoles, reusableRolesForImpact } from "./review-impact.mjs";
import { QaImpact } from "./qa-impact.mjs";
import { git, makeCheckout, makeHome } from "../../vibe/scripts/test-fixtures.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { sourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const roles = ["vibe-guardrails-reviewer", "vibe-adversarial-reviewer", "vibe-storybook-decomposer", "vibe-verify-worker"];

function scenario(t, changedFile, before, after, importers = []) {
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
  const request = { lastQa: { boundary }, evidence: { screens: [] }, graphImporters: { importers: [{ file: changedFile, importers }] },
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

  const commentsInSource = scenario(t, "src/commented.ts", "// before\nexport const value = 1;\n", "// after\nexport const value = 1;\n");
  assert.deepEqual([...reusableReviewRoles(commentsInSource.worktree, commentsInSource.receipts, commentsInSource.request)].sort(),
    ["vibe-adversarial-reviewer", "vibe-storybook-decomposer", "vibe-verify-worker"],
    "source-comment changes rerun guardrails so stale adjacent prose cannot carry");

  const storyFixture = scenario(t, "src/example-fixtures.ts", "export const count = 1;\n", "export const count = 2;\n",
    ["src/example.stories.tsx"]);
  assert.deepEqual([...reusableReviewRoles(storyFixture.worktree, storyFixture.receipts, storyFixture.request)], [],
    "a changed module imported by a story reruns Storybook review too");

  const lanesOnly = { outcome: QaImpact.LanesOnly, changedFiles: ["src/fixture.ts"] };
  assert.deepEqual([...reusableRolesForImpact(lanesOnly, null)], [],
    "missing importer evidence never carries Storybook review");
  assert.deepEqual([...reusableRolesForImpact(lanesOnly, {
    "src/fixture.ts": ["src/story-fixtures.ts"],
    "src/story-fixtures.ts": ["src/example.stories.tsx"],
  })], [], "transitive Storybook dependencies invalidate its review");
  assert.deepEqual([...reusableRolesForImpact(lanesOnly, { files: {
    "src/fixture.ts": ["src/example.stories.tsx"],
  } })], [], "the supported files importer shape invalidates Storybook review");
  assert.deepEqual([...reusableRolesForImpact(lanesOnly, [
    { file: "src/fixture.ts", importers: ["src/example.stories.tsx"] },
  ])], [], "the supported importer-array shape invalidates Storybook review");
  assert.deepEqual([...reusableRolesForImpact(lanesOnly, [
    { file: "src/fixture.ts" },
  ])], [], "an importer-array entry without an explicit importer list is incomplete evidence");
  assert.deepEqual([...reusableRolesForImpact(lanesOnly, [
    { file: "src/fixture.ts", importers: ["src/example.stories.tsx"] },
    { file: "src/fixture.ts", importers: [] },
  ])], [], "duplicate importer-array entries are incomplete instead of overwriting a story edge");
  assert.deepEqual([...reusableRolesForImpact({ outcome: QaImpact.LanesOnly, changedFiles: ["src/example.stories.ts"] }, {
    importers: { "src/example.stories.ts": [] },
  })], [], "a changed story seed invalidates its own Storybook review");

  const storyFilesShape = scenario(t, "src/files-fixture.ts", "export const count = 1;\n", "export const count = 2;\n");
  storyFilesShape.request.graphImporters = { files: {
    "src/files-fixture.ts": ["src/example.stories.tsx"],
  } };
  assert.deepEqual([...reusableReviewRoles(storyFilesShape.worktree, storyFilesShape.receipts, storyFilesShape.request)], [],
    "the full review-carry path keeps the supported files importer shape");
});
