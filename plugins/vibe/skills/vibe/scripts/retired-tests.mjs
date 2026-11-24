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

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isTestFile } from "./test-files.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { issueKey, requirementsKey } from "./tracker-key.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

const { git } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { scriptExitCode } = await vibeCore("lib/vibe/scripts/provider.mjs");

const RECORD_FILE = "vibe-retired-tests.json";
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

/** Exact file paths whose retirement record covers the entire file. */
export function wholeRetiredTestPaths(records) {
  return new Set(records.filter((entry) => entry.case === undefined).map((entry) => entry.path));
}

/** Adds one deletion, replacing an earlier entry for the same file and case. */
export function recordRetiredTest(worktree, entry) {
  const normalized = {
    path: entry.path,
    ...(entry.case ? { case: entry.case } : {}),
    retiredBy: entry.retiredBy,
    covers: entry.covers,
    ...(entry.assertions ? { assertions: entry.assertions } : {}),
    ...(entry.supersession ? { supersession: entry.supersession } : {}),
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

function relativeFile(file) {
  return typeof file === "string" && !path.isAbsolute(file) && !file.split("/").includes("..") && file.includes(".");
}

function validAssertion(row) {
  return row && isText(row.case) && Number.isSafeInteger(row.index) && row.index > 0 && relativeFile(row.source)
    && (row.replacement === undefined || (relativeFile(row.replacement?.path) && isTestFile(row.replacement.path) && isText(row.replacement.case)));
}

/** Scope an assertion supersession to one parsed case, captured base and authorized frozen-policy change. */
export function validTestSupersession(proof) {
  const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const authorizedReason = (proof?.row === "DT-038G" && proof.reason === "authorized stricter frozen repetition rule")
    || (proof?.row === "DT-017A" && proof.reason === "authorized separate frozen admission budget");
  return authorizedReason && /^[a-f0-9]{40}$/.test(proof.base ?? "") && isText(proof.source)
    && (proof.replacementCase === undefined || isText(proof.replacementCase))
    && Array.isArray(proof.changes) && proof.changes.length > 0
    && proof.changes.every((change) => Number.isSafeInteger(change?.index) && change.index > 0
      && sha(change.oldSha256) && sha(change.newSha256) && change.oldSha256 !== change.newSha256)
    && new Set(proof.changes.map(({ index }) => index)).size === proof.changes.length;
}

function isValidEntry(entry) {
  return Boolean(entry) && typeof entry === "object" &&
    typeof entry.path === "string" && !path.isAbsolute(entry.path) && !entry.path.split("/").includes("..") &&
    isTestFile(entry.path) &&
    (entry.case === undefined || isText(entry.case)) &&
    typeof entry.retiredBy === "string" && new RegExp(`^(?:${issueKey()}|${requirementsKey()})$`).test(entry.retiredBy) &&
    isText(entry.covers) &&
    (entry.assertions === undefined || Array.isArray(entry.assertions) && entry.assertions.every(validAssertion)) &&
    (entry.supersession === undefined || isText(entry.case) && validTestSupersession(entry.supersession));
}

function isText(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_TEXT;
}

if (isEntryPoint(import.meta.url)) {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: {
        worktree: { type: "string" }, path: { type: "string" }, case: { type: "string" },
        "retired-by": { type: "string" }, covers: { type: "string" }, "assertion-map": { type: "string" }, supersession: { type: "string" },
      },
    });
    if (!values.worktree) throw new Error("--worktree is required.");
    const [command] = positionals;
    let retiredTests;
    if (command === "record") {
      retiredTests = recordRetiredTest(values.worktree, {
        path: values.path, case: values.case, retiredBy: values["retired-by"], covers: values.covers,
        ...(values["assertion-map"] ? { assertions: JSON.parse(readFileSync(values["assertion-map"], "utf8")) } : {}),
        ...(values.supersession ? { supersession: JSON.parse(readFileSync(values.supersession, "utf8")) } : {}),
      });
    } else if (command === "list") {
      retiredTests = readRetiredTests(values.worktree);
    } else {
      throw new Error("Use record or list.");
    }
    process.stdout.write(`${JSON.stringify({ ok: true, retiredTests })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = scriptExitCode(error, 1);
  }
}
