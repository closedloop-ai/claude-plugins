// How vibe relates to the vibe-core plugin. vibe-core holds only the hook entry points and a loader: each hook
// event finds the vibe a session uses and runs hooks/runtime.mjs from it, so the guards and every module they
// use live here in vibe, at the paths they had in vibe-core (lib/**, hooks/**). vibeCore(), vibeCorePath() and
// runVibeCoreMain() keep their names and load those modules from this vibe's own root; vibeCoreRoot() and
// vibeCoreProblem() only report whether a vibe-core new enough to hand its hooks to this vibe is installed.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { comparePluginVersions, ownPluginRoot, pluginInstall, pluginManifest, pluginMarketplace, siblingPluginRoot } from "./plugin-roots.mjs";

/** The oldest vibe-core release whose hooks hand over to this vibe's guards (hooks/runtime.mjs); raise it when the hook contract changes. */
export const VIBE_CORE_MIN = "1.0.15";
const SELF = pluginInstall(import.meta.url);
const OWN_ROOT = ownPluginRoot(import.meta.url).root;
/** vibe-core's id in the marketplace this vibe came from. */
export const VIBE_CORE_ID = `vibe-core@${pluginMarketplace(SELF)}`;
/** The commands that add vibe-core beside this vibe in each harness. */
export const VIBE_CORE_INSTALL = Object.freeze({ claude: `claude plugin install ${VIBE_CORE_ID}`, codex: `codex plugin add ${VIBE_CORE_ID}` });

let cachedRoot = null;

/** vibe-core's root beside this vibe install; throws with the fix when it is missing or older than VIBE_CORE_MIN. */
export function vibeCoreRoot() {
  if (cachedRoot) return cachedRoot;
  const root = siblingPluginRoot("vibe-core", { from: import.meta.url });
  const installed = pluginManifest(root)?.version ?? null;
  if (installed === null || comparePluginVersions(installed, VIBE_CORE_MIN) < 0) {
    throw Object.assign(new Error(`${SELF.name} ${SELF.version ?? "unknown"} needs vibe-core ${VIBE_CORE_MIN} or newer, but vibe-core ${installed ?? "(no version)"} is installed; `
      + `update it with \`claude plugin update ${VIBE_CORE_ID}\` in Claude Code or \`${VIBE_CORE_INSTALL.codex}\` in Codex`),
      { outdated: true, installed, minimum: VIBE_CORE_MIN });
  }
  cachedRoot = root;
  return root;
}

/** Why vibe-core cannot be loaded ({ message, outdated, installed?, minimum? }), or null when it can. */
export function vibeCoreProblem() {
  try {
    vibeCoreRoot();
    return null;
  } catch (error) {
    return error.outdated === true
      ? { message: error.message, outdated: true, installed: error.installed, minimum: error.minimum }
      : { message: error.message, outdated: false };
  }
}

/** The absolute path of `relative` (for example "lib/vibe/scripts/session-record.mjs") inside this vibe. */
export function vibeCorePath(relative) {
  return path.join(OWN_ROOT, relative);
}

/** The module at `relative` inside this vibe, imported. */
export function vibeCore(relative) {
  return import(pathToFileURL(vibeCorePath(relative)).href);
}

/** Runs the command-line module at `relative` inside this vibe as if node had been started with it. */
export async function runVibeCoreMain(relative) {
  process.argv[1] = vibeCorePath(relative);
  await import(pathToFileURL(process.argv[1]).href);
}
