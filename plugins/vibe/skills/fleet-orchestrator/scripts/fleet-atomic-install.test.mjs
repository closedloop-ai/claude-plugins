import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const INSTALL = fileURLToPath(new URL("./fleet-atomic-install.sh", import.meta.url));

function staged(root, content) {
  const stage = path.join(root, `stage-${Math.random().toString(16).slice(2)}`);
  const relative = "plugins/vibe/skills/vibe/scripts/owned-state.mjs";
  mkdirSync(path.dirname(path.join(stage, relative)), { recursive: true });
  writeFileSync(path.join(stage, relative), content);
  writeFileSync(path.join(stage, "files"), `${relative}\n`);
  return { stage, relative };
}

test("atomic fleet install never exposes partial bytes and skips identical files", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-atomic-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const first = staged(root, `export const marker = '${"A".repeat(2_000_000)}';\n`);
  assert.equal(spawnSync("bash", [INSTALL, first.stage, target]).status, 0);
  const file = path.join(target, first.relative);
  const before = statSync(file);
  const same = staged(root, readFileSync(file));
  assert.equal(spawnSync("bash", [INSTALL, same.stage, target]).status, 0);
  const after = statSync(file);
  assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs], "identical shipment changes neither inode nor mtime");

  const updates = Array.from({ length: 8 }, (_, index) => `export const marker = '${String.fromCharCode(66 + index).repeat(2_000_000)}';\n`);
  const expected = updates.at(-1);
  let partial = null;
  const completeValues = new Set([readFileSync(file, "utf8"), ...updates]);
  const reader = setInterval(() => {
    try { const value = readFileSync(file, "utf8"); if (!completeValues.has(value)) partial = value; }
    catch (error) { partial = String(error); }
  }, 0);
  for (const content of updates) {
    const next = staged(root, content);
    const child = spawn("bash", [INSTALL, next.stage, target]);
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 0);
  }
  clearInterval(reader);
  assert.equal(partial === null, true, `reader observed partial shipment (${typeof partial === "string" ? partial.length : 0} bytes)`);
  assert.equal(readFileSync(file, "utf8"), expected);
});
