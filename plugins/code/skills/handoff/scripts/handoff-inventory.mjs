#!/usr/bin/env node
// Inventory a vibe session's work for handoff (its redeploy commits and
// anything not committed yet, against its base on main) and run the
// mechanical guardrail checks. Prints one JSON object; exits 0 when every
// blocking check passes and 1 otherwise. Changes nothing.
//
// Files in the session record's `localFixes` (workarounds for symphony-alpha
// bugs that the setup worker filed as tickets) are not the person's work:
// they are listed under `localFixes` and left out of `changedFiles` and every
// guardrail check, and no redeploy or handoff commit includes them.
//
// A draft session may edit nothing under `scripts/` except a source-gate
// allowlist edit that only removes entries or lowers counts
// (allowlist-shrink.mjs); those are listed under `shrinkOnlyAllowlists`.
//
// Usage: handoff-inventory.mjs --worktree <path>

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isShrinkOnlyAllowlistEdit, SHRINK_ONLY_ALLOWLISTS } from "./allowlist-shrink.mjs";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const BRANCH_PREFIX = "andy/";

const ALLOWED_PREFIXES = [
  "apps/app/",
  "packages/app/",
  "packages/design-system/",
  "apps/desktop/src/renderer/",
  "apps/storybook/",
];
// Full scope (ISS-12046) builds the backend too, and an engineer reviews it
// before it merges, so these move from forbidden to allowed.
const FULL_SCOPE_PREFIXES = [
  "apps/api/",
  "packages/api/",
  "packages/database/",
  "apps/desktop/src/main/",
  "apps/desktop/prisma/",
];
const ALWAYS_FORBIDDEN_PREFIXES = ["packages/golden-sessions/", ".github/"];
const SessionScope = { Draft: "draft", Full: "full" };
const RECORD_FILE = "vibe-session.json";

const FORBIDDEN_PREFIXES = [
  "apps/api/",
  "apps/mcp/",
  "apps/relay/",
  "apps/realtime/",
  "packages/database/",
  "packages/api/",
  "apps/desktop/src/main/",
  "apps/desktop/prisma/",
  "packages/golden-sessions/",
  ".github/",
  "scripts/",
];
const FORBIDDEN_SEGMENTS = ["/prisma/", "/migrations/"];
const FORBIDDEN_BASENAMES = new Set(["AGENTS.md", "CLAUDE.md", "AGENTS.override.md"]);

const STUB_SUFFIX = ".vibe-stub.ts";
const STORY_PATTERN = /\.stories\.tsx?$/;
const COMPONENT_PATTERN = /\/components\/.+\.tsx$/;
const TEST_PATTERN = /(?:\.test\.tsx?$|\/__tests__\/)/;
const HOOK_FILE_PATTERN = /\/hooks\/[^/]+\.tsx?$/;
const STUB_IMPORT_PATTERN = /from\s+["'][^"']*\.vibe-stub["']/;

const { values } = parseArgs({ options: { worktree: { type: "string" } } });
if (!values.worktree) {
  fail("--worktree is required.");
}
const worktree = path.resolve(values.worktree);

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (!branch.startsWith(BRANCH_PREFIX)) {
  fail(`${worktree} is on ${branch}, not a vibe branch (${BRANCH_PREFIX}*).`);
}

const record = readSessionRecord();
const scope = record?.scope === SessionScope.Full ? SessionScope.Full : SessionScope.Draft;
const localFixTickets = localFixTicketsByPath(record);
const baseCommit = git(["merge-base", "HEAD", `origin/${baseBranch()}`]);
const allChangedFiles = listChangedFiles(baseCommit);
const changedFiles = allChangedFiles.filter((file) => !localFixTickets.has(file.path));
const localFixes = allChangedFiles
  .filter((file) => localFixTickets.has(file.path))
  .map((file) => ({ ...file, ticket: localFixTickets.get(file.path) }));
const shrinkOnlyAllowlists = changedFiles.filter((file) => isShrinkOnlyEdit(file));
const shrinkOnlyPaths = new Set(shrinkOnlyAllowlists.map((file) => file.path));
const forbidden = changedFiles.filter((file) => isForbidden(file.path) && !shrinkOnlyPaths.has(file.path));
const outsideAllowed = changedFiles.filter(
  (file) => !isForbidden(file.path) && !isAllowed(file.path) && !shrinkOnlyPaths.has(file.path)
);
const stubs = changedFiles
  .filter((file) => file.path.endsWith(STUB_SUFFIX) && file.status !== "D")
  .map((file) => file.path);
const stubImportViolations = findStubImportViolations(changedFiles);
const componentsWithoutStories = findComponentsWithoutStories(changedFiles);

