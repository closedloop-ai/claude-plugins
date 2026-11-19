import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  testIntegrityCandidates,
  testIntegrityProblems,
  testIntegrityProofShapeProblems,
  proofSourceAt,
} from "./test-integrity.mjs";
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";
import { viewportWidthMutation } from "../../vibe/scripts/dist/qa-impact-parser.mjs";

// Tracker checks run only with a tracker bound, so these run bound to the provider this repository ships (spawned scripts inherit it).
bindProviderInProcess(after);

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

function withReceipt(input, source, mutation = ' void "intentional mutation";') {
  const hash = value => createHash("sha256").update(value).digest("hex");
  const proof = { ...input, mutationRun: { ...input.mutationRun, assertionFailure: runnerOutput(input, source) } };
  const old = source.split("\n")[0];
  const mutationEdit = typeof mutation === "string" ? { old, new: `${old}${mutation}` } : mutation;
  const receipt = { candidate: proof.candidate, target: proof.path, command: proof.command,
    mutationExit: proof.mutationRun.exitCode, mutationOutput: proof.mutationRun.assertionFailure,
    restoredExit: 0, restoredOutput: "Test Files 1 passed", head: proof.commit,
    beforeSha256: hash(source), mutatedSha256: hash(source.split(mutationEdit.old).join(mutationEdit.new)), mutationEdit };
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
      ? { viewportSource: "registered", desktopWidthMutation: "run the Mobile play at desktop width",
        ...(candidate.viewportSetup ? { viewportSetup: candidate.viewportSetup } : {}),
        assertionLine: candidate.assertionLine, assertionLocation: candidate.assertionLocation,
        mutationRun: { command: `pnpm vitest ${candidate.path}`, exitCode: 1,
          assertionFailure: `AssertionError: responsive assertion failed at ${candidate.assertionLocation}` } }
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
  const receiptProofs = proofs.map(proof => proof.class === "absence" || (proof.class === "responsive" && proof.assertionLocation)
    ? withReceipt(proof, read(proof.path)) : proof);
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: receiptProofs }, files, read, COMMIT, RECEIPT_DIR), []);

  const mockedOwner = structuredClone(receiptProofs);
  mockedOwner.find((proof) => proof.class === "absence").ownerBoundary = "mock";
  assert.match(testIntegrityProofShapeProblems({ testIntegrityProofs: mockedOwner }).join("\n"), /ownerBoundary: "production" or truthful "test-stand-in"/);
  const standInOwner = structuredClone(receiptProofs);
  const standIn = standInOwner.find((proof) => proof.class === "absence");
  standIn.ownerBoundary = "test-stand-in";
  delete standIn.mountedSignal;
  delete standIn.presentState;
  assert.deepEqual(testIntegrityProofShapeProblems({ testIntegrityProofs: standInOwner }, RECEIPT_DIR, read), [],
    "truthful stand-in proofs remain renderable even though candidate selection no longer requires them");
});

test("ISS-14128 viewport words in lint fixtures do not invent responsive render candidates", () => {
  const fixture = changed("src/viewport-rule.test.ts", [
    'test("rejects unknown viewport names", () => {',
    '  const names = ["Narrow", "mobile2"];',
    "  expect(check(names)).toBe(false);",
    "});",
  ].join("\n"), ["Narrow", "mobile2"]);
  const candidates = testIntegrityCandidates([fixture.file], (file) => file === fixture.file.path ? fixture.source : null);
  assert.deepEqual(candidates.filter(({ kind }) => kind === "responsive"), []);
});

test("ISS-14128 assertion words in string fixtures do not invent absence candidates", () => {
  const fixture = changed("src/string-fixture.test.ts", [
    'const assertion = "expect(await activeProjectOrNull()).toBeNull()";',
    'const query = "queryByRole(\\"dialog\\")";',
    'const nearbyMatcher = "toHaveCount(0)";',
  ].join("\n"), ["toBeNull", "queryByRole", "toHaveCount"]);
  assert.deepEqual(testIntegrityCandidates([fixture.file],
    file => file === fixture.file.path ? fixture.source : null), []);
});

