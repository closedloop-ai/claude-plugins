import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";
import { backendGroups, blastBundle, buildInventoryBundle, flagKeys, flagModuleLookup, guardPredicates, resolveConstant, storybookLinks } from "./inventory-bundle.mjs";
import { parseUnifiedDiff } from "./diff-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY = path.join(HERE, "handoff-inventory.mjs");
const SESSIONS = path.join(HERE, "..", "..", "vibe", "scripts", "vibe-sessions.mjs");

function diff(file, added, { status = "M" } = {}) {
  const header = status === "A" ? `new file mode 100644\n--- /dev/null\n+++ b/${file}\n` : `--- a/${file}\n+++ b/${file}\n`;
  return `diff --git a/${file} b/${file}\n${header}@@ -0,0 +1,${added.length} @@\n${added.map((line) => `+${line}`).join("\n")}\n`;
}

const files = (...parts) => parseUnifiedDiff(parts.join(""));

test("backend paths are grouped by what they are, each list sorted", () => {
  const groups = backendGroups([
    "apps/api/app/projects/route.ts", "apps/api/lib/project-service.ts", "packages/database/prisma/migrations/2026_x/migration.sql",
    "packages/database/prisma/schema.prisma", "packages/api/src/types/project.ts", "apps/desktop/src/main/db.ts", "apps/mcp/index.ts",
  ].map((file) => ({ path: file, status: "M" })));
  assert.deepEqual(groups, {
    routes: ["apps/api/app/projects/route.ts"],
    services: ["apps/api/lib/project-service.ts"],
    migrations: ["packages/database/prisma/migrations/2026_x/migration.sql"],
    schema: ["packages/database/prisma/schema.prisma"],
    sharedTypes: ["packages/api/src/types/project.ts"],
    desktopMain: ["apps/desktop/src/main/db.ts"],
    other: ["apps/mcp/index.ts"],
  });
  assert.deepEqual(backendGroups([]), {});
});

test("guard predicates are the added lines that read an auth, role or org guard or a flag; a test file and a deleted file are not scanned", () => {
  const result = guardPredicates(files(
    diff("apps/api/app/x/route.ts", ["export const GET = withAnyAuth(handler);", "const total = 1;", "if (project.orgId !== auth.orgId) return forbidden();"]),
    diff("apps/api/app/x/route.test.ts", ["withAnyAuth(h);"]),
  ));
  assert.deepEqual(result.predicates.map((item) => [item.file, item.line]), [["apps/api/app/x/route.ts", 1], ["apps/api/app/x/route.ts", 3]]);
  assert.equal(result.total, 2);
});

test("flag keys: a key read in the diff comes with its file and line, and the recorded keys pass through untouched", () => {
  const result = flagKeys(files(diff("packages/app/a.tsx", ["const on = useFeatureFlag(\"branchesBulk\");", "<FeatureFlagged flag=\"sessionsNav\">x</FeatureFlagged>", "const none = 1;"])), { flagKeys: { surfaces: ["s"] } });
  assert.deepEqual(result.readInDiff.map((item) => [item.key, item.line]), [["branchesBulk", 1], ["sessionsNav", 2]]);
  assert.deepEqual(result.recorded, { surfaces: ["s"] });
  assert.equal(flagKeys([], null).recorded, null);
});

const ALIAS_MODULE = [
  "export const NEW_THING_FEATURE_FLAG_KEY =",
  "  NEW_THING_FLAG_KEY;",
].join("\n");
const KEY_MODULE = "export const NEW_THING_FLAG_KEY =\n  \"new-thing\" as const;\n";
const lookupIn = (modules) => (name) => modules.filter((text) => text.includes(`const ${name}`));

