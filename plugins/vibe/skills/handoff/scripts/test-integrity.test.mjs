import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  testIntegrityCandidates,
  testIntegrityProblems,
  testIntegrityProofShapeProblems,
  proofSourceAt,
} from "./test-integrity.mjs";

const COMMIT = "a".repeat(40);
const RECEIPT_DIR = mkdtempSync(path.join(tmpdir(), "test-integrity-receipts-"));
process.on("exit", () => rmSync(RECEIPT_DIR, { recursive: true, force: true }));
let receiptNumber = 0;

/** Raw Vitest output for a summary: the runner header, the summary's own failure location and its source frame. */
function runnerOutput(proof, source) {
  const summary = proof.mutationRun.assertionFailure;
  if (/^\s*FAIL\s|^\s*\d+\)\s+\[/m.test(summary)) return summary;
  const location = /([A-Za-z0-9_./-]+\.(?:test|spec|stories)\.[cm]?[jt]sx?):(\d+):(\d+)/.exec(summary);
  const lines = [` FAIL  ${proof.path} > ${proof.case}`, ...summary.split("\n")];
  if (location) {
    lines.push(` ❯ ${location[0]}`);
    const frame = location[1] === proof.path ? source.split("\n")[Number(location[2]) - 1] : undefined;
    if (frame !== undefined) lines.push(`  > ${location[2]}| ${frame}`, `     | ${" ".repeat(Number(location[3]) - 1)}^`);
  }
  return lines.join("\n");
}

function withReceipt(input, source) {
  const hash = value => createHash("sha256").update(value).digest("hex");
  const proof = { ...input, mutationRun: { ...input.mutationRun, assertionFailure: runnerOutput(input, source) } };
  const old = source.split("\n")[0];
  const mutationEdit = { old, new: `${old} void "intentional mutation";` };
  const receipt = { candidate: proof.candidate, target: proof.path, command: proof.command,
    mutationExit: proof.mutationRun.exitCode, mutationOutput: proof.mutationRun.assertionFailure,
    restoredExit: 0, restoredOutput: "Test Files 1 passed", head: proof.commit,
    beforeSha256: hash(source), mutatedSha256: hash(source.replace(mutationEdit.old, mutationEdit.new)), mutationEdit };
  const name = `proof-${receiptNumber++}.json`;
  const bytes = JSON.stringify(receipt);
  writeFileSync(path.join(RECEIPT_DIR, name), bytes);
  return { ...proof, rawReceipt: name, rawReceiptSha256: hash(bytes),
    restoredOutputSha256: hash(receipt.restoredOutput) };
}

test("ISS-13846 proof source reads stay inside regular worktree files", t => {
  const root = mkdtempSync(path.join(tmpdir(), "proof-source-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "valid.stories.tsx"), "export const Valid = {};\n");
  symlinkSync("/etc/hosts", path.join(root, "linked.stories.tsx"));
  assert.match(proofSourceAt(root, "valid.stories.tsx"), /Valid/);
  assert.equal(proofSourceAt(root, "linked.stories.tsx"), null);
  assert.equal(proofSourceAt(root, "../outside.stories.tsx"), null);
});

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
  const receiptProofs = proofs.map(proof => proof.class === "absence" ? withReceipt(proof, read(proof.path)) : proof);
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: receiptProofs }, files, read, COMMIT, RECEIPT_DIR), []);

  const mockedOwner = structuredClone(receiptProofs);
  mockedOwner.find((proof) => proof.class === "absence").ownerBoundary = "mock";
  assert.match(testIntegrityProofShapeProblems({ testIntegrityProofs: mockedOwner }).join("\n"), /ownerBoundary: "production"/);
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
  const executedReceipt = withReceipt(executed, fixture.source);
  const missingBytes = JSON.parse(readFileSync(path.join(RECEIPT_DIR, executedReceipt.rawReceipt), "utf8"));
  delete missingBytes.mutationEdit;
  const missingBytesFile = `proof-${receiptNumber++}.json`;
  const missingBytesRaw = JSON.stringify(missingBytes);
  writeFileSync(path.join(RECEIPT_DIR, missingBytesFile), missingBytesRaw);
  const unverifiable = { ...executedReceipt, rawReceipt: missingBytesFile,
    rawReceiptSha256: createHash("sha256").update(missingBytesRaw).digest("hex") };
  assert.match(testIntegrityProofShapeProblems({ testIntegrityProofs: [unverifiable] }, RECEIPT_DIR, read).join("\n"),
    /mutation bytes|mutated source|provenance/i,
  "an arbitrary changed hash without recoverable mutated bytes is not proof");
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [executedReceipt] }, files, read, COMMIT, RECEIPT_DIR), []);
  assert.match(testIntegrityProofShapeProblems({ testIntegrityProofs: [executed] }, tmpdir(), read).join("\n"),
    /raw runner receipt/i, "a production receipt directory cannot accept authored non-Storybook failure text alone");
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
  assert.match(testIntegrityProblems({ testIntegrityProofs: [withReceipt(setupCrash, fixture.source)] }, files, read, COMMIT, RECEIPT_DIR).join("\n"), /exact assertion failure/);
  const wrongAssertion = { ...executed,
    mutationRun: { command: proof.command, exitCode: 1,
      assertionFailure: 'AssertionError: expect(other).toHaveCount(1) failed at unrelated.spec.ts:99:1; Expected count: 1; Received count: 0' } };
  assert.match(testIntegrityProblems({ testIntegrityProofs: [withReceipt(wrongAssertion, fixture.source)] }, files, read, COMMIT, RECEIPT_DIR).join("\n"), /exact assertion failure/);
  const unrelatedStack = { ...executed,
    mutationRun: { command: proof.command, exitCode: 1,
      assertionFailure: `AssertionError: expect(other).toHaveCount(1) failed at unrelated.spec.ts:9:1; Expected count: 1; Received count: 0\n at ${proof.assertionLocation}` } };
  assert.match(testIntegrityProblems({ testIntegrityProofs: [withReceipt(unrelatedStack, fixture.source)] }, files, read, COMMIT, RECEIPT_DIR).join("\n"), /primary assertion location/);
  const uiTextTypeError = { ...executed,
    mutationRun: { command: proof.command, exitCode: 1,
      assertionFailure: `AssertionError: expect(pager).toHaveCount(0) failed at ${proof.assertionLocation}; Expected null, received element with text TypeError` } };
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [withReceipt(uiTextTypeError, fixture.source)] }, files, read, COMMIT, RECEIPT_DIR), []);
});

test("AC-2 changed hidden and detached assertions are absence candidates", () => {
  const fixtures = [
    changed("src/hidden.test.tsx", 'test("hidden", () => { expect(screen.getByRole("status")).toBeHidden(); });', ["toBeHidden"]),
    changed("src/detached.spec.ts", 'test("detached", async () => { await expect(page.getByRole("status")).not.toBeAttached(); });', ["toBeAttached"]),
  ];
  const read = path => fixtures.find(({ file }) => file.path === path)?.source ?? null;
  assert.deepEqual(testIntegrityCandidates(fixtures.map(({ file }) => file), read).map(({ kind }) => kind), ["absence", "absence"]);
});

test("ISS-13846 positive presence assertions are not absence mutation candidates", () => {
  const fixture = changed("apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx", [
    "export const Live: Story = {",
    "  play: async () => {",
    '    expect(cell).not.toBeNull();',
    '    expect(idleLoadingRow).toBeNull();',
    "  },",
    "};",
  ].join("\n"), ["not.toBeNull", "idleLoadingRow"]);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.deepEqual(candidates.map(({ id }) => id), ["absence:apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx:4"]);
  const multiline = changed("apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx", [
    "export const Live: Story = {", "  play: async () => {", "    expect(cell)", "      .not", "      .toBeNull();", "  },", "};",
  ].join("\n"), [".toBeNull"]);
  assert.deepEqual(testIntegrityCandidates([multiline.file], path => path === multiline.file.path ? multiline.source : null), []);
});

test("ISS-13846 final review ADV-1 a positive assertion does not hide an unparsed absence check on its line", () => {
  const fixture = changed("src/presence.test.tsx", [
    'test("mixed", () => {',
    '  expect(screen.queryByText("a")).not.toBeNull(); expect(screen.queryByText("b")).toBeFalsy();',
    "});",
  ].join("\n"), ["toBeFalsy"]);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.deepEqual(candidates.map(({ id }) => id), ["absence:src/presence.test.tsx:2"]);
});

