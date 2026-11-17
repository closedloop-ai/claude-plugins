import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogEntries, findCatalogNameMismatches, formatCatalogMismatch } from "./catalog-names.js";
import { CLAUDE_MANIFEST, CODEX_MANIFEST } from "./manifest-versions.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "catalog-names-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function write(path: string, body: unknown): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), JSON.stringify(body));
}

describe("findCatalogNameMismatches", () => {
  it("reports an entry whose manifest names another plugin, per harness", () => {
    write(".claude-plugin/marketplace.json", { plugins: [{ name: "vibe-generic", source: "./plugins/vibe" }] });
    write(".agents/plugins/marketplace.json", { plugins: [{ name: "vibe-generic", source: { source: "local", path: "./plugins/vibe" } }] });
    write(`plugins/vibe/${CLAUDE_MANIFEST}`, { name: "vibe-generic", version: "1.1.88" });
    write(`plugins/vibe/${CODEX_MANIFEST}`, { name: "vibe", version: "1.1.88" });

    expect(findCatalogNameMismatches(repo).map(formatCatalogMismatch)).toEqual([
      ".agents/plugins/marketplace.json: entry vibe-generic points at ./plugins/vibe, whose manifest is named vibe",
    ]);
  });

  it("reports an entry with no manifest", () => {
    write(".claude-plugin/marketplace.json", { plugins: [{ name: "gone", source: "./plugins/gone" }] });
    write(".agents/plugins/marketplace.json", { plugins: [] });

    expect(findCatalogNameMismatches(repo).map((entry) => entry.manifestName)).toEqual([null]);
  });
});

describe("repository catalogs", () => {
  it("name every plugin as its manifest does in both harnesses", () => {
    expect(findCatalogNameMismatches(REPO).map(formatCatalogMismatch)).toEqual([]);
  });

  it("list vibe as the ClosedLoop build and vibe-generic as plugins/vibe, at one version", () => {
    const vibes = catalogEntries(REPO).filter((entry) => entry.name === "vibe" || entry.name === "vibe-generic")
      .map(({ catalog, name, source, version }) => ({ catalog, name, source, version }));
    const version = vibes[0]?.version;
    expect(vibes).toEqual([
      { catalog: ".claude-plugin/marketplace.json", name: "vibe", source: "./plugins/vibe-closedloop", version },
      { catalog: ".claude-plugin/marketplace.json", name: "vibe-generic", source: "./plugins/vibe", version },
      { catalog: ".agents/plugins/marketplace.json", name: "vibe", source: "./plugins/vibe-closedloop", version },
      { catalog: ".agents/plugins/marketplace.json", name: "vibe-generic", source: "./plugins/vibe", version },
    ]);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
