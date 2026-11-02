import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { codeowners, createGraphPack, featureMapIds, GRAPH_CALLS_STILL_OWED, ownersPattern, PACK_SCHEMA } from "./graph-pack.mjs";
import { makeCheckout, makeHome } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "graph-pack.mjs");

const FEATURE_MAP = `# FEATURE_MAP

### Branches (\`shell-route:branches\`)

<!-- control:generated id=shell-route:branches -->
| Field | Value |
| --- | --- |
| Web pages | \`apps/app/app/branches/page.tsx\` |
| Code | \`ui: packages/app/branches/\`, \`api: apps/api/app/branches/\` |
<!-- /control:generated -->

### Sessions (\`shell-route:sessions\`)

| Code | \`ui: packages/app/sessions/\` |
`;

const FILES = {
  "AGENTS.md": "root\n",
  ".github/CODEOWNERS": "* @everyone\n/packages/app/ @frontend\n/packages/app/branches/ @branches-team @frontend\n",
  ".claude/skills/control/FEATURE_MAP.md": FEATURE_MAP,
  "packages/app/package.json": "{\"name\":\"@repo/app\"}\n",
  "packages/app/AGENTS.md": "app rules\n",
  "packages/app/branches/branch-card.tsx": "export const BranchCard = () => null;\n",
  "packages/app/branches/branch-card.test.tsx": "import { BranchCard } from \"./branch-card\";\n",
  "packages/app/branches/branch-card.stories.tsx": "import { BranchCard } from \"./branch-card\";\nexport default { component: BranchCard };\n",
  "packages/app/branches/branch-list.tsx": "import { BranchCard } from \"./branch-card\";\nexport const BranchList = () => BranchCard;\n",
  "packages/app/branches/__tests__/branch-list.test.tsx": "import { BranchList } from \"../branch-list\";\n",
  "packages/app/sessions/session-row.tsx": "import { BranchCard } from \"../branches/branch-card\";\nexport const SessionRow = BranchCard;\n",
  "apps/api/lib/branch-service.ts": "import { BranchCard } from \"@repo/app/branches/branch-card\";\nexport const x = BranchCard;\n",
  "apps/api/lib/unrelated.ts": "// mentions branch-card only in a comment\nexport const y = 1;\n",
};

function fixture(t) {
  const home = makeHome("graph-pack-");
  t.after(home.cleanup);
  const checkout = path.join(home.root, "checkout");
  makeCheckout({ root: home.root, home: home.home, checkout, files: FILES });
  return checkout;
}

test("CODEOWNERS: the last matching line wins, a directory pattern covers its files, an unsupported pattern is ignored", () => {
  const text = "* @everyone\n/packages/app/ @frontend\n/packages/app/branches/ @branches-team @frontend\n!negated @x\n[a-z] @y\n";
  assert.deepEqual(codeowners(text, "packages/app/branches/branch-card.tsx"), ["@branches-team", "@frontend"]);
  assert.deepEqual(codeowners(text, "packages/app/other.tsx"), ["@frontend"]);
  assert.deepEqual(codeowners(text, "docs/x.md"), ["@everyone"]);
  assert.equal(ownersPattern("!x"), null);
  assert.equal(ownersPattern("[a]"), null);
});

test("FEATURE_MAP: an entry names a file through a folder it lists, and a file with no entry gets none", () => {
  assert.deepEqual(featureMapIds(FEATURE_MAP, "packages/app/branches/branch-card.tsx"), ["shell-route:branches"]);
  assert.deepEqual(featureMapIds(FEATURE_MAP, "apps/app/app/branches/page.tsx"), ["shell-route:branches"]);
  assert.deepEqual(featureMapIds(FEATURE_MAP, "packages/app/sessions/session-row.tsx"), ["shell-route:sessions"]);
  assert.deepEqual(featureMapIds(FEATURE_MAP, "packages/other/x.ts"), []);
});