test("ISS-14128 test-only E2E stand-ins are not production absence-proof candidates", () => {
  const spec = "apps/desktop/test/e2e/project.spec.ts";
  const standIn = "apps/desktop/test/e2e/helpers/active-project.ts";
  const source = [
    'import { activeProjectOrNull } from "./helpers/active-project";',
    'test("no active project", async () => {',
    '  expect(await activeProjectOrNull()).toBeNull();',
    '});',
  ].join("\n");
  const files = [{ path: spec, status: "M", added: [{ line: 3, text: '  expect(await activeProjectOrNull()).toBeNull();' }] }];
  const read = file => file === spec ? source : file === standIn
    ? "export async function activeProjectOrNull() { return null; }\n" : null;
  assert.deepEqual(testIntegrityCandidates(files, read).filter(({ kind }) => kind === "absence"), []);
  for (const typed of [
    "export async function activeProjectOrNull(): Promise<null> { return null; }\n",
    "export const activeProjectOrNull = async (): Promise<null> => null;\n",
  ]) {
    const typedRead = file => file === spec ? source : file === standIn ? typed : null;
    assert.deepEqual(testIntegrityCandidates(files, typedRead).filter(({ kind }) => kind === "absence"), [],
      "a typed constant-null helper remains a truthful test-only stand-in");
  }

  const conditionalRead = file => file === spec ? source : file === standIn
    ? "export async function activeProjectOrNull() { if (process.env.FORCE_EMPTY) return null; return productionLookup(); }\n" : null;
  assert.equal(testIntegrityCandidates(files, conditionalRead).filter(({ kind }) => kind === "absence").length, 1,
    "a conditional null path is not a constant test stand-in");
  const conditionalArrowRead = file => file === spec ? source : file === standIn
    ? "export const activeProjectOrNull = async () => null ?? productionLookup();\n" : null;
  assert.equal(testIntegrityCandidates(files, conditionalArrowRead).filter(({ kind }) => kind === "absence").length, 1,
    "a null-prefixed arrow expression is not a constant test stand-in");
  const multilineArrowRead = file => file === spec ? source : file === standIn
    ? "export const activeProjectOrNull = async () => null\n?? productionLookup();\n" : null;
  assert.equal(testIntegrityCandidates(files, multilineArrowRead).filter(({ kind }) => kind === "absence").length, 1,
    "a multiline continued arrow expression is not a constant test stand-in");
  const fakeDeclarationRead = file => file === spec ? source : file === standIn
    ? '// function activeProjectOrNull() { return null; }\nconst example = "function activeProjectOrNull() { return null; }";\nconst pattern = /function activeProjectOrNull() { return null; }/;\nexport async function activeProjectOrNull() { return productionLookup(); }\n' : null;
  assert.equal(testIntegrityCandidates(files, fakeDeclarationRead).filter(({ kind }) => kind === "absence").length, 1,
    "commented and quoted fake declarations cannot hide the real helper");
  for (const nested of [
    "function wrapper() { function activeProjectOrNull() { return null; } }\nexport async function activeProjectOrNull() { return productionLookup(); }\n",
    "function wrapper() { const activeProjectOrNull = () => null; }\nexport async function activeProjectOrNull() { return productionLookup(); }\n",
  ]) {
    const nestedRead = file => file === spec ? source : file === standIn ? nested : null;
    assert.equal(testIntegrityCandidates(files, nestedRead).filter(({ kind }) => kind === "absence").length, 1,
      "nested shadow declarations cannot hide the exported helper");
  }
  for (const namespaceShadow of [
    "namespace Fixture {\n  export async function activeProjectOrNull(): Promise<null> { return null; }\n}\nexport async function activeProjectOrNull() { return productionLookup(); }\n",
    "namespace Fixture {\n  export const activeProjectOrNull = async (): Promise<null> => null;\n}\nexport async function activeProjectOrNull() { return productionLookup(); }\n",
    "namespace Fixture {\n  void /}/;\n  export async function activeProjectOrNull(): Promise<null> { return null; }\n}\nexport async function activeProjectOrNull() { return productionLookup(); }\n",
    "namespace Fixture {\n  void /}/;\n  export const activeProjectOrNull = async (): Promise<null> => null;\n}\nexport async function activeProjectOrNull() { return productionLookup(); }\n",
    "namespace Fixture {\n  if (true) /}/.test(\"}\");\n  export async function activeProjectOrNull(): Promise<null> { return null; }\n}\nexport async function activeProjectOrNull() { return productionLookup(); }\n",
    "namespace Fixture {\n  if (true) /}/.test(\"}\");\n  export const activeProjectOrNull = async (): Promise<null> => null;\n}\nexport async function activeProjectOrNull() { return productionLookup(); }\n",
  ]) {
    const namespaceRead = file => file === spec ? source : file === standIn ? namespaceShadow : null;
    assert.equal(testIntegrityCandidates(files, namespaceRead).filter(({ kind }) => kind === "absence").length, 1,
      "a namespace-local null export cannot hide the imported module-level production helper");
  }
  for (const namespaceBeforeStandIn of [
    "namespace Fixture {\n  export async function activeProjectOrNull() { return productionLookup(); }\n}\nexport async function activeProjectOrNull(): Promise<null> { return null; }\n",
    "namespace Fixture {\n  export const activeProjectOrNull = async () => productionLookup();\n}\nexport const activeProjectOrNull = async (): Promise<null> => null;\n",
  ]) {
    const namespaceRead = file => file === spec ? source : file === standIn ? namespaceBeforeStandIn : null;
    assert.deepEqual(testIntegrityCandidates(files, namespaceRead).filter(({ kind }) => kind === "absence"), [],
      "a namespace-local same-name export cannot hide the imported module-level constant-null stand-in");
  }
  for (const mutable of [
    "export let activeProjectOrNull = async () => null;\nactiveProjectOrNull = async () => productionLookup();\n",
    "export var activeProjectOrNull = async () => null;\nactiveProjectOrNull = async () => productionLookup();\n",
    "export async function activeProjectOrNull() { return null; }\nactiveProjectOrNull = async () => productionLookup();\n",
    "export async function activeProjectOrNull() { return null; }\n({ activeProjectOrNull } = productionBindings);\n",
    "export async function activeProjectOrNull() { return null; }\nfor (activeProjectOrNull of productionBindings) break;\n",
    "export const activeProjectOrNull = async () => null;\nactiveProjectOrNull = async () => productionLookup();\n",
    "export async function activeProjectOrNull() { return null; }\neval('activeProjectOrNull = async () => productionLookup()');\n",
    "export async function activeProjectOrNull() { return null; }\nexport async function activeProjectOrNull() { return productionLookup(); }\n",
    "export const activeProjectOrNull = async () => null;\nexport const activeProjectOrNull = async () => productionLookup();\n",
    "export const activeProjectOrNull = async () => null;\nconst real = async () => productionLookup();\nexport { real as activeProjectOrNull };\n",
  ]) {
    const mutableRead = file => file === spec ? source : file === standIn ? mutable : null;
    assert.equal(testIntegrityCandidates(files, mutableRead).filter(({ kind }) => kind === "absence").length, 1,
      "a mutable null initializer is not a constant test stand-in");
  }
  const productionImport = source.replace('import { activeProjectOrNull } from "./helpers/active-project";',
    'import { activeProjectOrNull } from "../../src/main/active-project";\n// import { activeProjectOrNull } from "./helpers/active-project";');
  const productionImportRead = file => file === spec ? productionImport
    : file === standIn ? "export async function activeProjectOrNull(): Promise<null> { return null; }\n"
      : file === "apps/desktop/src/main/active-project.ts" ? "export async function activeProjectOrNull() { return productionLookup(); }\n" : null;
  assert.equal(testIntegrityCandidates(files, productionImportRead).filter(({ kind }) => kind === "absence").length, 1,
    "a commented helper import cannot override the real module-level production import");
  const shadowedSource = source.replace('test("no active project", async () => {',
    'test("no active project", async () => {\n  async function activeProjectOrNull() { return productionLookup(); }');
  const shadowedRead = file => file === spec ? shadowedSource : file === standIn
    ? "export async function activeProjectOrNull(): Promise<null> { return null; }\n" : null;
  assert.equal(testIntegrityCandidates(files, shadowedRead).filter(({ kind }) => kind === "absence").length, 1,
    "a local production helper shadowing the import keeps the absence proof requirement");
  const expressionShadow = changed(spec, [
    'import { activeProjectOrNull } from "./helpers/active-project";',
    'test("shadowed expression", async () => {',
    "  const check = async function activeProjectOrNull() {",
    "    expect(await activeProjectOrNull()).toBeNull();",
    "  };",
    "  await check();",
    "});",
  ].join("\n"), ["toBeNull"]);
  const expressionShadowRead = file => file === spec ? expressionShadow.source : file === standIn
    ? "export async function activeProjectOrNull(): Promise<null> { return null; }\n" : null;
  assert.equal(testIntegrityCandidates([expressionShadow.file], expressionShadowRead)
    .filter(({ kind }) => kind === "absence").length, 1,
  "a named function-expression shadow keeps the absence proof requirement");
  const namespaceShadow = changed(spec, [
    'import { activeProjectOrNull } from "./helpers/active-project";',
    "namespace Scenario {",
    "  import activeProjectOrNull = Production.lookup;",
    '  test("namespace shadow", async () => {',
    "    expect(await activeProjectOrNull()).toBeNull();",
    "  });",
    "}",
  ].join("\n"), ["toBeNull"]);
  const namespaceShadowRead = file => file === spec ? namespaceShadow.source : file === standIn
    ? "export async function activeProjectOrNull(): Promise<null> { return null; }\n" : null;
  assert.equal(testIntegrityCandidates([namespaceShadow.file], namespaceShadowRead)
    .filter(({ kind }) => kind === "absence").length, 1,
  "a namespace import-equals alias shadows the stand-in import and keeps the proof requirement");
  const duplicateImport = changed(spec, [
    'import { activeProjectOrNull } from "./helpers/active-project";',
    'import { productionProject as activeProjectOrNull } from "../../src/main/active-project";',
    'test("duplicate import", async () => {',
    "  expect(await activeProjectOrNull()).toBeNull();",
    "});",
  ].join("\n"), ["toBeNull"]);
  const duplicateImportRead = file => file === spec ? duplicateImport.source : file === standIn
    ? "export async function activeProjectOrNull(): Promise<null> { return null; }\n" : null;
  assert.equal(testIntegrityCandidates([duplicateImport.file], duplicateImportRead)
    .filter(({ kind }) => kind === "absence").length, 1,
  "ambiguous duplicate named imports fail closed instead of selecting the first helper");
  for (const competing of [
    'import activeProjectOrNull from "../../src/main/active-project";',
    'import * as activeProjectOrNull from "../../src/main/active-project";',
  ]) {
    const competingImport = changed(spec, [
      'import { activeProjectOrNull } from "./helpers/active-project";',
      competing,
      'test("competing import", async () => {',
      "  expect(await activeProjectOrNull()).toBeNull();",
      "});",
    ].join("\n"), ["toBeNull"]);
    const competingRead = file => file === spec ? competingImport.source : file === standIn
      ? "export async function activeProjectOrNull(): Promise<null> { return null; }\n" : null;
    assert.equal(testIntegrityCandidates([competingImport.file], competingRead)
      .filter(({ kind }) => kind === "absence").length, 1,
    "a competing default or namespace import makes the asserted binding ambiguous");
  }
  for (const declaration of [
    "enum activeProjectOrNull { Key }",
    "namespace activeProjectOrNull { export const Key = 1; }",
  ]) {
    const competingDeclaration = changed(spec, [
      'import { activeProjectOrNull } from "./helpers/active-project";',
      declaration,
      'test("competing declaration", async () => {',
      "  expect(await activeProjectOrNull()).toBeNull();",
      "});",
    ].join("\n"), ["toBeNull"]);
    const declarationRead = file => file === spec ? competingDeclaration.source : file === standIn
      ? "export async function activeProjectOrNull(): Promise<null> { return null; }\n" : null;
    assert.equal(testIntegrityCandidates([competingDeclaration.file], declarationRead)
      .filter(({ kind }) => kind === "absence").length, 1,
    "a competing enum or namespace declaration makes the asserted binding ambiguous");
  }

  const production = source.replace("./helpers/active-project", "../../src/main/active-project");
  const productionPath = "apps/desktop/src/main/active-project.ts";
  const readProduction = file => file === spec ? production : file === productionPath
    ? "export async function activeProjectOrNull() { return null; }\n" : null;
  assert.equal(testIntegrityCandidates(files, readProduction).filter(({ kind }) => kind === "absence").length, 1,
    "a production owner still requires ownerBoundary production");
});

