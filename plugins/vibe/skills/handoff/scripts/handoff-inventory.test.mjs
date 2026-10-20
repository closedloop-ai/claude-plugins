import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY = path.join(HERE, "handoff-inventory.mjs");
const SESSIONS = path.join(HERE, "..", "..", "vibe", "scripts", "vibe-sessions.mjs");
const RETIRED = path.join(HERE, "..", "..", "vibe", "scripts", "retired-tests.mjs");
const ALLOWLIST = "scripts/lint/source-gate-allowlist.json";
const FOCUS_RING = { rule: "no-hand-rolled-focus-ring", file: "packages/app/a.tsx", fingerprint: "packages/app/a.tsx", count: 1, reason: "seeded" };
const HEX = { rule: "no-hex-color-in-jsx-styling", file: "apps/app/b.tsx", fingerprint: "apps/app/b.tsx", count: 3, reason: "seeded" };
const allowlist = (entries) =>
  `${JSON.stringify({ registeredRules: ["no-hand-rolled-focus-ring", "no-hex-color-in-jsx-styling"], entries }, null, 2)}\n`;

function setup(t, slug, extraFiles = {}) {
  const fixture = makeHome("handoff-inventory-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, "Documents", "Closedloop.ai - Active Work", "symphony-alpha");
  makeCheckout({
    root: fixture.root,
    home: fixture.home,
    checkout,
    files: {
      "scripts/loops-setup.sh": "echo old\n",
      ".github/workflows/ci.yml": "on: push\n",
      "apps/app/page.tsx": "export const page = 1;\n",
      "apps/web/content/docs/concepts/bulk-actions.mdx": "Bulk actions.\n",
      "apps/web/content/docs/api-reference/projects/listProjects.mdx": "generated\n",
      "apps/web/content/docs/meta.json": "{\"pages\":[]}\n",
      "docs/runbooks/bulk-actions.md": "Runbook.\n",
      [ALLOWLIST]: allowlist([FOCUS_RING, HEX]),
      ...extraFiles,
    },
  });
  const created = runNode(
    SESSIONS,
    ["new", "--repo", checkout, "--slug", slug, "--summary", slug, "--mode", "seeded", "--operator-id", "user-operator", "--operator-email", "operator@example.com"],
    fixture.home
  );
  assert.equal(created.status, 0, created.stderr);
  return { ...fixture, worktree: created.json.session.worktree };
}

function write(worktree, file, content) {
  const absolute = path.join(worktree, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

test("worktree-local plans are not deliverables and neighboring artifacts fail closed", (t) => {
  const { home, worktree } = setup(t, "private-plan");
  write(worktree, ".closedloop-ai/vibe-plans/request-1.md", "private plan\n");
  write(worktree, ".closedloop-ai/vibe-plans-other.md", "not a local plan\n");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 1, JSON.stringify(result.json));
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.localPlans, [{ path: ".closedloop-ai/vibe-plans/request-1.md", status: "A" }]);
  assert.deepEqual(result.json.trackedLocalPlans, []);
  assert.deepEqual(result.json.changedFiles.map(file => file.path), [".closedloop-ai/vibe-plans-other.md", "apps/app/page.tsx"]);
  assert.deepEqual(result.json.outsideAllowed, [{ path: ".closedloop-ai/vibe-plans-other.md", status: "A" }]);
});

test("staged or committed plans block handoff instead of hiding a planning leak", (t) => {
  const { home, worktree } = setup(t, "tracked-plan");
  const plan = ".closedloop-ai/vibe-plans/request-1.md";
  write(worktree, plan, "private plan\n");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  git(worktree, ["add", plan], home);
  for (const committed of [false, true]) {
    if (committed) git(worktree, ["commit", "-m", "Fixture: accidentally tracked plan"], home);
    const result = runNode(INVENTORY, ["--worktree", worktree], home);
    assert.equal(result.status, 1);
    assert.equal(result.json.blocking.localPlansUntracked, false);
    assert.deepEqual(result.json.trackedLocalPlans, [plan]);
  }
});

test("root web and desktop test specs are allowed only for a requested pull request, never at handoff", (t) => {
  const { home, worktree } = setup(t, "pull-request-tests");
  write(worktree, "e2e/feature.spec.ts", "export {};\n");
  write(worktree, "apps/desktop/test/feature.spec.ts", "export {};\n");
  write(worktree, "e2e/playwright.config.ts", "export {};\n");
  const specs = [
    { path: "apps/desktop/test/feature.spec.ts", status: "A" },
    { path: "e2e/feature.spec.ts", status: "A" },
    { path: "e2e/playwright.config.ts", status: "A" },
  ];
  const build = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.deepEqual(build.json.outsideAllowed, specs);
  const handoff = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.deepEqual(handoff.json.outsideAllowed, specs);
  const pullRequest = runNode(INVENTORY, ["--worktree", worktree, "--phase", "pull-request"], home);
  assert.deepEqual(pullRequest.json.outsideAllowed, [{ path: "e2e/playwright.config.ts", status: "A" }]);
  const invalid = runNode(INVENTORY, ["--worktree", worktree, "--phase", "unknown"], home);
  assert.equal(invalid.status, 1);
});

test("existing tests and fixtures may be repaired in every phase; only a pull request adds, deletes or snapshot-updates one", (t) => {
  const { home, worktree } = setup(t, "test-repairs", {
    "packages/app/sessions/list.test.tsx": "expect(render(List)).toBeTruthy();\n",
    "packages/app/sessions/__fixtures__/rows.ts": "export const rows = [];\n",
    "packages/app/sessions/__snapshots__/list.test.tsx.snap": "exports[`list`] = `<ul />`;\n",
    "packages/app/sessions/retired.test.tsx": "expect(retired()).toBe(1);\n",
    "e2e/sessions.spec.ts": "test('sessions', () => {});\n",
    "e2e/fixtures/auth.ts": "export const auth = {};\n",
  });
  write(worktree, "packages/app/sessions/list.test.tsx", "expect(render(ListV2)).toBeTruthy();\n");
  write(worktree, "packages/app/sessions/__fixtures__/rows.ts", "export const rows: Row[] = [];\n");
  write(worktree, "packages/app/sessions/__snapshots__/list.test.tsx.snap", "exports[`list`] = `<ol />`;\n");
  write(worktree, "e2e/sessions.spec.ts", "test('sessions', async () => {});\n");
  write(worktree, "e2e/fixtures/auth.ts", "export const auth: Auth = {};\n");
  write(worktree, "packages/app/sessions/new.test.tsx", "expect(1).toBe(1);\n");
  write(worktree, "packages/app/sessions/__tests__/helper.ts", "export {};\n");
  git(worktree, ["rm", "-q", "packages/app/sessions/retired.test.tsx"], home);
  const repairs = [
    { path: "e2e/fixtures/auth.ts", status: "M" },
    { path: "e2e/sessions.spec.ts", status: "M" },
    { path: "packages/app/sessions/__fixtures__/rows.ts", status: "M" },
    { path: "packages/app/sessions/list.test.tsx", status: "M" },
  ];
  const authored = [
    { path: "packages/app/sessions/__snapshots__/list.test.tsx.snap", status: "M" },
    { path: "packages/app/sessions/__tests__/helper.ts", status: "A" },
    { path: "packages/app/sessions/new.test.tsx", status: "A" },
    { path: "packages/app/sessions/retired.test.tsx", status: "D" },
  ];
  for (const phase of ["build", "handoff"]) {
    const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", phase], home);
    assert.deepEqual(result.json.testRepairs, repairs, phase);
    assert.deepEqual(result.json.outsideAllowed, authored, phase);
  }
  const pullRequest = runNode(INVENTORY, ["--worktree", worktree, "--phase", "pull-request"], home);
  assert.deepEqual(pullRequest.json.testRepairs, repairs);
  assert.deepEqual(pullRequest.json.outsideAllowed, []);
});

test("a deleted test is allowed outside a pull request only when recorded as covering retired code", (t) => {
  const { home, worktree } = setup(t, "retired-tests", {
    "packages/app/sessions/grouped-list.test.tsx": "expect(renderGrouped()).toBeTruthy();\n",
    "packages/app/sessions/live.test.tsx": "expect(renderLive()).toBeTruthy();\n",
    "packages/app/sessions/list.test.tsx": "it('flat', () => {});\nit('grouped', () => {});\n",
  });
  git(worktree, ["rm", "-q", "packages/app/sessions/grouped-list.test.tsx", "packages/app/sessions/live.test.tsx"], home);
  write(worktree, "packages/app/sessions/list.test.tsx", "it('flat', () => {});\n");
  const recorded = [
    ["--path", "packages/app/sessions/grouped-list.test.tsx", "--retired-by", "PRD-720", "--covers", "GroupedListRenderer"],
    ["--path", "packages/app/sessions/list.test.tsx", "--case", "grouped", "--retired-by", "PRD-720", "--covers", "the grouped mode"],
  ];
  for (const args of recorded) {
    assert.equal(runNode(RETIRED, ["record", "--worktree", worktree, ...args], home).status, 0);
  }
  for (const phase of ["build", "handoff"]) {
    const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", phase], home);
    assert.deepEqual(result.json.outsideAllowed, [{ path: "packages/app/sessions/live.test.tsx", status: "D" }], phase);
    assert.deepEqual(result.json.testRepairs, [{ path: "packages/app/sessions/list.test.tsx", status: "M" }], phase);
    assert.deepEqual(result.json.retiredTests, [
      { path: "packages/app/sessions/grouped-list.test.tsx", retiredBy: "PRD-720", covers: "GroupedListRenderer", status: "D" },
      { path: "packages/app/sessions/list.test.tsx", case: "grouped", retiredBy: "PRD-720", covers: "the grouped mode", status: "M" },
    ], phase);
  }
  const caseOnly = runNode(RETIRED, ["record", "--worktree", worktree, "--path", "packages/app/sessions/live.test.tsx",
    "--case", "renders", "--retired-by", "PRD-720", "--covers", "nothing retired"], home);
  assert.equal(caseOnly.status, 0);
  const stillOutside = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.deepEqual(stillOutside.json.outsideAllowed, [{ path: "packages/app/sessions/live.test.tsx", status: "D" }]);
});

test("a test repair never admits a harness or a path the session may not edit", (t) => {
  const { home, worktree } = setup(t, "repair-bounds", {
    "e2e/playwright.config.ts": "export default {};\n",
    "apps/mcp/fixtures/tool.ts": "export const tool = {};\n",
  });
  write(worktree, "e2e/playwright.config.ts", "export default { retries: 5 };\n");
  write(worktree, "apps/mcp/fixtures/tool.ts", "export const tool: Tool = {};\n");
  for (const phase of ["build", "handoff", "pull-request"]) {
    const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", phase], home);
    assert.deepEqual(result.json.testRepairs, [], phase);
    assert.deepEqual(result.json.outsideAllowed, [
      { path: "apps/mcp/fixtures/tool.ts", status: "M" },
      { path: "e2e/playwright.config.ts", status: "M" },
    ], phase);
  }
});

test("no docs page is ever an allowed change, in any phase", (t) => {
  const { home, worktree } = setup(t, "feature-docs");
  write(worktree, "apps/web/content/docs/concepts/bulk-actions.mdx", "Bulk actions, agent draft.\n");
  write(worktree, "docs/runbooks/bulk-actions.md", "Runbook, updated draft.\n");
  write(worktree, "apps/web/content/docs/api-reference/projects/listProjects.mdx", "generated, hand edited\n");
  write(worktree, "apps/web/content/docs/meta.json", "{\"pages\":[\"new\"]}\n");
  write(worktree, "apps/web/content/docs/concepts/new-page.mdx", "A page nobody asked for.\n");
  const outside = [
    { path: "apps/web/content/docs/api-reference/projects/listProjects.mdx", status: "M" },
    { path: "apps/web/content/docs/concepts/bulk-actions.mdx", status: "M" },
    { path: "apps/web/content/docs/concepts/new-page.mdx", status: "A" },
    { path: "apps/web/content/docs/meta.json", status: "M" },
    { path: "docs/runbooks/bulk-actions.md", status: "M" },
  ];
  for (const phase of ["build", "handoff", "pull-request"]) {
    const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", phase], home);
    assert.deepEqual(result.json.outsideAllowed, outside, phase);
  }
});

test("local fixes are listed on their own and kept out of every guardrail check", (t) => {
  const { home, worktree } = setup(t, "local-fixes");
  // The setup worker's workaround: a forbidden repo script and a new helper.
  write(worktree, "scripts/loops-setup.sh", "echo fixed\n");
  write(worktree, "apps/app/env-fix.ts", "export const fixed = true;\n");
  runNode(
    SESSIONS,
    ["local-fix", "--worktree", worktree, "--ticket", "ISS-77", "--path", "scripts/loops-setup.sh", "--path", "apps/app/env-fix.ts"],
    home
  );
  // The person's own work.
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.changedFiles, [{ path: "apps/app/page.tsx", status: "M" }]);
  assert.deepEqual(result.json.localFixes, [
    { path: "apps/app/env-fix.ts", status: "A", ticket: "ISS-77" },
    { path: "scripts/loops-setup.sh", status: "M", ticket: "ISS-77" },
  ]);
  assert.deepEqual(result.json.forbidden, []);
  assert.deepEqual(result.json.outsideAllowed, []);
});

