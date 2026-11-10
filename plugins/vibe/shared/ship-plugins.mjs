#!/usr/bin/env node
// Stages the vibe and vibe-core files some vibe scripts need on another host
// (ISS-13869). fleet.sh and snapshot.sh ship scripts over ssh; since vibe's
// scripts load vibe-core's modules, the archive holds both plugins laid out as
// a checkout (plugins/vibe, plugins/vibe-core), which plugin-roots.mjs reads.
//
// Usage: ship-plugins.mjs <vibe-relative entry>...
// Prints a new temporary directory holding plugins/vibe and plugins/vibe-core
// as links to the two installs, and writes <dir>/files: each entry plus every
// module it loads (relative imports, vibeCore() and runVibeCoreMain() names,
// transitively) and both plugins' manifests, one stage-relative path per line.
// Archive them with `tar -h -C <dir> $(cat <dir>/files)`, then remove <dir>.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFESTS, ownPluginRoot } from "./plugin-roots.mjs";
import { vibeCoreRoot } from "./vibe-core.mjs";

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
const VIBE_CORE_LOAD = /\b(?:vibeCore|runVibeCoreMain|vibeCorePath)\(\s*["']([^"']+)["']\s*\)/g;

/** Every file `entries` (paths inside vibe) need, as `plugins/vibe/...` and `plugins/vibe-core/...` paths. */
export function shippedFiles(entries, roots = { vibe: ownPluginRoot(import.meta.url).root, core: vibeCoreRoot() }) {
  const plugins = [["vibe", roots.vibe], ["vibe-core", roots.core]];
  const label = (file) => {
    for (const [name, root] of plugins) {
      if (file.startsWith(`${root}${path.sep}`)) return `plugins/${name}/${path.relative(root, file)}`;
    }
    throw new Error(`${file} is in neither vibe nor vibe-core`);
  };
  const files = new Set(plugins.flatMap(([, root]) => MANIFESTS.map((manifest) => path.join(root, manifest)).filter((file) => existsSync(file))));
  const pending = entries.map((entry) => path.join(roots.vibe, entry));
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    if (!existsSync(file)) throw new Error(`${label(file)} does not exist`);
    files.add(file);
    if (!file.endsWith(".mjs")) continue;
    const source = readFileSync(file, "utf8");
    for (const [, spec] of source.matchAll(RELATIVE_IMPORT)) {
      const target = path.resolve(path.dirname(file), spec);
      if (!files.has(target)) pending.push(target);
    }
    for (const [, relative] of source.matchAll(VIBE_CORE_LOAD)) {
      const target = path.join(roots.core, relative);
      if (!files.has(target)) pending.push(target);
    }
  }
  return [...files].map(label).sort();
}

/** A new staging directory for `entries`, with its `files` list written; returns its path. */
export function stagePlugins(entries) {
  const roots = { vibe: ownPluginRoot(import.meta.url).root, core: vibeCoreRoot() };
  const files = shippedFiles(entries, roots);
  const stage = mkdtempSync(path.join(os.tmpdir(), "vibe-plugins-"));
  mkdirSync(path.join(stage, "plugins"));
  symlinkSync(roots.vibe, path.join(stage, "plugins", "vibe"));
  symlinkSync(roots.core, path.join(stage, "plugins", "vibe-core"));
  writeFileSync(path.join(stage, "files"), `${files.join("\n")}\n`);
  return stage;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const entries = process.argv.slice(2);
    if (entries.length === 0) throw new Error("Usage: ship-plugins.mjs <vibe-relative entry>...");
    process.stdout.write(`${stagePlugins(entries)}\n`);
  } catch (error) {
    process.stderr.write(`ship-plugins: ${error.message}\n`);
    process.exitCode = 2;
  }
}
