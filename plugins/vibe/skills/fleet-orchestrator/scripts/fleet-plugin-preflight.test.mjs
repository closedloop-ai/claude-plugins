import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { shippedFiles } from "../../../shared/ship-plugins.mjs";
import { stagedPluginProblems } from "./fleet-plugin-preflight.mjs";

function manifest(root, folder, name, version) {
  const dir = path.join(root, "plugins", folder, ".codex-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name, version }));
}

test("frozen render shipment carries vibe alone and names an older target version", (t) => {
  const shipped = shippedFiles(["skills/handoff/scripts/frozen-render.mjs"]);
  assert.ok(shipped.includes("plugins/vibe/skills/handoff/scripts/frozen-render.mjs"));
  assert.ok(shipped.includes("plugins/vibe/.codex-plugin/plugin.json"));
  assert.ok(shipped.some((file) => file.startsWith("plugins/vibe/lib/")), "frozen-render's lib dependencies are staged");
  assert.deepEqual(shipped.filter((file) => !file.startsWith("plugins/vibe/")), []);

  const layout = mkdtempSync(path.join(tmpdir(), "frozen-render-layout-"));
  t.after(() => rmSync(layout, { recursive: true, force: true }));
  manifest(layout, "vibe", "vibe-generic", "1.1.89");
  assert.deepEqual(stagedPluginProblems(layout, "1.1.90"),
    ["vibe plugin installed version 1.1.89 is older than required version 1.1.90"]);
  manifest(layout, "vibe", "vibe-generic", "1.1.90");
  assert.deepEqual(stagedPluginProblems(layout, "1.1.90"), []);
});