test("the same forbidden change is still blocked when it is not a recorded local fix", (t) => {
  const { home, worktree } = setup(t, "no-local-fix");
  write(worktree, ".github/workflows/ci.yml", "on: pull_request\n");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.forbidden, [{ path: ".github/workflows/ci.yml", status: "M" }]);
  assert.deepEqual(result.json.localFixes, []);
});

test("every path outside the allowed table blocks except a shrink-only allowlist", (t) => {
  const { home, worktree } = setup(t, "outside-allowed-blocks", {
    "plugins/product/skills/example/SKILL.md": "# Existing skill\n",
  });
  write(worktree, "scripts/release.mjs", "export const release = true;\n");
  write(worktree, "plugins/product/skills/example/SKILL.md", "# Changed skill\n");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.outsideAllowed, [
    { path: "plugins/product/skills/example/SKILL.md", status: "M" },
    { path: "scripts/release.mjs", status: "A" },
  ]);
});

test("a session whose only changes are local fixes has nothing to hand off", (t) => {
  const { home, worktree } = setup(t, "only-fixes");
  write(worktree, "scripts/loops-setup.sh", "echo fixed\n");
  runNode(
    SESSIONS,
    ["local-fix", "--worktree", worktree, "--ticket", "ISS-77", "--path", "scripts/loops-setup.sh"],
    home
  );

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.hasChanges, false);
  assert.deepEqual(result.json.changedFiles, []);
  assert.equal(result.json.localFixes.length, 1);
});

