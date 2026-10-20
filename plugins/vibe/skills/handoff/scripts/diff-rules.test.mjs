import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseUnifiedDiff, runDiffRules, transactionBodies } from "./diff-rules.mjs";
import { git, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "diff-rules.mjs");
const BASE_MIGRATION = "packages/database/prisma/migrations/20261020030000_drop_routines/migration.sql";

/** A checkout whose base commit holds `baseFiles`; `head` files are written uncommitted, `changeLog` beside the session record. */
function session(t, { baseFiles = {}, head = {}, remove = [], changeLog = "", commit = false }) {
  const { root, home, cleanup } = makeHome("vibe-diff-rules-");
  t.after(cleanup);
  const checkout = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", checkout], home);
  for (const [file, content] of Object.entries({ "README.md": "seed\n", [BASE_MIGRATION]: "SELECT 1;\n", ...baseFiles })) {
    mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    writeFileSync(path.join(checkout, file), content);
  }
  git(checkout, ["add", "-A"], home);
  git(checkout, ["commit", "--quiet", "-m", "base"], home);
  const base = git(checkout, ["rev-parse", "HEAD"], home);
  for (const [file, content] of Object.entries(head)) {
    mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    writeFileSync(path.join(checkout, file), content);
  }
  for (const file of remove) {
    rmSync(path.join(checkout, file));
  }
  if (commit) {
    git(checkout, ["add", "-A"], home);
    git(checkout, ["commit", "--quiet", "-m", "session"], home);
  }
  const gitDir = git(checkout, ["rev-parse", "--absolute-git-dir"], home);
  writeFileSync(path.join(gitDir, "vibe-changes.md"), changeLog);
  return { checkout, base, home, result: () => runDiffRules({ worktree: checkout, base }) };
}

const rules = (result) => result.blocking.map((finding) => finding.rule);

test("parseUnifiedDiff keeps added and removed line numbers per file", () => {
  const files = parseUnifiedDiff([
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -3,1 +3,2 @@",
    "-old",
    "+new",
    "+more",
    "diff --git a/.closedloop-ai/vibe-plans/p.md b/.closedloop-ai/vibe-plans/p.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/.closedloop-ai/vibe-plans/p.md",
    "@@ -0,0 +1 @@",
    "+plan",
  ].join("\n"));
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].removed, [{ line: 3, text: "old" }]);
  assert.deepEqual(files[0].added, [{ line: 3, text: "new" }, { line: 4, text: "more" }]);
});

test("a migration older than the base's newest blocks and every migration requires the repo gates", (t) => {
  const older = session(t, { head: { "packages/database/prisma/migrations/20261019000000_add_x/migration.sql": "CREATE TABLE \"x\" (id int);\n" } }).result();
  assert.deepEqual(rules(older), ["migration-order"]);
  assert.deepEqual(older.requiredChecks.map((check) => check.command), ["pnpm check:destructive-migrations", "pnpm check:migration-immutability"]);
  const newer = session(t, { head: { "packages/database/prisma/migrations/20261021000000_add_x/migration.sql": "CREATE TABLE \"x\" (id int);\nCREATE INDEX \"x_i\" ON \"x\"(id);\n" } }).result();
  assert.deepEqual(rules(newer), []);
});

test("a migration on an existing table needs its recorded precedent, and a full-table backfill blocks", (t) => {
  const sql = [
    "CREATE INDEX \"artifact_links_kind_idx\" ON \"artifact_links\"(\"kind\");",
    "UPDATE \"artifact_links\" SET \"kind\" = 'x';",
    "ALTER TABLE \"y\" ADD CONSTRAINT \"y_fk\" FOREIGN KEY (\"a\") REFERENCES \"z\"(\"id\") ON DELETE CASCADE ON UPDATE CASCADE;",
  ].join("\n");
  const file = "packages/database/prisma/migrations/20261021000000_link_kind/migration.sql";
  const bare = session(t, { head: { [file]: sql } }).result();
  assert.deepEqual(rules(bare).sort(), ["migration-backfill", "migration-precedent", "migration-precedent"]);
  assert.ok(bare.blocking.some((finding) => finding.problem.includes("artifact_links")));
  assert.ok(!bare.blocking.some((finding) => finding.problem.includes("CASCADE")));
  const logged = session(t, {
    head: { [file]: sql },
    changeLog: "- Migration precedent: artifact_links: a, b, c\n- Migration precedent: y: d, e, f\n",
  }).result();
  assert.deepEqual(rules(logged), []);
});

