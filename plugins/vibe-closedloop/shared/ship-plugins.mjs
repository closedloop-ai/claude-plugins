#!/usr/bin/env node
// Stages the vibe files some vibe scripts need on another host.
// fleet.sh and snapshot.sh ship scripts over ssh; the archive holds vibe laid
// out as a checkout (plugins/vibe), which plugin-roots.mjs reads.
//
// Usage: ship-plugins.mjs <vibe-relative entry>...
// Prints a new temporary directory holding plugins/vibe as a link to this
// install, and writes <dir>/files: each entry plus every module it loads
// (relative imports, vibeCore() and runVibeCoreMain() names, transitively)
// and vibe's manifests, one stage-relative path per line.
// Archive them with `tar -h -C <dir> $(cat <dir>/files)`, then remove <dir>.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isEntryPoint, MANIFESTS, ownPluginRoot } from "./plugin-roots.mjs";

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
const VIBE_CORE_LOAD = /\b(?:vibeCore|runVibeCoreMain|vibeCorePath)\(\s*["']([^"']+)["']\s*\)/g;

/** Every file `entries` (paths inside vibe) need, as `plugins/vibe/...` paths. */
export function shippedFiles(entries, root = ownPluginRoot(import.meta.url).root) {
  const label = (file) => {
    if (file.startsWith(`${root}${path.sep}`)) return `plugins/vibe/${path.relative(root, file)}`;
    throw new Error(`${file} is not in vibe`);
  };
  const files = new Set(MANIFESTS.map((manifest) => path.join(root, manifest)).filter((file) => existsSync(file)));
  const pending = entries.map((entry) => path.join(root, entry));
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
      const target = path.join(root, relative);
      if (!files.has(target)) pending.push(target);
    }
  }
  return [...files].map(label).sort();
}

/** A new staging directory for `entries`, with its `files` list written; returns its path. */
export function stagePlugins(entries) {
  const root = ownPluginRoot(import.meta.url).root;
  const files = shippedFiles(entries, root);
  const stage = mkdtempSync(path.join(os.tmpdir(), "vibe-plugins-"));
  mkdirSync(path.join(stage, "plugins"));
  symlinkSync(root, path.join(stage, "plugins", "vibe"));
  writeFileSync(path.join(stage, "files"), `${files.join("\n")}\n`);
  return stage;
}
if (isEntryPoint(import.meta.url)) {
  try {
    const entries = process.argv.slice(2);
    if (entries.length === 0) throw new Error("Usage: ship-plugins.mjs <vibe-relative entry>...");
    process.stdout.write(`${stagePlugins(entries)}\n`);
  } catch (error) {
    process.stderr.write(`ship-plugins: ${error.message}\n`);
    process.exitCode = 2;
  }
}