test("ISS-13846 a busy-state count in a summary spec is not card-layout proof", () => {
  const fixture = changed("e2e/documents-summary-scope.spec.ts", [
    'test("one busy list", async () => {',
    '  await expect(results.locator(\'[aria-busy="true"]\')).toHaveCount(1);',
    '  await expect(results.locator(\'[data-slot="card"]\')).toHaveCount(1);',
    "});",
  ].join("\n"), ["aria-busy", "data-slot"]);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.deepEqual(candidates.filter(({ kind }) => kind === "layout").map(({ id }) => id),
    ["layout:e2e/documents-summary-scope.spec.ts:3"]);
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
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [withReceipt(proof, fixture.source), withReceipt(secondProof, fixture.source)] }, [fixture.file],
    path => path === fixture.file.path ? fixture.source : null, COMMIT, RECEIPT_DIR), []);
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
  assert.match(testIntegrityProblems({ testIntegrityProofs: [withReceipt(proof, fixture.source)] }, [fixture.file], read, COMMIT, RECEIPT_DIR).join("\n"), /primary assertion location/);
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

test("ISS-13846 AC-1/2 real Storybook runner failure binds the primary changed assertion", t => {
  const fixture = changed("apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx", [
    "export const Live: Story = {",
    "  play: async ({ canvas }) => {",
    '    await expect(canvas.queryByRole("status")).toBeNull();',
    "  },",
    "};",
  ].join("\n"), ["toBeNull"]);
  const read = path => path === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  const command = "pnpm --filter storybook exec vitest run stories/surfaces-v2/v2-documents-list.stories.tsx";
  const raw = [
    " RUN  v5.0.2 /repo/apps/storybook",
    " FAIL  stories/surfaces-v2/v2-documents-list.stories.tsx > Live",
    'AssertionError: expected <span>Loading</span> to be null',
    "- Expected: null",
    "+ Received: <span>Loading</span>",
    " ❯ stories/surfaces-v2/v2-documents-list.stories.tsx:3:49",
    '     3|     await expect(canvas.queryByRole("status")).toBeNull();',
    "       |                                                 ^",
  ].join("\n");
  const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
    mutation: "render status inside the mounted story", presentState: "status is inside the story canvas",
    assertionLine: candidate.assertionLine, assertionLocation: candidate.assertionLocation,
    command, observedFailure: raw, restoredPass: true, commit: COMMIT,
    ownerBoundary: "production", mountedSignal: "story canvas mounted",
    mutationRun: { command, exitCode: 1, assertionFailure: raw } };
  const receipts = mkdtempSync(path.join(tmpdir(), "storybook-mutation-receipt-"));
  t.after(() => rmSync(receipts, { recursive: true, force: true }));
  const storyEdit = { old: "  play: async ({ canvas }) => {",
    new: '  play: async ({ canvas }) => { const row=document.createElement("span"); row.textContent="Loading"; canvas.append(row);' };
  const receipt = { candidate: candidate.id, target: candidate.path, command, mutationExit: 1, mutationOutput: raw,
    restoredExit: 0, restoredOutput: "Test Files 1 passed", head: [COMMIT],
    beforeSha256: createHash("sha256").update(fixture.source).digest("hex"),
    mutatedSha256: createHash("sha256").update(fixture.source.replace(storyEdit.old, storyEdit.new)).digest("hex"),
    mutationEdit: storyEdit };
  const bytes = JSON.stringify(receipt);
  writeFileSync(path.join(receipts, "storybook.json"), bytes);
  proof.rawReceipt = "storybook.json";
  proof.rawReceiptSha256 = createHash("sha256").update(bytes).digest("hex");
  proof.restoredOutputSha256 = createHash("sha256").update(receipt.restoredOutput).digest("hex");
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file], read, COMMIT, receipts), []);
  assert.match(testIntegrityProblems({ testIntegrityProofs: [{ ...proof, rawReceiptSha256: "0".repeat(64) }] },
    [fixture.file], read, COMMIT, receipts).join("\n"), /receipt/i);
  assert.match(testIntegrityProblems({ testIntegrityProofs: [{ ...proof, rawReceipt: undefined }] },
    [fixture.file], read, COMMIT, receipts).join("\n"), /receipt/i);
  const wrongSourceReceipt = { ...receipt, beforeSha256: "0".repeat(64) };
  const wrongSourceBytes = JSON.stringify(wrongSourceReceipt);
  writeFileSync(path.join(receipts, "wrong-source.json"), wrongSourceBytes);
  assert.match(testIntegrityProblems({ testIntegrityProofs: [{ ...proof,
    rawReceipt: "wrong-source.json", rawReceiptSha256: createHash("sha256").update(wrongSourceBytes).digest("hex") }] },
  [fixture.file], read, COMMIT, receipts).join("\n"), /receipt/i);
  let traversed = false;
  assert.match(testIntegrityProofShapeProblems({ testIntegrityProofs: [{ ...proof, path: "../../private.stories.tsx" }] },
    receipts, () => { traversed = true; return fixture.source; }).join("\n"), /path/i);
  assert.equal(traversed, false, "untrusted proof paths cannot make the validator read outside the worktree");
  for (const failure of [
    raw.replace(":3:49", ":2:49"),
    raw.replace("AssertionError:", "TypeError:"),
    raw.replace(" ❯ stories/surfaces-v2/v2-documents-list.stories.tsx:3:49", " ❯ unrelated.stories.tsx:3:49"),
  ]) assert.match(testIntegrityProblems({ testIntegrityProofs: [{ ...proof,
    mutationRun: { command, exitCode: 1, assertionFailure: failure } }] }, [fixture.file], read, COMMIT, receipts).join("\n"), /primary assertion location|receipt/i);
});