test("a raw write of a captured artifact field needs the canonical capture", (t) => {
  const write = "export async function move(tx) {\n  await tx.artifact.updateMany({\n    where: { id: { in: ids } },\n    data: { projectId: target },\n  });\n}\n";
  const file = "apps/api/app/documents/move-service.ts";
  assert.deepEqual(rules(session(t, { head: { [file]: write } }).result()), ["activity-capture"]);
  const captured = `${write}export const after = () => captureBatchProjectChange({ tx });\n`;
  assert.deepEqual(rules(session(t, { head: { [file]: captured } }).result()), []);
  const logged = session(t, { head: { [file]: write }, changeLog: `Activity capture: ${file}: the caller's captureBatchProjectChange\n` }).result();
  assert.deepEqual(rules(logged), []);
  const uncaptured = "await tx.artifact.updateMany({ where: {}, data: { sortKey: 1 } });\n";
  assert.deepEqual(rules(session(t, { head: { [file]: uncaptured } }).result()), []);
});

test("returning an error inside withDb.tx after a write blocks; refusing before the first write does not", (t) => {
  const partial = [
    "export const run = () => withDb.tx(async (tx) => {",
    "  await tx.artifactLink.create({ data });",
    "  if (cycle) {",
    "    return Result.err(Status.Conflict);",
    "  }",
    "  return Result.ok(1);",
    "});",
  ].join("\n");
  const file = "apps/api/app/links/service.ts";
  const found = session(t, { head: { [file]: partial } }).result();
  assert.deepEqual(rules(found), ["tx-result-after-write"]);
  assert.equal(found.blocking[0].line, 4);
  const validated = partial.replace("  await tx.artifactLink.create({ data });\n  if (cycle) {\n    return Result.err(Status.Conflict);\n  }", "  if (cycle) {\n    return Result.err(Status.Conflict);\n  }\n  await tx.artifactLink.create({ data });");
  assert.deepEqual(rules(session(t, { head: { [file]: validated } }).result()), []);
  assert.deepEqual(transactionBodies(partial), [[1, 7]]);
});

test("an artifact link delete must name the exact edge", (t) => {
  const file = "apps/api/app/links/placement.ts";
  const broad = "await tx.artifactLink.deleteMany({\n  where: { targetId: id, linkType: LinkType.Produces },\n});\n";
  assert.deepEqual(rules(session(t, { head: { [file]: broad } }).result()), ["artifact-link-delete"]);
  const exact = "await tx.artifactLink.deleteMany({\n  where: { sourceId: parent, targetId: id, linkType: LinkType.Produces },\n});\n";
  assert.deepEqual(rules(session(t, { head: { [file]: exact } }).result()), []);
});

test("a new Desktop sync lane needs the shared give-up, the shared backoff, a Susan pass and the roster", (t) => {
  const lane = "apps/desktop/src/main/agent-sync/placement-outbox.ts";
  const table = "apps/desktop/prisma/migrations/20261021000000_placement_outbox/migration.sql";
  const handRolled = "export const delay = (attempt) => 1000 * 2 ** attempt;\n";
  const bare = session(t, { head: { [lane]: handRolled, [table]: "CREATE TABLE \"placement_sync_outbox\" (id int);\n" } }).result();
  assert.deepEqual(rules(bare).sort(), ["desktop-sync-lane", "desktop-sync-lane", "desktop-sync-lane", "desktop-sync-lane"]);
  const shared = [
    "import { LaneGiveUpStampDefect } from \"../../shared/lane-give-up.js\";",
    "import { exponentialBackoffMs } from \"../../shared/exponential-backoff.js\";",
    "export const delay = (attempt) => exponentialBackoffMs(attempt + 1);",
  ].join("\n");
  const done = session(t, {
    head: { [lane]: shared, [table]: "CREATE TABLE \"placement_sync_outbox\" (id int);\n" },
    changeLog: "- Synchronizing-susan: no findings\n- Engineering needed (forbidden path): apps/desktop/src/main/sync/AGENTS.md; why: the lane roster names the new lane\n",
  }).result();
  assert.deepEqual(rules(done), []);
});

test("a dropped ticketed comment blocks while its code survives, and not when it moves or the code goes", (t) => {
  const file = "packages/app/shared/lib/order.ts";
  const base = "// ISS-12251: keep the id tiebreak so equal ranks stay stable\nexport const order = (a, b) => a.rank - b.rank || a.id.localeCompare(b.id);\n";
  const dropped = session(t, { baseFiles: { [file]: base }, head: { [file]: "export const order = (a, b) => a.rank - b.rank || a.id.localeCompare(b.id);\n" }, commit: true }).result();
  assert.deepEqual(rules(dropped), ["ticketed-comment"]);
  const moved = session(t, {
    baseFiles: { [file]: base },
    head: { [file]: "export { order } from \"./sort\";\n", "packages/app/shared/lib/sort.ts": base },
  }).result();
  assert.deepEqual(rules(moved), []);
  const deleted = session(t, { baseFiles: { [file]: `${base}export const keep = 1;\n` }, head: { [file]: "export const keep = 1;\n" } }).result();
  assert.deepEqual(rules(deleted), []);
});

