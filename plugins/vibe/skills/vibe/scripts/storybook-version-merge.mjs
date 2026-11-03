#!/usr/bin/env node
// Resolves a main sync whose only conflicts are the Storybook release files:
// the version file and the Version History. Main ships a Storybook release
// several times a day and so does every session that changes a story, so
// nearly every main sync conflicted on those two files, and resolving them by
// hand each time kept a publication from ever converging (ISS-13321).
//
// It takes main's version, bumps it by the level the session bumped its own
// base version (major, minor or patch), writes that into main's version file,
// and in each Version History file keeps both entries, the session's on top
// with the new version. It stages those files and changes nothing else; ROOT
// still commits the merge. The session's entry keeps its own contents counts,
// which the SAME writer updates to the merged tree before the commit.
//
// Usage: storybook-version-merge.mjs --worktree <path>
// Prints {"ok":true,"version","main","session","level","files"}; exits 2 when
// no merge is in progress, a conflict lies outside the release files, or the
// session did not bump its version (nothing it can settle mechanically).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { pathMatcher } from "../../handoff/scripts/path-gates.mjs";
import { bumpLevel, readStorybookRules } from "../../handoff/scripts/storybook-rules.mjs";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** `version` raised by `level` (major, minor or patch). */
export function bump(version, level) {
  const [, major, minor, patch] = SEMVER.exec(version) ?? [];
  if (major === undefined) throw new Error(`not a version: ${version}`);
  if (level === "major") return `${Number(major) + 1}.0.0`;
  if (level === "minor") return `${major}.${Number(minor) + 1}.0`;
  if (level === "patch") return `${major}.${minor}.${Number(patch) + 1}`;
  throw new Error(`the session's version change is not a bump (${level ?? "unchanged"})`);
}

/**
 * The merged Version History: main's file with the session's own inserted entries placed where the session put
 * them (newest first, above main's), renumbered to `version`. Null when the session did more than insert there.
 */
export function mergeHistory(base, ours, theirs, sessionVersion, version) {
  const lines = (text) => text.split(/(?<=\n)/);
  const [b, o, t] = [base, ours, theirs].map(lines);
  let prefix = 0;
  while (prefix < b.length && prefix < o.length && b[prefix] === o[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < b.length - prefix && suffix < o.length - prefix && b[b.length - 1 - suffix] === o[o.length - 1 - suffix]) suffix += 1;
  if (b.length - prefix - suffix !== 0) return null;
  if (b.slice(0, prefix).some((line, index) => t[index] !== line)) return null;
  const added = o.slice(prefix, o.length - suffix).join("").split(`"${sessionVersion}"`).join(`"${version}"`);
  return [...t.slice(0, prefix), added, ...t.slice(prefix)].join("");
}

/** The version file's text with `field` set to `version`, keeping the rest of main's file. */
export function setVersion(text, field, version) {
  const pattern = new RegExp(`("${field}"\\s*:\\s*")[^"]*(")`);
  if (!pattern.test(text)) throw new Error(`the version file has no "${field}"`);
  return text.replace(pattern, `$1${version}$2`);
}

function git(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { worktree: { type: "string" } } });
  if (!values.worktree) throw new Error("Usage: storybook-version-merge.mjs --worktree <path>");
  const worktree = path.resolve(values.worktree);
  const refuse = (reason) => { process.stdout.write(`${JSON.stringify({ ok: false, reason })}\n`); return 2; };
  try { git(worktree, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]); }
  catch { return refuse("no main merge is in progress"); }
  const release = readStorybookRules((file) => { try { return readFileSync(path.join(worktree, file), "utf8"); } catch { return null; } })?.config?.release;
  if (!release?.versionFile) return refuse("the repository declares no Storybook release files");
  const history = (release.historyFiles ?? []).map(pathMatcher);
  const conflicted = git(worktree, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
  const outside = conflicted.filter((file) => file !== release.versionFile && !history.some((matches) => matches(file)));
  if (conflicted.length === 0 || outside.length) return refuse(`conflicts outside the Storybook release files: ${outside.join(", ") || "none"}`);
  const field = release.versionField ?? "version";
  const stage = (number) => JSON.parse(git(worktree, ["show", `:${number}:${release.versionFile}`]))[field];
  const [base, session, mainVersion] = [1, 2, 3].map(stage);
  const level = bumpLevel(base, session);
  if (!["major", "minor", "patch"].includes(level)) return refuse(`the session's version ${session} is not a bump of ${base}`);
  const version = bump(mainVersion, level);
  const resolved = new Map();
  for (const file of conflicted.filter((item) => item !== release.versionFile)) {
    const [base, ours, theirs] = [1, 2, 3].map((number) => git(worktree, ["show", `:${number}:${file}`]) + "\n");
    const merged = mergeHistory(base, ours, theirs, session, version);
    if (merged === null) return refuse(`${file}: the session did more than add its release entry; the writer resolves it`);
    resolved.set(file, merged);
  }
  writeFileSync(path.join(worktree, release.versionFile), setVersion(git(worktree, ["show", `:3:${release.versionFile}`]) + "\n", field, version));
  resolved.forEach((text, file) => writeFileSync(path.join(worktree, file), text));
  git(worktree, ["add", "--", ...conflicted]);
  process.stdout.write(`${JSON.stringify({ ok: true, version, main: mainVersion, session, level, files: conflicted })}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