test("responsive E2E tests remain failing-mutation candidates", () => {
  const fixture = changed("e2e/mobile-navigation.spec.ts", [
    'test("mobile navigation opens on narrow viewport", async ({ page }) => {',
    "  await page.setViewportSize({ width: 375, height: 800 });",
    '  await expect(page.getByRole("navigation")).toBeVisible();',
    "});",
  ].join("\n"), ["setViewportSize", "toBeVisible"]);
  const candidates = testIntegrityCandidates([fixture.file], file => file === fixture.file.path ? fixture.source : null);
  assert.equal(candidates.filter(({ kind }) => kind === "responsive").length, 1);

  const edgeCases = [
    changed("e2e/mobile-soft.spec.ts", [
      'test("opens navigation", async ({ page }) => {',
      "  await page.setViewportSize({ width: 375, height: 800 });",
      '  await expect.soft(page.getByRole("navigation")).toBeVisible();',
      "});",
    ].join("\n"), ["expect.soft"]),
    changed("e2e/mobile-path-only.spec.ts", [
      'test("opens navigation", async ({ page }) => {',
      "  await page.setViewportSize({ width: 375, height: 800 });",
      '  await expect(page.getByRole("navigation")).toBeVisible();',
      "});",
    ].join("\n"), ["toBeVisible"]),
    changed("e2e/mobile-inline.spec.ts", [
      'test("opens navigation", async ({ page }) => {',
      '  await page.setViewportSize({ width: 375, height: 800 }); await expect(page.getByRole("navigation")).toBeVisible();',
      "});",
    ].join("\n"), ["setViewportSize"]),
  ];
  for (const edge of edgeCases) {
    const responsive = testIntegrityCandidates([edge.file], file => file === edge.file.path ? edge.source : null)
      .filter(({ kind }) => kind === "responsive");
    assert.equal(responsive.length, 1, `${edge.file.path} retains its responsive assertion`);
  }
  const mixedCallbacks = changed("e2e/mobile-mixed.spec.ts", [
    'test("mobile navigation", async ({ page }) => {',
    "  await page.setViewportSize({ width: 375, height: 800 });",
    '  await expect(page.getByRole("navigation")).toBeVisible();',
    "});",
    'test("desktop title", async ({ page }) => {',
    '  await expect(page.getByRole("heading")).toBeVisible();',
    "});",
    "beforeEach(async ({ page }) => {",
    '  await expect(page.getByRole("main")).toBeVisible();',
    "});",
  ].join("\n"), ['getByRole("heading")', 'getByRole("main")']);
  assert.deepEqual(testIntegrityCandidates([mixedCallbacks.file], file => file === mixedCallbacks.file.path ? mixedCallbacks.source : null)
    .filter(({ kind }) => kind === "responsive"), [],
  "desktop tests and hooks outside the responsive callback do not inherit its viewport proof requirement");
  const playwrightSuite = changed("e2e/navigation.spec.ts", [
    'test.describe("navigation", () => {',
    '  test("mobile navigation", async ({ page }) => {',
    "    await page.setViewportSize({ width: 375, height: 800 });",
    '    await expect(page.getByRole("navigation")).toBeVisible();',
    "  });",
    '  test("desktop title", async ({ page }) => {',
    '    await expect(page.getByRole("heading")).toBeVisible();',
    "  });",
    "});",
  ].join("\n"), ['getByRole("navigation")', 'getByRole("heading")']);
  const playwrightCandidates = testIntegrityCandidates([playwrightSuite.file],
    file => file === playwrightSuite.file.path ? playwrightSuite.source : null)
    .filter(({ kind }) => kind === "responsive");
  assert.equal(playwrightCandidates.length, 1, "test.describe is a suite and only its responsive leaf owns a candidate");
  assert.equal(playwrightCandidates[0].case, "mobile navigation");
  const viewportFixtureOnly = changed("e2e/mobile-fixture.spec.ts", [
    'test("mobile fixture", async ({ page }) => {',
    "  const fixture = { viewport: { width: 375, height: 800 } };",
    '  await expect(page.getByRole("navigation")).toBeVisible();',
    "});",
  ].join("\n"), ["toBeVisible"]);
  assert.deepEqual(testIntegrityCandidates([viewportFixtureOnly.file],
    file => file === viewportFixtureOnly.file.path ? viewportFixtureOnly.source : null)
    .filter(({ kind }) => kind === "responsive"), [],
  "a viewport-shaped fixture without an executed setViewportSize call is not responsive setup");
  const sameNameFixture = changed("e2e/mobile-method-fixture.spec.ts", [
    'test("mobile fixture method", async ({ page }) => {',
    "  fixture.setViewportSize({ width: 375, height: 800 });",
    '  await expect(page.getByRole("navigation")).toBeVisible();',
    "});",
  ].join("\n"), ["toBeVisible"]);
  assert.deepEqual(testIntegrityCandidates([sameNameFixture.file],
    file => file === sameNameFixture.file.path ? sameNameFixture.source : null)
    .filter(({ kind }) => kind === "responsive"), [],
  "an unrelated object's setViewportSize method is not page viewport setup");
  const inertSetup = changed("e2e/mobile-inert.spec.ts", [
    'test("mobile inert setup", async ({ page }) => {',
    "  const unusedSetup = () => page.setViewportSize({ width: 375, height: 800 });",
    '  await expect(page.getByRole("navigation")).toBeVisible();',
    "});",
  ].join("\n"), ["toBeVisible"]);
  assert.deepEqual(testIntegrityCandidates([inertSetup.file],
    file => file === inertSetup.file.path ? inertSetup.source : null)
    .filter(({ kind }) => kind === "responsive"), [],
  "an uninvoked nested viewport helper does not establish executed responsive setup");
  const nestedAssertion = changed("e2e/mobile-nested-assertion.spec.ts", [
    'test("mobile nested assertion", async ({ page }) => {',
    "  await page.setViewportSize({ width: 375, height: 800 });",
    "  function neverCalled() { expect(1).toBe(1); }",
    "});",
  ].join("\n"), ["expect(1)"]);
  assert.deepEqual(testIntegrityCandidates([nestedAssertion.file],
    file => file === nestedAssertion.file.path ? nestedAssertion.source : null)
    .filter(({ kind }) => kind === "responsive"), [],
  "an assertion inside an uncalled nested function is not owned by the responsive leaf");
  for (const [label, statement] of [
    ["inert arrow", "  void (() => expect(1).toBe(1));"],
    ["short circuit", "  void (false && expect(1).toBe(1));"],
    ["unconditional exit", "  if (true) return;\n  await expect(page.getByRole(\"navigation\")).toBeVisible();"],
    ["bare expect", "  expect(1);"],
    ["bare soft expect", "  expect.soft(1);"],
    ["exit before setup", ""],
    ["block return before setup", ""],
    ["block throw before setup", ""],
    ["nested true block return", ""],
    ["nested true block throw", ""],
    ["nested true if return", ""],
    ["false else return", ""],
    ["both arms return", ""],
    ["both arms throw", ""],
    ["post setup both arms return", ""],
    ["try return before setup", ""],
    ["try throw before setup", ""],
    ["post setup try return", ""],
  ]) {
    const exit = label === "exit before setup" ? "  return;"
      : label === "block return before setup" ? "  { return; }"
        : label === "block throw before setup" ? '  { throw new Error("stop"); }'
          : label === "nested true block return" ? "  if (true) { { return; } }"
            : label === "nested true block throw" ? '  if (true) { { throw new Error("stop"); } }'
              : label === "nested true if return" ? "  if (true) { if (true) return; }" : null;
    const branchExit = label === "false else return" ? "  if (false) {} else return;"
      : label === "both arms return" ? "  if (page) return; else return;"
        : label === "both arms throw" ? '  if (page) throw new Error("a"); else throw new Error("b");' : null;
    const selectedExit = exit ?? branchExit;
    const body = exit
      ? [selectedExit, "  await page.setViewportSize({ width: 375, height: 800 });", '  await expect(page.getByRole("navigation")).toBeVisible();']
      : branchExit
        ? [branchExit, "  await page.setViewportSize({ width: 375, height: 800 });", '  await expect(page.getByRole("navigation")).toBeVisible();']
        : label === "post setup both arms return"
          ? ["  await page.setViewportSize({ width: 375, height: 800 });", "  if (page) return; else return;", '  await expect(page.getByRole("navigation")).toBeVisible();']
          : label === "try return before setup"
            ? ["  try { return; } finally {}", "  await page.setViewportSize({ width: 375, height: 800 });", '  await expect(page.getByRole("navigation")).toBeVisible();']
            : label === "try throw before setup"
              ? ['  try { throw new Error("stop"); } finally {}', "  await page.setViewportSize({ width: 375, height: 800 });", '  await expect(page.getByRole("navigation")).toBeVisible();']
              : label === "post setup try return"
                ? ["  await page.setViewportSize({ width: 375, height: 800 });", "  try { return; } finally {}", '  await expect(page.getByRole("navigation")).toBeVisible();']
          : ["  await page.setViewportSize({ width: 375, height: 800 });", statement];
    const inert = changed(`e2e/mobile-${label.replaceAll(" ", "-")}.spec.ts`, [
      `test("mobile ${label}", async ({ page }) => {`, ...body, "});",
    ].join("\n"), ["expect"]);
    assert.deepEqual(testIntegrityCandidates([inert.file], file => file === inert.file.path ? inert.source : null)
      .filter(({ kind }) => kind === "responsive"), [], `${label} does not create a direct executable assertion candidate`);
  }
  for (const matcher of [
    '  await expect(page.getByRole("navigation")).not.toBeEnabled();',
    '  await expect.soft(page.getByRole("navigation")).not.toBeEnabled();',
  ]) {
    const negated = changed("e2e/mobile-negated.spec.ts", [
      'test("mobile negated", async ({ page }) => {',
      "  await page.setViewportSize({ width: 375, height: 800 });",
      matcher,
      "});",
    ].join("\n"), ["toBeEnabled"]);
    assert.equal(testIntegrityCandidates([negated.file], file => file === negated.file.path ? negated.source : null)
      .filter(({ kind }) => kind === "responsive").length, 1,
    "a direct negated matcher remains a responsive proof candidate");
  }
  for (const declaration of [
    '  const title = "Navigation";',
    "  const fixture = { title: \"Navigation\", values: [1, 2, 3] };",
    "  const pattern = /navigation/i;",
    '  const nav = page.getByRole("navigation");',
    '  const nav = page.locator("//nav");',
    '  const nav = page.getByRole("navigation").locator("button");',
  ]) {
    const literalPrelude = changed("e2e/mobile-literal-prelude.spec.ts", [
      'test("mobile literal prelude", async ({ page }) => {',
      "  await page.setViewportSize({ width: 375, height: 800 });",
      declaration,
      '  await expect(page.getByRole("navigation")).toBeVisible();',
      "});",
    ].join("\n"), ["toBeVisible"]);
    assert.equal(testIntegrityCandidates([literalPrelude.file],
      file => file === literalPrelude.file.path ? literalPrelude.source : null)
      .filter(({ kind }) => kind === "responsive").length, 1,
    "a provably literal variable prelude preserves the responsive candidate");
  }
  for (const typed of [
    '  await expect<unknown>(page.getByRole("navigation")).toBeVisible();',
    '  await expect.soft<unknown>(page.getByRole("navigation")).toBeVisible();',
    '  await expect<Promise<unknown>>(page.getByRole("navigation")).toBeVisible();',
    '  await expect.soft<Promise<unknown>>(page.getByRole("navigation")).toBeVisible();',
    '  await expect<\n    unknown\n  >(page.getByRole("navigation")).toBeVisible();',
  ]) {
    const typedMatcher = changed("e2e/mobile-typed-matcher.spec.ts", [
      'test("mobile typed matcher", async ({ page }) => {',
      "  await page.setViewportSize({ width: 375, height: 800 });",
      typed,
      "});",
    ].join("\n"), ["toBeVisible"]);
    assert.equal(testIntegrityCandidates([typedMatcher.file],
      file => file === typedMatcher.file.path ? typedMatcher.source : null)
      .filter(({ kind }) => kind === "responsive").length, 1,
    "a typed direct matcher remains a responsive proof candidate");
  }
  const nestedMatcher = changed("e2e/mobile-nested-matcher.spec.ts", [
    'test("mobile nested matcher", async ({ page }) => {',
    "  await page.setViewportSize({ width: 375, height: 800 });",
    "  await expect(() => expect(1)).not.toThrow();",
    "});",
  ].join("\n"), ["toThrow"]);
  const nestedMatcherCandidates = testIntegrityCandidates([nestedMatcher.file],
    file => file === nestedMatcher.file.path ? nestedMatcher.source : null)
    .filter(({ kind }) => kind === "responsive");
  assert.equal(nestedMatcherCandidates.length, 1, "only the outer terminal matcher owns responsive proof");
  assert.match(nestedMatcherCandidates[0].assertionLine, /^expect\(\(\) => expect\(1\)\)\.not\.toThrow/);
  const unreachableSetup = changed("e2e/mobile-unreachable.spec.ts", [
    'test("mobile unreachable setup", async ({ page }) => {',
    "  if (false) await page.setViewportSize({ width: 375, height: 800 });",
    '  await expect(page.getByRole("navigation")).toBeVisible();',
    "});",
  ].join("\n"), ["toBeVisible"]);
  assert.deepEqual(testIntegrityCandidates([unreachableSetup.file],
    file => file === unreachableSetup.file.path ? unreachableSetup.source : null)
    .filter(({ kind }) => kind === "responsive"), [],
  "a literal-false viewport branch does not establish executed responsive setup");
  for (const [label, lines] of [
    ["desktop width", ["  await page.setViewportSize({ width: 1280, height: 800 });", '  await expect(page.getByRole("navigation")).toBeVisible();']],
    ["variable width", ["  await page.setViewportSize({ width: mobileWidth, height: 800 });", '  await expect(page.getByRole("navigation")).toBeVisible();']],
    ["duplicate width", ["  await page.setViewportSize({ width: 375, height: 800, width: 375 });", '  await expect(page.getByRole("navigation")).toBeVisible();']],
    ["late setup", ['  await expect(page.getByRole("navigation")).toBeVisible();', "  await page.setViewportSize({ width: 375, height: 800 });"]],
    ["unawaited setup", ["  page.setViewportSize({ width: 375, height: 800 });", '  await expect(page.getByRole("navigation")).toBeVisible();']],
    ["second nested setup", ["  await page.setViewportSize({ width: 375, height: 800 });", "  if (true) await page.setViewportSize({ width: 375, height: 800 });", '  await expect(page.getByRole("navigation")).toBeVisible();']],
  ]) {
    const invalid = changed(`e2e/mobile-${label.replaceAll(" ", "-")}.spec.ts`, [
      `test("mobile ${label}", async ({ page }) => {`, ...lines, "});",
    ].join("\n"), ["toBeVisible"]);
    assert.deepEqual(testIntegrityCandidates([invalid.file], file => file === invalid.file.path ? invalid.source : null)
      .filter(({ kind }) => kind === "responsive"), [], `${label} does not establish canonical responsive setup`);
  }

  const paired = changed("e2e/mobile-pair.spec.ts", [
    'test("opens navigation", async ({ page }) => {',
    "  await page.setViewportSize({ width: 375, height: 800 });",
    '  await expect(page.locator("//nav")).toBeVisible(); await expect(page.getByRole("main")).toBeVisible();',
    "});",
  ].join("\n"), ['locator("//nav")', "getByRole"]);
  const pairedCandidates = testIntegrityCandidates([paired.file], file => file === paired.file.path ? paired.source : null)
    .filter(({ kind }) => kind === "responsive");
  assert.deepEqual(pairedCandidates.map(({ id }) => id), [
    "responsive:e2e/mobile-pair.spec.ts:3:1",
    "responsive:e2e/mobile-pair.spec.ts:3:2",
  ], "two changed assertions on one line need separate mutation proofs");
  const responsiveProof = (candidate, failureLocation = candidate.assertionLocation, mutation = {
    old: "await page.setViewportSize({ width: 375, height: 800 });",
    new: "await page.setViewportSize({ width: 1280, height: 800 });",
  }, proofSource = paired.source) => withReceipt({
    candidate: candidate.id,
    path: candidate.path,
    case: candidate.case,
    class: candidate.kind,
    mutation: `break ${candidate.assertionLine}`,
    command: `pnpm playwright test ${candidate.path}`,
    observedFailure: "the named responsive assertion failed",
    restoredPass: true,
    commit: COMMIT,
    viewportSource: "registered",
    desktopWidthMutation: "run at desktop width",
    viewportSetup: candidate.viewportSetup,
    assertionLine: candidate.assertionLine,
    assertionLocation: candidate.assertionLocation,
    mutationRun: { command: `pnpm playwright test ${candidate.path}`, exitCode: 1,
      assertionFailure: `AssertionError: responsive assertion failed at ${failureLocation}` },
  }, proofSource, mutation);
  const pairedProofs = pairedCandidates.map((candidate) => responsiveProof(candidate));
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: pairedProofs }, [paired.file],
    file => file === paired.file.path ? paired.source : null, COMMIT, RECEIPT_DIR), []);
  const relabeled = [pairedProofs[0], responsiveProof(pairedCandidates[1], pairedCandidates[0].assertionLocation)];
  assert.match(testIntegrityProblems({ testIntegrityProofs: relabeled }, [paired.file],
    file => file === paired.file.path ? paired.source : null, COMMIT, RECEIPT_DIR).join("\n"), /exact assertion failure/,
  "one responsive assertion failure cannot be relabeled as proof for its same-line sibling");
  const wrongMutation = [pairedProofs[0], responsiveProof(pairedCandidates[1], pairedCandidates[1].assertionLocation,
    { old: 'test("opens navigation"', new: 'test("breaks navigation"' })];
  assert.match(testIntegrityProblems({ testIntegrityProofs: wrongMutation }, [paired.file],
    file => file === paired.file.path ? paired.source : null, COMMIT, RECEIPT_DIR).join("\n"), /narrow-to-desktop width mutation/,
  "an unrelated executable edit cannot pose as the responsive desktop-width mutation");
  const appendedDesktop = [pairedProofs[0], responsiveProof(pairedCandidates[1], pairedCandidates[1].assertionLocation,
    { old: "await page.setViewportSize({ width: 375, height: 800 });",
      new: "await page.setViewportSize({ width: 375, alternate: { width: 1280 }, height: 800 });" })];
  assert.match(testIntegrityProblems({ testIntegrityProofs: appendedDesktop }, [paired.file],
    file => file === paired.file.path ? paired.source : null, COMMIT, RECEIPT_DIR).join("\n"), /narrow-to-desktop width mutation/,
  "adding an unused desktop width while retaining the narrow width cannot satisfy the responsive mutation");
  const xpathChange = [responsiveProof(pairedCandidates[0], pairedCandidates[0].assertionLocation, {
    old: 'await page.setViewportSize({ width: 375, height: 800 });\n  await expect(page.locator("//nav")).toBeVisible();',
    new: 'await page.setViewportSize({ width: 1280, height: 800 });\n  await expect(page.locator("//missing")).toBeVisible();',
  }), pairedProofs[1]];
  assert.match(testIntegrityProblems({ testIntegrityProofs: xpathChange }, [paired.file],
    file => file === paired.file.path ? paired.source : null, COMMIT, RECEIPT_DIR).join("\n"), /raw runner receipt|narrow-to-desktop width mutation/,
  "a width edit plus an XPath string change is not a width-only responsive mutation");
  const widthStringChange = [responsiveProof(pairedCandidates[0], pairedCandidates[0].assertionLocation, {
    old: 'await page.setViewportSize({ width: 375, height: 800 });\n  await expect(page.locator("//nav")).toBeVisible();',
    new: 'await page.setViewportSize({ width: 1280, height: 800 });\n  await expect(page.locator("//width: 1280")).toBeVisible();',
  }), pairedProofs[1]];
  assert.match(testIntegrityProblems({ testIntegrityProofs: widthStringChange }, [paired.file],
    file => file === paired.file.path ? paired.source : null, COMMIT, RECEIPT_DIR).join("\n"), /raw runner receipt|narrow-to-desktop width mutation/,
  "width-like text inside a changed string remains a non-width executable difference");
  const multilineTyped = changed("e2e/mobile-multiline-proof.spec.ts", [
    'test("mobile multiline typed", async ({ page }) => {',
    "  await page.setViewportSize({ width: 375, height: 800 });",
    "  await expect<",
    "    () => void",
    '  >(page.getByRole("navigation")).toBeVisible();',
    "});",
  ].join("\n"), ["toBeVisible"]);
  const [multilineCandidate] = testIntegrityCandidates([multilineTyped.file],
    file => file === multilineTyped.file.path ? multilineTyped.source : null)
    .filter(({ kind }) => kind === "responsive");
  const multilineProof = responsiveProof(multilineCandidate, multilineCandidate.assertionLocation, {
    old: "await page.setViewportSize({ width: 375, height: 800 });",
    new: "await page.setViewportSize({ width: 1280, height: 800 });",
  }, multilineTyped.source);
  assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [multilineProof] }, [multilineTyped.file],
    file => file === multilineTyped.file.path ? multilineTyped.source : null, COMMIT, RECEIPT_DIR), [],
  "a multiline nested typed matcher binds its exact raw runner frame");
  const typedNestedFrame = changed("e2e/mobile-typed-nested-frame.spec.ts", [
    'test("mobile typed nested frame", async ({ page }) => {',
    "  await page.setViewportSize({ width: 375, height: 800 });",
    "  await expect<",
    "    () => void",
    "  >(",
    '    /\\)/.test(")") ? await expect(page.getByRole("navigation")).toBeVisible() : undefined',
    "  ).toBeUndefined();",
    "});",
  ].join("\n"), ["toBeUndefined"]);
  const [typedOuter] = testIntegrityCandidates([typedNestedFrame.file],
    file => file === typedNestedFrame.file.path ? typedNestedFrame.source : null)
    .filter(({ kind }) => kind === "responsive");
  const innerLine = typedNestedFrame.source.split("\n").findIndex((line) => line.includes("await expect(page")) + 1;
  const innerColumn = typedNestedFrame.source.split("\n")[innerLine - 1].indexOf("expect(page") + 1;
  const typedInnerProof = responsiveProof(typedOuter,
    `${typedNestedFrame.file.path}:${innerLine}:${innerColumn}`, {
      old: "await page.setViewportSize({ width: 375, height: 800 });",
      new: "await page.setViewportSize({ width: 1280, height: 800 });",
    }, typedNestedFrame.source);
  assert.notDeepEqual(testIntegrityProblems({ testIntegrityProofs: [typedInnerProof] }, [typedNestedFrame.file],
    file => file === typedNestedFrame.file.path ? typedNestedFrame.source : null, COMMIT, RECEIPT_DIR), [],
  "a function-typed inner frame after a regex parenthesis cannot authenticate the outer matcher");
  assert.notEqual(viewportWidthMutation(
    "page.setViewportSize({ width: 375, height: ((fixture = { width: 375 }), 800) });",
    "page.setViewportSize({ width: 375, height: ((fixture = { width: 1280 }), 800) });",
  ), true, "a nested width under setViewportSize is not the call's effective viewport width");
  assert.notEqual(viewportWidthMutation(
    "page.setViewportSize({ width: 375, height: 800, ...{ width: 375 } });",
    "page.setViewportSize({ width: 1280, height: 800, ...{ width: 375 } });",
  ), true, "a later spread width makes effective viewport ownership ambiguous");
  assert.notEqual(viewportWidthMutation(
    "page.setViewportSize({ width: 375, height: 800, width: 375 });",
    "page.setViewportSize({ width: 1280, height: 800, width: 375 });",
  ), true, "a duplicate later width makes effective viewport ownership ambiguous");
  assert.notEqual(viewportWidthMutation(
    "page.setViewportSize({ width: 375, height: 800, width });",
    "page.setViewportSize({ width: 1280, height: 800, width });",
  ), true, "a later shorthand width makes effective viewport ownership ambiguous");
  assert.notEqual(viewportWidthMutation(
    "page.setViewportSize({ width: 375, height: 800, get width() { return 375; } });",
    "page.setViewportSize({ width: 1280, height: 800, get width() { return 375; } });",
  ), true, "a later width accessor makes effective viewport ownership ambiguous");
  assert.notEqual(viewportWidthMutation(
    "page.setViewportSize({ width: 375, height: 800 });\npage.setViewportSize({ width: 375, height: 800, ...fixture });",
    "page.setViewportSize({ width: 1280, height: 800 });\npage.setViewportSize({ width: 375, height: 800, ...fixture });",
  ), true, "a later ambiguous viewport call invalidates the whole desktop-width proof");
  assert.notEqual(viewportWidthMutation(
    "page.setViewportSize({ width: 375, height: 800 });\npage.setViewportSize(options);",
    "page.setViewportSize({ width: 1280, height: 800 });\npage.setViewportSize(options);",
  ), true, "a later variable viewport call invalidates the whole desktop-width proof");
  assert.notEqual(viewportWidthMutation(
    "page.setViewportSize({ width: 375, height: 800 });\npage.setViewportSize();",
    "page.setViewportSize({ width: 1280, height: 800 });\npage.setViewportSize();",
  ), true, "a later argumentless viewport call invalidates the whole desktop-width proof");

  const longFixture = changed("e2e/mobile-navigation-long.spec.ts", [
    'test("mobile navigation opens on narrow viewport", async ({ page }) => {',
    "  await page.setViewportSize({ width: 375, height: 800 });",
    "  // } does not close the test callback",
    '  // test("desktop placeholder") is not a declaration',
    '  // `test("desktop placeholder") is text`',
    '  // /test("desktop placeholder")/',
    "  // /}/",
    ...Array.from({ length: 40 }, (_, index) => `  // filler ${index}`),
    '  await expect(page.getByRole("navigation")).toBeVisible();',
    "});",
  ].join("\n"), ["toBeVisible"]);
  const longCandidates = testIntegrityCandidates([longFixture.file], file => file === longFixture.file.path ? longFixture.source : null);
  assert.equal(longCandidates.filter(({ kind }) => kind === "responsive").length, 1,
    "long E2E cases retain their enclosing responsive test name");

  const duplicateNames = changed("e2e/mobile-duplicate.spec.ts", [
    'describe("header", () => {',
    '  test("mobile layout", async ({ page }) => {',
    "    await page.setViewportSize({ width: 375, height: 800 });",
    '    await expect(page.locator("header")).toBeVisible();',
    "  });",
    "});",
    'describe("footer", () => {',
    '  test("mobile layout", async ({ page }) => {',
    "    await page.setViewportSize({ width: 375, height: 800 });",
    '    await expect(page.locator("footer")).toBeVisible();',
    "  });",
    "});",
  ].join("\n"), ['locator("header")', 'locator("footer")']);
  const duplicateCandidates = testIntegrityCandidates([duplicateNames.file], file => file === duplicateNames.file.path ? duplicateNames.source : null);
  assert.equal(duplicateCandidates.filter(({ kind }) => kind === "responsive").length, 2,
    "duplicate leaf names in separate test blocks each need proof");

  const suiteName = changed("e2e/mobile-suite.spec.ts", [
    'describe("mobile navigation", () => {',
    "  const closingBrace = /}/;",
    '  test("opens navigation", async ({ page }) => {',
    "    await page.setViewportSize({ width: 375, height: 800 });",
    '    await expect(page.getByRole("navigation")).toBeVisible();',
    "  });",
    "});",
  ].join("\n"), ["toBeVisible"]);
  const suiteCandidates = testIntegrityCandidates([suiteName.file], file => file === suiteName.file.path ? suiteName.source : null);
  assert.equal(suiteCandidates.filter(({ kind }) => kind === "responsive").length, 1,
    "a responsive suite title applies to its plain leaf test");

  const eachCase = changed("e2e/mobile-each.spec.ts", [
    "// 😀 keeps UTF-16 offsets aligned",
    'test.each([/\\)/])("mobile navigation %s", async (_row, { page }) => {',
    "  await page.setViewportSize({ width: 375, height: 800 });",
    ...Array.from({ length: 40 }, (_, index) => `  // filler ${index}`),
    '  await expect(page.getByRole("navigation")).toBeVisible();',
    "});",
  ].join("\n"), ["toBeVisible"]);
  const eachCandidates = testIntegrityCandidates([eachCase.file], file => file === eachCase.file.path ? eachCase.source : null);
  assert.equal(eachCandidates.filter(({ kind }) => kind === "responsive").length, 1,
    "regex tokens inside test.each data do not truncate the declaration");

  const functionCallbacks = changed("e2e/mobile-function.spec.ts", [
    'describe("mobile navigation", function mobileSuite() {',
    '  test("opens navigation", async function opensNavigation() {',
    "    await page.setViewportSize({ width: 375, height: 800 });",
    '    await expect(page.getByRole("navigation")).toBeVisible();',
    "  });",
    "});",
  ].join("\n"), ["toBeVisible"]);
  const functionCandidates = testIntegrityCandidates([functionCallbacks.file], file => file === functionCallbacks.file.path ? functionCallbacks.source : null);
  assert.equal(functionCandidates.filter(({ kind }) => kind === "responsive").length, 1,
    "function callback suites retain responsive context");

  const onlyCase = changed("e2e/mobile-only.spec.ts", [
    'test.only("mobile navigation", async ({ page }) => {',
    "  await page.setViewportSize({ width: 375, height: 800 });",
    '  await expect(page.getByRole("navigation")).toBeVisible();',
    "});",
  ].join("\n"), ["toBeVisible"]);
  const onlyCandidates = testIntegrityCandidates([onlyCase.file], file => file === onlyCase.file.path ? onlyCase.source : null);
  assert.equal(onlyCandidates.filter(({ kind }) => kind === "responsive").length, 1,
    "supported test modifiers retain their responsive proof candidate");
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
  const awaited = changed("apps/storybook/stories/surfaces-v2/v2-documents-list.stories.tsx", [
    "export const Live: Story = {", "  play: async () => {", "    await expect(idle).not.toBeNull();", "  },", "};",
  ].join("\n"), ["not.toBeNull"]);
  assert.deepEqual(testIntegrityCandidates([awaited.file], path => path === awaited.file.path ? awaited.source : null), []);
  const nested = changed("src/nested.test.tsx", [
    'test("nested", async () => {', "  await expect(",
    '    await waitFor(() => expect(screen.queryByText("b")).toBeFalsy())', "  ).not.toBeNull();", "});",
  ].join("\n"), ["toBeFalsy"]);
  assert.deepEqual(testIntegrityCandidates([nested.file], path => path === nested.file.path ? nested.source : null)
    .map(({ id }) => id), ["absence:src/nested.test.tsx:3"]);
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

