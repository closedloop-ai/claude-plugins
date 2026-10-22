import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseUnifiedDiff, runDiffRules, transactionBodies } from "./diff-rules.mjs";
import { git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";

const isFrozenStory = (text) => / v1\.0\//.test(text);

function put(root, files) {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(path.join(root, file));
      continue;
    }
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

/** Findings as [rule, file] for a base commit of `base` files and an uncommitted (or committed) `head`. */
function run(t, { history = [], base = {}, head = {}, changeLog = "", commit = false }) {
  const { root, home, cleanup } = makeHome("vibe-diff-rules-");
  t.after(cleanup);
  const checkout = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", checkout], home);
  for (const step of history) {
    put(checkout, step.files);
    git(checkout, ["add", "-A"], home);
    git(checkout, ["commit", "--quiet", "--allow-empty", "-m", step.message], home);
  }
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
  const table = {
    "apps/desktop/prisma/migrations/20261021000000_placement/migration.sql": "CREATE TABLE \"placement_sync_outbox\" (id int);\n",
    "apps/desktop/src/main/agent-sync/use-placement.js": "import { delay } from \"./placement-outbox\";\n",
  };
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

test("a diagnostic that dumps the whole environment blocks; reading named keys does not", (t) => {
  const result = run(t, { head: {
    "scripts/diag.mjs": "writeFileSync(report, JSON.stringify(process.env, null, 2));\nconst child = spawn(cmd, { env: { ...process.env, CI: \"1\" } });\nconsole.log(process.env.NODE_ENV);\n",
    "scripts/diag.sh": "#!/bin/sh\nenv > /tmp/env.txt\necho \"$HOME\"\n",
    "tools/diag.py": "import os\nprint(dict(os.environ))\nprint(os.environ.get(\"CI\"))\n",
  } });
  assert.deepEqual(result.blocking.filter((finding) => finding.rule === "env-dump").map((finding) => [finding.file, finding.line]),
    [["scripts/diag.mjs", 1], ["scripts/diag.sh", 2], ["tools/diag.py", 2]]);
});

test("a component or file a human removed is not brought back without a restore authorization (#8957, ISS-6005)", (t) => {
  const toolbar = "packages/app/sessions/sessions-toolbar.tsx";
  const badge = "packages/app/sessions/read-source-badge.tsx";
  const withPill = "export const Toolbar = () => (\n  <Bar>\n    <ReadSourceBadge source={source} />\n  </Bar>\n);\n";
  const withoutPill = "export const Toolbar = () => (\n  <Bar>\n  </Bar>\n);\n";
  const history = [
    { message: "Add sessions toolbar", files: { [toolbar]: withPill, [badge]: "export const ReadSourceBadge = () => null;\n", "packages/app/sessions/legacy-row.tsx": "export const LegacyRow = 1;\n" } },
    { message: "ISS-6005: remove the cloud pill on desktop and web", files: { [toolbar]: withoutPill, "packages/app/sessions/legacy-row.tsx": null } },
  ];
  const head = { [toolbar]: withPill.replace("<Bar>", "<Bar>\n    <NewFilter />"), "packages/app/sessions/legacy-row.tsx": "export const LegacyRow = 2;\n" };
  const bare = run(t, { history, head });
  const restored = bare.blocking.filter((finding) => finding.rule === "restored-removal");
  assert.deepEqual(restored.map((finding) => [finding.file, finding.line]), [[toolbar, 4], ["packages/app/sessions/legacy-row.tsx", 1]]);
  assert.match(restored[0].problem, /mounts ReadSourceBadge, removed by commit \w+ ISS-6005: remove the cloud pill/);
  assert.match(restored[1].problem, /adds back a file deleted by commit \w+ ISS-6005/);
  const changeLog = "Restore authorization: ReadSourceBadge: operator ruling, 2026-10-21, session thread; overrides ISS-6005\n"
    + "Restore authorization: packages/app/sessions/legacy-row.tsx: Pat Example, 2026-10-21, ISS-12 comment; overrides ISS-6005\n";
  assert.deepEqual(run(t, { history, head, changeLog }).found.filter(([rule]) => rule === "restored-removal"), []);
  const noSlug = "Restore authorization: ReadSourceBadge: operator ruling, 2026-10-21, session thread\n";
  assert.equal(run(t, { history, head, changeLog: noSlug }).found.some(([rule, file]) => rule === "restored-removal" && file === toolbar), true);
});

test("in a shallow clone the restored-removal check deepens the history to find the removal, and blocks only when that fails", (t) => {
  const toolbar = "packages/app/sessions/sessions-toolbar.tsx";
  const withPill = "export const Toolbar = () => (\n  <Bar>\n    <ReadSourceBadge source={source} />\n  </Bar>\n);\n";
  const shallowSession = (reachable) => {
    const { root, home, cleanup } = makeHome("vibe-diff-rules-shallow-");
    t.after(cleanup);
    const origin = path.join(root, "origin");
    git(root, ["init", "--quiet", "--initial-branch=main", origin], home);
    const commit = (files, message) => {
      put(origin, files);
      git(origin, ["add", "-A"], home);
      git(origin, ["commit", "--quiet", "-m", message], home);
    };
    commit({ [toolbar]: withPill }, "Add sessions toolbar");
    commit({ [toolbar]: "export const Toolbar = () => (\n  <Bar>\n  </Bar>\n);\n" }, "ISS-6005: remove the cloud pill");
    commit({ "README.md": "base\n" }, "base");
    const checkout = path.join(root, "wt");
    git(root, ["clone", "--quiet", "--depth", "1", `file://${origin}`, checkout], home);
    const base = git(checkout, ["rev-parse", "HEAD"], home);
    if (!reachable) {
      git(checkout, ["remote", "set-url", "origin", `file://${path.join(root, "gone")}`], home);
    }
    put(checkout, { [toolbar]: withPill });
    const result = runDiffRules({ worktree: checkout, base, isFrozenStory, changeLog: path.join(root, "no-log.md") });
    return { result, shallow: git(checkout, ["rev-parse", "--is-shallow-repository"], home) };
  };
  const deepened = shallowSession(true);
  const restored = deepened.result.blocking.filter((finding) => finding.rule === "restored-removal");
  assert.equal(restored.length, 1);
  assert.match(restored[0].problem, /mounts ReadSourceBadge, removed by commit \w+ ISS-6005/);
  assert.equal(deepened.shallow, "false");
  const failed = shallowSession(false).result.blocking.filter((finding) => finding.rule === "restored-removal");
  assert.equal(failed.length, 1);
  assert.match(failed[0].problem, /deepening it failed \(git fetch --deepen=1000: /);
});

test("removing a mount or a user-visible string main ships needs a recorded human source; moved ones do not (#8947)", (t) => {
  const menu = "packages/app/links/row-menu.tsx";
  const base = { [menu]: [
    "export const RowMenu = () => (",
    "  <Menu>",
    "    <MenuItem label=\"Open\" />",
    "    <MenuItem label=\"View linked sessions\" />",
    "    <LinkedBadge />",
    "  </Menu>",
    ");",
    "",
  ].join("\n"), "packages/app/links/other.tsx": "export const Other = () => <div />;\n" };
  const head = { [menu]: "export const RowMenu = () => (\n  <Menu>\n    <MenuItem label=\"Open\" />\n  </Menu>\n);\n",
    "packages/app/links/other.tsx": "export const Other = () => <div><LinkedBadge /></div>;\n" };
  const removals = run(t, { base, head }).blocking.filter((finding) => finding.rule === "capability-removal");
  assert.deepEqual(removals.map((finding) => finding.problem.match(/removes (.*?) that the base ships/)?.[1]), ["\"View linked sessions\""]);
  const changeLog = "Removal: \"View linked sessions\": ISS-4259 comment by Pat Example, 2026-10-21\n";
  assert.deepEqual(run(t, { base, head, changeLog }).found.filter(([rule]) => rule === "capability-removal"), []);
  const unmounted = run(t, { base, head: { [menu]: base[menu].replace("    <LinkedBadge />\n", "") } }).blocking.filter((finding) => finding.rule === "capability-removal");
  assert.match(unmounted[0].problem, /removes the LinkedBadge mount/);
});

test("copy provenance: a new toast, label or JSX string needs a cited source; existing and moved copy pass", (t) => {
  const file = "packages/app/tags/remove-tags.tsx";
  const base = { [file]: "export function A() {\n  return <Button aria-label=\"Close\">Save</Button>;\n}\n" };
  const head = { "packages/app/tags/use-tags.js": "import { A, B } from \"./remove-tags\";\n", [file]: [
    "export function A({ n }) {",
    "  toast.success(`Removed ${tag} from ${n} items`);",
    "  const ok = a > limit && b < 3;",
    "  return <Button aria-label=\"Close\" title=\"Remove tag\" variant=\"ghost\">Save</Button>;",
    "}",
    "export const B = () => <p className=\"x\">Nothing matched your filters</p>;",
    "",
  ].join("\n") };
  const bare = run(t, { base, head });
  assert.deepEqual(bare.blocking.map((finding) => [finding.rule, finding.line]), [["copy-provenance", 2], ["copy-provenance", 4], ["copy-provenance", 6]]);
  assert.match(bare.blocking[0].fix, /Copy: "Removed \$\{tag\} from \$\{n\} items": <ticket, PRD or person's words/);
  const cited = "Copy: \"Removed ${tag} from ${n} items\": ISS-1 AC2\nCopy: \"Remove tag\": PRD-1 R3\nCopy: \"Nothing matched your filters\": ISS-1 AC4\n";
  assert.deepEqual(run(t, { base, head, changeLog: cited }).found, []);
  const elsewhere = { ...base, "apps/app/old-toast.tsx": "toast.success(`Removed ${label} from ${count} items`);\n" };
  assert.deepEqual(run(t, { base: elsewhere, head }).blocking.map((finding) => finding.line), [4, 6]);
  assert.deepEqual(run(t, { head: { "packages/app/tags/remove-tags.test.tsx": "toast(\"Brand new words\");\n" } }).found, []);
  assert.deepEqual(run(t, { head: { "src/ui/banner.jsx": "export const B = () => <p>Brand new words</p>;\n", "src/ui/use-banner.js": "import { B } from \"./banner\";\n" } }).found, [["copy-provenance", "src/ui/banner.jsx"]]);
});

test("a lost story ID blocks unless recorded as a replacement, and every reference to it blocks", (t) => {
  const story = "export default { title: \"Composites/Rows\" };\nexport const Default = {};\nexport const WithLongText = {};\n";
  const result = run(t, {
    base: {
      "s/rows.stories.tsx": story,
      "e2e/rows.spec.ts": "goto('?path=/story/composites-rows--with-long-text');\n",
      "e2e/other.spec.ts": "composites-rows--default\n",
      "apps/desktop/test/e2e/helpers/story-urls.ts": "export const LONG = \"composites-rows--with-long-text\";\n",
    },
    head: { "s/rows.stories.tsx": "export default { title: \"Composites/Rows\" };\nexport const Default = {};\n" },
  });
  assert.deepEqual(result.found, [["lost-story-id", "s/rows.stories.tsx"], ["lost-story-id", "apps/desktop/test/e2e/helpers/story-urls.ts"], ["lost-story-id", "e2e/rows.spec.ts"]]);
});

test("a changed route requires the web and Desktop specs that reach its endpoint only through a helper, never the helper (#8967)", (t) => {
  const route = "apps/api/app/artifact-links/batch-move/route.ts";
  const webHelper = "e2e/helpers/sessions-list-fixtures.ts";
  const desktopHelper = "apps/desktop/test/e2e/helpers/sessions-list-project-cloud.ts";
  const result = run(t, {
    base: {
      [route]: "export const POST = 1;\n",
      [webHelper]: "const BATCH_MOVE_PATH = \"/artifact-links/batch-move\";\nexport const mockMove = (page) => page.route(`**${BATCH_MOVE_PATH}**`, handler);\n",
      "e2e/sessions-linked-entity-columns.spec.ts": "import {\n  mockMove,\n} from \"./helpers/sessions-list-fixtures\";\ntest(\"moves\", () => mockMove(page));\n",
      [desktopHelper]: "export const isMove = (request, pathname) => request.method === \"POST\" && pathname === \"/artifact-links/batch-move\";\n",
      "apps/desktop/test/e2e/sessions-list-project-edit.spec.ts": "import {\n  isMove,\n} from \"./helpers/sessions-list-project-cloud\";\ntest(\"edits\", () => isMove(request, path));\n",
      "e2e/helpers/unrelated.ts": "export const other = \"/documents\";\n",
      "e2e/unrelated.spec.ts": "import { other } from \"./helpers/unrelated\";\n",
    },
    head: { [route]: "export const POST = 2;\n" },
  });
  assert.deepEqual(result.requiredTests.map((entry) => entry.path).sort(), [
    "apps/desktop/test/e2e/sessions-list-project-edit.spec.ts",
    "e2e/sessions-linked-entity-columns.spec.ts",
  ]);
});

test("route specs follow helper imports two hops and scan every e2e-named root", (t) => {
  const route = "apps/api/app/artifact-links/batch-move/route.ts";
  const result = run(t, {
    base: {
      [route]: "export const POST = 1;\n",
      "e2e/helpers/paths.ts": "export const MOVE = \"/artifact-links/batch-move\";\n",
      "e2e/helpers/move-flow.ts": "export { MOVE } from \"./paths\";\nimport { MOVE } from \"./paths.js\";\n",
      "e2e/move-flow.spec.ts": "import { MOVE } from \"./helpers/move-flow\";\n",
      "e2e-web-smoke/boot.spec.ts": "await request.post(\"/artifact-links/batch-move\");\n",
      "packages/app/client.ts": "fetch(\"/artifact-links/batch-move\");\n",
    },
    head: { [route]: "export const POST = 2;\n" },
  });
  assert.deepEqual(result.requiredTests.map((entry) => entry.path).sort(), ["e2e-web-smoke/boot.spec.ts", "e2e/move-flow.spec.ts"]);
  assert.match(result.requiredTests.find((entry) => entry.path === "e2e/move-flow.spec.ts").reason, /e2e\/helpers\/paths\.ts/);
});

test("route specs require only the specs importing a helper export that reaches the endpoint; unresolvable imports fall back with a reason", (t) => {
  const route = "apps/api/app/artifact-links/batch-move/route.ts";
  const helper = [
    "// Mocks for /artifact-links/batch-move and the list.",
    "const BATCH_MOVE_PATH = \"/artifact-links/batch-move\";",
    "const BATCH_MOVE_URL_GLOB = `**${BATCH_MOVE_PATH}**`;",
    "export function sessionListRow(id) {",
    "  return { id, label: \"{ not a brace }\" };",
    "}",
    "export async function installProjectWriteMocks(",
    "  page,",
    "  moves",
    ") {",
    "  await page.route(BATCH_MOVE_URL_GLOB, (r) => moves.push(r));",
    "}",
    "const wrap = (page) => installProjectWriteMocks(page, []);",
    "export { wrap as installWrapped };",
    "",
  ].join("\n");
  const result = run(t, {
    base: {
      [route]: "export const POST = 1;\n",
      "e2e/helpers/fixtures.ts": helper,
      "e2e/rows.spec.ts": "import { sessionListRow } from \"./helpers/fixtures\";\n",
      "e2e/rows-typed.spec.ts": "import type { installProjectWriteMocks } from \"./helpers/fixtures\";\nimport { sessionListRow } from \"./helpers/fixtures\";\n",
      "e2e/move.spec.ts": "import {\n  installProjectWriteMocks,\n  sessionListRow,\n} from \"./helpers/fixtures\";\n",
      "e2e/wrapped.spec.ts": "import { installWrapped as setup } from \"./helpers/fixtures\";\n",
      "e2e/helpers/rows-only.ts": "import { sessionListRow } from \"./fixtures\";\nexport const rows = () => [sessionListRow(1)];\n",
      "e2e/rows-deep.spec.ts": "import { rows } from \"./helpers/rows-only\";\n",
      "e2e/helpers/move-reexport.ts": "export { installProjectWriteMocks as mockMoves } from \"./fixtures\";\n",
      "e2e/move-deep.spec.ts": "import { mockMoves } from \"./helpers/move-reexport\";\n",
      "e2e/namespace.spec.ts": "import * as fixtures from \"./helpers/fixtures\";\n",
    },
    head: { [route]: "export const POST = 2;\n" },
  });
  const required = new Map(result.requiredTests.map((entry) => [entry.path, entry.reason]));
  assert.deepEqual([...required.keys()].sort(), ["e2e/move-deep.spec.ts", "e2e/move.spec.ts", "e2e/namespace.spec.ts", "e2e/wrapped.spec.ts"]);
  assert.match(required.get("e2e/move.spec.ts"), /imports installProjectWriteMocks from e2e\/helpers\/fixtures\.ts/);
  assert.match(required.get("e2e/namespace.spec.ts"), /file-level fallback: namespace import/);
});

test("a spec importing only the helper export that does not reach the changed endpoint is not required", (t) => {
  const route = "apps/api/app/artifact-links/batch-move/route.ts";
  const result = run(t, {
    base: {
      [route]: "export const POST = 1;\n",
      "e2e/helpers/two-exports.ts": "export const mockMove = (page) => page.route(\"**/artifact-links/batch-move\", handler);\nexport const rowFixture = (id) => ({ id });\n",
      "e2e/move.spec.ts": "import { mockMove } from \"./helpers/two-exports\";\n",
      "e2e/rows.spec.ts": "import { rowFixture } from \"./helpers/two-exports\";\n",
    },
    head: { [route]: "export const POST = 2;\n" },
  });
  assert.deepEqual(result.requiredTests.map((entry) => entry.path), ["e2e/move.spec.ts"]);
});

test("a repo-declared path gate becomes a required run when the diff touches its paths", (t) => {
  const gates = JSON.stringify({ gates: [{ name: "catalog-imports", paths: ["apps/prototypes/**"], command: "node apps/prototypes/scripts/check-catalog-imports.mjs" }] });
  const touched = run(t, { base: { ".vibe/path-gates.json": gates }, head: { "apps/prototypes/src/page.tsx": "export const x = 1;\n" } });
  assert.ok(touched.requiredTests.some((entry) => entry.path === "node apps/prototypes/scripts/check-catalog-imports.mjs"));
  const elsewhere = run(t, { base: { ".vibe/path-gates.json": gates }, head: { "apps/app/page.tsx": "export const x = 1;\n" } });
  assert.ok(!elsewhere.requiredTests.some((entry) => entry.path.includes("check-catalog-imports")));
});

test("the repo's Storybook rules block the session diff and require its Storybook checks (#8953, #8960)", (t) => {
  const rules = JSON.stringify({
    noOpHandler: { pattern: String.raw`\bonUpdate\w*:\s*\(\)\s*=>\s*undefined` },
    checks: [{ name: "validate-catalog", command: "pnpm --filter storybook validate:catalog" }],
  });
  const file = "packages/app/documents/components/table/documents-view.stories.tsx";
  const meta = "// No controls: fixture.\nconst meta = { title: \"Composites/Documents View\" };\nexport default meta;\n";
  const result = run(t, {
    base: { ".vibe/storybook-rules.json": rules, [file]: meta },
    head: { [file]: `${meta}const editHandlers = { onUpdatePriority: () => undefined };\n` },
  });
  assert.deepEqual(result.found, [["story-no-op-handler", file]]);
  assert.ok(result.requiredTests.some((entry) => entry.path === "pnpm --filter storybook validate:catalog"));
  const undeclared = run(t, { base: { [file]: meta }, head: { [file]: `${meta}const editHandlers = { onUpdatePriority: () => undefined };\n` } });
  assert.deepEqual(undeclared.found, []);
});

test("a new sort comparator needs a recorded tie test that exists", (t) => {
  const head = { "p/rank.ts": "export const ranked = (rows) => rows.sort((a, b) => b.score - a.score);\n", "p/use-rank.ts": "import { ranked } from \"./rank\";\n" };
  assert.deepEqual(run(t, { head }).found, [["comparator-tie", "p/rank.ts"]]);
  assert.deepEqual(run(t, { head, changeLog: "Comparator: p/rank.ts: tie test p/rank.test.ts\n" }).found, [["comparator-tie", "p/rank.ts"]], "the cited test must exist");
  const tested = { ...head, "p/rank.test.ts": "test('two rows tied on score keep id order', () => {});\n" };
  assert.deepEqual(run(t, { head: tested, changeLog: "Comparator: p/rank.ts: tie test p/rank.test.ts\n" }).found, []);
});

test("a new export no other file uses blocks unless recorded; existing and framework exports do not", (t) => {
  assert.deepEqual(run(t, { head: { "p/outbox.ts": "export function flushOutbox() {}\n" } }).found, [["unused-export", "p/outbox.ts"]]);
  assert.deepEqual(run(t, { head: { "p/outbox.ts": "export function flushOutbox() {}\n" }, changeLog: "Export: flushOutbox: imported by the sync worker in ISS-1\n" }).found, []);
  assert.deepEqual(run(t, { base: { "p/old.ts": "export const old = 1;\n" }, head: { "p/old.ts": "export const old = 2;\n" } }).found, []);
  assert.deepEqual(run(t, { head: { "app/api/x/route.ts": "export async function GET() {}\n" } }).found, []);
});

test("a shared component's change requires every host's suites, in both flag states when it reads a flag", (t) => {
  const base = {
    "packages/ui/grid.tsx": "export const Grid = (props) => props.rows;\n",
    "apps/a/sessions.tsx": "import { Grid } from \"@repo/ui/grid\";\nexport const Sessions = Grid;\n",
    "apps/b/documents.tsx": "import { Grid } from \"@repo/ui/grid\";\nexport const Documents = Grid;\n",
    "apps/a/sessions.test.tsx": "import { Sessions } from \"./sessions\";\n",
    "apps/b/documents.stories.tsx": "import { Documents } from \"./documents\";\n",
    "apps/c/one.tsx": "import { Only } from \"@repo/ui/only\";\nexport const One = Only;\n",
    "packages/ui/only.tsx": "export const Only = 1;\n",
  };
  const suites = ["apps/a/sessions.test.tsx", "apps/b/documents.stories.tsx"];
  const plain = run(t, { base, head: { "packages/ui/grid.tsx": "export const Grid = (props) => props.rows.slice();\n" }, commit: true });
  assert.deepEqual(plain.requiredTests.filter((entry) => suites.includes(entry.path)).map((entry) => [entry.path, entry.flagStates]), suites.map((suite) => [suite, undefined]));
  assert.deepEqual(plain.found, []);

  const flagged = run(t, { base, head: { "packages/ui/grid.tsx": "export const Grid = (props) => (useFeatureFlag(props.k) ? props.rows : []);\n" }, commit: true });
  assert.deepEqual(flagged.requiredTests.filter((entry) => suites.includes(entry.path)).map((entry) => entry.flagStates), [["on", "off"], ["on", "off"]]);
  assert.deepEqual(flagged.found, [["shared-flag-branch", "packages/ui/grid.tsx"]]);
  const keyed = run(t, { base, head: { "packages/ui/grid.tsx": "export const Grid = (props) => (useFeatureFlag(props.k) ? props.rows : []);\n" }, commit: true, changeLog: "Shared behavior: packages/ui/grid.tsx: keyed on hideSelectAll; hosts run: both\n" });
  assert.deepEqual(keyed.found, []);
  assert.equal(keyed.requiredTests.filter((entry) => suites.includes(entry.path)).length, 2, "keying it does not drop the hosts' runs");

  const single = run(t, { base, head: { "packages/ui/only.tsx": "export const Only = 2;\n" }, commit: true });
  assert.deepEqual(single.requiredTests, [], "a component one host imports is not shared");
});