test("ISS-13846 AC-1 Storybook instrumenter source-map coordinate binds a receipt-edited precondition", t => {
  const fixture = changed("apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx", [
    "export const LivePagedGroupedAppending: Story = {",
    "  play: async ({ canvasElement }) => {",
    '    const idleLoadingRow = canvasElement.querySelector("[data-paged-list-loading-row]");',
    "    await expect(idleLoadingRow).toBeNull();",
    "  },",
    "};",
  ].join("\n"), ["toBeNull"]);
  const read = file => file === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  const command = "STORYBOOK_BROWSER_TESTS=1 pnpm --filter storybook exec vitest run stories/surfaces-v2/v2-documents-list.stories.tsx";
  const raw = [" RUN  v5.0.2 /repo/apps/storybook",
    " FAIL  stories/surfaces-v2/v2-documents-list.stories.tsx > Live Paged Grouped Appending",
    "AssertionError: expected <div data-paged-list-loading-row></div> to be null",
    " ❯ toBeNull stories/surfaces-v2/v2-documents-list.stories.tsx:1:3",
    "     1| export const LivePagedGroupedAppending: Story = {",
    "       |   ^", " Failed Tests 1", " Test Files 1 failed", " Tests 1 failed | 16 passed"].join("\n");
  const edit = { old: '    const idleLoadingRow = canvasElement.querySelector("[data-paged-list-loading-row]");',
    new: '    const idleLoadingRow = (() => { const row = document.createElement("div"); row.setAttribute("data-paged-list-loading-row", ""); canvasElement.append(row); return canvasElement.querySelector("[data-paged-list-loading-row]"); })();' };
  const hash = value => createHash("sha256").update(value).digest("hex");
  const receipt = { candidate: candidate.id, target: candidate.path, command, mutationExit: 1, mutationOutput: raw,
    restoredExit: 0, restoredOutput: "Test Files 1 passed", head: COMMIT,
    beforeSha256: hash(fixture.source), mutatedSha256: hash(fixture.source.replace(edit.old, edit.new)), mutationEdit: edit };
  const dir = mkdtempSync(path.join(tmpdir(), "storybook-instrumented-proof-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = JSON.stringify(receipt);
  writeFileSync(path.join(dir, "story.json"), bytes);
  const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
    mutation: "insert one loading row into the idle mounted cell", presentState: "row inside the exact queried cell",
    assertionLine: candidate.assertionLine, assertionLocation: candidate.assertionLocation,
    command, observedFailure: raw, restoredPass: true, commit: COMMIT, ownerBoundary: "production",
    mountedSignal: "idle cell mounted", mutationRun: { command, exitCode: 1, assertionFailure: raw },
    rawReceipt: "story.json", rawReceiptSha256: hash(bytes), restoredOutputSha256: hash(receipt.restoredOutput) };
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file], read, COMMIT, dir), []);
  const sourceFile = path.join(dir, fixture.file.path);
  mkdirSync(path.dirname(sourceFile), { recursive: true });
  writeFileSync(sourceFile, fixture.source);
  const evidencePath = path.join(dir, "evidence.json");
  writeFileSync(evidencePath, JSON.stringify({ testSelection: [], testRuns: [], rerunCycles: [],
    testIntegrityProofs: [proof], targetedInventory: { actor: "read-only", source: "final-committed-diff",
      commit: COMMIT, laneReport: { command: "pnpm test:lanes", matches: [] }, entries: [], noTestsReason: "fixture" } }));
  const schema = new URL("./pr-evidence-schema.mjs", import.meta.url).pathname;
  const runSchema = worktree => spawnSync(process.execPath, [schema, "--file", evidencePath,
    ...(worktree ? ["--worktree", worktree] : [])], { encoding: "utf8" });
  assert.equal(runSchema(dir).status, 0);
  assert.match(runSchema(null).stdout, /primary assertion location/);
  const proxyRaw = raw.replace(" ❯ toBeNull stories/surfaces-v2/v2-documents-list.stories.tsx:1:3",
    " ❯ Proxy.toBeNull node_modules/.cache/storybook/test-helper.js:2552:20\n ❯ _jsxDEV stories/surfaces-v2/v2-documents-list.stories.tsx:1:3");
  const proxyReceipt = { ...receipt, mutationOutput: proxyRaw };
  const proxyBytes = JSON.stringify(proxyReceipt);
  writeFileSync(path.join(dir, "proxy.json"), proxyBytes);
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [{ ...proof, rawReceipt: "proxy.json",
    rawReceiptSha256: hash(proxyBytes), mutationRun: { command, exitCode: 1, assertionFailure: proxyRaw } }] },
  [fixture.file], read, COMMIT, dir), []);
  for (const failure of [raw.replace("❯ toBeNull", "❯ toBeVisible"), raw.replace("AssertionError", "TypeError"),
    raw.replace("stories/surfaces-v2/v2-documents-list.stories.tsx:1:3", "other.stories.tsx:1:3")]) {
    const changedReceipt = { ...receipt, mutationOutput: failure };
    const changedBytes = JSON.stringify(changedReceipt);
    writeFileSync(path.join(dir, "changed.json"), changedBytes);
    assert.notDeepEqual(testIntegrityProblems({ testIntegrityProofs: [{ ...proof,
      rawReceipt: "changed.json", rawReceiptSha256: hash(changedBytes),
      mutationRun: { command, exitCode: 1, assertionFailure: failure } }] }, [fixture.file], read, COMMIT, dir), []);
  }
});