test("flag keys regression: a key read through a constant, with the call split across lines, resolves through an alias to its literal", () => {
  const head = [
    "import { NEW_THING_FEATURE_FLAG_KEY } from \"@repo/app/shared/lib/feature-flags\";",
    "export function View() {",
    "  const on = useFeatureFlag(",
    "    NEW_THING_FEATURE_FLAG_KEY",
    "  );",
    "  return on;",
    "}",
    "",
  ].join("\n");
  const changed = files(diff("packages/app/view.tsx", head.split("\n")));
  const result = flagKeys(changed, null, () => head, lookupIn([ALIAS_MODULE, KEY_MODULE]));
  assert.deepEqual(result.readInDiff, [{ key: "new-thing", file: "packages/app/view.tsx", line: 3, constant: "NEW_THING_FEATURE_FLAG_KEY", resolvedBy: "alias of NEW_THING_FLAG_KEY" }]);
});

test("flag keys: a constant defined in the diff resolves from the changed file; one that cannot resolve is reported unresolved, never dropped", () => {
  const head = "export const LOCAL_KEY = \"local-key\";\nconst a = useFeatureFlag(LOCAL_KEY);\nconst b = useFeatureFlag(MISSING_KEY);\n";
  const changed = files(diff("packages/app/x.tsx", head.split("\n")));
  const result = flagKeys(changed, null, () => head, () => []);
  assert.deepEqual(result.readInDiff.map((item) => [item.key, item.constant, item.unresolved ?? false]), [["local-key", "LOCAL_KEY", false], [null, "MISSING_KEY", true]]);
});

test("flag keys: a read the diff did not add is not reported, and the string-literal read still works", () => {
  const head = "const old = useFeatureFlag(OLD_KEY);\nconst added = useFeatureFlag(\"literal-key\");\n";
  const changed = parseUnifiedDiff(`diff --git a/a.tsx b/a.tsx\n--- a/a.tsx\n+++ b/a.tsx\n@@ -1,0 +2,1 @@\n+const added = useFeatureFlag("literal-key");\n`);
  const result = flagKeys(changed, null, () => head, () => []);
  assert.deepEqual(result.readInDiff.map((item) => item.key), ["literal-key"]);
});

test("constants resolve through the repository's flag modules by the lookup the inventory uses", () => {
  assert.equal(resolveConstant("A", [], lookupIn(["export const A = \"a-key\";"])).key, "a-key");
  assert.equal(resolveConstant("A", [], lookupIn(["export const A = B;", "export const B = A;"])), null);
  const calls = [];
  const lookup = flagModuleLookup("/wt", (command, args) => { calls.push(args.join(" ")); return { status: 0, stdout: "export const A =\n  \"a-key\";\n--\nother", stderr: "" }; });
  assert.equal(resolveConstant("A", [], lookup).key, "a-key");
  assert.match(calls[0], /grep -h -A3 -E export const A\\b -- \*-flag\.ts/);
});

test("guard predicates regression: import lines, multi-line import specifiers and comments are not predicates", () => {
  const head = [
    "import {",
    "  FeatureFlagged,",
    "  useFeatureFlag,",
    "} from \"@repo/app/shared/feature-flags\";",
    "import { ARTIFACT_FEATURE_FLAG_KEY } from \"@repo/app/shared/lib/feature-flags\";",
    "// the feature flag gates this",
    "const on = useFeatureFlag(KEY);",
    "",
  ].join("\n");
  const changed = files(diff("packages/app/view.tsx", head.split("\n")));
  const result = guardPredicates(changed, () => head);
  assert.deepEqual(result.predicates.map((item) => item.line), [7]);
  assert.equal(result.total, 1);
});

const STORY = "const meta = { title: 'Components/Bulk Bar', component: Bar };\nexport default meta;\nexport const Default = {};\nexport const Selected = {};\n";

