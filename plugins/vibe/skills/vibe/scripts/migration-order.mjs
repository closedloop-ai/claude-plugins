#!/usr/bin/env node
// Every migration a branch adds must sort after the newest migration main
// already has in the same folder, checked before every push. A branch
// migration minted before a newer one landed on main ran out of order after
// the merge and failed the repo's smoke and rebuild checks. The fix is a
// rename to a later timestamp with the migration's contents unchanged.
//
// A migration is a folder or file directly under any `migrations` folder whose
// name starts with a timestamp of at least 8 digits
// (`.../migrations/20261021000000_name/migration.sql`, `.../migrations/20261021_name.sql`).
//
// Usage: migration-order.mjs --worktree <path> [--main <ref, default origin/main>]
// Prints one JSON object {ok, problems}; exits 1 when a migration sorts too early.
// A missing main ref is not checked (nothing to compare against) and says so.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const MIGRATION = /^(.*?(?:^|\/)migrations)\/(\d{8,})[^/]*(?:\/|$)/;
const MAX_BUFFER = 64 * 1024 * 1024;

/** Compares two digit strings as numbers of any length. */
function compareStamps(a, b) {
  return a.length === b.length ? a.localeCompare(b) : a.length - b.length;
}

/** The migrations folder and timestamp of a path, or null when it is not a migration. */
export function migrationOf(file) {
  const match = MIGRATION.exec(file);
  return match ? { dir: match[1], entry: file.slice(match[1].length + 1).split("/")[0], stamp: match[2] } : null;
}

/** Problems with the migrations `worktree`'s branch adds, against `main`. */
export function migrationOrderProblems(worktree, main = "origin/main") {
  const git = (args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    git(["rev-parse", "--verify", "--quiet", `${main}^{commit}`]);
  } catch {
    return { checked: false, problems: [], reason: `${main} is not available` };
  }
  const base = git(["merge-base", "HEAD", main]);
  const added = git(["diff", "--name-only", "--diff-filter=A", base, "HEAD"]).split("\n").filter(Boolean);
  const branch = new Map();
  for (const migration of added.map(migrationOf).filter(Boolean)) {
    branch.set(`${migration.dir}/${migration.entry}`, migration);
  }
  const newest = new Map();
  const problems = [];
  for (const migration of branch.values()) {
    if (!newest.has(migration.dir)) {
      const entries = lsTreeSafe(worktree, main, migration.dir).split("\n").filter(Boolean);
      newest.set(migration.dir, { entries: new Set(entries), stamp: entries.map((entry) => /^\d{8,}/.exec(entry)?.[0]).filter(Boolean).sort(compareStamps).at(-1) ?? null });
    }
    const onMain = newest.get(migration.dir);
    if (onMain.entries.has(migration.entry) || onMain.stamp === null) {
      continue;
    }
    if (compareStamps(migration.stamp, onMain.stamp) <= 0) {
      problems.push(`${migration.dir}/${migration.entry} sorts before or with main's newest ${onMain.stamp}; rename it to a timestamp after ${onMain.stamp}, contents unchanged`);
    }
  }
  return { checked: true, problems };
}

function lsTreeSafe(worktree, main, dir) {
  try {
    return execFileSync("git", ["-C", worktree, "ls-tree", "--name-only", `${main}:${dir}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function main() {
  const { values } = parseArgs({ options: { worktree: { type: "string" }, main: { type: "string" } } });
  if (!values.worktree) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "--worktree is required." })}\n`);
    process.exit(1);
  }
  const result = migrationOrderProblems(path.resolve(values.worktree), values.main);
  process.stdout.write(`${JSON.stringify({ ok: result.problems.length === 0, ...result }, null, 2)}\n`);
  process.exit(result.problems.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