test("ISS-13846 final review ADV10-1 a frame on an assertion nested in the candidate's argument is not its failure", () => {
  const shapes = [
    ['test("multi", async () => {', "  expect(",
      '    await waitFor(() => { expect(screen.queryByText("b")).toBeTruthy(); return screen.queryByText("a"); })',
      "  ).toBeNull();", "});"],
    ['test("same", async () => {',
      '  expect(await waitFor(() => expect(screen.queryByText("b")).toBeTruthy())).toBeNull();', "});"],
  ];
  for (const lines of shapes) {
    const fixture = changed("src/nested-frame.test.tsx", lines.join("\n"), ["toBeNull"]);
    const read = path => path === fixture.file.path ? fixture.source : null;
    const [candidate] = testIntegrityCandidates([fixture.file], read);
    const command = "pnpm vitest src/nested-frame.test.tsx";
    const proofAt = (line, column) => withReceipt({ candidate: candidate.id, path: candidate.path, case: candidate.case,
      class: "absence", mutation: "render a", presentState: "a is present", assertionLine: candidate.assertionLine,
      assertionLocation: candidate.assertionLocation, command, observedFailure: "a assertion failed", restoredPass: true,
      commit: COMMIT, ownerBoundary: "production", mountedSignal: "owner mounted",
      mutationRun: { command, exitCode: 1, assertionFailure: `AssertionError: expected null at src/nested-frame.test.tsx:${line}:${column}` } }, fixture.source);
    const problems = proof => testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file], read, COMMIT, RECEIPT_DIR);
    const innerLine = lines.findIndex(text => text.includes("expect(screen.queryByText")) + 1;
    const matcherLine = lines.findIndex(text => text.includes(").toBeNull()")) + 1;
    assert.notDeepEqual(problems(proofAt(innerLine, lines[innerLine - 1].indexOf("expect(screen") + 1)), [], lines[1]);
    assert.deepEqual(problems(proofAt(matcherLine, lines[matcherLine - 1].lastIndexOf(".toBeNull") + 2)), [], lines[1]);
    assert.deepEqual(problems(proofAt(2, 3)), [], lines[1]);
  }
});