test("a recorded local fix that was already restored is not listed", (t) => {
  const { home, worktree } = setup(t, "restored");
  runNode(
    SESSIONS,
    ["local-fix", "--worktree", worktree, "--ticket", "ISS-77", "--path", "scripts/loops-setup.sh"],
    home
  );
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 0);
  assert.deepEqual(result.json.localFixes, []);
});

test("committed redeploys count as the session's work and the live ticket is reported", (t) => {
  const { home, worktree } = setup(t, "redeployed");
  write(worktree, "apps/app/page.tsx", "export const page = 3;\n");
  git(worktree, ["add", "apps/app/page.tsx"], home);
  git(worktree, ["commit", "--quiet", "-m", "redeploy 1"], home);
  write(worktree, "apps/app/later.tsx", "export const later = 1;\n");
  runNode(SESSIONS, ["touch", "--worktree", worktree, "--live-ticket", "ISS-90"], home);

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.deepEqual(result.json.changedFiles, [
    { path: "apps/app/later.tsx", status: "A" },
    { path: "apps/app/page.tsx", status: "M" },
  ]);
  assert.equal(result.json.liveTicket, "ISS-90");
  assert.equal(result.json.mode, "seeded");
  assert.equal(result.json.vercel.appUrl, "https://app-stage-git-vibe-redeployed.preview.closedloop-stage.ai");
});

