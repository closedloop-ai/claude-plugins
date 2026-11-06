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
      ? { ownerBoundary: "production", mountedSignal: "the production list owner is visible before the absence assertion",
        presentState: "the asserted element is present inside the production owner",
        assertionLine: candidate.assertionLine,
        assertionLocation: candidate.assertionLocation,
        mutationRun: { command: `pnpm vitest ${candidate.path}`, exitCode: 1,
          assertionFailure: `AssertionError: absence assertion failed at ${candidate.assertionLocation}` } }
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

test("responsive candidates ignore reviewer wording but retain mobile cases and viewport setup", () => {
  const fixtures = [
    changed("review-summary.test.ts", [
      'test("describes the review", () => {',
      '  expect(summary).toContain("use a narrower scope");',
      "});",
    ].join("\n"), ["narrower"]),
    changed("mobile-layout.test.ts", [
      'test("mobile layout", () => {',
      '  expect(panel).toBeVisible();',
      "});",
    ].join("\n"), ["toBeVisible"]),
    changed("viewport-layout.test.ts", [
      'test("layout at the breakpoint", async ({ page }) => {',
      '  await page.setViewportSize({ width: 390, height: 844 });',
      "});",
    ].join("\n"), ["setViewportSize"]),
  ];
  const sources = new Map(fixtures.map(({ file, source }) => [file.path, source]));
  const candidates = testIntegrityCandidates(fixtures.map(({ file }) => file), (file) => sources.get(file));
  assert.deepEqual(candidates.filter(({ kind }) => kind === "responsive").map(({ path }) => path).sort(),
    ["mobile-layout.test.ts", "viewport-layout.test.ts"]);
  const meta = changed("plugins/vibe/skills/handoff/scripts/test-integrity.test.mjs", [
    'test("mobile viewport classifier fixture", () => {',
    '  const source = "await page.setViewportSize({ width: 390 })";',
    "});",
  ].join("\n"), ["setViewportSize"]);
  assert.deepEqual(testIntegrityCandidates([meta.file], () => meta.source), [],
    "the checker's synthetic source is not an executable responsive boundary");
});

test("lower-camel and Pascal responsive story plays require proof, while NarrowerLayout does not", () => {
  const fixtures = ["mobileCard", "narrowLayout", "MobileCard", "NarrowLayout", "NarrowerLayout"].map((name) => changed(
    `packages/app/${name}.stories.tsx`, [
      `export const ${name}: Story = {`,
      "  play: async () => { await expect(card).toBeVisible(); },",
      "};",
    ].join("\n"), ["play: async"]));
  const sources = new Map(fixtures.map(({ file, source }) => [file.path, source]));
  const files = fixtures.map(({ file }) => file);
  const read = (file) => sources.get(file) ?? null;
  const missing = testIntegrityProblems({ testIntegrityProofs: [] }, files, read, COMMIT).join("\n");
  assert.match(missing, /responsive:packages\/app\/mobileCard\.stories\.tsx/);
  assert.match(missing, /responsive:packages\/app\/narrowLayout\.stories\.tsx/);
  assert.match(missing, /responsive:packages\/app\/MobileCard\.stories\.tsx/);
  assert.match(missing, /responsive:packages\/app\/NarrowLayout\.stories\.tsx/);
  assert.doesNotMatch(missing, /NarrowerLayout/);
});

