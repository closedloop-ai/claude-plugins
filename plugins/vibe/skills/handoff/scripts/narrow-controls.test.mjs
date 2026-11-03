import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareRows, snapshotControls } from "./narrow-controls.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "narrow-controls.mjs");

// The #8962 shape: the wide row's status pill opens a menu; the narrow row shows a read-only glyph.
const WIDE = `- row "Plan doc In review":
  - cell:
    - checkbox "Select Plan doc"
  - cell "Plan doc":
    - link "Plan doc":
      - /url: /acme/documents/PLN-1
  - cell:
    - button "Status: In review" [expanded]
  - cell:
    - 'button "Owner: O''Neil"'
  - cell:
    - button "More actions"
`;
const NARROW = `- row "Plan doc In review":
  - checkbox "Select Plan doc"
  - img "In review"
  - link "Plan doc":
    - /url: /acme/documents/PLN-1
  - 'button "Owner: O''Neil"'
  - button "More actions"
`;

test("reads interactive controls from a Playwright aria snapshot, including single-quoted keys", () => {
  assert.deepEqual(snapshotControls(WIDE), [
    'checkbox "Select Plan doc"', 'link "Plan doc"', 'button "Status: In review"', `button "Owner: O'Neil"`, 'button "More actions"',
  ]);
  assert.deepEqual(snapshotControls(NARROW).includes('img "In review"'), false);
});

test("a wide control replaced by a read-only glyph at narrow width has no narrow home", () => {
  const result = compareRows(WIDE, NARROW);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['button "Status: In review"']);
});

test("a recorded home must exist in the narrow row; a ruling clears the control", () => {
  const home = compareRows(WIDE, NARROW, 'Narrow home: button "Status: In review" -> button "More actions"\n');
  assert.deepEqual([home.ok, home.missing, home.problems], [true, [], []]);
  const absentHost = compareRows(WIDE, NARROW, '- Narrow home: button "Status: In review" -> button "Change status"\n');
  assert.equal(absentHost.ok, false);
  assert.deepEqual(absentHost.missing, ['button "Status: In review"']);
  assert.match(absentHost.problems[0], /narrow row has no button "Change status"/);
  const ruled = compareRows(WIDE, NARROW, 'Narrow ruling: button "Status: In review": PRD-727 R4\n');
  assert.equal(ruled.ok, true);
});

test("duplicates count: two wide links with one narrow link leave one missing", () => {
  const wide = '- link "Open"\n- link "Open"\n';
  assert.deepEqual(compareRows(wide, '- link "Open"\n').missing, ['link "Open"']);
  assert.equal(compareRows(wide, '- link "Open"\n- link "Open"\n').ok, true);
});

test("the CLI exits 1 on a missing control or an empty wide capture and reads the session change log", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "narrow-controls-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name, text) => { writeFileSync(path.join(dir, name), text); return path.join(dir, name); };
  const run = (...args) => {
    const out = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    return { status: out.status, json: JSON.parse(out.stdout) };
  };
  const wide = file("wide.yml", WIDE);
  const narrow = file("narrow.yml", NARROW);
  const missing = run("--wide", wide, "--narrow", narrow);
  assert.deepEqual([missing.status, missing.json.missing], [1, ['button "Status: In review"']]);
  const log = file("changes.md", 'Narrow ruling: button "Status: In review": operator ruling 2026-10-20\n');
  assert.equal(run("--wide", wide, "--narrow", narrow, "--change-log", log).status, 0);
  const empty = run("--wide", file("blank.yml", '- row "x"\n'), "--narrow", narrow);
  assert.deepEqual([empty.status, /no interactive controls/.test(empty.json.problems.join())], [1, true]);
  assert.equal(run("--wide", wide).status, 1);
});