test("a session may only shrink the source-gate allowlist under scripts/", (t) => {
  const { home, worktree } = setup(t, "shrink");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  write(worktree, ALLOWLIST, allowlist([HEX]));
  const removed = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(removed.status, 0, JSON.stringify(removed.json.forbidden));
  assert.deepEqual(removed.json.shrinkOnlyAllowlists, [{ path: ALLOWLIST, status: "M" }]);
  assert.deepEqual(removed.json.forbidden, []);
  assert.deepEqual(removed.json.outsideAllowed, []);

  write(worktree, ALLOWLIST, allowlist([FOCUS_RING, { ...HEX, count: 2 }]));
  assert.deepEqual(runNode(INVENTORY, ["--worktree", worktree], home).json.outsideAllowed, []);

  const grown = { ...HEX, count: 4 };
  const added = { ...HEX, file: "apps/app/c.tsx", fingerprint: "apps/app/c.tsx" };
  for (const entries of [[FOCUS_RING, grown], [FOCUS_RING, HEX, added], [{ ...FOCUS_RING, reason: "changed" }]]) {
    write(worktree, ALLOWLIST, allowlist(entries));
    const refused = runNode(INVENTORY, ["--worktree", worktree], home);
    assert.deepEqual(refused.json.outsideAllowed, [{ path: ALLOWLIST, status: "M" }], JSON.stringify(entries));
    assert.deepEqual(refused.json.shrinkOnlyAllowlists, []);
    assert.equal(refused.json.blocking.forbiddenPaths, false);
    assert.equal(refused.status, 1);
  }

  write(worktree, ALLOWLIST, allowlist([HEX]));
  write(worktree, "scripts/loops-setup.sh", "echo fixed\n");
  const other = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.deepEqual(other.json.outsideAllowed, [{ path: "scripts/loops-setup.sh", status: "M" }]);
  assert.equal(other.json.blocking.forbiddenPaths, false);
  assert.equal(other.status, 1);
});