test("responsive setup ignores quoted and commented tokens but keeps executable calls and assertions", () => {
  const fixture = (name, body, needle) => changed(`packages/app/${name}.test.tsx`, [
    'test("reviews the layout", async ({ page }) => {',
    ...body,
    "});",
  ].join("\n"), [needle]);
  const fixtures = [
    fixture("quoted", ['  const note = "page.setViewportSize({ width: 390 })";'], "setViewportSize"),
    fixture("quoted-breakpoint", ['  const note = "expect(panel).toHaveClass(\'md:hidden\')";'], "toHaveClass"),
    fixture("line-comment", ["  // await page.setViewportSize({ width: 390 });"], "setViewportSize"),
    fixture("block-comment", ["  /*", "  await page.setViewportSize({ width: 390 });", "  */"], "setViewportSize"),
    fixture("commented-assertion", ['  expect(enabled).toBe(true); // expect(panel).toHaveClass("md:hidden");'], "toHaveClass"),
    fixture("real-viewport", ["  await page.setViewportSize({ width: 390, height: 844 });"], "setViewportSize"),
    fixture("real-breakpoint", ['  expect(panel).toHaveClass("md:hidden");'], "toHaveClass"),
  ];
  const sources = new Map(fixtures.map(({ file, source }) => [file.path, source]));
  const candidates = testIntegrityCandidates(fixtures.map(({ file }) => file), (file) => sources.get(file));
  assert.deepEqual(candidates.filter(({ kind }) => kind === "responsive").map(({ path }) => path).sort(),
    ["packages/app/real-breakpoint.test.tsx", "packages/app/real-viewport.test.tsx"]);
  for (const name of ["quoted", "quoted-breakpoint", "line-comment", "block-comment", "commented-assertion"]) {
    const item = fixtures.find(({ file }) => file.path === `packages/app/${name}.test.tsx`);
    assert.deepEqual(testIntegrityProblems({}, [item.file], () => item.source, COMMIT), [], name);
  }
});

test("responsive test names accept spaced and camel tokens but not ordinary narrower wording", () => {
  const cases = [
    ["mobile card", true],
    ["isMobileCard visible", true],
    ["narrow layout", true],
    ["narrower layout", false],
  ];
  for (const [name, expected] of cases) {
    const fixture = changed(`packages/app/${name.replace(/\W+/g, "-")}.test.tsx`, [
      `test("${name}", () => {`,
      "  expect(card).toBeVisible();",
      "});",
    ].join("\n"), ["toBeVisible"]);
    const candidates = testIntegrityCandidates([fixture.file], () => fixture.source);
    assert.equal(candidates.some(({ kind }) => kind === "responsive"), expected, name);
  }
});

