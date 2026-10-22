import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Raised when a caller-supplied root cannot be the plugin these workers belong to. */
export class AgentRootError extends Error {
  constructor(readonly code: "AGENT_ROOT_INVALID" | "STALE_PLUGIN_ROOT", message: string) { super(message); }
}

/** The installed plugin root that owns a bundled entry (`<root>/skills/vibe/scripts/dist/<entry>.mjs`). */
export function installedPluginRoot(metaUrl: string): string {
  return realpathSync(resolve(dirname(fileURLToPath(metaUrl)), "../../../.."));
}

/**
 * Resolves the agent root a worker binds to. With nothing supplied it is the installed plugin root, or the
 * persistent writer's recorded root when that ledger binding still exists. A supplied `<root>/agents` means
 * `<root>` (the 2026-10-15 session passed it and every launch failed). A supplied root from another installed
 * release is refused unless it is exactly the recorded binding a resumed writer must keep.
 */
export function resolveAgentRoot(supplied: string | undefined, installed: string, recorded?: string): string {
  const fallback = recorded && existsSync(recorded) ? recorded : installed;
  if (supplied === undefined) return fallback;
  let root: string;
  try { root = realpathSync(supplied); }
  catch { throw new AgentRootError("AGENT_ROOT_INVALID", "The supplied agent root does not exist; omit agentRoot to use the installed plugin"); }
  if (basename(root) === "agents" && isPluginRoot(dirname(root))) root = dirname(root);
  if (!isPluginRoot(root)) {
    throw new AgentRootError("AGENT_ROOT_INVALID", "The supplied agent root is not a vibe plugin root; omit agentRoot to use the installed plugin");
  }
  if (root === installed || root === recorded) return root;
  const suppliedVersion = pluginVersion(root);
  const installedVersion = pluginVersion(installed);
  if (suppliedVersion && installedVersion && suppliedVersion !== installedVersion) {
    throw new AgentRootError("STALE_PLUGIN_ROOT",
      `The supplied agent root is vibe ${suppliedVersion}, but this launcher belongs to vibe ${installedVersion}; omit agentRoot`);
  }
  return root;
}

function isPluginRoot(root: string): boolean {
  const manifest = join(root, ".claude-plugin", "plugin.json");
  if (!existsSync(manifest) || !existsSync(join(root, "agents"))) return false;
  try { return (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === "vibe"; }
  catch { return false; }
}

function pluginVersion(root: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch { return undefined; }
}
