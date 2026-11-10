// vibe's install as vibe-core reads it: data only (its version, its skill
// definitions, which of its scripts exist). vibe-core never imports or runs a
// file under vibe's root (ISS-13869, AC3).

import { existsSync } from "node:fs";
import path from "node:path";
import { siblingPluginRoot, siblingPluginRootOrNull } from "./plugin-roots.mjs";

/** Why vibe-core's hooks stand down, or null when they should run. */
export const HookStandDown = Object.freeze({ NoVibe: "vibe is not installed", VibeOwnsHooks: "the installed vibe still registers its own hooks" });

/** vibe's install root beside this vibe-core; throws with the fix when vibe is not installed. */
export function vibeRoot() {
  return siblingPluginRoot("vibe", { from: import.meta.url });
}

/** vibe's install root, or null when vibe is not installed beside this vibe-core. */
export function vibeRootOrNull() {
  return siblingPluginRootOrNull("vibe", { from: import.meta.url });
}

/** The path of vibe script `relative` (for example "skills/vibe/scripts/plugin-version.mjs") to print in a command, never to run. */
export function vibeScriptPath(relative) {
  return path.join(vibeRootOrNull() ?? "<vibe plugin root>", relative);
}

/**
 * Whether vibe-core's hooks should stand down for `root` (vibe's install, or null): with no vibe
 * there is nothing to guard, and a vibe from before the split (1.1.68 or older) still runs its own
 * copy of these hooks, so running both would apply every guard twice.
 */
export function hookStandDown(root = vibeRootOrNull()) {
  if (!root) return HookStandDown.NoVibe;
  return existsSync(path.join(root, "hooks", "hooks.json")) ? HookStandDown.VibeOwnsHooks : null;
}