test("ISS-13846 review DT-18 real adjacent 611/612 matcher cannot be relabeled", t => {
  const filePath = "apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx";
  const lines = [...Array.from({ length: 607 }, () => "// story context"),
    "async function triggerPagedRefetch() {",
    '  const loadingRow = loadingScope.querySelector("[data-paged-list-loading-row]");',
    "  await ready;",
    "  await expect(loadingRow).toBeNull();",
    '  await expect(within(loadingScope).queryByText("Loading documents…")).toBeNull();',
    "}",
    "export const LivePagedRefetch: Story = { play: async () => { await triggerPagedRefetch(); } };"];
  const source = lines.join("\n");
  const file = { path: filePath, status: "M", added: [611, 612].map(line => ({ line, text: lines[line - 1] })) };
  const read = path => path === filePath ? source : null;
  const candidates = testIntegrityCandidates([file], read);
  assert.deepEqual(candidates.map(item => item.id), [`absence:${filePath}:611`, `absence:${filePath}:612`]);
  const command = "STORYBOOK_BROWSER_TESTS=1 pnpm --filter storybook exec vitest run stories/surfaces-v2/v2-documents-list.stories.tsx";
  const raw = [" FAIL  stories/surfaces-v2/v2-documents-list.stories.tsx > Live Paged Refetch",
    "AssertionError: expected <div data-paged-list-loading-row></div> to be null",
    " ❯ Proxy.toBeNull node_modules/.cache/storybook/test-helper.js:2552:20",
    " ❯ _jsxDEV stories/surfaces-v2/v2-documents-list.stories.tsx:416:7",
    " Failed Tests 2", " Test Files 1 failed"].join("\n");
  const edit = { old: lines[608], new: '  const injected = document.createElement("div"); injected.setAttribute("data-paged-list-loading-row", ""); loadingScope.append(injected); ' + lines[608] };
  const hash = value => createHash("sha256").update(value).digest("hex");
  const dir = mkdtempSync(path.join(tmpdir(), "adjacent-story-proof-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proofFor = candidate => {
    const receipt = { candidate: candidate.id, target: filePath, command, mutationExit: 1,
      mutationOutput: raw, restoredExit: 0, restoredOutput: "Test Files 1 passed", head: COMMIT,
      beforeSha256: hash(source), mutatedSha256: hash(source.replace(edit.old, edit.new)), mutationEdit: edit };
    const bytes = JSON.stringify(receipt);
    const name = `line-${candidate.line}.json`;
    writeFileSync(path.join(dir, name), bytes);
    return { candidate: candidate.id, path: filePath, case: candidate.case, class: "absence",
      mutation: "insert loading row before the first absence assertion", command, observedFailure: raw,
      restoredPass: true, commit: COMMIT, ownerBoundary: "production", mountedSignal: "scope mounted",
      presentState: "loading row present", assertionLine: candidate.assertionLine,
      assertionLocation: candidate.assertionLocation, mutationRun: { command, exitCode: 1, assertionFailure: raw },
      rawReceipt: name, rawReceiptSha256: hash(bytes), restoredOutputSha256: hash(receipt.restoredOutput) };
  };
  assert.deepEqual(testIntegrityProofShapeProblems({ testIntegrityProofs: [proofFor(candidates[0])] }, dir, read), []);
  assert.match(testIntegrityProofShapeProblems({ testIntegrityProofs: [proofFor(candidates[1])] }, dir, read).join("\n"),
    /exact assertion|primary assertion|receipt/i,
  "the same raw line-611 failure cannot be relabeled as adjacent line 612");
  const textEdit = { old: `${lines[610]}\n${lines[611]}`,
    new: `${lines[610]} const inserted = document.createElement("span"); inserted.textContent = "Loading documents…"; loadingScope.append(inserted);\n${lines[611]}` };
  const textRaw = raw.replace("<div data-paged-list-loading-row></div>", "<span>Loading documents…</span>");
  const textProofFor = candidate => {
    const base = proofFor(candidate);
    const receipt = { candidate: candidate.id, target: filePath, command, mutationExit: 1,
      mutationOutput: textRaw, restoredExit: 0, restoredOutput: "Test Files 1 passed", head: COMMIT,
      beforeSha256: hash(source), mutatedSha256: hash(source.replace(textEdit.old, textEdit.new)), mutationEdit: textEdit };
    const bytes = JSON.stringify(receipt);
    const name = `text-line-${candidate.line}.json`;
    writeFileSync(path.join(dir, name), bytes);
    return { ...base, mutationRun: { command, exitCode: 1, assertionFailure: textRaw },
      rawReceipt: name, rawReceiptSha256: hash(bytes) };
  };
  assert.deepEqual(testIntegrityProofShapeProblems({ testIntegrityProofs: [textProofFor(candidates[1])] }, dir, read), []);
  assert.match(testIntegrityProofShapeProblems({ testIntegrityProofs: [textProofFor(candidates[0])] }, dir, read).join("\n"),
    /exact assertion|primary assertion|receipt/i,
  "the line-612 text failure cannot be relabeled as the preceding line-611 row assertion");
  const firstWinsEdit = { old: lines[608],
    new: '  const inserted = document.createElement("div"); inserted.setAttribute("data-paged-list-loading-row", ""); inserted.textContent = "Loading documents…"; loadingScope.append(inserted); ' + lines[608] };
  const firstWinsRaw = raw.replace("<div data-paged-list-loading-row></div>",
    "<div data-paged-list-loading-row>Loading documents…</div>");
  const falseSecondReceipt = { candidate: candidates[1].id, target: filePath, command,
    mutationExit: 1, mutationOutput: firstWinsRaw, restoredExit: 0, restoredOutput: "Test Files 1 passed",
    head: COMMIT, beforeSha256: hash(source), mutatedSha256: hash(source.replace(firstWinsEdit.old, firstWinsEdit.new)),
    mutationEdit: firstWinsEdit };
  const falseSecondBytes = JSON.stringify(falseSecondReceipt);
  writeFileSync(path.join(dir, "first-wins.json"), falseSecondBytes);
  const falseSecondProof = { ...proofFor(candidates[1]), rawReceipt: "first-wins.json",
    rawReceiptSha256: hash(falseSecondBytes), mutationRun: { command, exitCode: 1, assertionFailure: firstWinsRaw } };
  assert.match(testIntegrityProofShapeProblems({ testIntegrityProofs: [falseSecondProof] }, dir, read).join("\n"),
    /exact assertion|primary assertion|receipt/i,
  "a line-611 failure cannot satisfy line 612 merely because the injected row also contains its queried text");
});

test("ISS-13846 review DT-25 queryByRole failure needs the exact asserted scope", t => {
  const pathName = "apps/storybook/stories/surfaces-v2/scope.stories.tsx";
  const source = ["export const Live: Story = {", "  play: async ({ canvasElement }) => {",
    '    const scope = canvasElement.querySelector("#scope"); const unrelated = canvasElement.querySelector("#elsewhere");',
    '    await expect(within(scope).queryByRole("status")).toBeNull();',
    '    await expect(within(unrelated).queryByRole("status")).toBeNull();',
    "  },", "};"].join("\n");
  const file = { path: pathName, status: "M", added: [{ line: 4, text: source.split("\n")[3] }] };
  const read = fileName => fileName === pathName ? source : null;
  const [candidate] = testIntegrityCandidates([file], read);
  const command = "STORYBOOK_BROWSER_TESTS=1 pnpm --filter storybook exec vitest run scope.stories.tsx";
  const raw = [" FAIL  stories/surfaces-v2/scope.stories.tsx > Live",
    "AssertionError: expected <span role=status></span> to be null",
    " ❯ Proxy.toBeNull node_modules/.cache/storybook/test-helper.js:2552:20",
    " ❯ _jsxDEV stories/surfaces-v2/scope.stories.tsx:1:3", " Failed Tests 1"].join("\n");
  const old = source.split("\n")[2];
  const edit = { old, new: old + ' const node = document.createElement("span"); node.setAttribute("role", "status"); unrelated.append(node);' };
  const hash = value => createHash("sha256").update(value).digest("hex");
  const receipt = { candidate: candidate.id, target: pathName, command, mutationExit: 1,
    mutationOutput: raw, restoredExit: 0, restoredOutput: "Test Files 1 passed", head: COMMIT,
    beforeSha256: hash(source), mutatedSha256: hash(source.replace(old, edit.new)), mutationEdit: edit };
  const dir = mkdtempSync(path.join(tmpdir(), "storybook-scope-receipt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = JSON.stringify(receipt);
  writeFileSync(path.join(dir, "wrong-scope.json"), bytes);
  const proof = { candidate: candidate.id, path: pathName, case: candidate.case, class: "absence",
    mutation: "insert status only in unrelated scope", command, observedFailure: raw,
    restoredPass: true, commit: COMMIT, ownerBoundary: "production", mountedSignal: "both scopes mounted",
    presentState: "status outside the exact asserted scope", assertionLine: candidate.assertionLine,
    assertionLocation: candidate.assertionLocation, mutationRun: { command, exitCode: 1, assertionFailure: raw },
    rawReceipt: "wrong-scope.json", rawReceiptSha256: hash(bytes), restoredOutputSha256: hash(receipt.restoredOutput) };
  assert.match(testIntegrityProofShapeProblems({ testIntegrityProofs: [proof] }, dir, read).join("\n"),
    /exact assertion|primary assertion|receipt/i);
});

test("ISS-13846 AC-2 real Vitest package-relative matcher coordinate identifies a multiline expect", () => {
  const fixture = changed("packages/app/shared/components/__tests__/paged-list-refetch-loading.test.tsx", [
    'test("no loading row", () => {',
    "  expect(",
    '    screen.queryByText("Loading documents")',
    "  ).toBeNull();",
    "});",
  ].join("\n"), ["toBeNull"]);
  const read = path => path === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  const command = "pnpm --filter @repo/app exec vitest run shared/components/__tests__/paged-list-refetch-loading.test.tsx";
  const raw = [
    " FAIL  shared/components/__tests__/paged-list-refetch-loading.test.tsx > no loading row",
    "AssertionError: expected <span>Loading documents</span> to be null",
    " ❯ shared/components/__tests__/paged-list-refetch-loading.test.tsx:4:5",
    "     2|   expect(",
    '     3|     screen.queryByText("Loading documents")',
    "     4|   ).toBeNull();",
    "       |     ^",
  ].join("\n");
  const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
    mutation: "render loading row", presentState: "loading row is mounted", assertionLine: candidate.assertionLine,
    assertionLocation: candidate.assertionLocation, command, observedFailure: raw, restoredPass: true,
    commit: COMMIT, ownerBoundary: "production", mountedSignal: "list mounted",
    mutationRun: { command, exitCode: 1, assertionFailure: raw } };
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [withReceipt(proof, fixture.source)] }, [fixture.file], read, COMMIT, RECEIPT_DIR), []);
  assert.match(testIntegrityProblems({ testIntegrityProofs: [withReceipt({ ...proof,
    mutationRun: { command, exitCode: 1, assertionFailure: raw.replace(":4:5", ":1:5") } }, fixture.source)] },
  [fixture.file], read, COMMIT, RECEIPT_DIR).join("\n"), /primary assertion location/);
});

test("ISS-13846 AC-4 credential-free web E2E proof still needs real red and restored receipts", t => {
  const fixture = changed("e2e/documents-summary-scope.spec.ts", [
    'test("no loading rows", async ({ page }) => {',
    '  await expect(page.locator("[data-paged-list-loading-row]")).toHaveCount(',
    "    0",
    "  );",
    "});",
  ].join("\n"), ["toHaveCount("]);
  const read = path => path === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  const command = "pnpm exec playwright test --project=chromium e2e/documents-summary-scope.spec.ts --retries=0 -g 'no loading rows'";
  const raw = ["Running 1 test using 1 worker", "1) [chromium] › e2e/documents-summary-scope.spec.ts:1:1 › no loading rows",
    "    Error: \u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m).toHaveCount(expected) failed",
    "    Expected: 0", "    Received: 1",
    '    > 2 |   await expect(page.locator("[data-paged-list-loading-row]")).toHaveCount(',
    "          |                                                                    ^",
    "      3 |     0", "      4 |   );",
    "        at /work/e2e/documents-summary-scope.spec.ts:2:68"].join("\n");
  const receipts = mkdtempSync(path.join(tmpdir(), "web-mutation-receipt-"));
  t.after(() => rmSync(receipts, { recursive: true, force: true }));
  const receipt = { candidate: candidate.id, target: candidate.path, command, mutationExit: 1, mutationOutput: raw,
    restoredExit: 0, restoredOutput: "1 passed", head: COMMIT,
    beforeSha256: createHash("sha256").update(fixture.source).digest("hex"),
    mutationEdit: { old: 'test("no loading rows", async ({ page }) => {',
      new: 'test("no loading rows", async ({ page }) => { void "intentional setup mutation";' },
    mutatedSha256: createHash("sha256").update(fixture.source.replace('test("no loading rows", async ({ page }) => {',
      'test("no loading rows", async ({ page }) => { void "intentional setup mutation";')).digest("hex") };
  const bytes = JSON.stringify(receipt);
  writeFileSync(path.join(receipts, "web.json"), bytes);
  const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
    mutation: "mount the loading row", presentState: "loading row mounted", assertionLine: candidate.assertionLine,
    assertionLocation: candidate.assertionLocation, command, observedFailure: raw, restoredPass: true,
    commit: COMMIT, ownerBoundary: "production", mountedSignal: "list mounted",
    mutationRun: { command, exitCode: 1, assertionFailure: raw }, rawReceipt: "web.json",
    rawReceiptSha256: createHash("sha256").update(bytes).digest("hex"),
    restoredOutputSha256: createHash("sha256").update(receipt.restoredOutput).digest("hex") };
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file], read, COMMIT, receipts), []);
  for (const changedProof of [
    { ...proof, commit: "c".repeat(40) },
    { ...proof, mutationRun: { ...proof.mutationRun, exitCode: 0 } },
    { ...proof, restoredOutputSha256: "0".repeat(64) },
    { ...proof, mutationRun: { ...proof.mutationRun, assertionFailure: "AssertionError: authored failure at e2e/documents-summary-scope.spec.ts:2:9" } },
  ]) assert.notDeepEqual(testIntegrityProblems({ testIntegrityProofs: [changedProof] }, [fixture.file], read, COMMIT, receipts), []);
});

