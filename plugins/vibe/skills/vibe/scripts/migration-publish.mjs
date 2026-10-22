#!/usr/bin/env node
// Pushing a migration publishes it. A vibe branch push once ran preview CI
// that applied an unreviewed migration to two shared preview schemas, and the
// later fix needed a cleanup run; a takeover writer found another migration's
// trigger had moved quadratic cost onto every insert (10 s per insert), which
// its handoff had called done. So before the first push, each new migration
// needs a test that runs it, and one that adds a trigger, a function or
// per-row work needs a measured scale test, both recorded in the change log:
//   Migration test: <migration id>: <test file>
//   Scale test: <migration id>: <test file>: <n> rows, <time per write or total>
// The test file must exist at HEAD; an existing test that applies every
// migration counts, since a vibe session writes no tests unless asked for a
// pull request. The migration id is its folder name
// (`migrations/<id>/migration.sql`) or its file name without `.sql`.
//
// Usage: migration-publish.mjs --worktree <path> --since <the last pushed commit, or the session's base commit> [--change-log <file>]
// Prints {"ok","migrations","problems"}; exits 1 on any problem. Changes nothing.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { escapeRegExp } from "../../handoff/scripts/source-imports.mjs";
import { git } from "./session-record.mjs";
import { isTestFile } from "./test-files.mjs";

const MIGRATION = /(?:^|\/)migrations\/(?:([^/]+)\/[^/]+|([^/]+))\.sql$/;
const PER_ROW_WORK = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?(?:TRIGGER|FUNCTION|PROCEDURE)\b|\bFOR\s+EACH\s+ROW\b/i;
const MEASUREMENT = /\d[\d,_]*\s*(?:k\s*)?rows?\b.*\d+(?:\.\d+)?\s*(?:ms|s|seconds?|milliseconds?)\b/i;

/** The migration id of a SQL file under a `migrations` directory, or null. */
export function migrationId(file) {
  const match = MIGRATION.exec(file);
  if (!match) return null;
  return match[1] ?? match[2];
}

/**
 * Problems with the new migrations in `added` (`{path, sql}` each) against the
 * change log; `exists(file)` says whether a recorded test file is at HEAD.
 */
export function migrationProblems(added, changeLog, exists) {
  const problems = [];
  for (const { path: file, sql } of added) {
    const id = migrationId(file);
    const recorded = (label) => {
      const match = new RegExp(String.raw`^\s*(?:[-*]\s+)?${label}:\s*${escapeRegExp(id)}:\s*(\S+?)(?::\s*(.*))?\s*$`, "m").exec(changeLog);
      return match ? { test: match[1], rest: match[2] ?? "" } : null;
    };
    const test = recorded("Migration test");
    if (!test) {
      problems.push(`${file}: no \`Migration test: ${id}: <test file>\`; pushing applies it to shared preview schemas, so a test that runs it comes first`);
    } else if (!isTestFile(test.test) || !exists(test.test)) {
      problems.push(`${file}: the recorded migration test ${test.test} is not a test file at HEAD`);
    }
    if (PER_ROW_WORK.test(sql)) {
      const scale = recorded("Scale test");
      if (!scale) {
        problems.push(`${file}: adds a trigger, function or per-row work with no \`Scale test: ${id}: <test file>: <n> rows, <time>\`; measure it at production scale before the first push`);
      } else if (!isTestFile(scale.test) || !exists(scale.test) || !MEASUREMENT.test(scale.rest)) {
        problems.push(`${file}: the scale test line needs a test file at HEAD and a measurement (<n> rows, <time>), got "${scale.test}: ${scale.rest}"`);
      }
    }
  }
  return problems;
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { worktree: { type: "string" }, since: { type: "string" }, "change-log": { type: "string" } } });
  if (!values.worktree || !values.since) {
    throw new Error("Usage: migration-publish.mjs --worktree <path> --since <commit> [--change-log <file>]");
  }
  const worktree = path.resolve(values.worktree);
  const files = git(worktree, ["diff", "--name-only", "--diff-filter=A", `${values.since}..HEAD`]).split("\n").filter((file) => migrationId(file));
  const added = files.map((file) => ({ path: file, sql: git(worktree, ["show", `HEAD:${file}`]) }));
  const logFile = values["change-log"] ?? path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "vibe-changes.md");
  const changeLog = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  const tracked = new Set(git(worktree, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n"));
  const problems = migrationProblems(added, changeLog, (file) => tracked.has(file));
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, migrations: files, problems }, null, 2)}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