test("storybook links use the verified Vercel base first, the local one second, and the full-UI path form", () => {
  const changed = files(diff("packages/design-system/bulk.stories.tsx", STORY.split("\n")));
  const read = () => STORY;
  const vercel = storybookLinks(changed, { vercel: { storybookUrl: "https://sb.example/" }, stack: { storybookUrl: "http://localhost:6100" } }, read);
  assert.equal(vercel.source, "verified Vercel storybookUrl");
  assert.deepEqual(vercel.stories.map((story) => story.url), [
    "https://sb.example/?path=/story/components-bulk-bar--default", "https://sb.example/?path=/story/components-bulk-bar--selected",
  ]);
  const local = storybookLinks(changed, { stack: { storybookUrl: "http://localhost:6100" } }, read);
  assert.equal(local.stories[0].url, "http://localhost:6100/?path=/story/components-bulk-bar--default");
  const none = storybookLinks(changed, {}, read);
  assert.equal(none.base, null);
  assert.equal(none.stories[0].url, null);
  assert.ok(!JSON.stringify(vercel).includes("iframe.html"));
});

test("a story file with no readable title yields no story rather than a guessed id", () => {
  const result = storybookLinks(files(diff("a.stories.tsx", ["x"])), { stack: { storybookUrl: "http://localhost:6100" } }, () => "export const A = {};");
  assert.deepEqual(result.stories, []);
});

test("the blast bundle covers changed source files only, says it is worktree evidence, and counts what it left out", () => {
  const seen = [];
  const pack = { pack: ({ paths }) => { seen.push(...paths); return { source: "worktree: not the closedloop-graph", graphCallsStillOwed: ["code_callers"], paths: paths.map((file) => ({ path: file, owner: {}, importers: { total: 0 }, tests: [], stories: [], featureMap: [] })) }; } };
  const changed = files(diff("packages/app/a.tsx", ["x"]), diff("packages/app/a.test.tsx", ["x"]), diff("packages/app/a.stories.tsx", ["x"]), diff("README.md", ["x"]));
  const bundle = blastBundle("/wt", changed, pack);
  assert.deepEqual(seen, ["packages/app/a.tsx"]);
  assert.match(bundle.source, /not the closedloop-graph/);
  assert.deepEqual(bundle.graphCallsStillOwed, ["code_callers"]);
  assert.equal(bundle.truncated, 0);
});

test("a bundle that cannot be built is reported unavailable, never thrown", () => {
  const result = buildInventoryBundle({ worktree: "/wt", diffText: diff("a.ts", ["x"]), backendFiles: [], record: null, readHead: () => "", pack: { pack: () => { throw new Error("git exploded\nmore"); } } });
  assert.deepEqual(result, { unavailable: "git exploded" });
});

function setup(t, extra) {
  const fixture = makeHome("inventory-bundle-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, "Documents", "Active Work", "symphony-alpha");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout, files: { "apps/app/page.tsx": "export const page = 1;\n", "apps/api/lib/svc.ts": "export const svc = 1;\n", ...extra } });
  const created = runNode(SESSIONS, ["new", "--repo", checkout, "--slug", "bundle", "--summary", "bundle", "--mode", "seeded", "--operator-id", "user-operator", "--operator-email", "operator@example.com"], fixture.home);
  assert.equal(created.status, 0, created.stderr);
  return { ...fixture, worktree: created.json.session.worktree };
}

test("the real inventory adds the bundle in the handoff phase only, and a backend change shows up grouped", (t) => {
  const { home, worktree } = setup(t);
  const file = path.join(worktree, "apps/api/lib/svc.ts");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "export const svc = withAnyAuth(2);\n");
  git(worktree, ["add", "-A"], home);
  git(worktree, ["commit", "-m", "Fixture: backend change"], home);
  const build = runNode(INVENTORY, ["--worktree", worktree], home);
  assert.equal("bundle" in build.json, false);
  const handoff = runNode(INVENTORY, ["--worktree", worktree, "--phase", "handoff"], home);
  assert.ok(handoff.json.bundle, JSON.stringify(handoff.json).slice(0, 400));
  assert.deepEqual(handoff.json.bundle.backendPaths, { services: ["apps/api/lib/svc.ts"] });
  assert.equal(handoff.json.bundle.guards.predicates[0].file, "apps/api/lib/svc.ts");
  assert.match(handoff.json.bundle.blastBundle.source, /not the closedloop-graph/);
  assert.equal(handoff.json.backendChanged, true);
});
