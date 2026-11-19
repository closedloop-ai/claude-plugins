/**
 * Codex's `codex-plugin-bundle-v1` content hash of a plugin root: the value Codex stores as a hook's
 * `trusted_content_hash` and recomputes before every hook run, so any change to it makes Codex users approve the
 * plugin's hooks again. Ported from codex-rs/hooks/src/engine/plugin_fingerprint.rs `plugin_content_hash`
 * (openai/codex tag rust-v0.169.0): SHA-256 over the tag, then each entry depth first in byte order of its name,
 * as the u64 little-endian length and bytes of its path relative to the root, then "directory", or "file" with
 * the u64 little-endian length and the bytes. Entries named `__pycache__` or `.venv`, or ending in `.pyc` or
 * `.egg-info`, are skipped with everything under them; any other entry type (a symlink) is an error, as it is in
 * Codex, which then skips every hook of the plugin.
 *
 * Checked against Codex itself: this port reproduces the `trusted_content_hash` codex-cli 0.169.0 recorded for
 * vibe-core 1.0.13 and for code 2.0.2 from their installed cache folders, and the same value for vibe-core 1.0.13
 * exported from main.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const BUNDLE_TAG = "codex-plugin-bundle-v1";

export function codexPluginFingerprint(root: string): string {
  if (!lstatSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
  const hash = createHash("sha256").update(BUNDLE_TAG);
  const pending = [root];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    const name = relative(root, path);
    if (name !== "" && isSkipped(basename(name))) continue;
    const nameBytes = Buffer.from(name);
    hash.update(u64(nameBytes.length)).update(nameBytes);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      hash.update("directory");
      const entries = readdirSync(path).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      pending.push(...entries.reverse().map((entry) => join(path, entry)));
    } else if (stat.isFile()) {
      const bytes = readFileSync(path);
      hash.update("file").update(u64(bytes.length)).update(bytes);
    } else {
      throw new Error(`unsupported plugin entry type: ${path}`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function isSkipped(name: string): boolean {
  return name === "__pycache__" || name === ".venv" || name.endsWith(".pyc") || name.endsWith(".egg-info");
}

function u64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}