test("AC-4 absence assertions reject missing or unrun proof and accept an executed failure", () => {
  const fixture = changed(
    "apps/desktop/test/e2e/branches-page.spec.ts",
    [
      'test("range readout is absent in the asserted pager state", async ({ page }) => {',
      '  const pager = page.locator(\'nav[aria-label="pagination"]\');',
      '  await expect(pager.getByRole("status")).toHaveCount(0);',
      "});",
    ].join("\n"),
    ["toHaveCount(0)"],
  );
  const files = [fixture.file];
  const read = path => path === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates(files, read);
  assert.equal(candidate.kind, "absence");
  assert.match(testIntegrityProblems({}, files, read, COMMIT).join("\n"), /needs exactly one failing-mutation proof/);

  const proof = {
    candidate: candidate.id,
    path: candidate.path,
    case: candidate.case,
    class: "absence",
    mutation: "render the range readout inside the pagination nav in the asserted state",
    presentState: "the range readout is visible inside the pagination nav",
    assertionLine: candidate.assertionLine,
    assertionLocation: candidate.assertionLocation,
    command: "pnpm test:desktop-e2e branches-page.spec.ts",
    observedFailure: "the status count was 1 instead of 0",
    ownerBoundary: "production",
    mountedSignal: "the production pagination footer is mounted",
    restoredPass: true,
    commit: COMMIT,
  };
  assert.match(testIntegrityProblems({ testIntegrityProofs: [proof] }, files, read, COMMIT).join("\n"), /mutation run/);
  const executed = {
    ...proof,
    mutationRun: {
      command: proof.command,
      exitCode: 1,
      assertionFailure: `AssertionError: expect(pager.getByRole("status")).toHaveCount(0) failed at ${proof.assertionLocation}; Expected count: 0; Received count: 1`,
    },
  };
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [executed] }, files, read, COMMIT), []);
  for (const mutationRun of [
    { command: proof.command, exitCode: 0, assertionFailure: "no assertion failed" },
    { command: "a different test", exitCode: 1, assertionFailure: "the status count was 1" },
    { command: proof.command, exitCode: 1, assertionFailure: "" },
  ]) {
    assert.match(testIntegrityProblems({ testIntegrityProofs: [{ ...executed, mutationRun }] }, files, read, COMMIT).join("\n"), /mutation run/);
  }
  assert.match(testIntegrityProblems({ testIntegrityProofs: [{ ...executed, assertionLine: "another assertion" }] }, files, read, COMMIT).join("\n"), /assertionLine must match/);
  assert.match(testIntegrityProblems({ testIntegrityProofs: [{ ...executed, presentState: "" }] }, files, read, COMMIT).join("\n"), /presentState/);
  assert.match(testIntegrityProofShapeProblems({ testIntegrityProofs: [{ ...executed,
    assertionLocation: "unrelated.spec.ts:99" }] }).join("\n"), /assertionLocation must name the candidate path, line and column/);
  const setupCrash = { ...executed, observedFailure: "setup crashed",
    mutationRun: { command: proof.command, exitCode: 1,
      assertionFailure: "TypeError: Cannot read properties of undefined" } };
  assert.match(testIntegrityProblems({ testIntegrityProofs: [setupCrash] }, files, read, COMMIT).join("\n"), /exact assertion failure/);
  const wrongAssertion = { ...executed,
    mutationRun: { command: proof.command, exitCode: 1,
      assertionFailure: 'AssertionError: expect(other).toHaveCount(1) failed at unrelated.spec.ts:99:1; Expected count: 1; Received count: 0' } };
  assert.match(testIntegrityProblems({ testIntegrityProofs: [wrongAssertion] }, files, read, COMMIT).join("\n"), /exact assertion failure/);
  const unrelatedStack = { ...executed,
    mutationRun: { command: proof.command, exitCode: 1,
      assertionFailure: `AssertionError: expect(other).toHaveCount(1) failed at unrelated.spec.ts:9:1; Expected count: 1; Received count: 0\n at ${proof.assertionLocation}` } };
  assert.match(testIntegrityProblems({ testIntegrityProofs: [unrelatedStack] }, files, read, COMMIT).join("\n"), /primary assertion location/);
  const uiTextTypeError = { ...executed,
    mutationRun: { command: proof.command, exitCode: 1,
      assertionFailure: `AssertionError: expect(pager).toHaveCount(0) failed at ${proof.assertionLocation}; Expected null, received element with text TypeError` } };
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [uiTextTypeError] }, files, read, COMMIT), []);
});

test("AC-2 changed hidden and detached assertions are absence candidates", () => {
  const fixtures = [
    changed("src/hidden.test.tsx", 'test("hidden", () => { expect(screen.getByRole("status")).toBeHidden(); });', ["toBeHidden"]),
    changed("src/detached.spec.ts", 'test("detached", async () => { await expect(page.getByRole("status")).not.toBeAttached(); });', ["toBeAttached"]),
  ];
  const read = path => fixtures.find(({ file }) => file.path === path)?.source ?? null;
  assert.deepEqual(testIntegrityCandidates(fixtures.map(({ file }) => file), read).map(({ kind }) => kind), ["absence", "absence"]);
});

test("AC-2 changing only the locator in a multiline absence assertion still needs proof", () => {
  const fixture = changed("e2e/branches-page.spec.ts", [
    'test("range readout is absent", async ({ page }) => {',
    "  await expect(",
    '    pager.getByRole("status")',
    "  ).toHaveCount(0);",
    "});",
  ].join("\n"), ['pager.getByRole("status")']);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "absence");
});

test("AC-2 a newly added multiline absence assertion needs one proof", () => {
  const fixture = changed("e2e/branches-page.spec.ts", [
    'test("range readout is absent", async ({ page }) => {',
    "  await expect(",
    '    pager.getByRole("status")',
    "  ).toHaveCount(0);",
    "});",
  ].join("\n"), ["await expect(", 'pager.getByRole("status")', "toHaveCount(0)"]);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].line, 2);
});

