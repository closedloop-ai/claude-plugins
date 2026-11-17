import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "..");
const REPO = resolve(TOOL, "../..");
const VALIDATED = /claude plugin validate (\S+)/g;

/** The plugin folders `npm run validate:plugins` validates, repository-relative. */
function validated(): string[] {
  const script = (JSON.parse(readFileSync(join(TOOL, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["validate:plugins"] ?? "";
  return [...script.matchAll(VALIDATED)].map((match) => resolve(TOOL, match[1]!).slice(REPO.length + 1));
}

test("validate:plugins validates both vibes the catalog ships, vibe-core and closedloop-core, and no provider folder", () => {
  const catalog = JSON.parse(readFileSync(join(REPO, ".claude-plugin/marketplace.json"), "utf8")) as { plugins: { name: string; source: string }[] };
  const sources = ["vibe", "vibe-generic", "vibe-core", "closedloop-core"]
    .map((name) => catalog.plugins.find((entry) => entry.name === name)?.source.replace(/^\.\//, ""));
  assert.deepEqual([...validated()].sort(), [...sources].sort());
  for (const dir of validated()) {
    const manifest = JSON.parse(readFileSync(join(REPO, dir, ".claude-plugin/plugin.json"), "utf8")) as { name: string };
    assert.equal(catalog.plugins.find((entry) => entry.source === `./${dir}`)?.name, manifest.name, dir);
  }
  assert.equal(validated().includes("plugins/vibe-closedloop-provider"), false);
  assert.ok(existsSync(join(REPO, "plugins/vibe-closedloop/.claude-plugin/plugin.json")));
});
