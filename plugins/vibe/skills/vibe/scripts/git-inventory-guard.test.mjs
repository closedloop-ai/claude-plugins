import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { rawGitInventoryLines } from "./dist/qa-impact-parser.mjs";

const sourceRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const sourceFolders = ["plugins/vibe", "tools/vibe-workers/src", "tools/vibe-closedloop-build/src"];
const generatedOrFixture = new Set(["dist", "node_modules", "fixtures", "test", "tests", "__tests__"]);
const implementation = /\.(?:[cm]?[jt]sx?|sh|py)$/;
const testFile = /(?:^test_.*\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$)/;
const inventoryMention = /\bls-(?:tree|files)\b/;
const fixture = "plugins/vibe/skills/vibe/scripts/inventory-guard-fixture.mjs";

function *implementationFiles(relative) {
  for (const entry of readdirSync(path.join(sourceRoot, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory() && !generatedOrFixture.has(entry.name)) yield *implementationFiles(child);
    else if (entry.isFile() && implementation.test(entry.name) && !testFile.test(entry.name)) yield child;
  }
}

function scriptInventoryLines(text) {
  const broad = /\bls-files\b(?![^\n]*\s--(?:\s|["']))/;
  const recursive = /\bls-tree\b[^\n]*\s["']?-(?:[a-z]*r[a-z]*|\-recursive)\b/i;
  return text.split("\n").flatMap((line, index) =>
    !line.trimStart().startsWith("#") && /\bgit\b/.test(line) && (broad.test(line) || recursive.test(line)) ? [index + 1] : []);
}

function violations(file, source) {
  if (!inventoryMention.test(source)) return [];
  const lines = /\.(?:sh|py)$/.test(file) ? scriptInventoryLines(source) : rawGitInventoryLines(file, source);
  return lines === null ? [`${file}: cannot parse Git inventory policy input`]
    : lines.map((line) => `${file}:${line}: route the Git inventory through readGitInventory`);
}

test("ISS-14476 the source guard catches direct, wrapped and disguised raw Git inventory commands", () => {
  const rejected = [
    'execFileSync("git", ["-C", repo, "ls-tree", "-r", "-z", head]);',
    'git(repo, ["ls-tree", "-rz", "--name-only", "HEAD"]);',
    'run(repo, ["ls-files", "--cached", "--others", "-z"]);',
    'const argv = ["ls-files"]; run(repo, argv);',
    'run(repo, ["ls-files", "--cached", "--", "."]);',
    'run(repo, ["ls-files", "--cached", "--", ...packagePaths]);',
    'import { readGitInventory } from "./git-inventory.mjs"; readGitInventory(repo, ["ls-files"]);',
    'import { readGitInventory } from "../../../lib/vibe/scripts/git-inventory.mjs"; function f(readGitInventory) { readGitInventory(repo, ["ls-files"]); }',
  ];
  for (const text of rejected) assert.equal(violations(fixture, text).length, 1, text);
  assert.deepEqual(violations("fixtures/source.sh", 'git -C "$repo" ls-tree -rz HEAD\n'), ["fixtures/source.sh:1: route the Git inventory through readGitInventory"]);
  assert.deepEqual(violations("fixtures/source.sh", '# explanation: git ls-tree -r does not run\n'), []);
});

test("ISS-14476 permits scoped lookups and inventories tied to the exact shared owner", () => {
  const accepted = [
    'git(repo, ["ls-tree", "HEAD", "--", file]);',
    'git(repo, ["ls-files", "--stage", "--", file]);',
    '// A source description can name git ls-tree -r.',
    'import { readGitInventory } from "../../../lib/vibe/scripts/git-inventory.mjs"; readGitInventory(repo, ["ls-files"]);',
    'import { readGitInventory as inventory } from "../../../lib/vibe/scripts/git-inventory.mjs"; const args = ["ls-files"]; inventory(repo, args);',
  ];
  for (const text of accepted) assert.deepEqual(violations(fixture, text), [], text);
});

test("ISS-14476 all authoritative Vibe whole-tree and whole-index reads use the shared inventory owner", () => {
  const findings = sourceFolders.flatMap((folder) => [...implementationFiles(folder)].flatMap((file) =>
    violations(file, readFileSync(path.join(sourceRoot, file), "utf8"))));
  assert.equal(findings.length, 0, findings.join("\n"));
});
