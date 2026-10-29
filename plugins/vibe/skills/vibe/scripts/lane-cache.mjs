// Lane-evidence cache (ISS-13354, PRD-823, WS4 R3): a lane result is reused
// only when the tree, the base, the config and the scope all match, and a
// reused result is recorded and reported as `cached`, never as a fresh pass.
//
// The key is the SHA-256 of one canonical JSON object:
//   { v: 1, command, tree, base, config, scope }
//   tree   = the tested commit's tree id (`HEAD^{tree}`), so a commit with the
//            same content (an amend, an empty commit, a rebase onto the same
//            base) matches and any content change does not.
//   base   = the main commit the diff is taken against; main moving on is a
//            different base, so it invalidates.
//   config = the lane's command line plus every `--config <text>` the caller
//            passes (anything outside the tree that changes the result).
//   scope  = a hash of the changed files' paths and blob ids against `base`.
// Only a record that is itself a fresh `pass` with a key is reusable; a cached
// record, a failure, `main-preexisting` and a record without a key never are.
// This module changes no records itself: pre-pr-lanes.mjs applies it, behind
// `check --reuse-cache`.

import { createHash } from "node:crypto";
import { git } from "./session-record.mjs";

export const LANE_CACHE_VERSION = 1;
export const Provenance = { Fresh: "fresh", Cached: "cached" };
export const CACHED_RESULT = "cached";

/** Deterministic key for one lane's inputs; a different value in any field gives a different key. */
export function laneCacheKey({ command, tree, base, config = [], scope }) {
  for (const [name, value] of Object.entries({ command, tree, base, scope })) {
    if (typeof value !== "string" || value === "") throw new Error(`lane cache key needs ${name}`);
  }
  const canonical = JSON.stringify({ v: LANE_CACHE_VERSION, command: command.trim(), tree, base, config: [...config].map(String).sort(), scope });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Hash of the changed paths and their blob ids between `base` and `head`; "empty" when nothing changed. */
export function scopeHash(worktree, base, head = "HEAD") {
  const raw = git(worktree, ["diff", "--raw", "--no-abbrev", "--no-renames", base, head]);
  const lines = raw.split("\n").filter(Boolean).map((line) => line.replace(/^:\d+ \d+ [0-9a-f]+ /, "")).sort();
  return lines.length === 0 ? "empty" : createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** The key for `command` at the worktree's HEAD, or null when the base cannot be resolved (then nothing is cached or reused). */
export function laneKeyFor(worktree, { command, base, config = [] }) {
  try {
    const resolvedBase = base ?? git(worktree, ["merge-base", "HEAD", "origin/main"]);
    return laneCacheKey({
      command, base: git(worktree, ["rev-parse", resolvedBase]), config,
      tree: git(worktree, ["rev-parse", "HEAD^{tree}"]), scope: scopeHash(worktree, resolvedBase),
    });
  } catch {
    return null;
  }
}

/** The fresh passing record whose key is `key`, or undefined. Cached, failed and key-less records never match. */
export function findReusable(records, key) {
  if (!key) return undefined;
  return records.find((record) => record.result === "pass" && record.provenance !== Provenance.Cached && record.cacheKey === key);
}

/** The record that stands in for a lane not run at `head`: result `cached`, never `pass`. */
export function cachedRecord({ command, head, key, source, at = new Date().toISOString() }) {
  return { command, head, result: CACHED_RESULT, provenance: Provenance.Cached, cacheKey: key, reusedFrom: { head: source.head, at: source.at }, at };
}
