/**
 * Codex refuses a marketplace entry whose name differs from the name in the
 * plugin's own manifest ("plugin.json name `vibe` does not match marketplace
 * plugin name `vibe-generic`"), and Claude Code installs an entry under its
 * manifest's name. CI fails while any entry of either catalog names a plugin
 * whose manifest for that harness says otherwise.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_MANIFEST, CODEX_MANIFEST } from "./manifest-versions.js";

export const CATALOGS = Object.freeze([
  { catalog: ".claude-plugin/marketplace.json", manifest: CLAUDE_MANIFEST },
  { catalog: ".agents/plugins/marketplace.json", manifest: CODEX_MANIFEST },
]);

export interface CatalogEntry {
  catalog: string;
  name: string;
  source: string;
  manifestName: string | null;
  version: string | null;
}

/** Every entry of both catalogs under `repo`, with the name and version its source's manifest for that harness declares. */
export function catalogEntries(repo: string): CatalogEntry[] {
  return CATALOGS.flatMap(({ catalog, manifest }) => {
    const parsed = JSON.parse(readFileSync(join(repo, catalog), "utf8")) as { plugins?: unknown };
    const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
    return plugins.map((entry: { name?: unknown; source?: unknown }) => {
      const source = typeof entry.source === "string" ? entry.source : (entry.source as { path?: unknown } | undefined)?.path;
      const file = typeof source === "string" ? join(repo, source, manifest) : null;
      const read = file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; version?: unknown }) : {};
      return {
        catalog, name: String(entry.name), source: String(source),
        manifestName: typeof read.name === "string" ? read.name : null,
        version: typeof read.version === "string" ? read.version : null,
      };
    });
  });
}

/** The entries whose manifest is missing or names another plugin. */
export function findCatalogNameMismatches(repo: string): CatalogEntry[] {
  return catalogEntries(repo).filter((entry) => entry.manifestName !== entry.name);
}

export function formatCatalogMismatch({ catalog, name, source, manifestName }: CatalogEntry): string {
  return `${catalog}: entry ${name} points at ${source}, whose manifest is named ${manifestName ?? "(missing)"}`;
}
