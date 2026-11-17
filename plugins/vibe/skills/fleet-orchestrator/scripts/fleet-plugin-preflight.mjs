#!/usr/bin/env node
import path from "node:path";
import { comparePluginVersions, isEntryPoint, pluginManifest } from "../../../shared/plugin-roots.mjs";

/** A named version error for one staged plugin, or null when it meets the required version. */
export function pluginVersionProblem(plugin, installed, required) {
  if (typeof installed !== "string" || comparePluginVersions(installed, required) < 0) {
    return `${plugin} plugin installed version ${installed ?? "missing"} is older than required version ${required}`;
  }
  return null;
}

/** Validate the two-plugin checkout layout used by a shipped plugin script. */
export function stagedPluginProblems(layout, requiredVibe, requiredCore) {
  const vibe = pluginManifest(path.join(layout, "plugins", "vibe"));
  const core = pluginManifest(path.join(layout, "plugins", "vibe-core"));
  return [
    pluginVersionProblem("vibe", vibe?.version, requiredVibe),
    pluginVersionProblem("vibe-core", core?.version, requiredCore),
  ].filter(Boolean);
}

if (isEntryPoint(import.meta.url)) {
  const [layout, requiredVibe, requiredCore] = process.argv.slice(2);
  if (!layout || !requiredVibe || !requiredCore) {
    process.stderr.write("usage: fleet-plugin-preflight.mjs <staged-layout> <required-vibe> <required-vibe-core>\n");
    process.exitCode = 2;
  } else {
    const problems = stagedPluginProblems(layout, requiredVibe, requiredCore);
    if (problems.length) {
      process.stderr.write(`fleet plugin preflight: ${problems.join("; ")}\n`);
      process.exitCode = 78;
    }
  }
}