const blocking = {
  forbiddenPaths: forbidden.length === 0,
  stubImportsOnlyInHooks: stubImportViolations.length === 0,
  hasChanges: changedFiles.length > 0,
};

const result = {
  ok: Object.values(blocking).every(Boolean),
  worktree,
  branch,
  scope,
  mode: record?.mode ?? null,
  liveTicket: record?.liveTicket ?? record?.handoffTicket ?? null,
  vercel: record?.vercel ?? null,
  baseCommit,
  blocking,
  changedFiles,
  localFixes,
  forbidden,
  outsideAllowed,
  shrinkOnlyAllowlists,
  stubs,
  stubImportViolations,
  componentsWithoutStories,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);

function git(args) {
  return execFileSync("git", args, {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
}

function listChangedFiles(base) {
  const files = new Map();
  const tracked = git(["diff", "--name-status", "--no-renames", base]);
  for (const line of tracked.split("\n").filter(Boolean)) {
    const [status, filePath] = line.split("\t");
    files.set(filePath, { path: filePath, status });
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  for (const filePath of untracked.split("\n").filter(Boolean)) {
    files.set(filePath, { path: filePath, status: "A" });
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function isForbidden(filePath) {
  if (ALWAYS_FORBIDDEN_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return true;
  }
  if (scope === SessionScope.Full) {
    if (FULL_SCOPE_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
      return false;
    }
    return FORBIDDEN_BASENAMES.has(path.basename(filePath));
  }
  if (FORBIDDEN_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return true;
  }
  if (FORBIDDEN_SEGMENTS.some((segment) => `/${filePath}`.includes(segment))) {
    return true;
  }
  return FORBIDDEN_BASENAMES.has(path.basename(filePath));
}

/** A modified shrink-only allowlist whose working-tree copy only shrinks the base copy. */
function isShrinkOnlyEdit(file) {
  if (file.status !== "M" || !SHRINK_ONLY_ALLOWLISTS.has(file.path)) {
    return false;
  }
  const absolute = path.join(worktree, file.path);
  if (!existsSync(absolute)) {
    return false;
  }
  let baseText;
  try {
    baseText = git(["show", `${baseCommit}:${file.path}`]);
  } catch {
    return false;
  }
  return isShrinkOnlyAllowlistEdit(baseText, readFileSync(absolute, "utf8"));
}

function isAllowed(filePath) {
  const allowed =
    scope === SessionScope.Full
      ? [...ALLOWED_PREFIXES, ...FULL_SCOPE_PREFIXES]
      : ALLOWED_PREFIXES;
  return allowed.some((prefix) => filePath.startsWith(prefix));
}

function findStubImportViolations(files) {
  const violations = [];
  for (const file of files) {
    if (file.status === "D" || !/\.tsx?$/.test(file.path)) {
      continue;
    }
    if (file.path.endsWith(STUB_SUFFIX) || HOOK_FILE_PATTERN.test(file.path)) {
      continue;
    }
    const absolute = path.join(worktree, file.path);
    if (existsSync(absolute) && STUB_IMPORT_PATTERN.test(readFileSync(absolute, "utf8"))) {
      violations.push(file.path);
    }
  }
  return violations;
}

function findComponentsWithoutStories(files) {
  const changedPaths = new Set(files.map((file) => file.path));
  return files
    .filter(
      (file) =>
        file.status !== "D" &&
        COMPONENT_PATTERN.test(`/${file.path}`) &&
        !STORY_PATTERN.test(file.path) &&
        !TEST_PATTERN.test(file.path)
    )
    .filter((file) => {
      const story = file.path.replace(/\.tsx$/, ".stories.tsx");
      return !changedPaths.has(story) && !existsSync(path.join(worktree, story));
    })
    .map((file) => file.path);
}

function baseBranch() {
  try {
    return git(["config", "--get", "vibe.baseRef"]) || "main";
  } catch {
    return "main";
  }
}

function readSessionRecord() {
  const file = path.join(git(["rev-parse", "--absolute-git-dir"]), RECORD_FILE);
  if (!existsSync(file)) {
    return null;
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function localFixTicketsByPath(sessionRecord) {
  const tickets = new Map();
  const fixes = Array.isArray(sessionRecord?.localFixes) ? sessionRecord.localFixes : [];
  for (const fix of fixes) {
    for (const filePath of Array.isArray(fix?.paths) ? fix.paths : []) {
      if (typeof filePath === "string" && !tickets.has(filePath)) {
        tickets.set(filePath, typeof fix.ticket === "string" ? fix.ticket : null);
      }
    }
  }
  return tickets;
}
