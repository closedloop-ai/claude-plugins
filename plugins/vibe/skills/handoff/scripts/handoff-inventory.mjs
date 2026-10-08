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
// A session may edit nothing under `scripts/` except a source-gate allowlist
// edit that only removes entries or lowers counts (allowlist-shrink.mjs);
// those are listed under `shrinkOnlyAllowlists`.
//
// `backendChanged` says whether the work touched backend code
// (`backendFiles`). Handoff runs its lighter checks when it did not, and the
// full suite with two workflow-code-review passes when it did.
//
// Usage: handoff-inventory.mjs --worktree <path> [--phase build|handoff]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { committedLocalPlans, isLocalPlanPath, LOCAL_PLAN_PREFIX } from "../../vibe/scripts/local-plans.mjs";
import { isOwnedPrototypeSession, requirePrototypePublication } from "../../vibe/scripts/prototype-session.mjs";
import { readSessionRecord } from "../../vibe/scripts/session-record.mjs";
import { isShrinkOnlyAllowlistEdit, SHRINK_ONLY_ALLOWLISTS } from "./allowlist-shrink.mjs";
import { isPortableSurfaceAllowlistEdit, PORTABLE_SURFACE_CHECKER } from "./prototype-allowlist.mjs";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const BRANCH_PREFIX = "vibe/";

// The sole implementation writer owns frontend and backend changes (ISS-12135);
// an engineer reviews both before merge.
const ALLOWED_PREFIXES = [
  "apps/app/",
  "packages/app/",
  "packages/design-system/",
  "apps/desktop/src/renderer/",
  "apps/storybook/",
  "apps/api/",
  "packages/api/",
  "packages/database/",
  "apps/desktop/src/main/",
  "apps/desktop/prisma/",
];
const FORBIDDEN_PREFIXES = ["packages/golden-sessions/", ".github/"];
const FORBIDDEN_BASENAMES = new Set(["AGENTS.md", "CLAUDE.md", "AGENTS.override.md"]);
const BACKEND_PREFIXES = [
  "apps/api/",
  "apps/mcp/",
  "apps/relay/",
  "apps/realtime/",
  "packages/api/",
  "packages/database/",
  "apps/desktop/src/main/",
  "apps/desktop/src/server/",
  "apps/desktop/prisma/",
];
const BACKEND_SEGMENTS = ["/prisma/", "/migrations/"];

const STORY_PATTERN = /\.stories\.tsx?$/;
const COMPONENT_PATTERN = /\/components\/.+\.tsx$/;
const TEST_PATTERN = /(?:\.test\.tsx?$|\/__tests__\/)/;
const HANDOFF_TEST_PREFIXES = ["e2e/", "apps/desktop/test/"];
const HANDOFF_TEST_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

const { values } = parseArgs({ options: { worktree: { type: "string" }, phase: { type: "string", default: "build" } } });
if (!values.worktree) {
  fail("--worktree is required.");
}
if (!["build", "handoff"].includes(values.phase)) {
  fail("--phase must be build or handoff.");
}
const worktree = path.resolve(values.worktree);

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const record = readSessionRecord(worktree);
const prototype = isOwnedPrototypeSession(record, branch);
if (!branch.startsWith(BRANCH_PREFIX) && !prototype) {
  fail(`${worktree} is on ${branch}, not a vibe branch (${BRANCH_PREFIX}*).`);
}

let publicationProblem;
if (prototype) {
  try { requirePrototypePublication(record, git(["rev-parse", "HEAD"])); }
  catch (error) { publicationProblem = error.message; }
}
const localFixTickets = localFixTicketsByPath(record);
const baseCommit = git(["merge-base", "HEAD", `origin/${baseBranch()}`]);
const allChangedFiles = listChangedFiles(baseCommit);
const localPlans = allChangedFiles.filter((file) => isLocalPlanPath(file.path));
const trackedLocalPlans = [...new Set([
  ...git(["ls-files", "--", LOCAL_PLAN_PREFIX]).split("\n"),
  ...committedLocalPlans(git),
])].filter(Boolean);
const changedFiles = allChangedFiles.filter((file) => !localFixTickets.has(file.path) && !isLocalPlanPath(file.path));
const localFixes = allChangedFiles
  .filter((file) => localFixTickets.has(file.path))
  .map((file) => ({ ...file, ticket: localFixTickets.get(file.path) }));
const shrinkOnlyAllowlists = changedFiles.filter((file) => isShrinkOnlyEdit(file));
const shrinkOnlyPaths = new Set(shrinkOnlyAllowlists.map((file) => file.path));
const forbidden = changedFiles.filter((file) => isForbidden(file.path) && !shrinkOnlyPaths.has(file.path));
const outsideAllowed = changedFiles.filter(
  (file) => !isForbidden(file.path) && !isAllowed(file.path) && !shrinkOnlyPaths.has(file.path)
);
const backendFiles = changedFiles.filter((file) => isBackend(file.path));
const componentsWithoutStories = findComponentsWithoutStories(changedFiles);

const blocking = {
  forbiddenPaths: forbidden.length === 0,
  hasChanges: changedFiles.length > 0,
  ...(trackedLocalPlans.length ? { localPlansUntracked: false } : {}),
  ...(prototype ? { prototypePublicationCurrent: publicationProblem === undefined } : {}),
};

const result = {
  ok: Object.values(blocking).every(Boolean),
  worktree,
  branch,
  mode: record?.mode ?? null,
  liveTicket: record?.liveTicket ?? record?.handoffTicket ?? null,
  vercel: record?.vercel ?? null,
  ...(prototype ? { prototype: record.prototype } : {}),
  ...(publicationProblem ? { publicationProblem } : {}),
  baseCommit,
  blocking,
  changedFiles,
  localFixes,
  localPlans,
  trackedLocalPlans,
  forbidden,
  outsideAllowed,
  shrinkOnlyAllowlists,
  backendChanged: backendFiles.length > 0,
  backendFiles,
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
  return (
    FORBIDDEN_PREFIXES.some((prefix) => filePath.startsWith(prefix)) ||
    FORBIDDEN_BASENAMES.has(path.basename(filePath))
  );
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
  if (values.phase === "handoff" && HANDOFF_TEST_PREFIXES.some(prefix => filePath.startsWith(prefix)) &&
    HANDOFF_TEST_PATTERN.test(filePath)) {
    return true;
  }
  if (prototype && (filePath.startsWith(`apps/prototypes/app/p/${record.slug}/`) ||
    filePath === "apps/prototypes/lib/registry.generated.ts")) {
    return true;
  }
  if (prototype && filePath === PORTABLE_SURFACE_CHECKER) {
    try {
      return isPortableSurfaceAllowlistEdit(
        git(["show", `${baseCommit}:${filePath}`]),
        readFileSync(path.join(worktree, filePath), "utf8"),
        (specifier) => [".ts", ".tsx", ".mjs"].some((extension) =>
          existsSync(path.join(worktree, "packages/app", `${specifier.slice("@repo/app/".length)}${extension}`)))
      );
    } catch { return false; }
  }
  return ALLOWED_PREFIXES.some((prefix) => filePath.startsWith(prefix));
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

function isBackend(filePath) {
  return (
    BACKEND_PREFIXES.some((prefix) => filePath.startsWith(prefix)) ||
    BACKEND_SEGMENTS.some((segment) => `/${filePath}`.includes(segment))
  );
}
