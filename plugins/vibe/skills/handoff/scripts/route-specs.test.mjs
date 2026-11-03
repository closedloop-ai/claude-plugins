import assert from "node:assert/strict";
import test from "node:test";
import { moduleShape, splitTopLevel } from "./module-symbols.mjs";
import { routeSpecs } from "./route-specs.mjs";

const ROUTE = "apps/api/app/artifact-links/batch-move/route.ts";

function required(files) {
  const repo = { headFiles: Object.keys(files), head: (file) => files[file] ?? null };
  return new Map(routeSpecs([{ path: ROUTE, status: "M", added: [], removed: [] }], repo).map((entry) => [entry.path, entry.reason]));
}

test("the splitter keeps regex, string and template text out of the statement boundaries and the references", () => {
  const source = [
    "const QUOTE = /[\"'`{]/g;",
    "const ratio = total / count / 2;",
    "export const glob = `**${PATHS[\"move\"]}**${`{${inner}}`}`;",
    "export function wrap(page) {",
    "  return page.route(\"{ notCode }\", handler);",
    "}",
    "",
  ].join("\n");
  const split = splitTopLevel(source);
  assert.equal(split.ok, true);
  assert.equal(split.statements.length, 4);
  const shape = moduleShape(source, () => undefined);
  const glob = shape.statements.find((statement) => statement.names.includes("glob"));
  assert.ok(glob.refs.has("PATHS") && glob.refs.has("inner"));
  assert.ok(!shape.statements.find((statement) => statement.names.includes("wrap")).refs.has("notCode"));
  assert.deepEqual(splitTopLevel("export const a = (1;\n"), { ok: false, reason: "unclosed (", statements: [] });
  assert.equal(splitTopLevel("const a = `open\n").ok, false);
});

test("an endpoint named whole in one constant reaches through a star re-export, two imports away", () => {
  const specs = required({
    "e2e/helpers/paths.ts": "export const MOVE = \"/artifact-links/batch-move\";\nexport const LIST = \"/artifact-links/list\";\n",
    "e2e/helpers/index.ts": "export * from \"./paths\";\n",
    "e2e/move.spec.ts": "import { MOVE } from \"./helpers\";\n",
    "e2e/list.spec.ts": "import { LIST } from \"./helpers\";\n",
  });
  assert.deepEqual([...specs.keys()], ["e2e/move.spec.ts"]);
  assert.match(specs.get("e2e/move.spec.ts"), /imports MOVE from e2e\/helpers\/index\.ts, which reaches the changed endpoint in .* \(named in e2e\/helpers\/paths\.ts, 2 imports away\)/);
});

test("imports the symbol walk cannot follow fall back to file level and say why", () => {
  const helper = "export const mockMove = () => \"/artifact-links/batch-move\";\nexport const row = () => 1;\n";
  const specs = required({
    "e2e/helpers/move.ts": helper,
    "e2e/default.spec.ts": "import helpers from \"./helpers/move\";\n",
    "e2e/dynamic.spec.ts": "test(\"x\", async () => { const { row } = await import(\"./helpers/move\"); });\n",
    "e2e/bare.spec.ts": "import \"./helpers/move\";\n",
    "e2e/helpers/broken.ts": "import { mockMove } from \"./move\";\nexport const run = () => (mockMove(;\n",
    "e2e/broken.spec.ts": "import { run } from \"./helpers/broken\";\n",
  });
  assert.deepEqual([...specs.keys()].sort(), ["e2e/broken.spec.ts", "e2e/default.spec.ts", "e2e/dynamic.spec.ts"]);
  assert.match(specs.get("e2e/default.spec.ts"), /file-level fallback: default import of e2e\/helpers\/move\.ts, which declares no default export/);
  assert.match(specs.get("e2e/dynamic.spec.ts"), /file-level fallback: dynamic import of e2e\/helpers\/move\.ts/);
  assert.match(specs.get("e2e/broken.spec.ts"), /file-level fallback: e2e\/helpers\/broken\.ts could not be split into statements/);
});

test("a helper whose top level reaches the endpoint when it loads requires every importer", () => {
  const specs = required({
    "e2e/helpers/setup.ts": "export const row = () => 1;\ntest.beforeEach(({ page }) => page.route(\"**/artifact-links/batch-move\", handler));\n",
    "e2e/rows.spec.ts": "import { row } from \"./helpers/setup\";\n",
    "e2e/other.spec.ts": "import \"./helpers/setup\";\n",
  });
  assert.deepEqual([...specs.keys()].sort(), ["e2e/other.spec.ts", "e2e/rows.spec.ts"]);
});

test("a comment naming the endpoint does not make a spec or an export reach it; the hop limit still holds", () => {
  const specs = required({
    "e2e/commented.spec.ts": "// see /artifact-links/batch-move\ntest(\"x\", () => {});\n",
    "e2e/helpers/a.ts": "export const A = \"/artifact-links/batch-move\";\n",
    "e2e/helpers/b.ts": "export { A as B } from \"./a\";\n",
    "e2e/helpers/c.ts": "export { B as C } from \"./b\";\n",
    "e2e/helpers/d.ts": "export { C as D } from \"./c\";\n",
    "e2e/three.spec.ts": "import { C } from \"./helpers/c\";\n",
    "e2e/four.spec.ts": "import { D } from \"./helpers/d\";\n",
  });
  assert.deepEqual([...specs.keys()], ["e2e/three.spec.ts"]);
});
