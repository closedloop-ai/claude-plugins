// How vibe loads the code that lives in the vibe-core plugin (ISS-13869):
// vibe-core holds the hooks and every module they run, so a vibe release that
// does not touch them leaves vibe-core's bundle, and Codex's approval of its
// hooks, unchanged. Every vibe script that uses one of those modules imports
// it through vibeCore(); a command-line entry point that moved keeps a thin
// wrapper at its old vibe path that calls runVibeCoreMain().

import path from "node:path";
import { pathToFileURL } from "node:url";
import { comparePluginVersions, ownPluginRoot, pluginManifest, siblingPluginRoot } from "./plugin-roots.mjs";

/** The oldest vibe-core release this vibe works with; raise it when vibe starts using something newer. */
export const VIBE_CORE_MIN = "1.0.0";
/** The commands that add vibe-core beside this vibe in each harness. */
export const VIBE_CORE_INSTALL = Object.freeze({ claude: "claude plugin install vibe-core@closedloop-ai", codex: "codex plugin add vibe-core@closedloop-ai" });

let cachedRoot = null;

/** vibe-core's root beside this vibe install; throws with the fix when it is missing or older than VIBE_CORE_MIN. */
export function vibeCoreRoot() {
  if (cachedRoot) return cachedRoot;
  const root = siblingPluginRoot("vibe-core", { from: import.meta.url });
  const installed = pluginManifest(root)?.version ?? null;
  if (installed === null || comparePluginVersions(installed, VIBE_CORE_MIN) < 0) {
    const vibe = ownPluginRoot(import.meta.url).version ?? "unknown";
    throw new Error(`vibe ${vibe} needs vibe-core ${VIBE_CORE_MIN} or newer, but vibe-core ${installed ?? "(no version)"} is installed; `
      + `update it with \`claude plugin update vibe-core@closedloop-ai\` in Claude Code or \`${VIBE_CORE_INSTALL.codex}\` in Codex`);
  }
  cachedRoot = root;
  return root;
}

/** The absolute path of `relative` (for example "lib/vibe/scripts/session-record.mjs") inside vibe-core. */
export function vibeCorePath(relative) {
  return path.join(vibeCoreRoot(), relative);
}

/** The vibe-core module at `relative`, imported. */
export function vibeCore(relative) {
  return import(pathToFileURL(vibeCorePath(relative)).href);
}

/** Runs the vibe-core command-line module at `relative` as if node had been started with it. */
export async function runVibeCoreMain(relative) {
  process.argv[1] = vibeCorePath(relative);
  await import(pathToFileURL(process.argv[1]).href);
}