test("a modified shared service needs a recorded parity line", (t) => {
  const helper = "apps/api/lib/tree-order.ts";
  const baseFiles = {
    [helper]: "export const sortTree = (rows) => rows;\n",
    "apps/api/app/a/service.ts": "import { sortTree } from \"../../lib/tree-order\";\n",
    "apps/api/app/b/service.ts": "import { sortTree } from \"@/lib/tree-order.js\";\n",
  };
  const changed = { [helper]: "export const sortTree = (rows) => [...rows].reverse();\n" };
  assert.deepEqual(rules(session(t, { baseFiles, head: changed }).result()), ["shared-path"]);
  const logged = session(t, { baseFiles, head: changed, changeLog: `Shared path: ${helper}: changed; ruling: ISS-1 operator comment\n` }).result();
  assert.deepEqual(rules(logged), []);
  const single = { ...baseFiles, "apps/api/app/b/service.ts": "export const b = 1;\n" };
  assert.deepEqual(rules(session(t, { baseFiles: single, head: changed }).result()), []);
});

test("a changed story assertion needs a release, and a new entry beside a current one blocks", (t) => {
  const story = "apps/storybook/stories/rows.stories.tsx";
  const baseStory = "export default { title: \"Composites/Rows\", component: Rows, tags: [\"stable\"] };\nexport const Refused = { play: async () => { await expect(alert).toBeVisible(); } };\n";
  const flipped = baseStory.replace("toBeVisible()", "not.toBeInTheDocument()");
  assert.deepEqual(rules(session(t, { baseFiles: { [story]: baseStory }, head: { [story]: flipped } }).result()), ["story-outcome"]);
  const released = session(t, {
    baseFiles: { [story]: baseStory, "apps/storybook/package.json": "{\n  \"version\": \"3.2.4\"\n}\n" },
    head: { [story]: flipped, "apps/storybook/package.json": "{\n  \"version\": \"3.3.0\"\n}\n" },
  }).result();
  assert.deepEqual(rules(released), []);
  const sibling = session(t, {
    baseFiles: { [story]: baseStory },
    head: { "apps/storybook/stories/rows-touch.stories.tsx": "export default { title: \"Composites/Rows Touch\", component: Rows, tags: [\"stable\"] };\n" },
  }).result();
  assert.deepEqual(rules(sibling), ["story-entry"]);
  const frozen = session(t, {
    baseFiles: { [story]: baseStory.replace("Composites/Rows", "Composites v1.0/Rows") },
    head: { "apps/storybook/stories/rows-current.stories.tsx": "export default { title: \"Composites/Rows\", component: Rows, tags: [\"stable\"] };\n" },
  }).result();
  assert.deepEqual(rules(frozen), []);
  const harness = session(t, { head: { "apps/storybook/stories/rows-preview-harness.stories.tsx": "export default { title: \"Composites/Rows Harness\", component: RowsHarness };\n" } }).result();
  assert.deepEqual(rules(harness), ["story-entry"]);
});

test("route and GridTableV2 changes require the specs and parity tests the graph does not map", (t) => {
  const result = session(t, {
    baseFiles: {
      "apps/api/app/documents/[id]/links/route.ts": "export const POST = 1;\n",
      "e2e/links.spec.ts": "await request.post(`/documents/${id}/links`, { data: body });\n",
      "e2e/other.spec.ts": "await request.post('/documents/abc/linksets');\n",
      "apps/app/__tests__/grid-table-v2-surface-capability-parity.test.ts": "test\n",
      "apps/app/__tests__/sessions-list-v2-host-capability-parity.test.ts": "test\n",
      "packages/design-system/lib/grid-table-v2-types.ts": "export type A = 1;\n",
    },
    head: {
      "apps/api/app/documents/[id]/links/route.ts": "export const POST = 2;\n",
      "packages/design-system/lib/grid-table-v2-types.ts": "export type A = 2;\n",
    },
  }).result();
  assert.deepEqual(result.requiredTests.map((entry) => entry.path), [
    "e2e/links.spec.ts",
    "apps/app/__tests__/grid-table-v2-surface-capability-parity.test.ts",
    "apps/app/__tests__/sessions-list-v2-host-capability-parity.test.ts",
  ]);
});

test("the CLI prints the verdict and exits 1 only when something blocks", (t) => {
  const blocked = session(t, { head: { "packages/database/prisma/migrations/20261019000000_add_x/migration.sql": "SELECT 1;\n" } });
  const failing = runNode(SCRIPT, ["--worktree", blocked.checkout, "--base", blocked.base], blocked.home);
  assert.equal(failing.status, 1);
  assert.equal(failing.json.ok, false);
  const clean = session(t, { head: { "README.md": "changed\n" } });
  const passing = runNode(SCRIPT, ["--worktree", clean.checkout, "--base", clean.base], clean.home);
  assert.equal(passing.status, 0);
  assert.deepEqual(passing.json.blocking, []);
  const missing = runNode(SCRIPT, ["--worktree", clean.checkout], clean.home);
  assert.equal(missing.status, 1);
  assert.match(missing.json.error, /--base/);
});
