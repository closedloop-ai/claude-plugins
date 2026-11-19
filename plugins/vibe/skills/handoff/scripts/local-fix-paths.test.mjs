import assert from "node:assert/strict";
import test from "node:test";
import { localFixPaths } from "./local-fix-paths.mjs";

test("local-fix paths map each exact path to its fix's ticket; the first fix naming a path wins", () => {
  const paths = localFixPaths({ localFixes: [
    { ticket: "ISS-1", paths: ["packages/a.ts", "packages/b.ts"] },
    { ticket: "ISS-2", paths: ["packages/b.ts", "packages/c.ts"] },
    { paths: ["packages/d.ts"] },
  ] });
  assert.deepEqual([...paths], [["packages/a.ts", "ISS-1"], ["packages/b.ts", "ISS-1"], ["packages/c.ts", "ISS-2"], ["packages/d.ts", null]]);
  assert.equal(paths.has("packages"), false, "a path is exact, never a directory prefix");
});

test("a missing record, missing localFixes or malformed entries add no path", () => {
  for (const record of [null, undefined, {}, { localFixes: "x" }, { localFixes: [null, { paths: "a.ts" }, { ticket: 3, paths: [7, "ok.ts"] }] }]) {
    const paths = localFixPaths(record);
    assert.deepEqual([...paths], record?.localFixes?.[2] ? [["ok.ts", null]] : []);
  }
});
