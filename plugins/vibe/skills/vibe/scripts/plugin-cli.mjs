// Finding the Claude Code and Codex CLIs and reading which closedloop-ai plugins each lists.
// It loads nothing from vibe-core, so plugin-version.mjs can still report a missing vibe-core.

import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MARKETPLACE = "closedloop-ai";
export const BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
/** harness-identity.mjs's Harness values, the names a harness goes by on the wire. */
const CLAUDE = "claude";

/** The CLI for `harness` that exists on this machine, or null: PATH first, then its usual install places. */
export function findCli(harness, env = process.env, home = os.homedir()) {
  const fallbacks = harness === CLAUDE
    ? [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude")]
    : [BUNDLED_CODEX];
  return onPath(harness, env) ?? fallbacks.find(isExecutable) ?? null;
}

/** The enabled closedloop-ai plugins one harness's `plugin list --json` output names, as {name, id, version, scope?, marketplace?}. */
export function installedPlugins(harness, listing) {
  const parsed = typeof listing === "string" ? JSON.parse(listing) : listing;
  if (harness === CLAUDE) {
    const rows = Array.isArray(parsed) ? parsed : [];
    return rows.filter((row) => typeof row?.id === "string" && row.id.endsWith(`@${MARKETPLACE}`) && row.enabled !== false)
      .map((row) => ({ name: row.id.slice(0, -MARKETPLACE.length - 1), id: row.id, version: row.version ?? null, scope: row.scope ?? null }));
  }
  const rows = Array.isArray(parsed?.installed) ? parsed.installed : [];
  return rows.filter((row) => row?.marketplaceName === MARKETPLACE && row.installed !== false && row.enabled !== false && typeof row.name === "string")
    .map((row) => ({ name: row.name, id: row.pluginId ?? `${row.name}@${MARKETPLACE}`, version: row.version ?? null, marketplace: marketplaceOf(row) }));
}

function onPath(name, env) {
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function marketplaceOf(row) {
  const source = row.marketplaceSource;
  if (source?.sourceType === "local" && typeof source.source === "string") {
    return { type: "local", root: source.source };
  }
  return { type: source?.sourceType ?? "unknown" };
}
