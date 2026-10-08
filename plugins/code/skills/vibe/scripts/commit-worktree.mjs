#!/usr/bin/env node
// Commits a worktree's changes for an orchestrator (vibe, handoff, or
// vibe-seed-refresh). No worker commits: committing runs the repository's
// commit hooks, so the orchestrator owns it and gets back one short JSON line
// instead of the hook output.
//
// Usage:
//   commit-worktree.mjs --worktree <path> --subject <text> [--body <text>]
//
// Stages everything, then leaves out the session's `localFixes` (from the
// vibe session record, when the worktree has one) and files that never belong
// in a commit (`.env` files and `.control/`, `node_modules/`, `.next/`,
// `.turbo/`, `storybook-static/`). A staged merge (MERGE_HEAD) is concluded.
// Hooks always run; a refused commit commits nothing and reports the end of
// the hook output. Never amends, squashes, or skips hooks.
//
// Prints one JSON object on stdout. Errors print {"ok":false,"error":...} and
// exit non-zero.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { git, readSessionRecord } from "./session-record.mjs";

const MAX_SUBJECT_LENGTH = 72;
const HOOK_OUTPUT_LINES = 40;
// A commit hook can run an affected typecheck; give it room before giving up.
const COMMIT_TIMEOUT_MS = 30 * 60 * 1000;
const NEVER_COMMITTED_SEGMENTS = new Set([".control", "node_modules", ".next", ".turbo", "storybook-static"]);
const ENV_FILE = /^\.env(?:\..+)?$/;
const ENV_EXAMPLE = /^\.env\.example$/;

const { values } = parseArgs({
  options: {
    worktree: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
  },
});

try {
  process.stdout.write(`${JSON.stringify({ ok: true, ...commitWorktree() }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
  );
  process.exit(1);
}

function commitWorktree() {
  if (!values.worktree) {
    throw new Error("--worktree is required.");
  }
  const worktree = path.resolve(values.worktree);
  const subject = requireSubject(values.subject);
  const localFixes = (readSessionRecord(worktree)?.localFixes ?? []).flatMap((fix) => fix.paths ?? []);

  git(worktree, ["add", "-A"]);
  const excluded = stagedFiles(worktree).filter((file) => isLocalFix(file, localFixes) || neverCommitted(file));
  for (const file of excluded) {
    git(worktree, ["restore", "--staged", "--", file]);
  }
  const files = stagedFiles(worktree);
  const merging = hasMergeHead(worktree);
  if (files.length === 0 && !merging) {
    return { committed: false, reason: "Nothing to commit.", excluded };
  }

  const messageFile = path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "vibe-commit-message.txt");
  writeFileSync(messageFile, values.body ? `${subject}\n\n${values.body.trim()}\n` : `${subject}\n`);
  const result = spawnSync("git", ["commit", "-F", messageFile], {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: COMMIT_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n");
    const reason = result.error ? result.error.message : `exit ${result.status}`;
    throw new Error(
      `The commit was refused (${reason}); nothing was committed. Last lines:\n${output.slice(-HOOK_OUTPUT_LINES).join("\n")}`
    );
  }
  return { committed: true, commit: git(worktree, ["rev-parse", "HEAD"]), subject, merge: merging, files, excluded };
}

function requireSubject(subject) {
  if (!subject || !subject.trim()) {
    throw new Error("--subject is required.");
  }
  if (subject.includes("\n")) {
    throw new Error("--subject must be one line; put the rest in --body.");
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new Error(`--subject must be at most ${MAX_SUBJECT_LENGTH} characters (got ${subject.length}).`);
  }
  return subject.trim();
}

function stagedFiles(worktree) {
  const names = git(worktree, ["diff", "--cached", "--name-only"]);
  return names ? names.split("\n") : [];
}

function hasMergeHead(worktree) {
  try {
    git(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function isLocalFix(file, localFixes) {
  return localFixes.some((fix) => file === fix || file.startsWith(`${fix}/`));
}

function neverCommitted(file) {
  const segments = file.split("/");
  const name = segments.at(-1);
  if (ENV_FILE.test(name) && !ENV_EXAMPLE.test(name)) {
    return true;
  }
  return segments.some((segment) => NEVER_COMMITTED_SEGMENTS.has(segment));
}
