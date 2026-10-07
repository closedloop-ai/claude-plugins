import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_MANIFEST,
  CODEX_MANIFEST,
  findManifestVersionMismatches,
  formatMismatch,
} from "./manifest-versions.js";

const REPO_PLUGINS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins");

let pluginsDir: string;

beforeEach(() => {
  pluginsDir = mkdtempSync(join(tmpdir(), "plugin-manifests-"));
});

afterEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
});

function writeManifest(plugin: string, manifest: string, body: Record<string, unknown>): void {
  const path = join(pluginsDir, plugin, manifest);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
}

describe("findManifestVersionMismatches", () => {
  it("reports a plugin whose codex manifest lags its claude manifest", () => {
    writeManifest("code", CLAUDE_MANIFEST, { name: "code", version: "1.19.14" });
    writeManifest("code", CODEX_MANIFEST, { name: "code", version: "1.19.13" });

    expect(findManifestVersionMismatches(pluginsDir)).toEqual([
      { plugin: "code", claudeVersion: "1.19.14", codexVersion: "1.19.13" },
    ]);
  });

  it("checks each plugin separately", () => {
    writeManifest("code", CLAUDE_MANIFEST, { version: "1.2.0" });
    writeManifest("code", CODEX_MANIFEST, { version: "1.2.0" });
    writeManifest("code-review", CLAUDE_MANIFEST, { version: "3.10.3" });
    writeManifest("code-review", CODEX_MANIFEST, { version: "2.34.0" });

    expect(findManifestVersionMismatches(pluginsDir)).toEqual([
      { plugin: "code-review", claudeVersion: "3.10.3", codexVersion: "2.34.0" },
    ]);
  });

  it("passes when every plugin's manifests agree", () => {
    writeManifest("code", CLAUDE_MANIFEST, { version: "1.19.15" });
    writeManifest("code", CODEX_MANIFEST, { version: "1.19.15" });

    expect(findManifestVersionMismatches(pluginsDir)).toEqual([]);
  });

  it("skips a plugin that ships only a claude manifest", () => {
    writeManifest("judges", CLAUDE_MANIFEST, { version: "1.7.1" });

    expect(findManifestVersionMismatches(pluginsDir)).toEqual([]);
  });

  it("reports a manifest without a version", () => {
    writeManifest("code", CLAUDE_MANIFEST, { version: "1.19.15" });
    writeManifest("code", CODEX_MANIFEST, { name: "code" });
    writeManifest("code-review", CLAUDE_MANIFEST, { version: "" });
    writeManifest("code-review", CODEX_MANIFEST, { version: "" });

    expect(findManifestVersionMismatches(pluginsDir)).toEqual([
      { plugin: "code", claudeVersion: "1.19.15", codexVersion: null },
      { plugin: "code-review", claudeVersion: null, codexVersion: null },
    ]);
  });
});

describe("repository plugins", () => {
  it("carry the same version in .claude-plugin and .codex-plugin", () => {
    const mismatches = findManifestVersionMismatches(REPO_PLUGINS_DIR).map(formatMismatch);

    expect(mismatches, "bump both manifests of each listed plugin to the same version").toEqual([]);
  });
});
