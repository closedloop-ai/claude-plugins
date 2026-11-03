import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";
import { STORY_GROUP_ORDER_PATH, StorybookScheme, storybookSchemeOf } from "./storybook-taxonomy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY = path.join(HERE, "handoff-inventory.mjs");
const SESSIONS = path.join(HERE, "..", "..", "vibe", "scripts", "vibe-sessions.mjs");

// Excerpts of symphony-alpha's apps/storybook/story-group-order.ts as each
// scheme declares itself: before #8867 (ISS-12610) there is no lifecycle and
// the current roots carry `v2.0`; from #8867 on the file exports the lifecycle
// tags and the v1.0 baseline version.
const VERSION_SCHEME_ORDER = [
  `export const storybookPatternsV2Root = "Patterns v2.0";`,
  `export const storybookNextVersion = "v2.0";`,
  "export function storybookVersionedRoot(level: string, version: string) {",
  "  return `${level} ${version}`;",
  "}",
  "",
].join("\n");
const LIFECYCLE_SCHEME_ORDER = [
  "export const StorybookLifecycle = {",
  `  Experimental: "experimental",`,
  `  Preview: "preview",`,
  `  Stable: "stable",`,
  `  Deprecated: "deprecated",`,
  "} as const;",
  "export type StorybookLifecycle =",
  "  (typeof StorybookLifecycle)[keyof typeof StorybookLifecycle];",
  "",
  "export const storybookLifecycleTags: readonly StorybookLifecycle[] =",
  "  Object.values(StorybookLifecycle);",
  "",
  `/** The v1.0 baseline: Deprecated, titled under "<Level> v1.0". */`,
  `export const storybookBaselineVersion = "v1.0";`,
  "",
  `/** The current release: titled under the plain "<Level>" root. */`,
  `export const storybookNextVersion = "v2.0";`,
  "",
].join("\n");
const LIFECYCLE_SUMMARY = {
  name: StorybookScheme.Lifecycle,
  frozenTag: "deprecated",
  frozenRoots: "<Level> v1.0",
  lifecycleTags: ["experimental", "preview", "stable", "deprecated"],
};

// A story file whose meta keeps its title and tags apart from its stories, so
// a main import that retitles it and a session that adds a story merge cleanly.
const story = (title, tags, stories = ["Default"]) =>
  [
    `import type { Meta } from "@storybook/react";`,
    "const meta = {",
    `  title: "${title}",`,
    `  tags: [${tags.map((tag) => `"${tag}"`).join(", ")}],`,
    "  parameters: { layout: \"padded\" },",
    "  args: { label: \"Row\" },",
    "  argTypes: {},",
    "} satisfies Meta;",
    "export default meta;",
    "",
    ...stories.map((name) => `export const ${name} = { args: { label: "${name}" } };`),
    "",
  ].join("\n");

