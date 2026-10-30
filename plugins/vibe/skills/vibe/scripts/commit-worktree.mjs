#!/usr/bin/env node
// Commits a worktree's changes for an orchestrator (vibe, handoff, or
// vibe-seed-refresh). No worker commits: committing runs the repository's
// commit hooks, so the orchestrator owns it and gets back one short JSON line
// instead of the hook output.
//
// Usage:
//   commit-worktree.mjs --worktree <path> --subject <text> [--body <text>] [--exclude <path>]...
//   commit-worktree.mjs --worktree <path> --amend
//
// Stages everything, then leaves out the session's `localFixes` (from the
// vibe session record, when the worktree has one), files that never belong
// in a commit (`.env` files and `.control/`, `node_modules/`, `.next/`,
// `.turbo/`, `storybook-static/`) and each untracked file or folder named by
// `--exclude`: a person's own files the session did not write, which the
// inventory lists as foreign. A person's 17 untracked skill files once held a
// commit for 1 h 37 min while a question about moving them waited
// (2026-10-26). `--exclude` never drops a tracked change, and a path that
// names no untracked file is refused, so a typo cannot hide work. A staged
// merge (MERGE_HEAD) is concluded.
// Hooks always run; a refused commit commits nothing and reports the end of
// the hook output. `--amend` is only for a repaired commit that no remote
// contains yet; it preserves the message and still runs hooks. Never squashes
// or skips hooks.
// Prints one JSON object on stdout. Errors print {"ok":false,"error":...} and
// exit non-zero.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { committedLocalPlans, isLocalPlanPath } from "./local-plans.mjs";
import { git, readSessionRecord } from "./session-record.mjs";
import { mainSyncFailure, prepareMainSync, readMainSyncInput } from "./dist/main-sync.mjs";

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
    exclude: { type: "string", multiple: true, default: [] },
    amend: { type: "boolean", default: false },
    "prepare-main-sync": { type: "boolean", default: false },
  },
});

try {
  const result = values["prepare-main-sync"]
    ? { mainSync: prepareMainSync(await readMainSyncInput(values.worktree ?? "")) }
    : commitWorktree();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, ...(values["prepare-main-sync"] ? mainSyncFailure(error)
      : { error: error instanceof Error ? error.message : String(error) }) })}\n`
  );
  process.exit(1);
}

function commitWorktree() {
  if (!values.worktree) {
    throw new Error("--worktree is required.");
  }
  const worktree = path.resolve(values.worktree);
  const amend = values.amend;
  const subject = amend ? git(worktree, ['log', '-1', '--format=%s']) : requireSubject(values.subject);
  if (amend && publishedHead(worktree)) {
    throw new Error('Refusing to amend a commit already published on a remote branch.');
  }
  const localFixes = (readSessionRecord(worktree)?.localFixes ?? []).flatMap((fix) => fix.paths ?? []);

  const committedPlans = committedLocalPlans(args => git(worktree, args));
  if (committedPlans.length) {
    throw new Error(`Local technical plans are already committed; publication is blocked: ${committedPlans.join(", ")}`);
  }

  const foreign = foreignFiles(worktree, values.exclude);
  git(worktree, ["add", "-A"]);
  const excluded = stagedFiles(worktree).filter((file) => isLocalFix(file, localFixes) || neverCommitted(file) || foreign.has(file));
  for (const file of excluded) {
    git(worktree, ["restore", "--staged", "--", file]);
  }
  const files = stagedFiles(worktree);
  const merging = hasMergeHead(worktree);
  if (files.length === 0 && !merging) {
    return { committed: false, reason: "Nothing to commit.", excluded };
  }

  const messageFile = path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "vibe-commit-message.txt");
  if (!amend) writeFileSync(messageFile, values.body ? `${subject}\n\n${values.body.trim()}\n` : `${subject}\n`);
  const result = spawnSync("git", amend ? ["commit", "--amend", "--no-edit"] : ["commit", "-F", messageFile], {
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
  return { committed: true, amended: amend, commit: git(worktree, ["rev-parse", "HEAD"]), subject, merge: merging, files, excluded };
}

function publishedHead(worktree) {
  const head = git(worktree, ['rev-parse', 'HEAD']);
  const trackedRemotely = () => Boolean(git(worktree, ['branch', '-r', '--contains', head]));
  if (trackedRemotely()) return true;
  const remotes = git(worktree, ['remote']).split('\n').filter(Boolean);
  for (const remote of remotes) {
    const listed = spawnSync('git', ['ls-remote', '--heads', remote], {
      cwd: worktree, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (listed.error || listed.status !== 0) throw new Error('Cannot verify whether the commit was published to a remote; refusing to amend.');
    const advertised = listed.stdout.split('\n').filter(Boolean).map(line => {
      const [oid, ref] = line.split('\t');
      return { oid, ref };
    });
    if (advertised.some(({ oid }) => oid === head)) return true;
    if (advertised.length === 0) continue;
    // A remote tip may be a descendant of HEAD, so exact OID comparison is
    // insufficient. Refresh every advertised branch and ask Git about reachability.
    const fetched = spawnSync('git', ['fetch', '--quiet', '--no-tags', remote, `+refs/heads/*:refs/remotes/${remote}/*`], {
      cwd: worktree, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (fetched.error || fetched.status !== 0) throw new Error('Cannot verify remote branch ancestry; refusing to amend.');
    for (const { oid, ref } of advertised) {
      const branch = ref.slice('refs/heads/'.length);
      let fetchedOid = null;
      try { fetchedOid = git(worktree, ['rev-parse', '--verify', `refs/remotes/${remote}/${branch}^{commit}`]); }
      catch { /* The branch moved or disappeared between listing and fetch. */ }
      if (fetchedOid !== oid) throw new Error('Remote branches changed while verifying amend safety; refusing to amend.');
    }
    if (trackedRemotely()) return true;
  }
  return false;
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
  const names = git(worktree, ["diff", "--cached", "--name-only", "-z"]);
  return names ? names.split("\0").filter(Boolean) : [];
}

/** The untracked files under each `--exclude` path; refuses a path that names none. */
function foreignFiles(worktree, excludes) {
  if (excludes.length === 0) return new Set();
  const listed = git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = listed ? listed.split("\0").filter(Boolean) : [];
  const foreign = new Set();
  for (const exclude of excludes) {
    const prefix = exclude.replace(/\/+$/, "");
    const matched = untracked.filter((file) => file === prefix || file.startsWith(`${prefix}/`));
    if (matched.length === 0) throw new Error(`--exclude ${exclude} names no untracked file; it leaves out only a person's own untracked files, never the session's tracked changes`);
    for (const file of matched) foreign.add(file);
  }
  return foreign;
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
  if (isLocalPlanPath(file)) {
    return true;
  }
  const segments = file.split("/");
  const name = segments.at(-1);
  if (ENV_FILE.test(name) && !ENV_EXAMPLE.test(name)) {
    return true;
  }
  return segments.some((segment) => NEVER_COMMITTED_SEGMENTS.has(segment));
}
