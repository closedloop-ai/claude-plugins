import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EVIDENCE_SCHEMA, gatherEvidence, pathsIn, readResults, REQUIRED_QUERIES, slugsIn } from "./req-gather.mjs";
import { makeCheckout, makeHome } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "req-gather.mjs");

const FILES = {
  "packages/app/branches/branch-card.tsx": "export const BranchCard = () => null;\n",
  "packages/app/branches/branch-list.tsx": "import { BranchCard } from \"./branch-card\";\nexport const BranchList = BranchCard;\n",
  ".claude/skills/control/FEATURE_MAP.md": "### Branches (`shell-route:branches`)\n\n| Code | `ui: packages/app/branches/` |\n",
};

function fixture(t) {
  const home = makeHome("req-gather-");
  t.after(home.cleanup);
  const checkout = path.join(home.root, "checkout");
  makeCheckout({ root: home.root, home: home.home, checkout, files: FILES });
  return { checkout, root: home.root };
}

test("slugs are every ticket, plan, document and project reference, once each, in order", () => {
  assert.deepEqual(slugsIn("Fix ISS-12 per PRD-7; see ISS-12 and PLN-3, PRO-9."), ["ISS-12", "PRD-7", "PLN-3", "PRO-9"]);
  assert.deepEqual(slugsIn("no references here"), []);
});

test("paths are only the ones that exist in the tree, files or folders, never an invented one", () => {
  const tracked = new Set(["packages/app/branches/branch-card.tsx", "apps/api/lib/x.ts"]);
  assert.deepEqual(pathsIn("Change packages/app/branches/branch-card.tsx, and apps/api/lib/. Not packages/app/gone/new.tsx or a/b.", tracked), [
    "packages/app/branches/branch-card.tsx", "apps/api/lib/",
  ]);
});

test("a required query with no saved result is listed missing, and the saved ones are bundled whole", () => {
  const files = { "/r/ticket_detail.json": "{\"slug\":\"ISS-1\"}", "/r/query_collisions.json": "[]" };
  const out = readResults("/r", { exists: (file) => file in files, read: (file) => files[file], size: () => 10 });
  assert.deepEqual(out.present, ["ticket_detail", "query_collisions"]);
  assert.deepEqual(out.missing, ["get-document-comments", "code_symbols", "blast_radius_tickets", "search_nodes", "shipped_lineage"]);
  assert.deepEqual(out.results.ticket_detail, { slug: "ISS-1" });
});

test("a result that is not JSON or is too large counts as missing and says why, never as present", () => {
  const files = { "/r/ticket_detail.json": "not json", "/r/query_collisions.json": "[]" };
  const out = readResults("/r", { exists: (file) => file in files, read: (file) => files[file], size: (file) => (file.endsWith("query_collisions.json") ? 999_999 : 5) });
  assert.deepEqual(out.present, []);
  assert.ok(out.missing.includes("ticket_detail") && out.missing.includes("query_collisions"));
  assert.deepEqual(out.unreadable.map((item) => item.name), ["ticket_detail", "query_collisions"]);
  assert.match(out.unreadable[0].reason, /not JSON/);
});

test("no results directory means every required query is missing", () => {
  const out = readResults(undefined);
  assert.deepEqual(out.missing, [...REQUIRED_QUERIES]);
});

test("the evidence resolves the request's paths against the worktree and ledgers the queries", (t) => {
  const { checkout, root } = fixture(t);
  const dir = path.join(root, "results");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "ticket_detail.json"), JSON.stringify({ slug: "ISS-5", title: "Branch card" }));
  const evidence = gatherEvidence({
    worktree: checkout, request: "ISS-5: change packages/app/branches/branch-card.tsx and packages/app/nope/x.tsx", resultsDir: dir, terms: ["BranchCard"],
  });
  assert.equal(evidence.schema, EVIDENCE_SCHEMA);
  assert.deepEqual(evidence.slugs, ["ISS-5"]);
  assert.deepEqual(evidence.paths.map((item) => item.path), ["packages/app/branches/branch-card.tsx"]);
  assert.deepEqual(evidence.paths[0].featureMap, ["shell-route:branches"]);
  assert.equal(evidence.precedents[0].term, "BranchCard");
  assert.deepEqual(evidence.queries.present, ["ticket_detail"]);
  assert.ok(evidence.queries.missing.includes("query_collisions"));
  assert.equal(evidence.results.ticket_detail.slug, "ISS-5");
});

test("the command line exits 3 while a required query is missing and 0 once every one has a result", (t) => {
  const { checkout, root } = fixture(t);
  const dir = path.join(root, "results");
  mkdirSync(dir);
  const run = () => spawnSync(process.execPath, [SCRIPT, "--worktree", checkout, "--request", "ISS-5 packages/app/branches/", "--results-dir", dir], { encoding: "utf8" });
  const partial = run();
  assert.equal(partial.status, 3, partial.stderr);
  assert.ok(JSON.parse(partial.stdout).queries.missing.length > 0);
  for (const name of REQUIRED_QUERIES) writeFileSync(path.join(dir, `${name}.json`), "{}");
  const full = run();
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(JSON.parse(full.stdout).queries.missing, []);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--worktree", checkout], { encoding: "utf8" }).status, 2);
});