function setup(t, slug, files) {
  const fixture = makeHome("handoff-storybook-scheme-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, "Documents", "Closedloop.ai - Active Work", "symphony-alpha");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout, files: { "apps/app/page.tsx": "export const page = 1;\n", ...files } });
  const created = runNode(
    SESSIONS,
    ["new", "--repo", checkout, "--slug", slug, "--summary", slug, "--mode", "seeded", "--operator-id", "user-operator", "--operator-email", "operator@example.com"],
    fixture.home
  );
  assert.equal(created.status, 0, created.stderr);
  return { ...fixture, checkout, worktree: created.json.session.worktree };
}

function write(root, file, content) {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function inventory(worktree, home) {
  return runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
}

test("the base's story-group-order.ts decides the scheme, read from its own lifecycle and baseline constants", () => {
  assert.deepEqual(storybookSchemeOf(undefined).summary, { name: StorybookScheme.Version });
  assert.deepEqual(storybookSchemeOf(VERSION_SCHEME_ORDER).summary, { name: StorybookScheme.Version });
  const lifecycle = storybookSchemeOf(LIFECYCLE_SCHEME_ORDER);
  assert.deepEqual(lifecycle.summary, LIFECYCLE_SUMMARY);
  assert.equal(lifecycle.frozenTitle(story("Composites v1.0/Data Display/Tree Row", ["deprecated"])), true);
  assert.equal(lifecycle.frozenTitle(story("Composites/Artifacts/Grid Groups", ["stable"])), false);
  assert.equal(lifecycle.frozenTitle(story("Composites v2.0/Shared/Artifact List/Documents View", ["v2.0"])), false);
  assert.equal(lifecycle.frozenTag(story("Composites/Artifacts/Grid Groups", ["stable"])), false);
  assert.equal(lifecycle.frozenTag(story("Composites v1.0/Data Display/Tree Row", ["deprecated", "autodocs"])), true);
  assert.equal(lifecycle.frozenTag(story("Composites/Artifacts/Grid Groups", ["!deprecated", "stable"])), false);
  const version = storybookSchemeOf(VERSION_SCHEME_ORDER);
  assert.equal(version.frozenTitle(story("Composites/Artifacts/Grid Groups", ["stable"])), true);
  assert.equal(version.frozenTitle(story("Composites v2.0/Artifacts/Grid Groups", ["v2.0"])), false);

  // The next rename on symphony-alpha's side moves the checks with it.
  const renamed = storybookSchemeOf(LIFECYCLE_SCHEME_ORDER.replace(`Deprecated: "deprecated"`, `Deprecated: "retired"`).replace(`= "v1.0"`, `= "v2.0"`));
  assert.deepEqual(renamed.summary, { ...LIFECYCLE_SUMMARY, frozenTag: "retired", frozenRoots: "<Level> v2.0", lifecycleTags: ["experimental", "preview", "stable", "retired"] });
  assert.equal(renamed.frozenTitle(story("Composites v2.0/Artifacts/Grid Groups", ["stable"])), true);
  assert.equal(renamed.frozenTag(story("Composites/Artifacts/Grid Groups", ["retired"])), true);

  const unreadable = storybookSchemeOf("export const StorybookLifecycle = Object.freeze(LIFECYCLE);\n");
  assert.equal(unreadable.summary.name, StorybookScheme.Unrecognized);
  assert.match(unreadable.summary.problem, /update the vibe plugin/);
});

test("on a lifecycle base the current roots are not frozen: new entries go there and existing ones take extra stories", (t) => {
  // The 1.0.47 failure: every plain-root story file, new or edited, read as v1.0.
  const gridGroups = "apps/storybook/stories/composites-v2/v2-grid-groups.stories.tsx";
  const button = "apps/storybook/stories/primitives-v2/button.stories.tsx";
  const { home, worktree } = setup(t, "lifecycle-current-root", {
    [STORY_GROUP_ORDER_PATH]: LIFECYCLE_SCHEME_ORDER,
    [gridGroups]: story("Composites/Artifacts/Grid Groups", ["stable"]),
    [button]: story("Primitives/Actions/Button", ["stable", "autodocs"]),
  });
  write(worktree, gridGroups, story("Composites/Artifacts/Grid Groups", ["stable"], ["Default", "Grouped"]));
  write(worktree, button, story("Primitives/Actions/Button", ["stable", "autodocs"], ["Default", "Pending"]));
  write(worktree, "packages/app/documents/components/table/documents-view.stories.tsx", story("Composites/Shared/Artifact List/Documents View", ["stable", "autodocs"]));
  write(worktree, "apps/storybook/stories/composites-v2/v2-issues-list.stories.tsx", story("Composites/Labs/Issues/Issues List/Toolbar", ["preview"]));
  write(worktree, "apps/storybook/stories/composites-v2/v2-judges.stories.tsx", story("Composites/Not In The Live App/Judges/Judge Detail/Header", ["experimental"]));
  const result = inventory(worktree, home);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.deepEqual(result.json.storybookScheme, LIFECYCLE_SUMMARY);
  assert.equal(result.json.blocking.storiesInV2Taxonomy, true);
  assert.deepEqual(result.json.v1Stories, []);
  assert.deepEqual(result.json.compileOnlyV1Repairs, []);
  assert.deepEqual(result.json.retitledStories, []);
});

test("on a lifecycle base the v1.0 roots and the deprecated tag are frozen, with the compile-only repair kept", (t) => {
  const treeRow = "apps/storybook/stories/tree-row.stories.tsx";
  const repaired = "apps/storybook/stories/tree-cell.stories.tsx";
  const moved = "apps/storybook/stories/tree-node.stories.tsx";
  const movedTo = "apps/storybook/stories/tree/tree-node.stories.tsx";
  const history = "apps/storybook/stories/start-here-version-history.stories.tsx";
  const deprecatedRow = (name, stories) => story(`Composites v1.0/Data Display/${name}`, ["deprecated", "autodocs"], stories);
  const { home, worktree } = setup(t, "lifecycle-frozen", {
    [STORY_GROUP_ORDER_PATH]: LIFECYCLE_SCHEME_ORDER,
    [treeRow]: deprecatedRow("Tree Row"),
    [repaired]: deprecatedRow("Tree Cell"),
    [moved]: deprecatedRow("Tree Node"),
    [history]: story("Start Here/Version History", ["stable"]),
  });
  write(worktree, treeRow, deprecatedRow("Tree Row", ["Default", "Selected"]));
  write(worktree, repaired, deprecatedRow("Tree Cell").replace(`import type { Meta } from "@storybook/react";`, `import type { Meta } from "@storybook/react-vite";`));
  mkdirSync(path.join(worktree, "apps/storybook/stories/tree"), { recursive: true });
  git(worktree, ["mv", moved, movedTo], home);
  write(worktree, history, story("Start Here/Version History", ["stable"], ["Default", "Release301"]));
  write(worktree, "apps/storybook/stories/composites-v1/tree-row-grouped.stories.tsx", story("Composites v1.0/Data Display/Tree Row Grouped", ["stable"]));
  write(worktree, "apps/storybook/stories/composites-v2/tree-row-legacy.stories.tsx", story("Composites/Shared/Navigation/Tree Row Legacy", ["deprecated"]));
  write(worktree, "apps/storybook/stories/composites-v2/v2-tree-row-grouped.stories.tsx", story("Composites/Shared/Navigation/Tree Row Grouped", ["stable"], ["Grouped", "GroupedCollapsed"]));
  write(worktree, "apps/storybook/stories/composites-v2/v2-tree-row-preview.stories.tsx", `${story("Composites/Shared/Navigation/Tree Row Preview", ["stable"])}export const Design = { tags: ["!stable", "experimental"] };\n`);

  const result = inventory(worktree, home);
  assert.equal(result.status, 1);
  assert.equal(result.json.storybookScheme.name, StorybookScheme.Lifecycle);
  assert.equal(result.json.blocking.storiesInV2Taxonomy, false);
  assert.deepEqual(result.json.v1Stories, [
    { path: "apps/storybook/stories/composites-v1/tree-row-grouped.stories.tsx", status: "A", reasons: ["title"] },
    { path: "apps/storybook/stories/composites-v2/tree-row-legacy.stories.tsx", status: "A", reasons: ["tag"] },
    { path: treeRow, status: "M", reasons: ["frozen"] },
    { path: movedTo, status: "A", from: moved, reasons: ["frozen"] },
  ]);
  assert.deepEqual(result.json.compileOnlyV1Repairs, [{ path: repaired, status: "M" }]);
  assert.deepEqual(result.json.retitledStories, []);

  git(worktree, ["mv", movedTo, moved], home);
  git(worktree, ["checkout", "-q", "--", treeRow], home);
  git(worktree, ["clean", "-qfd", "apps/storybook/stories/composites-v1"], home);
  write(worktree, "apps/storybook/stories/composites-v2/tree-row-legacy.stories.tsx", story("Composites/Shared/Navigation/Tree Row Legacy", ["preview"]));
  const clean = inventory(worktree, home);
  assert.equal(clean.status, 0, JSON.stringify(clean.json));
  assert.deepEqual(clean.json.v1Stories, []);
  assert.deepEqual(clean.json.compileOnlyV1Repairs, [{ path: repaired, status: "M" }]);
});

test("a session based before #8867 keeps the version scheme, and after syncing main is not blamed for its renames", (t) => {
  const gridGroups = "apps/storybook/stories/composites-v2/v2-grid-groups.stories.tsx";
  const treeRow = "apps/storybook/stories/tree-row.stories.tsx";
  const documentsView = "packages/app/documents/components/table/documents-view.stories.tsx";
  const { home, checkout, worktree } = setup(t, "grouped-list-sections", {
    [STORY_GROUP_ORDER_PATH]: VERSION_SCHEME_ORDER,
    [gridGroups]: story("Composites v2.0/Artifacts/Grid Groups", ["v2.0"]),
    [treeRow]: story("Composites/Data Display/Tree Row", ["v1.0", "autodocs"]),
  });
  write(worktree, gridGroups, story("Composites v2.0/Artifacts/Grid Groups", ["v2.0"], ["Default", "Grouped"]));
  write(worktree, documentsView, story("Composites v2.0/Shared/Artifact List/Documents View", ["autodocs", "v2.0"]));
  git(worktree, ["add", "-A"], home);
  git(worktree, ["commit", "-q", "-m", "redeploy 1"], home);

  const before = inventory(worktree, home);
  assert.equal(before.status, 0, JSON.stringify(before.json));
  assert.deepEqual(before.json.storybookScheme, { name: StorybookScheme.Version });
  assert.deepEqual(before.json.v1Stories, []);
  write(worktree, treeRow, story("Composites/Data Display/Tree Row", ["v1.0", "autodocs"], ["Default", "Selected"]));
  const frozenBefore = inventory(worktree, home);
  assert.deepEqual(frozenBefore.json.v1Stories, [{ path: treeRow, status: "M", reasons: ["frozen"] }]);
  git(worktree, ["checkout", "-q", "--", treeRow], home);

  // Main lands the lifecycle scheme: the v2.0 roots become the plain roots and
  // the old plain roots become `<Level> v1.0`, each file tagged by lifecycle.
  write(checkout, STORY_GROUP_ORDER_PATH, LIFECYCLE_SCHEME_ORDER);
  write(checkout, gridGroups, story("Composites/Artifacts/Grid Groups", ["stable"]));
  write(checkout, treeRow, story("Composites v1.0/Data Display/Tree Row", ["deprecated", "autodocs"]));
  git(checkout, ["commit", "-q", "-am", "Storybook lifecycle tags; drop v2.0 from root titles"], home);
  git(checkout, ["push", "-q", "origin", "main"], home);
  git(worktree, ["fetch", "-q", "origin", "main"], home);
  git(worktree, ["merge", "-q", "--no-edit", "origin/main"], home);

  const synced = inventory(worktree, home);
  assert.equal(synced.json.storybookScheme.name, StorybookScheme.Lifecycle);
  assert.equal(synced.json.baseCommit, git(worktree, ["rev-parse", "origin/main"], home));
  assert.deepEqual(synced.json.retitledStories, []);
  assert.deepEqual(synced.json.v1Stories, []);
  assert.equal(synced.status, 0, JSON.stringify(synced.json));
  assert.match(git(worktree, ["show", `HEAD:${gridGroups}`], home), /title: "Composites\/Artifacts\/Grid Groups",\n {2}tags: \["stable"\],[\s\S]*export const Grouped/);

  // The session's own new entry moves to the current root with a lifecycle
  // tag; it is not at the base, so that is not a retitle.
  write(worktree, documentsView, story("Composites/Shared/Artifact List/Documents View", ["stable", "autodocs"]));
  const placed = inventory(worktree, home);
  assert.equal(placed.status, 0, JSON.stringify(placed.json));
  assert.deepEqual(placed.json.retitledStories, []);
  assert.deepEqual(placed.json.v1Stories, []);

  write(worktree, treeRow, story("Composites v1.0/Data Display/Tree Row", ["deprecated", "autodocs"], ["Default", "Selected"]));
  const frozenAfter = inventory(worktree, home);
  assert.equal(frozenAfter.status, 1);
  assert.deepEqual(frozenAfter.json.v1Stories, [{ path: treeRow, status: "M", reasons: ["frozen"] }]);
});

test("a lifecycle export this script cannot read blocks story changes instead of guessing their rules", (t) => {
  const gridGroups = "apps/storybook/stories/composites-v2/v2-grid-groups.stories.tsx";
  const { home, worktree } = setup(t, "lifecycle-unreadable", {
    [STORY_GROUP_ORDER_PATH]: "export const StorybookLifecycle = Object.freeze(LIFECYCLE);\n",
    [gridGroups]: story("Composites/Artifacts/Grid Groups", ["stable"]),
  });
  write(worktree, "apps/app/page.tsx", "export const page = 2;\n");
  const noStories = inventory(worktree, home);
  assert.equal(noStories.status, 0, JSON.stringify(noStories.json));
  assert.equal(noStories.json.storybookScheme.name, StorybookScheme.Unrecognized);
  assert.equal("storybookSchemeRecognized" in noStories.json.blocking, false);

  write(worktree, gridGroups, story("Composites/Artifacts/Grid Groups", ["stable"], ["Default", "Grouped"]));
  const withStories = inventory(worktree, home);
  assert.equal(withStories.status, 1);
  assert.equal(withStories.json.blocking.storybookSchemeRecognized, false);
});
