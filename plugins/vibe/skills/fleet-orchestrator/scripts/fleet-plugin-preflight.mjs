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

/** Validate the checkout layout (plugins/vibe) a shipped plugin script runs from. */
export function stagedPluginProblems(layout, requiredVibe) {
  const vibe = pluginManifest(path.join(layout, "plugins", "vibe"));
  return [pluginVersionProblem("vibe", vibe?.version, requiredVibe)].filter(Boolean);
}

if (isEntryPoint(import.meta.url)) {
  const [layout, requiredVibe] = process.argv.slice(2);
  if (!layout || !requiredVibe) {
    process.stderr.write("usage: fleet-plugin-preflight.mjs <staged-layout> <required-vibe>\n");
    process.exitCode = 2;
  } else {
    const problems = stagedPluginProblems(layout, requiredVibe);
    if (problems.length) {
      process.stderr.write(`fleet plugin preflight: ${problems.join("; ")}\n`);
      process.exitCode = 78;
    }
  }
}