test("ISS-13846 final review F14 a frame inside the argument is not the candidate's failure, and an unreadable proof source cannot bind", () => {
  const lines = ['test("helper", async () => {', "  expect(await expectBannerGone(screen)).toBeNull();",
    '  expect(screen.getByText("other")).toBeVisible();', "});"];
  const fixture = changed("src/argument-frame.test.tsx", lines.join("\n"), ["expectBannerGone"]);
  const read = path => path === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  const command = "pnpm vitest src/argument-frame.test.tsx";
  const proofAt = (line, column, assertionFailure) => withReceipt({ candidate: candidate.id, path: candidate.path,
    case: candidate.case, class: "absence", mutation: "render the banner", presentState: "banner is present",
    assertionLine: candidate.assertionLine, assertionLocation: candidate.assertionLocation, command,
    observedFailure: "banner assertion failed", restoredPass: true, commit: COMMIT, ownerBoundary: "production",
    mountedSignal: "owner mounted", mutationRun: { command, exitCode: 1,
      assertionFailure: assertionFailure ?? `AssertionError: expected null at src/argument-frame.test.tsx:${line}:${column}` } }, fixture.source);
  const problems = (proof, proofRead = read) => testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file],
    proofRead, COMMIT, RECEIPT_DIR, read);
  assert.notDeepEqual(problems(proofAt(2, lines[1].indexOf("expectBannerGone") + 1)), [], "a helper frame inside the argument");
  assert.deepEqual(problems(proofAt(2, 3)), []);
  assert.deepEqual(problems(proofAt(2, lines[1].indexOf(".toBeNull") + 2)), []);
  const laterFrame = [` FAIL  src/argument-frame.test.tsx > ${candidate.case}`, "AssertionError: expected visible",
    " ❯ src/argument-frame.test.tsx:3:3", `    2| ${lines[1]}`, `  > 3| ${lines[2]}`].join("\n");
  // Without the proof source the receipt cannot bind, so the no-source frame match is never reached.
  assert.match(problems(proofAt(3, 3, laterFrame), () => null).join("\n"), /receipt before hash does not match the tested source/);
});

