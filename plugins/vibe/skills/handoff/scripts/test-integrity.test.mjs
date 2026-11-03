import assert from "node:assert/strict";
import test from "node:test";
import {
  testIntegrityCandidates,
  testIntegrityProblems,
  testIntegrityProofShapeProblems,
} from "./test-integrity.mjs";

const COMMIT = "a".repeat(40);

function changed(path, source, needles) {
  const lines = source.split("\n");
  return {
    file: { path, status: "M", hunks: [{ added: needles.map((needle) => {
      const index = lines.findIndex((line) => line.includes(needle));
      assert.notEqual(index, -1, `${needle} is present`);
      return { line: index + 1, text: lines[index] };
    }) }] },
    source,
  };
}

test("responsive, mocked-owner absence, premature absence, and count-only layout need failing mutations", () => {
  const fixtures = [
    changed(
      "packages/app/dialog.stories.tsx",
      [
        "export const Mobile: Story = {",
        '  globals: { viewport: { value: "mobile2" } },',
        "  play: async () => { await expect(button).toBeVisible(); },",
        "};",
      ].join("\n"),
      ["play: async"]
    ),
    changed(
      "packages/app/project-detail-page.test.tsx",
      [
        'vi.mock("./ProjectArtifactList", () => ({ ProjectArtifactList: () => null }));',
        'it("does not render the day filter", () => {',
        "  renderPage();",
        '  expect(screen.queryByRole("radiogroup")).toBeNull();',
        "});",
      ].join("\n"),
      ["queryByRole"]
    ),
    changed(
      "e2e/project-detail.spec.ts",
      [
        'test("does not show the day filter", async ({ page }) => {',
        "  await page.reload();",
        '  await expect(page.getByRole("radiogroup")).toHaveCount(0);',
        "});",
      ].join("\n"),
      ["toHaveCount(0)"]
    ),
    changed(
      "e2e/documents-summary-scope.spec.ts",
      [
        'test("shows one summary card", async ({ page }) => {',
        '  await expect(page.locator(\'[data-slot="card"]\')).toHaveCount(1);',
        "});",
      ].join("\n"),
      ["toHaveCount(1)"]
    ),
  ];
  const files = fixtures.map(({ file }) => file);
  const sources = new Map(fixtures.map(({ file, source }) => [file.path, source]));
  const read = path => sources.get(path) ?? null;
  const candidates = testIntegrityCandidates(files, read);

  assert.deepEqual(candidates.map(({ kind }) => kind).sort(), ["absence", "absence", "layout", "responsive"]);
  const missing = testIntegrityProblems({}, files, read, COMMIT).join("\n");
  for (const kind of ["responsive", "absence", "layout"]) assert.match(missing, new RegExp(`${kind}:`));

  const proofs = candidates.map((candidate) => ({
    candidate: candidate.id,
    path: candidate.path,
    case: candidate.case,
    class: candidate.kind,
    mutation: candidate.kind === "layout" ? "move the card outside the metric grid" : "break the asserted precondition",
    command: `pnpm vitest ${candidate.path}`,
    observedFailure: "the named assertion failed on the intentional regression",
    restoredPass: true,
    commit: COMMIT,
    ...(candidate.kind === "responsive"
      ? { viewportSource: "registered", desktopWidthMutation: "run the Mobile play at desktop width" }
      : {}),
    ...(candidate.kind === "absence"
      ? { ownerBoundary: "production", mountedSignal: "the production list owner is visible before the absence assertion" }
      : {}),
    ...(candidate.kind === "layout"
      ? { baseline: "Surfaces/Artifacts/Documents/Documents List", layoutAssertion: "the card is a child of the metric grid at its established width" }
      : {}),
  }));
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: proofs }, files, read, COMMIT), []);

  const mockedOwner = structuredClone(proofs);
  mockedOwner.find((proof) => proof.class === "absence").ownerBoundary = "mock";
  assert.match(testIntegrityProofShapeProblems({ testIntegrityProofs: mockedOwner }).join("\n"), /ownerBoundary: "production"/);
});