test("frontend-only work reports no backend change", (t) => {
  const { home, worktree } = setup(t, "frontend-only");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  write(worktree, "packages/app/tags/components/tag-menu.tsx", "export const TagMenu = 1;\n");
  write(worktree, "apps/desktop/src/renderer/view.tsx", "export const view = 1;\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.equal(result.json.backendChanged, false);
  assert.deepEqual(result.json.backendFiles, []);
});

test("backend work is allowed and reported for the full checks", (t) => {
  const { home, worktree } = setup(t, "backend");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  write(worktree, "apps/api/app/tags/route.ts", "export const GET = 1;\n");
  write(worktree, "packages/api/src/types/tag.ts", "export type Tag = string;\n");
  write(worktree, "packages/database/prisma/migrations/1_tags/migration.sql", "select 1;\n");
  write(worktree, "apps/desktop/src/main/tags.ts", "export const tags = 1;\n");

  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.deepEqual(result.json.forbidden, []);
  assert.deepEqual(result.json.outsideAllowed, []);
  assert.equal(result.json.backendChanged, true);
  assert.deepEqual(
    result.json.backendFiles.map((file) => file.path),
    [
      "apps/api/app/tags/route.ts",
      "apps/desktop/src/main/tags.ts",
      "packages/api/src/types/tag.ts",
      "packages/database/prisma/migrations/1_tags/migration.sql",
    ]
  );
});

test("a migration outside the backend packages and a local-fix backend file count the right way", (t) => {
  const { home, worktree } = setup(t, "migration-elsewhere");
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  write(worktree, "apps/desktop/src/server/fix.ts", "export const fix = 1;\n");
  runNode(
    SESSIONS,
    ["local-fix", "--worktree", worktree, "--ticket", "ISS-77", "--path", "apps/desktop/src/server/fix.ts"],
    home
  );
  const withoutBackend = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(withoutBackend.json.backendChanged, false);

  write(worktree, "apps/mcp/prisma/migrations/2_x/migration.sql", "select 1;\n");
  const result = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(result.json.backendChanged, true);
  assert.deepEqual(result.json.backendFiles, [{ path: "apps/mcp/prisma/migrations/2_x/migration.sql", status: "A" }]);
  assert.deepEqual(result.json.outsideAllowed, [{ path: "apps/mcp/prisma/migrations/2_x/migration.sql", status: "A" }]);
});

// The story cases below run on a base with no story-group-order.ts, so the
// version scheme (pre-#8867) applies; handoff-inventory-storybook-scheme.test.mjs
// covers the lifecycle scheme and the move between them.
test("a v1.0 story file is frozen: an edit or move blocks, and new states go in a new v2.0 entry", (t) => {
  const v1Meta = (title, tags) => `export default { title: "${title}", tags: [${tags.map((tag) => `"${tag}"`).join(", ")}] };\n`;
  const subtree = "apps/storybook/stories/composites/sortable-subtree.stories.tsx";
  const treeRow = "apps/storybook/stories/composites/tree-row.stories.tsx";
  const movedTreeRow = "apps/storybook/stories/tree/tree-row.stories.tsx";
  const { home, worktree } = setup(t, "story-taxonomy", {
    [subtree]: v1Meta("Primitives/Data Display/Sortable Subtree", ["autodocs"]),
    [treeRow]: `${v1Meta("Composites/Data Display/Tree Row", ["v1.0"])}export const Default = { args: { label: "Row" } };\n`,
    "apps/storybook/stories/composites-v2/grid-groups.stories.tsx": v1Meta("Composites v2.0/Artifacts/Grid Groups", ["v2.0"]),
  });
  write(worktree, subtree, `${v1Meta("Primitives/Data Display/Sortable Subtree", ["autodocs"])}export const Grouped = {};\n`);
  mkdirSync(path.join(worktree, "apps/storybook/stories/tree"), { recursive: true });
  git(worktree, ["mv", treeRow, movedTreeRow], home);
  write(worktree, "apps/storybook/stories/composites-v2/grid-groups.stories.tsx", v1Meta("Composites v2.0/Artifacts/Grid Groups", ["v2.0", "v1.0"]));
  write(worktree, "packages/app/documents/components/documents-grid-groups-body.stories.tsx", v1Meta("Composites/Documents/Documents Grid Groups Body", ["v1.0"]));
  write(worktree, "apps/storybook/stories/composites-v2/documents-grid-groups-body.stories.tsx", v1Meta("Composites v2.0/Artifacts/Documents/Grid Groups Body", ["v2.0"]));
  const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.storiesInV2Taxonomy, false);
  assert.deepEqual(result.json.v1Stories, [
    { path: "apps/storybook/stories/composites-v2/grid-groups.stories.tsx", status: "M", reasons: ["tag"] },
    { path: subtree, status: "M", reasons: ["frozen"] },
    { path: movedTreeRow, status: "A", from: treeRow, reasons: ["frozen"] },
    { path: "packages/app/documents/components/documents-grid-groups-body.stories.tsx", status: "A", reasons: ["title", "tag"] },
  ]);
  assert.deepEqual(result.json.retitledStories, []);

  git(worktree, ["mv", movedTreeRow, treeRow], home);
  git(worktree, ["checkout", "-q", "--", subtree, "apps/storybook/stories/composites-v2/grid-groups.stories.tsx"], home);
  git(worktree, ["clean", "-qfd", "packages/app"], home);
  write(worktree, "apps/storybook/stories/primitives-v2/sortable-subtree-grouping.stories.tsx", `${v1Meta("Primitives v2.0/Data Display/Sortable Subtree Grouping", ["v2.0"])}export const Grouped = {};\n`);
  const clean = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(clean.json.blocking.storiesInV2Taxonomy, true, JSON.stringify(clean.json.v1Stories));
  assert.deepEqual(clean.json.v1Stories, []);
  assert.equal(clean.status, 0, JSON.stringify(clean.json));
});

