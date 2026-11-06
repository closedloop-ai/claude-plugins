import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readAssembled } from "./skill-split.mjs";

test("a stub reads as the block it names, the path taken from the skill folder", () => {
  const root = mkdtempSync(path.join(tmpdir(), "skill-split-"));
  mkdirSync(path.join(root, "references"));
  writeFileSync(path.join(root, "SKILL.md"), "# skill\n");
  writeFileSync(path.join(root, "references", "a.md"), "# a\n\n<!-- block: one -->\nfirst\nsecond\n<!-- end: one -->\n\n<!-- block: two -->\nother\n<!-- end: two -->\n");
  writeFileSync(path.join(root, "references", "b.md"), "before\n\n> Read `references/a.md` (block `two`) when it applies.\n\nafter\n");
  assert.equal(readAssembled(path.join(root, "references", "b.md")), "before\n\nother\n\nafter\n");
  writeFileSync(path.join(root, "references", "c.md"), "plain\n");
  assert.equal(readAssembled(path.join(root, "references", "c.md")), "plain\n");
  writeFileSync(path.join(root, "references", "d.md"), "> Read `references/a.md` (block `missing`) x\n");
  assert.throws(() => readAssembled(path.join(root, "references", "d.md")), /no block missing/);
});

test("every stub in the plugin resolves to a block", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const skills = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const files = [];
  const walk = (dir) => { for (const name of readdirSync(dir)) { const full = path.join(dir, name); if (statSync(full).isDirectory()) { if (name !== "node_modules") walk(full); } else if (name.endsWith(".md")) files.push(full); } };
  walk(skills);
  for (const file of files) assert.doesNotMatch(readAssembled(file), /^> Read `[^`]+` \(block `/m, file);
});