test("ISS-13846 AC-5 PR evidence CLI rejects a tampered raw Storybook receipt", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-proof-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const commit = "f".repeat(40);
  const candidate = "absence:apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx:3";
  const command = "pnpm --filter storybook exec vitest run stories/surfaces-v2/v2-documents-list.stories.tsx";
  const raw = [" FAIL  stories/surfaces-v2/v2-documents-list.stories.tsx > Live",
    "AssertionError: expected <span>Loading</span> to be null",
    " ❯ stories/surfaces-v2/v2-documents-list.stories.tsx:3:49",
    '     3|     await expect(canvas.queryByRole("status")).toBeNull();'].join("\n");
  const receipt = { candidate, command, mutationExit: 1, mutationOutput: raw, restoredExit: 0,
    restoredOutput: "1 passed", head: commit, beforeSha256: "a".repeat(64), mutatedSha256: "b".repeat(64) };
  const bytes = JSON.stringify(receipt);
  writeFileSync(path.join(dir, "story.json"), bytes);
  const proof = { candidate, path: "apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx",
    case: "Live", class: "absence", mutation: "render status", command, observedFailure: raw,
    restoredPass: true, commit, ownerBoundary: "production", mountedSignal: "story mounted",
    presentState: "status rendered", assertionLine: 'expect(canvas.queryByRole("status")).toBeNull()',
    assertionLocation: "apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx:3:11",
    mutationRun: { command, exitCode: 1, assertionFailure: raw }, rawReceipt: "story.json",
    rawReceiptSha256: createHash("sha256").update(bytes).digest("hex"),
    restoredOutputSha256: createHash("sha256").update(receipt.restoredOutput).digest("hex") };
  const evidence = { testSelection: [], testRuns: [], rerunCycles: [], testIntegrityProofs: [proof],
    targetedInventory: { actor: "read-only", source: "final-committed-diff", commit,
      laneReport: { command: "pnpm test:lanes", matches: [] }, entries: [], noTestsReason: "fixture" } };
  const evidencePath = path.join(dir, "vibe-pr-evidence.json");
  const run = value => { writeFileSync(evidencePath, JSON.stringify(value));
    return spawnSync(process.execPath, [new URL("./pr-evidence-schema.mjs", import.meta.url).pathname,
      "--file", evidencePath], { encoding: "utf8" }); };
  assert.equal(run(evidence).status, 0);
  const tampered = { ...evidence, testIntegrityProofs: [{ ...proof, rawReceiptSha256: "0".repeat(64) }] };
  assert.match(run(tampered).stdout, /raw runner receipt is invalid/);
  assert.notEqual(run(tampered).status, 0);
});

test("ISS-13846 review F1 a comment-only mutation or authored failure text cannot prove absence", () => {
  const fixture = changed("src/pager.test.tsx", [
    'test("no stale pager", () => {',
    '  expect(screen.queryByText("stale")).toBeNull();',
    "});",
  ].join("\n"), ["toBeNull"]);
  const read = path => path === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  assert.equal(candidate.kind, "absence");
  const command = "pnpm vitest src/pager.test.tsx";
  const summary = `AssertionError: expect(queryByText).toBeNull failed at ${candidate.assertionLocation}`;
  const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
    mutation: "render the stale pager", presentState: "the stale pager is present",
    assertionLine: candidate.assertionLine, assertionLocation: candidate.assertionLocation,
    command, observedFailure: "stale pager assertion failed", restoredPass: true, commit: COMMIT,
    ownerBoundary: "production", mountedSignal: "pager owner mounted",
    mutationRun: { command, exitCode: 1, assertionFailure: summary } };
  const hash = value => createHash("sha256").update(value).digest("hex");
  const first = fixture.source.split("\n")[0];
  const receiptFor = (output, edit) => {
    const receipt = { candidate: proof.candidate, target: proof.path, command, mutationExit: 1, mutationOutput: output,
      restoredExit: 0, restoredOutput: "Test Files 1 passed", head: COMMIT, beforeSha256: hash(fixture.source),
      mutatedSha256: hash(fixture.source.replace(edit.old, edit.new)), mutationEdit: edit };
    const name = `proof-${receiptNumber++}.json`;
    const bytes = JSON.stringify(receipt);
    writeFileSync(path.join(RECEIPT_DIR, name), bytes);
    return { ...proof, mutationRun: { ...proof.mutationRun, assertionFailure: output }, rawReceipt: name,
      rawReceiptSha256: hash(bytes), restoredOutputSha256: hash(receipt.restoredOutput) };
  };
  const problems = entry => testIntegrityProblems({ testIntegrityProofs: [entry] }, [fixture.file], read, COMMIT, RECEIPT_DIR);
  const realEdit = { old: first, new: `${first} render(<Pager stale />);` };
  const runner = runnerOutput(proof, fixture.source);
  assert.deepEqual(problems(receiptFor(runner, realEdit)), [], "positive control: real runner output and an executable mutation");
  assert.match(problems(receiptFor(runner, { old: first, new: `${first} /* render(<Pager stale />) */` })).join("\n"),
    /executable source/, "a comment-only edit cannot make the assertion fail");
  assert.match(problems(receiptFor(runner, { old: first, new: `${first} // render(<Pager stale />)` })).join("\n"),
    /executable source/, "a line comment is not a mutation either");
  assert.match(problems(receiptFor(runner, { old: first, new: `${first} {/* <Pager stale /> */}` })).join("\n"),
    /executable source/, "a JSX comment is not a mutation either");
  assert.match(problems(receiptFor(summary, realEdit)).join("\n"), /exact assertion failure/,
    "authored text naming the coordinate is not runner output");
});

test("ISS-13846 review F2 a direct Storybook frame on another assertion cannot prove this candidate", t => {
  const fixture = changed("apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx", [
    "export const LivePagedGroupedAppending: Story = {",
    "  play: async ({ canvasElement }) => {",
    '    const idleLoadingRow = canvasElement.querySelector("[data-paged-list-loading-row]");',
    "    await expect(idleLoadingRow).toBeNull();",
    '    await expect(canvasElement.querySelector("[data-stale]")).toBeNull();',
    "  },",
    "};",
  ].join("\n"), ["expect(idleLoadingRow)"]);
  const read = file => file === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  assert.equal(candidate.line, 4);
  const command = "STORYBOOK_BROWSER_TESTS=1 pnpm --filter storybook exec vitest run stories/surfaces-v2/v2-documents-list.stories.tsx";
  const edit = { old: '    const idleLoadingRow = canvasElement.querySelector("[data-paged-list-loading-row]");',
    new: '    const idleLoadingRow = (() => { const row = document.createElement("div"); row.setAttribute("data-paged-list-loading-row", ""); canvasElement.append(row); return canvasElement.querySelector("[data-paged-list-loading-row]"); })();' };
  const hash = value => createHash("sha256").update(value).digest("hex");
  const dir = mkdtempSync(path.join(tmpdir(), "storybook-other-assertion-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const problems = (frame, name) => {
    const raw = [" FAIL  stories/surfaces-v2/v2-documents-list.stories.tsx > Live Paged Grouped Appending",
      "AssertionError: expected <div></div> to be null",
      ` ❯ toBeNull stories/surfaces-v2/v2-documents-list.stories.tsx:${frame}`,
      " Failed Tests 1", " Test Files 1 failed"].join("\n");
    const receipt = { candidate: candidate.id, target: candidate.path, command, mutationExit: 1, mutationOutput: raw,
      restoredExit: 0, restoredOutput: "Test Files 1 passed", head: COMMIT,
      beforeSha256: hash(fixture.source), mutatedSha256: hash(fixture.source.replace(edit.old, edit.new)), mutationEdit: edit };
    const bytes = JSON.stringify(receipt);
    writeFileSync(path.join(dir, name), bytes);
    const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
      mutation: "insert one loading row", presentState: "row inside the queried cell",
      assertionLine: candidate.assertionLine, assertionLocation: candidate.assertionLocation,
      command, observedFailure: raw, restoredPass: true, commit: COMMIT, ownerBoundary: "production",
      mountedSignal: "idle cell mounted", mutationRun: { command, exitCode: 1, assertionFailure: raw },
      rawReceipt: name, rawReceiptSha256: hash(bytes), restoredOutputSha256: hash(receipt.restoredOutput) };
    return testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file], read, COMMIT, dir);
  };
  assert.deepEqual(problems("1:3", "story-line.json"), [], "positive control: the instrumenter maps to the story object");
  assert.match(problems("5:11", "other-assertion.json").join("\n"), /exact assertion failure/,
    "the runner named the unchanged line-5 assertion");
});