test("a compile-only repair of a v1.0 story file passes for engineering review; a story, title, tag or move change still blocks", (t) => {
  const dir = "apps/storybook/stories/composites";
  const v1File = (name, { title = `Composites/Data Display/${name}`, tags = ["v1.0", "autodocs"], prop = "label", from = "@repo/design-system/tree-row", stories = ["Default", "Selected"] } = {}) =>
    [
      `import type { Meta } from "@storybook/react";`,
      `import { TreeRow } from "${from}";`,
      "const meta = {",
      `  title: "${title}",`,
      "  component: TreeRow,",
      `  tags: [${tags.map((tag) => `"${tag}"`).join(", ")}],`,
      "} satisfies Meta<typeof TreeRow>;",
      "export default meta;",
      ...stories.map((story) => `export const ${story} = { args: { ${prop}: "${story}" } };`),
      "",
    ].join("\n");
  const cases = {
    propRename: "Prop Rename",
    addedStory: "Added Story",
    removedStory: "Removed Story",
    renamedStory: "Renamed Story",
    retitled: "Retitled",
    retagged: "Retagged",
    moved: "Moved",
  };
  const file = (key) => `${dir}/${key}.stories.tsx`;
  const movedTo = "apps/storybook/stories/tree/moved.stories.tsx";
  const { home, worktree } = setup(
    t,
    "story-compile-only",
    Object.fromEntries(Object.entries(cases).map(([key, name]) => [file(key), v1File(name)]))
  );
  const repaired = { prop: "text", from: "@repo/design-system/tree/tree-row" };
  write(worktree, file("propRename"), v1File(cases.propRename, repaired));
  write(worktree, file("addedStory"), v1File(cases.addedStory, { ...repaired, stories: ["Default", "Selected", "Disabled"] }));
  write(worktree, file("removedStory"), v1File(cases.removedStory, { ...repaired, stories: ["Default"] }));
  write(worktree, file("renamedStory"), v1File(cases.renamedStory, { ...repaired, stories: ["Default", "Active"] }));
  write(worktree, file("retitled"), v1File(cases.retitled, { ...repaired, title: "Composites/Data Display/Retitled Row" }));
  write(worktree, file("retagged"), v1File(cases.retagged, { ...repaired, tags: ["v1.0"] }));
  mkdirSync(path.join(worktree, "apps/storybook/stories/tree"), { recursive: true });
  git(worktree, ["mv", file("moved"), movedTo], home);
  write(worktree, movedTo, v1File(cases.moved, repaired));

  const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.storiesInV2Taxonomy, false);
  assert.deepEqual(result.json.compileOnlyV1Repairs, [{ path: file("propRename"), status: "M" }]);
  assert.deepEqual(result.json.v1Stories, [
    { path: file("addedStory"), status: "M", reasons: ["frozen"] },
    { path: file("removedStory"), status: "M", reasons: ["frozen"] },
    { path: file("renamedStory"), status: "M", reasons: ["frozen"] },
    { path: file("retagged"), status: "M", reasons: ["frozen"] },
    { path: file("retitled"), status: "M", reasons: ["frozen"] },
    { path: movedTo, status: "A", from: file("moved"), reasons: ["frozen"] },
  ]);

  git(worktree, ["mv", movedTo, file("moved")], home);
  git(worktree, ["checkout", "-q", "--", ...["addedStory", "removedStory", "renamedStory", "retitled", "retagged", "moved"].map(file)], home);
  const repairOnly = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(repairOnly.status, 0, JSON.stringify(repairOnly.json));
  assert.equal(repairOnly.json.blocking.storiesInV2Taxonomy, true);
  assert.deepEqual(repairOnly.json.v1Stories, []);
  assert.deepEqual(repairOnly.json.compileOnlyV1Repairs, [{ path: file("propRename"), status: "M" }]);
});

