/**
 * Codex installs a plugin into a cache folder named by the version in its
 * .codex-plugin/plugin.json, so a plugin whose two manifests disagree can leave
 * Codex users on stale content under an old version folder. CI fails while any
 * plugin that ships both manifests carries different versions in them.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CLAUDE_MANIFEST = ".claude-plugin/plugin.json";
export const CODEX_MANIFEST = ".codex-plugin/plugin.json";

export interface ManifestVersionMismatch {
  plugin: string;
  claudeVersion: string | null;
  codexVersion: string | null;
}

export function findManifestVersionMismatches(pluginsDir: string): ManifestVersionMismatch[] {
  const mismatches: ManifestVersionMismatch[] = [];
  const plugins = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const plugin of plugins) {
    const claudePath = join(pluginsDir, plugin, CLAUDE_MANIFEST);
    const codexPath = join(pluginsDir, plugin, CODEX_MANIFEST);
    if (!existsSync(claudePath) || !existsSync(codexPath)) continue;
    const claudeVersion = readVersion(claudePath);
    const codexVersion = readVersion(codexPath);
    if (claudeVersion === null || claudeVersion !== codexVersion) {
      mismatches.push({ plugin, claudeVersion, codexVersion });
    }
  }
  return mismatches;
}

export function formatMismatch({ plugin, claudeVersion, codexVersion }: ManifestVersionMismatch): string {
  return `plugins/${plugin}: ${CLAUDE_MANIFEST} version ${claudeVersion ?? "(missing)"} but ${CODEX_MANIFEST} version ${codexVersion ?? "(missing)"}`;
}

function readVersion(manifestPath: string): string | null {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) return null;
  const { version } = parsed;
  return typeof version === "string" && version !== "" ? version : null;
}