test("ISS-13846 review F3 a real card count keeps its layout proof while a busy count does not", () => {
  const fixture = changed("src/documents-list.test.tsx", [
    'test("renders one card in the narrow layout", () => {',
    '  const items = screen.getAllByRole("article");',
    "  expect(items).toHaveLength(1);",
    '  expect(screen.getAllByRole("row", { busy: true })).toHaveLength(1);',
    "});",
  ].join("\n"), ["toHaveLength"]);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.deepEqual(candidates.filter(({ kind }) => kind === "layout").map(({ id }) => id),
    ["layout:src/documents-list.test.tsx:3"], "the card comes only from the test's context; the busy count is state");
});

test("ISS-13846 review A1 A2 Storybook proof binds the exact story and never another multiline assertion", t => {
  const fixture = changed("apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx", [
    "export const Live: Story = {",
    "  play: async ({ canvasElement }) => {",
    '    const idleLoadingRow = canvasElement.querySelector("[data-paged-list-loading-row]");',
    "    await expect(idleLoadingRow).toBeNull();",
    "    await expect(",
    '      canvasElement.querySelector("[data-stale]"),',
    "    ).toBeNull();",
    "  },",
    "};",
    "export const LiveEmpty: Story = {};",
  ].join("\n"), ["expect(idleLoadingRow)"]);
  const read = file => file === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  assert.equal(candidate.line, 4);
  const command = "STORYBOOK_BROWSER_TESTS=1 pnpm --filter storybook exec vitest run stories/surfaces-v2/v2-documents-list.stories.tsx";
  const edit = { old: '    const idleLoadingRow = canvasElement.querySelector("[data-paged-list-loading-row]");',
    new: '    const idleLoadingRow = (() => { const row = document.createElement("div"); row.setAttribute("data-paged-list-loading-row", ""); canvasElement.append(row); return canvasElement.querySelector("[data-paged-list-loading-row]"); })();' };
  const hash = value => createHash("sha256").update(value).digest("hex");
  const dir = mkdtempSync(path.join(tmpdir(), "storybook-exact-story-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const problems = (story, frame, instrumented = false) => {
    const raw = [` FAIL   0 (chromium)  stories/surfaces-v2/v2-documents-list.stories.tsx > ${story}`,
      "AssertionError: expected <div></div> to be null",
      ...(instrumented ? [" ❯ Proxy.toBeNull node_modules/.cache/storybook/sb-vitest/vitest/deps/test.js:10:5"] : []),
      ` ❯ toBeNull stories/surfaces-v2/v2-documents-list.stories.tsx:${frame}`,
      " Failed Tests 1", " Test Files 1 failed"].join("\n");
    const receipt = { candidate: candidate.id, target: candidate.path, command, mutationExit: 1, mutationOutput: raw,
      restoredExit: 0, restoredOutput: "Test Files 1 passed", head: COMMIT,
      beforeSha256: hash(fixture.source), mutatedSha256: hash(fixture.source.replace(edit.old, edit.new)), mutationEdit: edit };
    const name = `story-${n++}.json`;
    const bytes = JSON.stringify(receipt);
    writeFileSync(path.join(dir, name), bytes);
    const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
      mutation: "insert one loading row", presentState: "row inside the queried cell",
      assertionLine: candidate.assertionLine, assertionLocation: candidate.assertionLocation,
      command, observedFailure: raw, restoredPass: true, commit: COMMIT, ownerBoundary: "production",
      mountedSignal: "idle cell mounted", mutationRun: { command, exitCode: 1, assertionFailure: raw },
      rawReceipt: name, rawReceiptSha256: hash(bytes), restoredOutputSha256: hash(receipt.restoredOutput) };
    return testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file], read, COMMIT, dir);
  };
  assert.deepEqual(problems("Live", "1:3"), [], "positive control: the exact story, framed on its story object");
  assert.match(problems("Live", "7:7").join("\n"), /exact assertion failure/,
    "A1: the runner framed the unchanged multiline assertion at its matcher line");
  assert.match(problems("Live Empty", "10:3").join("\n"), /exact assertion failure/,
    "A2: a sibling story whose name the candidate's story prefixes");
  assert.deepEqual(problems("Live", "7:7", true), [],
    "a Proxy instrumenter run maps its direct frame by source map, which ISS-13699's real runs placed on an unrelated assertion");
  assert.match(problems("Live Empty", "1:3", true).join("\n"), /exact assertion failure/,
    "the instrumenter path still binds the exact story");
});

test("ISS-13846 review A4 a card count whose locator merely contains loading letters keeps its layout proof", () => {
  const fixture = changed("src/documents-list.test.tsx", [
    'test("renders one card in the narrow layout", () => {',
    '  expect(screen.getAllByTestId("document-card-uploading")).toHaveLength(1);',
    '  expect(screen.getAllByTestId("document-loading-row")).toHaveLength(1);',
    "});",
  ].join("\n"), ["toHaveLength"]);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.deepEqual(candidates.filter(({ kind }) => kind === "layout").map(({ id }) => id),
    ["layout:src/documents-list.test.tsx:2"], "uploading is a card state word, a loading row is state");
});

test("ISS-13846 final review A-1 a later assertion that could see the mutation cannot prove an instrumented candidate", t => {
  const source = later => [
    "async function expectNoLoading(scope) {",
    '  await expect(within(scope).queryByText("Loading")).toBeNull();',
    "}",
    "export const Live: Story = {",
    "  play: async ({ canvasElement }) => {",
    "    const grid = canvasElement.querySelector(\"[role=grid]\");",
    '    await expect(within(grid).queryByText("Loading")).toBeNull();',
    ...(later ? [`    ${later}`] : []),
    "  },",
    "};",
  ].join("\n");
  const hash = value => createHash("sha256").update(value).digest("hex");
  const dir = mkdtempSync(path.join(tmpdir(), "storybook-later-assertion-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const problems = later => {
    const fixture = changed("apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx", source(later), ["within(grid)"]);
    const read = file => file === fixture.file.path ? fixture.source : null;
    const [candidate] = testIntegrityCandidates([fixture.file], read);
    const command = "STORYBOOK_BROWSER_TESTS=1 pnpm --filter storybook exec vitest run stories/surfaces-v2/v2-documents-list.stories.tsx";
    const edit = { old: '    const grid = canvasElement.querySelector("[role=grid]");',
      new: '    const grid = canvasElement.querySelector("[role=grid]"); const note = document.createElement("p"); note.textContent = "Loading"; grid.append(note);' };
    const raw = [" FAIL   0 (chromium)  stories/surfaces-v2/v2-documents-list.stories.tsx > Live",
      "AssertionError: ", " ❯ Proxy.toBeNull node_modules/.cache/storybook/sb-vitest/vitest/deps/test.js:10:5",
      " ❯ toBeNull stories/surfaces-v2/v2-documents-list.stories.tsx:4:3", " Failed Tests 1", " Test Files 1 failed"].join("\n");
    const receipt = { candidate: candidate.id, target: candidate.path, command, mutationExit: 1, mutationOutput: raw,
      restoredExit: 0, restoredOutput: "Test Files 1 passed", head: COMMIT,
      beforeSha256: hash(fixture.source), mutatedSha256: hash(fixture.source.replace(edit.old, edit.new)), mutationEdit: edit };
    const name = `later-${n++}.json`;
    const bytes = JSON.stringify(receipt);
    writeFileSync(path.join(dir, name), bytes);
    const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
      mutation: "append Loading inside the grid", presentState: "Loading present in the grid",
      assertionLine: candidate.assertionLine, assertionLocation: candidate.assertionLocation,
      command, observedFailure: raw, restoredPass: true, commit: COMMIT, ownerBoundary: "production",
      mountedSignal: "grid mounted", mutationRun: { command, exitCode: 1, assertionFailure: raw },
      rawReceipt: name, rawReceiptSha256: hash(bytes), restoredOutputSha256: hash(receipt.restoredOutput) };
    return testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file], read, COMMIT, dir);
  };
  assert.deepEqual(problems(null), [], "positive control: the mutation is inside the asserted grid and nothing later can fail");
  assert.deepEqual(problems('await expect(within(canvasElement).queryByText("Saved")).toBeNull();'), [],
    "a later assertion over text the mutation never inserts cannot be the failure");
  for (const [later, why] of [
    ['await expect(within(canvasElement).queryByText("Loading")).toBeNull();', "the same literal query"],
    ["await expect(within(canvasElement).queryByText('Loading')).toBeNull();", "the same query in other quotes"],
    ["await expect(within(canvasElement).queryByText(/Loading/)).toBeNull();", "a regular expression that matches the inserted text"],
    ["await expectNoLoading(canvasElement);", "a helper that asserts with the same matcher"],
  ]) assert.match(problems(later).join("\n"), /exact assertion failure/, why);
});