test("Start Here is unversioned: its Version History and other pages may be edited, re-tagged and retitled while other v1.0 files stay frozen", (t) => {
  const page = (title, tags, releases) =>
    [
      `import type { Meta } from "@storybook/react";`,
      `import packageJson from "../package.json";`,
      `const RELEASES = [${releases.map((version) => `{ version: "${version}" }`).join(", ")}];`,
      "const meta = {",
      `  title: "${title}",`,
      `  tags: [${tags.map((tag) => `"${tag}"`).join(", ")}],`,
      "} satisfies Meta;",
      "export default meta;",
      "export const Page = { args: { releases: RELEASES, version: packageJson.version } };",
      "",
    ].join("\n");
  const history = "apps/storybook/stories/start-here-version-history.stories.tsx";
  const catalog = "apps/storybook/stories/start-here-catalog.stories.tsx";
  const treeRow = "apps/storybook/stories/composites/tree-row.stories.tsx";
  const treeRowMeta = `export default { title: "Composites/Data Display/Tree Row", tags: ["v1.0"] };\nexport const Default = {};\n`;
  const { home, worktree } = setup(t, "start-here-unversioned", {
    [history]: page("Start Here/Version History", ["v1.0"], ["2.0.30"]),
    [catalog]: page("Start Here/Catalog", ["v1.0"], []),
    [treeRow]: treeRowMeta,
  });
  write(worktree, history, page("Start Here/Version History", ["v2.0"], ["2.0.31", "2.0.30"]));
  write(worktree, catalog, page("Start Here/Component Catalog", ["v1.0"], []));
  write(worktree, treeRow, `${treeRowMeta}export const Selected = {};\n`);

  const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.storiesInV2Taxonomy, false);
  assert.deepEqual(result.json.v1Stories, [{ path: treeRow, status: "M", reasons: ["frozen"] }]);
  assert.deepEqual(result.json.compileOnlyV1Repairs, []);
  assert.equal(result.json.blocking.existingStoryTitlesKept, true);
  assert.deepEqual(result.json.retitledStories, []);

  git(worktree, ["checkout", "-q", "--", treeRow], home);
  const startHereOnly = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(startHereOnly.status, 0, JSON.stringify(startHereOnly.json));
  assert.equal(startHereOnly.json.blocking.storiesInV2Taxonomy, true);
  assert.deepEqual(startHereOnly.json.v1Stories, []);
  assert.deepEqual(startHereOnly.json.retitledStories, []);
  assert.deepEqual(startHereOnly.json.changedFiles.map((file) => file.path), [catalog, history]);
});

test("an existing non-v1.0 story file whose meta title changed blocks unless recorded as a replacement's entry", (t) => {
  const meta = (title, tags) => `const meta = {\n  title: "${title}",\n  tags: [${tags.map((tag) => `"${tag}"`).join(", ")}],\n};\nexport default meta;\n`;
  const table = "apps/storybook/stories/grid-table-v2.stories.tsx";
  const toolbar = "apps/storybook/stories/grid-table-toolbar.stories.tsx";
  const footer = "apps/storybook/stories/grid-table-footer.stories.tsx";
  const card = "apps/storybook/stories/grid-table-card.stories.tsx";
  const { home, worktree } = setup(t, "story-retitle", {
    [table]: meta("Composites v2.0/Data Display/Tables/Grid Table V2", ["v2.0"]),
    [toolbar]: meta("Composites v2.0/Data Display/Tables/Grid Table Toolbar", ["v2.0"]),
    [footer]: `${meta("Composites v2.0/Data Display/Tables/Grid Table Footer", ["v2.0"])}export const Default = { args: { label: "Rows" } };\n`,
    [card]: `${meta("Composites v2.0/Data Display/Tables/Grid Table Card", ["v2.0"])}export const Default = { args: { label: "Card" } };\n`,
  });
  write(worktree, table, `${meta("Composites v2.0/Tables/Grid Table V2", ["v2.0"])}export const Grouped = {};\n`);
  write(worktree, toolbar, `${meta("Composites v2.0/Data Display/Tables/Grid Table Toolbar", ["v2.0"])}export const Grouped = { args: { title: "Composites v2.0/Not a meta title" } };\n`);
  mkdirSync(path.join(worktree, "apps/storybook/stories/tables"), { recursive: true });
  git(worktree, ["mv", footer, "apps/storybook/stories/tables/grid-table-footer.stories.tsx"], home);
  write(worktree, "apps/storybook/stories/tables/grid-table-footer.stories.tsx", `${meta("Composites v2.0/Tables/Grid Table Footer", ["v2.0"])}export const Default = { args: { label: "Rows" } };\n`);
  git(worktree, ["mv", card, "apps/storybook/stories/tables/grid-table-card.stories.tsx"], home);
  git(worktree, ["commit", "--quiet", "-m", "redeploy 1"], home);

  const result = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.blocking.existingStoryTitlesKept, false);
  assert.deepEqual(result.json.v1Stories, []);
  assert.deepEqual(result.json.retitledStories, [
    { path: table, baseTitle: "Composites v2.0/Data Display/Tables/Grid Table V2", title: "Composites v2.0/Tables/Grid Table V2", replacement: null },
    {
      path: "apps/storybook/stories/tables/grid-table-footer.stories.tsx",
      from: footer,
      baseTitle: "Composites v2.0/Data Display/Tables/Grid Table Footer",
      title: "Composites v2.0/Tables/Grid Table Footer",
      replacement: null,
    },
  ]);

  const rejected = runNode(SESSIONS, ["story-replacement", "--worktree", worktree, "--path", "apps/app/page.tsx", "--replacement", "GridTableV3"], home);
  assert.equal(rejected.status, 1);
  assert.match(rejected.json.error, /must name a story file/);
  for (const story of [table, footer]) {
    const recorded = runNode(SESSIONS, ["story-replacement", "--worktree", worktree, "--path", story, "--replacement", "GridTableV3"], home);
    assert.equal(recorded.status, 0, JSON.stringify(recorded.json));
  }
  const replaced = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.equal(replaced.json.blocking.existingStoryTitlesKept, true, JSON.stringify(replaced.json.retitledStories));
  assert.equal(replaced.status, 0, JSON.stringify(replaced.json.blocking));
  assert.deepEqual(replaced.json.retitledStories.map((story) => story.replacement), ["GridTableV3", "GridTableV3"]);
});

