#!/usr/bin/env node
// Records tests the session's writer deleted because they covered only code the
// request itself retires (operator ruling, 2026-10-13). Each entry cites
// the ticket or PRD that retires that code. The handoff inventory admits a
// deleted test file outside a pull request only with a whole-file entry here,
// and the live ticket lists every entry next to Missing tests.
//
// The record is private Git metadata beside the session record, never a
// tracked file.
//
// Usage:
//   retired-tests.mjs record --worktree <wt> --path <test file> --retired-by <ISS-|PRD-|FEA-slug>
//                           --covers "<retired code it covered>" [--case "<test name>"]
//   retired-tests.mjs list --worktree <wt>

import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { git } from "./session-record.mjs";
import { isTestFile } from "./test-files.mjs";

const RECORD_FILE = "vibe-retired-tests.json";
const RETIRING_DOCUMENT = /^(?:ISS|PRD|FEA)-\d+$/;
const MAX_TEXT = 500;

/** Every recorded retired-only test deletion, oldest first; empty when none were recorded. */
export function readRetiredTests(worktree) {
  const file = recordPath(worktree);
  if (!existsSync(file)) {
    return [];
  }
  const entries = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(entries) || !entries.every(isValidEntry)) {
    throw new Error(`${file} is not a valid retired-test record.`);
  }
  return entries;
}

/** Adds one deletion, replacing an earlier entry for the same file and case. */
export function recordRetiredTest(worktree, entry) {
  const normalized = {
    path: entry.path,
    ...(entry.case ? { case: entry.case } : {}),
    retiredBy: entry.retiredBy,
    covers: entry.covers,
  };
  if (!isValidEntry(normalized)) {
    throw new Error(
      "A retired test needs a repo-relative test file --path, --retired-by with the ISS-, PRD- or FEA- slug that retires the code, and --covers naming that code."
    );
  }
  const entries = readRetiredTests(worktree)
    .filter((existing) => existing.path !== normalized.path || existing.case !== normalized.case);
  entries.push(normalized);
  const file = recordPath(worktree);
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return entries;
}

function recordPath(worktree) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), RECORD_FILE);
}

function isValidEntry(entry) {
  return Boolean(entry) && typeof entry === "object" &&
    typeof entry.path === "string" && !path.isAbsolute(entry.path) && !entry.path.split("/").includes("..") &&
    isTestFile(entry.path) &&
    (entry.case === undefined || isText(entry.case)) &&
    typeof entry.retiredBy === "string" && RETIRING_DOCUMENT.test(entry.retiredBy) &&
    isText(entry.covers);
}

function isText(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_TEXT;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: {
        worktree: { type: "string" }, path: { type: "string" }, case: { type: "string" },
        "retired-by": { type: "string" }, covers: { type: "string" },
      },
    });
    if (!values.worktree) throw new Error("--worktree is required.");
    const [command] = positionals;
    let retiredTests;
    if (command === "record") {
      retiredTests = recordRetiredTest(values.worktree, {
        path: values.path, case: values.case, retiredBy: values["retired-by"], covers: values.covers,
      });
    } else if (command === "list") {
      retiredTests = readRetiredTests(values.worktree);
    } else {
      throw new Error("Use record or list.");
    }
    process.stdout.write(`${JSON.stringify({ ok: true, retiredTests })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
