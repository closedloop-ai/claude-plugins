// The handoff inventory's result cache, in the session's private git directory.
// An entry is reused only when its key matches exactly: the head commit, the
// diff hash (the comparison base, the uncommitted and untracked source, and the
// session inputs the rules read) and the rules version (the content of every
// rule source file, computed, never hand-bumped). There is no fallback to an
// entry from another head or diff: stale evidence must never pass.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { vibeCorePath } from "../../../shared/vibe-core.mjs";

const VIBE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CACHE_DIR = "vibe-inventory-cache";
const CACHE_ENTRIES = 16;

/** Every rule source directory: this plugin's handoff and vibe scripts, shared modules and lib. */
export function ruleSourceRoots() {
  return [
    path.join(VIBE_ROOT, "skills", "handoff", "scripts"),
    path.join(VIBE_ROOT, "skills", "vibe", "scripts"),
    path.join(VIBE_ROOT, "shared"),
    vibeCorePath("lib"),
  ];
}

/** Every non-test module under the rule source roots, absolute and sorted. */
export function ruleSourceFiles(roots = ruleSourceRoots()) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") walk(file);
      else if (entry.isFile() && /\.m?js$/.test(entry.name) && !/\.test\.m?js$/.test(entry.name)) files.push(file);
    }
  };
  roots.forEach(walk);
  return files.sort();
}

/** The rules version: one hash over each rule source file's path and content. */
export function rulesVersion(roots = ruleSourceRoots()) {
  const hash = createHash("sha256");
  for (const file of ruleSourceFiles(roots)) {
    hash.update(`${path.relative(path.dirname(VIBE_ROOT), file)}\0`).update(readFileSync(file)).update("\0");
  }
  return hash.digest("hex");
}

/** sha256 of the values in order, each framed so no two different lists hash alike. */
export function hashParts(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const text = typeof part === "string" ? part : JSON.stringify(part ?? null);
    hash.update(`${Buffer.byteLength(text)}:`).update(text);
  }
  return hash.digest("hex");
}

/** The cached value for exactly `key` ({ head, diffHash, rulesVersion, ... }), or null. */
export function readInventoryCache(gitDir, key) {
  let entry;
  try { entry = JSON.parse(readFileSync(entryPath(gitDir, key), "utf8")); }
  catch { return null; }
  return isDeepStrictEqual(entry?.key, key) ? entry.value : null;
}

/** Store `value` under `key`, keeping the newest CACHE_ENTRIES entries. */
export function writeInventoryCache(gitDir, key, value) {
  const dir = path.join(gitDir, CACHE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = entryPath(gitDir, key);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ key, value })}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  const entries = readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, at: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  for (const { name } of entries.slice(CACHE_ENTRIES)) rmSync(path.join(dir, name), { force: true });
}

function entryPath(gitDir, key) {
  return path.join(gitDir, CACHE_DIR, `${hashParts([key])}.json`);
}