test("ISS-13846 final review A-2 a restored run is proof only with a numeric zero exit", () => {
  const fixture = changed("src/pager.test.tsx", [
    'test("no stale pager", () => {',
    '  expect(screen.queryByText("stale")).toBeNull();',
    "});",
  ].join("\n"), ["toBeNull"]);
  const read = path => path === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  const command = "pnpm vitest src/pager.test.tsx";
  const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
    mutation: "render the stale pager", presentState: "the stale pager is present",
    assertionLine: candidate.assertionLine, assertionLocation: candidate.assertionLocation,
    command, observedFailure: "stale pager assertion failed", restoredPass: true, commit: COMMIT,
    ownerBoundary: "production", mountedSignal: "pager owner mounted",
    mutationRun: { command, exitCode: 1, assertionFailure: `AssertionError: expect(queryByText).toBeNull failed at ${candidate.assertionLocation}` } };
  const hash = value => createHash("sha256").update(value).digest("hex");
  const first = fixture.source.split("\n")[0];
  const edit = { old: first, new: `${first} render(<Pager stale />);` };
  const raw = runnerOutput(proof, fixture.source);
  const withRestoredExit = (restored) => {
    const receipt = { candidate: proof.candidate, target: proof.path, command, mutationExit: 1, mutationOutput: raw,
      restoredOutput: "Test Files 1 passed", head: COMMIT, beforeSha256: hash(fixture.source),
      mutatedSha256: hash(fixture.source.replace(edit.old, edit.new)), mutationEdit: edit,
      ...(restored === undefined ? {} : { restoredExit: restored }) };
    const name = `proof-${receiptNumber++}.json`;
    const bytes = JSON.stringify(receipt);
    writeFileSync(path.join(RECEIPT_DIR, name), bytes);
    return testIntegrityProblems({ testIntegrityProofs: [{ ...proof, mutationRun: { ...proof.mutationRun, assertionFailure: raw },
      rawReceipt: name, rawReceiptSha256: hash(bytes), restoredOutputSha256: hash(receipt.restoredOutput) }] },
    [fixture.file], read, COMMIT, RECEIPT_DIR);
  };
  assert.deepEqual(withRestoredExit(0), [], "positive control");
  for (const restored of [1, "0", null, undefined, -1]) {
    assert.match(withRestoredExit(restored).join("\n"), /raw runner receipt is invalid/,
      `a passing summary with restoredExit ${JSON.stringify(restored)} is not a restored pass`);
  }
});

test("ISS-13846 final review A-3 a card count filtered to not-busy rows keeps its layout proof", () => {
  const fixture = changed("src/documents-summary.test.tsx", [
    'test("renders one summary card", () => {',
    '  expect(screen.getAllByRole("article", { busy: false })).toHaveLength(1);',
    '  expect(screen.getAllByRole("row", { busy: true })).toHaveLength(1);',
    "});",
  ].join("\n"), ["toHaveLength"]);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.deepEqual(candidates.filter(({ kind }) => kind === "layout").map(({ id }) => id),
    ["layout:src/documents-summary.test.tsx:2"], "busy: false filters ordinary cards; busy: true counts busy state");
});

test("ISS-13846 final review N1 a card count over a negated busy predicate keeps its layout proof", () => {
  const fixture = changed("e2e/documents-summary-cards.spec.ts", [
    'test("one summary card", async ({ page }) => {',
    '  await expect(page.locator(\'[data-card]:not([aria-busy="true"])\')).toHaveCount(1);',
    "  expect(cards.filter(card => !card.loading)).toHaveLength(1);",
    "  expect(cards.filter(card => card.loading === false)).toHaveLength(1);",
    '  await expect(page.locator(\'[aria-busy="true"]\')).toHaveCount(1);',
    "  expect(rows.filter(row => row.loading)).toHaveLength(1);",
    "});",
  ].join("\n"), ["[data-card]", "!card.loading", "card.loading === false", "page.locator('[aria-busy", "row.loading"]);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.deepEqual(candidates.filter(({ kind }) => kind === "layout").map(({ id }) => id),
    ["layout:e2e/documents-summary-cards.spec.ts:2", "layout:e2e/documents-summary-cards.spec.ts:3", "layout:e2e/documents-summary-cards.spec.ts:4"],
    "negated busy predicates count ordinary cards; positive busy or loading counts stay exempt (PC-2)");
});

/** A receipt-bound instrumented Storybook proof for the `within(grid)` candidate in a generated story file. */
function instrumentedStoryProblems(dir, name, lines, { target, story = "Live", needle = "within(grid)",
  insert = ' const note = document.createElement("p"); note.textContent = "Loading"; grid.append(note);' } = {}) {
  const fixture = changed("apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx", lines.join("\n"), [needle]);
  // A mutated production file carrying the same line, as in the review's probe, is readable too.
  const read = file => file === fixture.file.path || file === target ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  const hash = value => createHash("sha256").update(value).digest("hex");
  const command = "STORYBOOK_BROWSER_TESTS=1 pnpm --filter storybook exec vitest run stories/surfaces-v2/v2-documents-list.stories.tsx";
  const old = lines.find(line => line.includes('querySelector("[role=grid]")'));
  const edit = { old, new: `${old}${insert}` };
  const raw = [` FAIL   0 (chromium)  stories/surfaces-v2/v2-documents-list.stories.tsx > ${story}`,
    "AssertionError: ", " ❯ Proxy.toBeNull node_modules/.cache/storybook/sb-vitest/vitest/deps/test.js:10:5",
    " ❯ toBeNull stories/surfaces-v2/v2-documents-list.stories.tsx:1:3", " Failed Tests 1", " Test Files 1 failed"].join("\n");
  const receipt = { candidate: candidate.id, target: target ?? candidate.path, command, mutationExit: 1, mutationOutput: raw,
    restoredExit: 0, restoredOutput: "Test Files 1 passed", head: COMMIT,
    beforeSha256: hash(fixture.source), mutatedSha256: hash(fixture.source.replace(edit.old, edit.new)), mutationEdit: edit };
  const bytes = JSON.stringify(receipt);
  writeFileSync(path.join(dir, name), bytes);
  const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
    mutation: "append Loading inside the grid", presentState: "Loading present in the grid",
    assertionLine: candidate.assertionLine, assertionLocation: candidate.assertionLocation,
    command, observedFailure: raw, restoredPass: true, commit: COMMIT, ownerBoundary: "production",
    mountedSignal: "grid mounted", mutationRun: { command, exitCode: 1, assertionFailure: raw },
    rawReceipt: name, rawReceiptSha256: hash(bytes), restoredOutputSha256: hash(receipt.restoredOutput) };
  return testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file], read, COMMIT, dir);
}