test("ISS-13846 final review ADV15-1 an unreadable test source cannot bind a later line through a production-file receipt", () => {
  const lines = ['test("owner", () => {', '  expect(screen.queryByText("stale")).toBeNull();',
    '  expect(screen.getByText("other")).toBeVisible();', "});"];
  const fixture = changed("src/owner-proof.test.tsx", lines.join("\n"), ["toBeNull"]);
  const readCandidates = path => path === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], readCandidates);
  const owner = "export const Owner = () => null;";
  const hash = value => createHash("sha256").update(value).digest("hex");
  const command = "pnpm vitest src/owner-proof.test.tsx";
  const failure = [` FAIL  src/owner-proof.test.tsx > ${candidate.case}`, "AssertionError: expected visible",
    " ❯ src/owner-proof.test.tsx:3:3", `    2| ${lines[1]}`, `  > 3| ${lines[2]}`].join("\n");
  const mutationEdit = { old: owner, new: `${owner} void "intentional mutation";` };
  const receipt = { candidate: candidate.id, target: "src/owner.tsx", command, mutationExit: 1, mutationOutput: failure,
    restoredExit: 0, restoredOutput: "Test Files 1 passed", head: COMMIT, beforeSha256: hash(owner),
    mutatedSha256: hash(owner.replace(mutationEdit.old, mutationEdit.new)), mutationEdit };
  const name = `proof-${receiptNumber++}.json`;
  const bytes = JSON.stringify(receipt);
  writeFileSync(path.join(RECEIPT_DIR, name), bytes);
  const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
    mutation: "render stale", presentState: "stale is present", assertionLine: candidate.assertionLine,
    assertionLocation: candidate.assertionLocation, command, observedFailure: "stale assertion failed", restoredPass: true,
    commit: COMMIT, ownerBoundary: "production", mountedSignal: "owner mounted",
    mutationRun: { command, exitCode: 1, assertionFailure: failure },
    rawReceipt: name, rawReceiptSha256: hash(bytes), restoredOutputSha256: hash(receipt.restoredOutput) };
  const readProof = path => path === "src/owner.tsx" ? owner : null;
  assert.match(testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file], readProof, COMMIT, RECEIPT_DIR,
    readCandidates).join("\n"), /exact assertion failure|proof source/);
});

