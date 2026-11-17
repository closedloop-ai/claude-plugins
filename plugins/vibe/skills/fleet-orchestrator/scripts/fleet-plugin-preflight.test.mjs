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

test("frozen render shipment carries both plugin roots and names an older target version", (t) => {
  const shipped = shippedFiles(["skills/handoff/scripts/frozen-render.mjs"]);
  assert.ok(shipped.includes("plugins/vibe/skills/handoff/scripts/frozen-render.mjs"));
  assert.ok(shipped.includes("plugins/vibe/.codex-plugin/plugin.json"));
  assert.ok(shipped.includes("plugins/vibe-core/.codex-plugin/plugin.json"));
  assert.ok(shipped.some((file) => file.startsWith("plugins/vibe-core/lib/")), "frozen-render vibe-core dependencies are staged");

  const layout = mkdtempSync(path.join(tmpdir(), "frozen-render-layout-"));
  t.after(() => rmSync(layout, { recursive: true, force: true }));
  manifest(layout, "vibe", "vibe-generic", "1.1.90");
  manifest(layout, "vibe-core", "vibe-core", "1.0.6");
  assert.deepEqual(stagedPluginProblems(layout, "1.1.90", "1.0.7"),
    ["vibe-core plugin installed version 1.0.6 is older than required version 1.0.7"]);
  manifest(layout, "vibe-core", "vibe-core", "1.0.7");
  assert.deepEqual(stagedPluginProblems(layout, "1.1.90", "1.0.7"), []);
});