test("the pack names the owner, the hosts that import a file, its tests and stories, and its FEATURE_MAP entry", (t) => {
  const checkout = fixture(t);
  const result = createGraphPack().pack({ worktree: checkout, paths: ["packages/app/branches/branch-card.tsx"], terms: ["BranchCard"] });
  assert.equal(result.schema, PACK_SCHEMA);
  assert.match(result.head, /^[0-9a-f]{40}$/);
  const entry = result.paths[0];
  assert.equal(entry.kind, "file");
  assert.deepEqual(entry.owner, { agentsMd: "packages/app/AGENTS.md", package: "@repo/app", codeowners: ["@branches-team", "@frontend"] });
  assert.deepEqual(entry.featureMap, ["shell-route:branches"]);
  assert.deepEqual(entry.importers.components, ["packages/app/branches/branch-list.tsx", "packages/app/sessions/session-row.tsx"]);
  assert.deepEqual(entry.importers.other, ["apps/api/lib/branch-service.ts"]);
  assert.equal(entry.importers.total, 3);
  assert.deepEqual(entry.tests, ["packages/app/branches/branch-card.test.tsx"]);
  assert.deepEqual(entry.stories, ["packages/app/branches/branch-card.stories.tsx"]);
  assert.equal(result.precedents[0].term, "BranchCard");
  assert.ok(result.precedents[0].files.includes("packages/app/branches/branch-list.tsx"));
});

test("an importer found only by a comment mentioning the name is not an importer", (t) => {
  const checkout = fixture(t);
  const entry = createGraphPack().pack({ worktree: checkout, paths: ["packages/app/branches/branch-card.tsx"] }).paths[0];
  assert.ok(!entry.importers.other.includes("apps/api/lib/unrelated.ts"));
});

test("a test beside a host in __tests__ counts as that host's test", (t) => {
  const checkout = fixture(t);
  const entry = createGraphPack().pack({ worktree: checkout, paths: ["packages/app/branches/branch-list.tsx"] }).paths[0];
  assert.deepEqual(entry.tests, ["packages/app/branches/__tests__/branch-list.test.tsx"]);
});

test("a directory gets its owner and FEATURE_MAP entry with importers, tests and stories null, not empty", (t) => {
  const checkout = fixture(t);
  const entry = createGraphPack().pack({ worktree: checkout, paths: ["packages/app/sessions/"] }).paths[0];
  assert.equal(entry.kind, "directory");
  assert.equal(entry.tracked, true);
  assert.deepEqual(entry.featureMap, ["shell-route:sessions"]);
  assert.equal(entry.importers, null);
  assert.equal(entry.tests, null);
  assert.equal(entry.stories, null);
});

test("an untracked path is reported untracked and a term shorter than three characters is not searched", (t) => {
  const checkout = fixture(t);
  const result = createGraphPack().pack({ worktree: checkout, paths: ["packages/app/new-thing.tsx"], terms: ["ab", "BranchList"] });
  assert.equal(result.paths[0].tracked, false);
  assert.deepEqual(result.precedents.map((item) => item.term), ["BranchList"]);
});

test("the pack never claims the graph: its source says worktree and every required graph call stays owed", (t) => {
  const checkout = fixture(t);
  const result = createGraphPack().pack({ worktree: checkout, paths: ["packages/app/branches/branch-card.tsx"] });
  assert.match(result.source, /not the closedloop-graph/);
  assert.deepEqual(result.graphCallsStillOwed, [...GRAPH_CALLS_STILL_OWED]);
  assert.ok(GRAPH_CALLS_STILL_OWED.includes("code_tests_for") && GRAPH_CALLS_STILL_OWED.includes("blast_radius_tickets"));
});

test("the command line prints the pack and needs --worktree and --paths", (t) => {
  const checkout = fixture(t);
  const good = spawnSync(process.execPath, [SCRIPT, "--worktree", checkout, "--paths", "packages/app/branches/branch-card.tsx"], { encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).schema, PACK_SCHEMA);
  const bad = spawnSync(process.execPath, [SCRIPT, "--worktree", checkout], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});