test("ISS-13846 final review A-TARGET A-ORDER an instrumented proof refuses other targets and anything that runs after the mutation", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "storybook-order-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const story = (body, extra = []) => [
    ...extra,
    "export const Live: Story = {",
    "  play: async (context) => {",
    "    const { canvasElement } = context;",
    '    const grid = canvasElement.querySelector("[role=grid]");',
    ...body,
    "  },",
    "};",
  ];
  const candidateLine = '    await expect(within(grid).queryByText("Loading")).toBeNull();';
  const assertsLoading = ["async function expectNoLoading(scope) {", '  await expect(within(scope).queryByText("Loading")).toBeNull();', "}"];
  const assertsSaved = ["async function expectNoSaved(scope) {", '  await expect(within(scope).queryByText("Saved")).toBeNull();', "}"];
  let n = 0;
  const problems = (lines, options) => instrumentedStoryProblems(dir, `order-${n++}.json`, lines, options);
  assert.deepEqual(problems(story([candidateLine])), [], "positive control");
  assert.deepEqual(problems(story(["    await expectNoSaved(canvasElement);", candidateLine], assertsSaved)), [],
    "a helper call whose assertions cannot see the mutation is not ambiguous");
  assert.match(problems(story([candidateLine]), { target: "packages/app/src/menu.tsx" }).join("\n"), /exact assertion failure/,
    "A-TARGET: a receipt that mutates another file is not positioned in this story");
  for (const [lines, why] of [
    [story(["    await expectNoLoading(canvasElement);", candidateLine], assertsLoading), "(a) a same-matcher helper between the mutation and the candidate"],
    [story([candidateLine, '    const broad = within(canvasElement).queryByText("Loading");', "    await expect(broad).toBeNull();"]), "(b) a variable holding the same broader query"],
    [story([candidateLine, "    await Other.play(context);"]), "(c) a composed play"],
    [story([candidateLine, '    await expect.soft(within(canvasElement).queryByText("Loading")).toBeNull();']), "(e) a later soft assertion"],
  ]) assert.match(problems(lines).join("\n"), /exact assertion failure/, why);
  const helperCandidate = [
    "async function checkGrid(canvasElement) {",
    '  const grid = canvasElement.querySelector("[role=grid]");',
    '  await expect(within(grid).queryByText("Loading")).toBeNull();',
    "}",
    "export const Live: Story = {",
    "  play: async ({ canvasElement }) => {",
    "    await checkGrid(canvasElement);",
  ];
  assert.deepEqual(problems([...helperCandidate, "  },", "};"]), [], "a helper candidate named through its calling story");
  assert.match(problems([...helperCandidate, '    await expect(within(canvasElement).queryByText("Loading")).toBeNull();', "  },", "};"]).join("\n"),
    /exact assertion failure/, "(d) the calling story asserts the same query more broadly after the helper");
  assert.match(problems([...helperCandidate, "  },", "};"], { story: "Other" }).join("\n"), /exact assertion failure/,
    "(d) the runner header must name a story that runs the helper");
});

test("ISS-13846 final review L-NEG a card count excluding loading items in any form keeps its layout proof", () => {
  const lines = [
    'test("one summary card", async ({ page }) => {',
    '  await expect(page.locator("[data-card]").filter({ hasNotText: "Loading" })).toHaveCount(1);',
    '  await expect(page.locator("[data-card]").filter({ hasNot: page.getByText("loading") })).toHaveCount(1);',
    '  await expect(page.locator("[data-card]:not(.loading)")).toHaveCount(1);',
    '  await expect(page.locator("[data-card]:not([data-loading])")).toHaveCount(1);',
    '  await expect(page.locator("[data-card]")).toHaveCount(1); // after loading',
    '  await expect(page.locator(\'[aria-busy="true"]\')).toHaveCount(1);',
    "});",
  ];
  const fixture = changed("e2e/documents-summary-cards.spec.ts", lines.join("\n"),
    ["hasNotText", "hasNot:", ":not(.loading)", ":not([data-loading])", "// after loading", "aria-busy"]);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.deepEqual(candidates.filter(({ kind }) => kind === "layout").map(({ id }) => Number(id.split(":").at(-1))), [2, 3, 4, 5, 6],
    "only the positive aria-busy count on line 7 is a busy-state count (PC-2)");
});

test("ISS-13846 final review B1 B2 B3 a later query the gate can key is refused when ambiguous, and arrow helpers are attributed", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "storybook-keys-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const problems = (lines, options) => instrumentedStoryProblems(dir, `keys-${n++}.json`, lines, options);
  const story = (candidate, later = []) => [
    "export const Live: Story = {",
    "  play: async ({ canvasElement }) => {",
    '    const grid = canvasElement.querySelector("[role=grid]");',
    `    ${candidate}`,
    ...later.map(line => `    ${line}`),
    "  },",
    "};",
  ];
  const testId = 'await expect(within(grid).queryByTestId("toast")).toBeNull();';
  const ghostInsert = ' const ghost = document.createElement("span"); ghost.setAttribute("data-ghost", ""); ghost.textContent = "Ghost"; canvasElement.append(ghost);';
  const ghost = 'await expect(within(grid).queryByText("Ghost")).toBeNull();';
  assert.deepEqual(problems(story(testId)), [], "B1 positive control");
  assert.match(problems(story(testId, [testId])).join("\n"), /exact assertion failure/, "B1: an identical later queryByTestId");
  assert.deepEqual(problems(story(ghost, ['await expect(canvasElement.querySelector("[data-saved]")).toBeNull();']), { insert: ghostInsert }), [],
    "B2 positive control: a selector the mutation never touches");
  assert.match(problems(story(ghost, ['await expect(canvasElement.querySelector("[data-ghost]")).toBeNull();']), { insert: ghostInsert }).join("\n"),
    /exact assertion failure/, "B2: a later selector over the inserted attribute");
  const arrow = later => [
    "const check = async (canvasElement) => {",
    '  const grid = canvasElement.querySelector("[role=grid]");',
    '  await expect(within(grid).queryByText("Loading")).toBeNull();',
    "};",
    "export const Live: Story = {",
    "  play: async ({ canvasElement }) => {",
    "    await check(canvasElement);",
    ...later,
    "  },",
    "};",
  ];
  assert.deepEqual(problems(arrow([])), [], "B3 positive control: an arrow helper named through its calling story");
  assert.match(problems(arrow(['    await expect(within(canvasElement).queryByText("Loading")).toBeNull();'])).join("\n"),
    /exact assertion failure/, "B3: the calling story asserts the same query after the arrow helper");
});

test("ISS-13846 final review N1-variable a card count through a variable named loading keeps its layout proof", () => {
  const fixture = changed("e2e/summary.spec.ts", [
    'test("one metric card", async ({ page }) => {',
    '  const loading = page.getByTestId("metric-card");',
    "  await expect(loading).toHaveCount(1);",
    '  await expect(page.locator(\'[aria-busy="true"]\')).toHaveCount(1);',
    "});",
  ].join("\n"), ["expect(loading)", "aria-busy"]);
  const candidates = testIntegrityCandidates([fixture.file], path => path === fixture.file.path ? fixture.source : null);
  assert.deepEqual(candidates.filter(({ kind }) => kind === "layout").map(({ id }) => id), ["layout:e2e/summary.spec.ts:3"],
    "a variable name is not a busy state; the aria-busy count is (PC-2)");
});

test("ISS-13846 final review a helper's own definition is not a call from the helper before it", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "storybook-definition-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = [
    "async function settle(canvasElement) {",
    "  await waitFor(() => canvasElement);",
    "}",
    "async function checkGrid(canvasElement) {",
    '  const grid = canvasElement.querySelector("[role=grid]");',
    '  await expect(within(grid).queryByText("Loading")).toBeNull();',
    "}",
    "export const Settled: Story = {",
    "  play: async ({ canvasElement }) => {",
    "    await settle(canvasElement);",
    '    await expect(within(canvasElement).queryByText("Loading")).toBeNull();',
    "  },",
    "};",
    "export const Live: Story = {",
    "  play: async ({ canvasElement }) => { await checkGrid(canvasElement); },",
    "};",
  ];
  assert.deepEqual(instrumentedStoryProblems(dir, "definition.json", lines), [],
    "only Live runs checkGrid; Settled's broader assertion follows a different helper");
});
