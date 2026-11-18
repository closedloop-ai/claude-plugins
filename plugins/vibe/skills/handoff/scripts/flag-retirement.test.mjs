import assert from "node:assert/strict";
import test from "node:test";
import { run } from "./diff-rules-test-fixture.mjs";

const REGISTRY = "packages/api/src/types/retired-feature-flags.ts";
const OWNER = "packages/app/documents/create-document.ts";
const BROWSER = "e2e/documents-create-failure-recovery.spec.ts";
const STORY = "packages/app/documents/create-document.stories.ts";
const PINNED = "e2e/documents-pin-composer.spec.ts";
const OTHER = "e2e/project-list.spec.ts";
const flag = "artifact-creation-composer";

const base = {
  [REGISTRY]: 'export const RetiredFeatureFlag = {\n  Other: "other-flag",\n} as const;\n',
  [OWNER]: `export function openDocument() {\n  return useFeatureFlag("${flag}") ? "Document title" : "Title*";\n}\n`,
  [BROWSER]: "test('recovers', async ({ page }) => {\n  await page.goto('/documents');\n  await page.getByLabel('Title*').fill('draft');\n});\n",
  [STORY]: "import { openDocument } from './create-document';\nexport const Create = { render: openDocument };\n",
  [PINNED]: `configureFlags({ "${flag}": true });\n`,
  [OTHER]: "test('lists projects', async ({ page }) => { await page.goto('/projects'); });\n",
};
const head = {
  [REGISTRY]: base[REGISTRY].replace("} as const;", `  Composer: "${flag}",\n} as const;`),
  [OWNER]: 'export function openDocument() {\n  return "Document title";\n}\n',
  [BROWSER]: base[BROWSER].replace("Title*", "Document title"),
};
const row = (status, path, evidence) => `Flag retirement: ${flag}: ${status} ${path}: ${evidence}`;
const records = [
  row("updated", BROWSER, "the unpinned Documents route now drives the composer title input"),
  row("retained", STORY, "the story imports openDocument and its composer render passed"),
  row("pinned", PINNED, "explicit true in the flag fixture"),
  row("unrelated", OTHER, "visits the Projects list and never opens Documents"),
];
const findings = (result) => result.blocking.filter(({ rule }) => rule === "flag-retirement-inventory");

test("AC-019 retirement demands the unpinned browser and story inventory", (t) => {
  const missing = findings(run(t, { base, head, changeLog: records.slice(2).join("\n") }));
  assert.equal(missing.length, 1);
  assert.match(missing[0].problem, /missing 2 base spec\/story dispositions/);
  assert.ok(missing[0].problem.includes(BROWSER));
  assert.ok(missing[0].problem.includes(STORY));

  const verified = run(t, { base, head, changeLog: records.join("\n") });
  assert.deepEqual(findings(verified), []);
  assert.deepEqual(verified.flagRetirements[0].unpinned, [BROWSER, STORY]);
});

test("AC-019 retirement rejects a claimed update or unrelated story that the source disproves", (t) => {
  const fakeUpdate = findings(run(t, { base, head: { [REGISTRY]: head[REGISTRY], [OWNER]: head[OWNER] }, changeLog: records.join("\n") }));
  assert.ok(fakeUpdate.some(({ problem }) => problem.includes(`${BROWSER} is listed as updated`)));
  const fakeUnrelated = [records[0], row("unrelated", STORY, "claimed unrelated"), ...records.slice(2)];
  assert.ok(findings(run(t, { base, head, changeLog: fakeUnrelated.join("\n") }))
    .some(({ problem }) => problem.includes(`${STORY} imports a former flag owner`)));
});