test("AC-2 two absence assertions on one changed line each need their own proof", () => {
  const fixture = changed("src/controls.test.tsx", [
    'test("no stale controls", () => { expect(screen.queryByText("stale A")).toBeNull(); expect(screen.queryByText("stale B")).toBeNull(); });',
  ].join("\n"), ["no stale controls"]);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0].id, candidates[1].id);
  assert.match(candidates[0].assertionLine, /stale A/);
  assert.doesNotMatch(candidates[0].assertionLine, /stale B/);
  assert.match(candidates[1].assertionLine, /stale B/);
  const first = candidates[0];
  const command = "pnpm vitest src/controls.test.tsx";
  const proof = { candidate: first.id, path: first.path, case: first.case, class: "absence",
    mutation: "render stale A in the asserted controls", presentState: "stale A is present",
    assertionLine: first.assertionLine, assertionLocation: first.assertionLocation,
    command, observedFailure: "stale A assertion failed", restoredPass: true, commit: COMMIT,
    ownerBoundary: "production", mountedSignal: "controls owner mounted",
    mutationRun: { command, exitCode: 1,
      assertionFailure: `AssertionError: expect(queryByText).toBeNull failed at ${first.assertionLocation}` } };
  assert.match(testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file],
    path => path === fixture.file.path ? fixture.source : null, COMMIT).join("\n"), /:2: needs exactly one failing-mutation proof/);
  const second = candidates[1];
  const secondProof = { ...proof, candidate: second.id, case: second.case,
    mutation: "render stale B in the asserted controls", presentState: "stale B is present",
    assertionLine: second.assertionLine, assertionLocation: second.assertionLocation,
    mutationRun: { command, exitCode: 1,
      assertionFailure: `AssertionError: expect(queryByText).toBeNull failed at ${second.assertionLocation}` } };
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [proof, secondProof] }, [fixture.file],
    path => path === fixture.file.path ? fixture.source : null, COMMIT), []);
  assert.match(testIntegrityProofShapeProblems({ testIntegrityProofs: [{ ...secondProof,
    assertionLocation: `${second.path}:${second.line}` }] }).join("\n"), /path, line and column/);
});

test("AC-2 an earlier positive assertion on the same line cannot satisfy absence proof", () => {
  const fixture = changed("src/controls.test.tsx", [
    'test("no stale controls", () => { expect(ready).toBe(true); expect(screen.queryByText("stale")).toBeNull(); });',
  ].join("\n"), ["no stale controls"]);
  const read = path => path === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  assert.equal(candidate.kind, "absence");
  const command = "pnpm vitest src/controls.test.tsx";
  const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
    mutation: "render stale in the asserted controls", presentState: "stale is present",
    assertionLine: candidate.assertionLine, assertionLocation: candidate.assertionLocation,
    command, observedFailure: "a same-line assertion failed", restoredPass: true, commit: COMMIT,
    ownerBoundary: "production", mountedSignal: "controls owner mounted",
    mutationRun: { command, exitCode: 1,
      assertionFailure: `AssertionError: expect(ready).toBe(true) failed at ${candidate.path}:${candidate.line}:1` } };
  assert.match(testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file], read, COMMIT).join("\n"), /primary assertion location/);
});

test("AC-2 a changed locator deep inside a multiline absence assertion needs proof", () => {
  const fixture = changed("e2e/branches-page.spec.ts", [
    'test("range readout is absent", async ({ page }) => {',
    "  await expect(",
    "    page",
    '      .locator("main")',
    '      .locator("section")',
    '      .locator("article")',
    '      .locator("footer")',
    '      .locator("div")',
    '      .locator("nav")',
    '      .locator("ul")',
    '      .locator("li")',
    '      .getByRole("status")',
    "  ).toHaveCount(0);",
    "});",
  ].join("\n"), ['getByRole("status")']);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].line, 2);
});

test("AC-2 a changed locator inside expect.soft needs absence proof", () => {
  const fixture = changed("e2e/branches-page.spec.ts", [
    'test("range readout is absent", async ({ page }) => {',
    "  await expect.soft(",
    '    page.getByRole("status")',
    "  ).toHaveCount(0);",
    "});",
  ].join("\n"), ['getByRole("status")']);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "absence");
});