test("ISS-13846 final review R16D-1 a genuine mutation containing replacement tokens binds its receipt", () => {
  const lines = ['test("price", () => {', '  expect(screen.queryByText("stale")).toBeNull();', "});"];
  const fixture = changed("src/price.test.tsx", lines.join("\n"), ["toBeNull"]);
  const read = path => path === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  const command = "pnpm vitest src/price.test.tsx";
  const proof = { candidate: candidate.id, path: candidate.path, case: candidate.case, class: "absence",
    mutation: "render stale", presentState: "stale is present", assertionLine: candidate.assertionLine,
    assertionLocation: candidate.assertionLocation, command, observedFailure: "stale assertion failed", restoredPass: true,
    commit: COMMIT, ownerBoundary: "production", mountedSignal: "owner mounted",
    mutationRun: { command, exitCode: 1, assertionFailure: "AssertionError: expected null at src/price.test.tsx:2:3" } };
  for (const token of ["$'", "$`", "$&", "$$"]) {
    const bound = withReceipt(proof, fixture.source, ` void formatPrice("${token}");`);
    assert.deepEqual(testIntegrityProblems({ testIntegrityProofs: [bound] }, [fixture.file], read, COMMIT, RECEIPT_DIR), [], token);
  }
});

test("ISS-13846 final review F11-1 a frame on another assertion sharing the candidate's closing line is not its failure", () => {
  const lines = ['test("closing", () => {', "  expect(", '    screen.queryByText("a")',
    '  ).toBeNull(); expect(screen.queryByText("b")).toBeTruthy();', "});"];
  const fixture = changed("src/closing-line.test.tsx", lines.join("\n"), ['queryByText("a")']);
  const read = path => path === fixture.file.path ? fixture.source : null;
  const [candidate] = testIntegrityCandidates([fixture.file], read);
  const command = "pnpm vitest src/closing-line.test.tsx";
  const proofAt = column => withReceipt({ candidate: candidate.id, path: candidate.path, case: candidate.case,
    class: "absence", mutation: "render a", presentState: "a is present", assertionLine: candidate.assertionLine,
    assertionLocation: candidate.assertionLocation, command, observedFailure: "a assertion failed", restoredPass: true,
    commit: COMMIT, ownerBoundary: "production", mountedSignal: "owner mounted",
    mutationRun: { command, exitCode: 1, assertionFailure: `AssertionError: expected null at src/closing-line.test.tsx:4:${column}` } }, fixture.source);
  const problems = proof => testIntegrityProblems({ testIntegrityProofs: [proof] }, [fixture.file], read, COMMIT, RECEIPT_DIR);
  assert.notDeepEqual(problems(proofAt(lines[3].indexOf("expect(screen") + 1)), []);
  assert.deepEqual(problems(proofAt(lines[3].indexOf(".toBeNull") + 2)), []);
});