test("all of apps/storybook is allowed while root scripts, .github and AGENTS.md stay out", (t) => {
  const { home, worktree } = setup(t, "storybook-wiring", {
    "apps/storybook/.storybook/main.ts": "export default {};\n",
    "apps/storybook/.storybook/preview.tsx": "export default {};\n",
    "apps/storybook/TAXONOMY.md": "# Taxonomy\n",
    "apps/storybook/scripts/taxonomy-classification.mjs": "export const DS_PRIMITIVES = [];\n",
    "apps/storybook/AGENTS.md": "# Storybook\n",
  });
  const storybook = [
    "apps/storybook/.storybook/decorators/flag-decorator.tsx",
    "apps/storybook/.storybook/main.ts",
    "apps/storybook/.storybook/manager.ts",
    "apps/storybook/.storybook/preview.tsx",
    "apps/storybook/scripts/taxonomy-classification.mjs",
    "apps/storybook/TAXONOMY.md",
  ];
  for (const file of storybook) write(worktree, file, "export const changed = true;\n");
  const allowed = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(allowed.status, 0, JSON.stringify(allowed.json));
  assert.deepEqual(allowed.json.changedFiles.map((file) => file.path), storybook);
  assert.deepEqual(allowed.json.outsideAllowed, []);
  assert.deepEqual(allowed.json.forbidden, []);

  write(worktree, "scripts/lint/rules/no-threaded-feature-flag.ts", "export {};\n");
  write(worktree, ".github/workflows/storybook-release.yml", "on: release\n");
  write(worktree, "apps/storybook/AGENTS.md", "# Storybook, changed\n");
  const refused = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.blocking.forbiddenPaths, false);
  assert.deepEqual(refused.json.forbidden, [
    { path: ".github/workflows/storybook-release.yml", status: "A" },
    { path: "apps/storybook/AGENTS.md", status: "M" },
  ]);
  assert.deepEqual(refused.json.outsideAllowed, [{ path: "scripts/lint/rules/no-threaded-feature-flag.ts", status: "A" }]);
});

test("diff rule findings block the inventory and its required tests are reported, local fixes left out", (t) => {
  const { home, worktree } = setup(t, "diff-rules", {
    "apps/app/__tests__/grid-table-v2-surface-capability-parity.test.ts": "test\n",
    "packages/design-system/lib/grid-table-v2-types.ts": "export type A = 1;\n",
  });
  write(worktree, "packages/design-system/lib/grid-table-v2-types.ts", "export type A = 2;\n");
  const clean = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(clean.status, 0, JSON.stringify(clean.json));
  assert.equal(clean.json.blocking.diffRulesClear, true);
  assert.deepEqual(clean.json.diffRules.requiredTests.map((entry) => entry.path), ["apps/app/__tests__/grid-table-v2-surface-capability-parity.test.ts"]);

  const write_ = "await tx.artifactLink.deleteMany({ where: { targetId: id } });\n";
  write(worktree, "apps/api/app/links/fix.ts", write_);
  runNode(SESSIONS, ["local-fix", "--worktree", worktree, "--ticket", "ISS-77", "--path", "apps/api/app/links/fix.ts"], home);
  assert.equal(runNode(INVENTORY, ["--worktree", worktree], home).json.blocking.diffRulesClear, true);

  write(worktree, "apps/api/app/links/service.ts", write_);
  const blocked = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal(blocked.status, 1);
  assert.equal(blocked.json.blocking.diffRulesClear, false);
  assert.deepEqual(blocked.json.diffRules.blocking.map((finding) => [finding.rule, finding.file]), [["artifact-link-delete", "apps/api/app/links/service.ts"]]);
});
