import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseUnifiedDiff, runDiffRules, transactionBodies } from "./diff-rules.mjs";
import { git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";

const isFrozenStory = (text) => / v1\.0\//.test(text);

function put(root, files) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

/** Findings as [rule, file] for a base commit of `base` files and an uncommitted (or committed) `head`. */
function run(t, { base = {}, head = {}, changeLog = "", commit = false }) {
  const { root, home, cleanup } = makeHome("vibe-diff-rules-");
  t.after(cleanup);
  const checkout = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", checkout], home);
  put(checkout, { "README.md": "seed\n", ...base });
  git(checkout, ["add", "-A"], home);
  git(checkout, ["commit", "--quiet", "-m", "base"], home);
  const baseSha = git(checkout, ["rev-parse", "HEAD"], home);
  put(checkout, head);
  if (commit) {
    git(checkout, ["add", "-A"], home);
    git(checkout, ["commit", "--quiet", "-m", "session"], home);
  }
  writeFileSync(path.join(git(checkout, ["rev-parse", "--absolute-git-dir"], home), "vibe-changes.md"), changeLog);
  const result = runDiffRules({ worktree: checkout, base: baseSha, isFrozenStory });
  return { ...result, found: result.blocking.map((finding) => [finding.rule, finding.file]) };
}

test("the diff parser keeps line numbers, drops private plans, and finds transaction bodies", () => {
  const files = parseUnifiedDiff([
    "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -3,1 +3,2 @@", "-old", "+new", "+more",
    "diff --git a/.closedloop-ai/vibe-plans/p.md b/.closedloop-ai/vibe-plans/p.md", "new file mode 100644",
    "--- /dev/null", "+++ b/.closedloop-ai/vibe-plans/p.md", "@@ -0,0 +1 @@", "+plan",
  ].join("\n"));
  assert.deepEqual(files.map((file) => [file.path, file.removed, file.added]), [["a.ts", [{ line: 3, text: "old" }], [{ line: 3, text: "new" }, { line: 4, text: "more" }]]]);
  assert.deepEqual(transactionBodies("x\nwithDb.tx(async (tx) => {\n  a();\n});\n"), [[2, 4]]);
});

test("migrations: an existing table needs its recorded precedent, a full-table backfill blocks, and the repo gates run", (t) => {
  const file = "packages/database/prisma/migrations/20261021000000_link_kind/migration.sql";
  const sql = [
    "CREATE TABLE \"fresh\" (id int);",
    "CREATE INDEX \"fresh_i\" ON \"fresh\"(id);",
    "CREATE INDEX \"artifact_links_kind_idx\" ON \"artifact_links\"(\"kind\");",
    "UPDATE \"artifact_links\" SET \"kind\" = 'x';",
    "ALTER TABLE \"y\" ADD CONSTRAINT \"y_fk\" FOREIGN KEY (\"a\") REFERENCES \"z\"(\"id\") ON UPDATE CASCADE;",
  ].join("\n");
  const bare = run(t, { head: { [file]: sql } });
  assert.deepEqual(bare.found, [["migration-precedent", file], ["migration-precedent", file], ["migration-backfill", file]]);
  assert.deepEqual(bare.requiredChecks.map((check) => check.command), ["pnpm check:destructive-migrations", "pnpm check:migration-immutability"]);
  const logged = run(t, { head: { [file]: sql }, changeLog: "Migration precedent: artifact_links: a, b, c\nMigration precedent: y: d, e, f\n" });
  assert.deepEqual(logged.found, []);
});

test("backend writes: uncaptured artifact fields, errors after a transaction write, and unscoped link deletes block", (t) => {
  const write = "await tx.artifact.updateMany({\n  where: { id: { in: ids } },\n  data: { projectId: target },\n});\n";
  const partial = "export const run = () => withDb.tx(async (tx) => {\n  await tx.artifactLink.create({ data });\n  if (cycle) {\n    return Result.err(Status.Conflict);\n  }\n});\n";
  const result = run(t, {
    head: {
      "apps/api/app/a/raw.ts": write,
      "apps/api/app/a/captured.ts": `${write}captureBatchProjectChange({ tx });\n`,
      "apps/api/app/a/logged.ts": write,
      "apps/api/app/a/sort-key.ts": "await tx.artifact.updateMany({ where: {}, data: { sortKey: 1 } });\n",
      "apps/api/app/a/partial.ts": partial,
      "apps/api/app/a/validated.ts": partial.replace("  await tx.artifactLink.create({ data });\n", "").replace("});\n", "  await tx.artifactLink.create({ data });\n});\n"),
      "apps/api/app/a/broad-delete.ts": "await tx.artifactLink.deleteMany({ where: { targetId: id, linkType: L } });\n",
      "apps/api/app/a/exact-delete.ts": "await tx.artifactLink.deleteMany({ where: { sourceId: p, targetId: id, linkType: L } });\n",
    },
    changeLog: "Activity capture: apps/api/app/a/logged.ts: the caller's captureBatchProjectChange\n",
  });
  assert.deepEqual(result.found.sort(), [
    ["activity-capture", "apps/api/app/a/raw.ts"],
    ["artifact-link-delete", "apps/api/app/a/broad-delete.ts"],
    ["tx-result-after-write", "apps/api/app/a/partial.ts"],
  ]);
});

test("a new Desktop sync lane needs the shared give-up, the shared backoff, a Susan pass and the roster", (t) => {
  const lane = "apps/desktop/src/main/agent-sync/placement-outbox.ts";
  const table = { "apps/desktop/prisma/migrations/20261021000000_placement/migration.sql": "CREATE TABLE \"placement_sync_outbox\" (id int);\n" };
  const bare = run(t, { head: { [lane]: "export const delay = (attempt) => 1000 * 2 ** attempt;\n", ...table } });
  assert.equal(bare.found.filter(([rule]) => rule === "desktop-sync-lane").length, 4);
  const done = run(t, {
    head: { [lane]: "import { LaneGiveUpStampDefect } from \"../../shared/lane-give-up.js\";\nexport const delay = (n) => exponentialBackoffMs(n + 1);\n", ...table },
    changeLog: "Synchronizing-susan: no findings\nEngineering needed (forbidden path): apps/desktop/src/main/sync/AGENTS.md; why: roster\n",
  });
  assert.deepEqual(done.found, []);
});

test("a dropped ticketed comment blocks while its code survives; moved, reworded or deleted with its code it does not", (t) => {
  const comment = (slug) => `// ${slug}: keep the id tiebreak so equal ranks stay stable\nexport const order${slug.slice(4)} = (a, b) => a.id.localeCompare(b.id);\n`;
  const result = run(t, {
    base: { "p/dropped.ts": comment("ISS-1"), "p/moved.ts": comment("ISS-2"), "p/reworded.ts": comment("ISS-3"), "p/deleted.ts": `${comment("ISS-4")}export const keep = 1;\n` },
    head: {
      "p/dropped.ts": comment("ISS-1").split("\n").slice(1).join("\n"),
      "p/moved.ts": "export { order2 } from \"./sort\";\n",
      "p/sort.ts": comment("ISS-2"),
      "p/reworded.ts": comment("ISS-3").replace("keep the id tiebreak", "the id tiebreak keeps"),
      "p/deleted.ts": "export const keep = 1;\n",
    },
    commit: true,
  });
  assert.deepEqual(result.found, [["ticketed-comment", "p/dropped.ts"]]);
});

test("a modified service that two files import needs a recorded parity line", (t) => {
  const importing = (stem) => ({ [`apps/api/app/x-${stem}/service.ts`]: `import { f } from "../../lib/${stem}";\n`, [`apps/api/app/y-${stem}/service.ts`]: `import { f } from "@/lib/${stem}.js";\n` });
  const result = run(t, {
    base: { "apps/api/lib/shared.ts": "a\n", "apps/api/lib/ruled.ts": "a\n", "apps/api/lib/single.ts": "a\n", ...importing("shared"), ...importing("ruled"), "apps/api/app/z/service.ts": "import { f } from \"../../lib/single\";\n" },
    head: { "apps/api/lib/shared.ts": "b\n", "apps/api/lib/ruled.ts": "b\n", "apps/api/lib/single.ts": "b\n" },
    changeLog: "Shared path: apps/api/lib/ruled.ts: changed; ruling: ISS-1 operator comment\n",
  });
  assert.deepEqual(result.found, [["shared-path", "apps/api/lib/shared.ts"]]);
});

test("stories: a flipped assertion needs a release, a new entry beside a current one or for a harness blocks", (t) => {
  const meta = (title, component = "Rows") => `export default { title: "${title}", component: ${component}, tags: ["stable"] };\n`;
  const story = `${meta("Composites/Rows")}export const Refused = { play: async () => { await expect(alert).toBeVisible(); } };\n`;
  const flipped = story.replace("toBeVisible()", "not.toBeInTheDocument()");
  const result = run(t, {
    base: { "s/rows.stories.tsx": story, "s/cards.stories.tsx": meta("Composites v1.0/Cards", "Cards") },
    head: {
      "s/rows.stories.tsx": flipped,
      "s/rows-touch.stories.tsx": meta("Composites/Rows Touch"),
      "s/cards-current.stories.tsx": meta("Composites/Cards", "Cards"),
      "s/rows-harness.stories.tsx": meta("Composites/Rows Harness", "RowsHarness"),
    },
  });
  assert.deepEqual(result.found.sort(), [
    ["story-entry", "s/rows-harness.stories.tsx"],
    ["story-entry", "s/rows-touch.stories.tsx"],
    ["story-outcome", "s/rows.stories.tsx"],
  ]);
  const released = run(t, {
    base: { "s/rows.stories.tsx": story, "apps/storybook/package.json": "{\n  \"version\": \"3.2.4\"\n}\n" },
    head: { "s/rows.stories.tsx": flipped, "apps/storybook/package.json": "{\n  \"version\": \"3.3.0\"\n}\n" },
  });
  assert.deepEqual(released.found, []);
});

test("a change anywhere in a frozen story's import closure blocks until its identical render is recorded", (t) => {
  const base = {
    "apps/storybook/stories/row.stories.tsx": "import { Row } from \"@repo/design-system/components/row\";\nexport default { title: \"Composites v1.0/Row\" };\n",
    "packages/design-system/components/row.tsx": "import { cell } from \"./cell\";\nexport const Row = cell;\n",
    "packages/design-system/components/cell.tsx": "export const cell = 1;\n",
    "packages/design-system/components/other.tsx": "export const other = 1;\n",
  };
  const deep = run(t, { base, head: { "packages/design-system/components/cell.tsx": "export const cell = 2;\n" } });
  assert.deepEqual(deep.found, [["frozen-render", "apps/storybook/stories/row.stories.tsx"]]);
  assert.deepEqual(run(t, { base, head: { "packages/design-system/components/other.tsx": "export const other = 2;\n" } }).found, []);
  const recorded = run(t, { base, head: { "packages/design-system/components/cell.tsx": "export const cell = 2;\n" }, changeLog: "Frozen render unchanged: all 1 stories: storybook test-runner on base and branch, identical\n" });
  assert.deepEqual(recorded.found, []);
});

test("routes, GridTableV2 and story titles require the tests the graph does not map", (t) => {
  const tests = ["apps/app/__tests__/grid-table-v2-surface-capability-parity.test.ts", "apps/app/__tests__/sessions-list-v2-host-capability-parity.test.ts", "apps/storybook/__tests__/preview-story-sort-order.test.ts", "apps/storybook/__tests__/story-group-order.test.ts"];
  const result = run(t, {
    base: {
      ...Object.fromEntries(tests.map((file) => [file, "test\n"])),
      "apps/api/app/documents/[id]/links/route.ts": "export const POST = 1;\n",
      "e2e/links.spec.ts": "await request.post(`/documents/${id}/links`, { data: body });\n",
      "e2e/other.spec.ts": "await request.post('/documents/abc/linksets');\n",
      "packages/design-system/lib/grid-table-v2-types.ts": "export type A = 1;\n",
      "s/rows.stories.tsx": "export default { title: \"Composites/Rows\" };\n",
    },
    head: {
      "apps/api/app/documents/[id]/links/route.ts": "export const POST = 2;\n",
      "packages/design-system/lib/grid-table-v2-types.ts": "export type A = 2;\n",
      "s/rows.stories.tsx": "export default { title: \"Composites/Row List\" };\n",
    },
  });
  assert.deepEqual(result.requiredTests.map((entry) => entry.path), ["e2e/links.spec.ts", ...tests]);
});

test("a lost story ID blocks unless recorded as a replacement, and every reference to it blocks", (t) => {
  const story = "export default { title: \"Composites/Rows\" };\nexport const Default = {};\nexport const WithLongText = {};\n";
  const result = run(t, {
    base: { "s/rows.stories.tsx": story, "e2e/rows.spec.ts": "goto('?path=/story/composites-rows--with-long-text');\n", "e2e/other.spec.ts": "composites-rows--default\n" },
    head: { "s/rows.stories.tsx": "export default { title: \"Composites/Rows\" };\nexport const Default = {};\n" },
  });
  assert.deepEqual(result.found, [["lost-story-id", "s/rows.stories.tsx"], ["lost-story-id", "e2e/rows.spec.ts"]]);
});