test("ISS-13846 final review F11-2 a callback check inside a positive assertion's argument keeps main's candidate", () => {
  const multiline = changed("src/callback.test.tsx", [
    'test("callback", async () => {', "  await expect(await waitFor(() => {",
    '    if (screen.queryByText("b")) throw new Error("b is shown");', "    return cell;", "  })).not.toBeNull();", "});",
  ].join("\n"), ['queryByText("b")']);
  assert.deepEqual(testIntegrityCandidates([multiline.file], path => path === multiline.file.path ? multiline.source : null)
    .map(({ id }) => id), ["absence:src/callback.test.tsx:3"]);
  const sameLine = changed("src/callback-line.test.tsx", [
    'test("callback", async () => {',
    '  await expect(await waitFor(() => (screen.queryByText("b") ? null : cell))).not.toBeNull();', "});",
  ].join("\n"), ["waitFor"]);
  assert.deepEqual(testIntegrityCandidates([sameLine.file], path => path === sameLine.file.path ? sameLine.source : null)
    .map(({ id }) => id), ["absence:src/callback-line.test.tsx:2"]);
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

test("ISS-13846 final review L-NEG a card count excluding loading items in a recognized form keeps its layout proof", () => {
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
  const compared = changed("e2e/documents-summary-cards.spec.ts", [
    'test("one summary card", async ({ page }) => {',
    '  expect(cards.filter((card) => card.status !== "loading")).toHaveLength(1);',
    '  expect(cards.filter((card) => card.dataset.busy === "false")).toHaveLength(1);',
    "});",
  ].join("\n"), ['!== "loading"', '=== "false"']);
  assert.deepEqual(testIntegrityCandidates([compared.file], path => path === compared.file.path ? compared.source : null)
    .filter(({ kind }) => kind === "layout").map(({ id }) => Number(id.split(":").at(-1))), [2, 3],
    "a count filtered by an inequality or a false comparison counts ordinary cards");
  const sibling = changed("e2e/documents-summary-cards.spec.ts", [
    'test("one summary card", async ({ page }) => {',
    '  expect(within(summary).getAllByRole("article")).toHaveLength(1); expect(status).toHaveTextContent("Loading");',
    "});",
  ].join("\n"), ["toHaveLength(1)"]);
  assert.deepEqual(testIntegrityCandidates([sibling.file], path => path === sibling.file.path ? sibling.source : null)
    .filter(({ kind }) => kind === "layout").map(({ id }) => Number(id.split(":").at(-1))), [2],
    "a busy word in a sibling statement does not exempt the count (ADV15-2)");
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
