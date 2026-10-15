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
// In the handoff and pull-request phases only, an app session may modify
// (never add) existing product docs pages under apps/web/content/docs/; a new,
// generated or build-phase docs edit, and any edit under the internal docs/
// folder, stays in `outsideAllowed`.
//
// Root web and Desktop test specs are admitted only in the pull-request phase,
// which only the person's explicit request for a pull request opens.
//
// In the build and handoff phases a test file may only be repaired: an
// existing test or fixture modified so the tree compiles after the session's
// own change, never added, deleted or a snapshot updated. Repairs are listed
// under `testRepairs` for the guardrails reviewer, which checks that no
// assertion changed. The one deletion allowed there is a test file that covered
// only code the request retires, recorded with ../../vibe/scripts/retired-tests.mjs;
// every recorded deletion, file or case, is listed under `retiredTests` with
// its status so the reviewer can verify it and the ticket can list it.
//
// New story files belong in the v2.0 Storybook taxonomy (symphony-alpha's
// apps/storybook/TAXONOMY.md); one titled under or tagged for a frozen v1.0
// root, or an existing one newly given either, is listed under `v1Stories` and
// blocks. An existing story file keeps its meta title, because Storybook
// builds story IDs from it: a title changed from the base, moves included, is
// listed under `retitledStories` and blocks unless the session record lists
// the file as a replacement's entry (`vibe-sessions.mjs story-replacement`).
//
// `backendChanged` says whether the work touched backend code
// (`backendFiles`). Handoff runs its lighter checks when it did not, and the
// full suite with two workflow-code-review passes when it did.
//
// Usage: handoff-inventory.mjs --worktree <path> [--phase build|handoff|pull-request]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { committedLocalPlans, isLocalPlanPath, LOCAL_PLAN_PREFIX } from "../../vibe/scripts/local-plans.mjs";
import { isOwnedPrototypeSession, requirePrototypePublication } from "../../vibe/scripts/prototype-session.mjs";
import { readRetiredTests } from "../../vibe/scripts/retired-tests.mjs";
import { readSessionRecord } from "../../vibe/scripts/session-record.mjs";
import { isRootTest, isSnapshot, isTestFile, TEST_SPEC_PATTERN } from "../../vibe/scripts/test-files.mjs";
import { readMainSyncProvenance } from "../../vibe/scripts/dist/main-sync.mjs";
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
// v1.0 is the frozen baseline; new work goes under `<Level> v2.0/`
// (apps/storybook/TAXONOMY.md; Daniel Ochoa's ruling, 2026-10-14).
const V1_STORY_TITLE = /\btitle:\s*["'`](?:Foundations|Primitives|Composites|Surfaces)\//;
const V1_STORY_TAG = /\btags:\s*\[[^\]]*["'`]v1\.0["'`]/;
// The meta object's title, not a `title:` arg or prop elsewhere in the file.
const STORY_META_START = /\b(?:const\s+meta\b[^=]*=|export\s+default)\s*\{/;
const STORY_META_TITLE = /\btitle:\s*(["'`])((?:(?!\1).)+)\1/;
const STORY_PATHSPECS = ["*.stories.ts", "*.stories.tsx"];
// Tests are written only when the person explicitly asks for a pull request
// (Daniel Ochoa's ruling, 2026-10-13); earlier phases may only repair existing
// tests and fixtures the session's change broke (Daniel Ochoa's ruling,
// 2026-10-13, after the PRD-720 live test) or delete a recorded retired-only
// test (Daniel Ochoa's ruling, 2026-10-13).
// Handoff may edit, never create, existing product docs pages as marked agent
// drafts (Daniel Ochoa's scoped exception, 2026-10-13); generated pages and
// the internal docs/ folder stay out.
const PRODUCT_DOCS_PREFIX = "apps/web/content/docs/";
const PRODUCT_DOCS_EXTENSION = ".mdx";
const PHASES = ["build", "handoff", "pull-request"];
const GENERATED_DOCS_PREFIX = "apps/web/content/docs/api-reference/";

const { values } = parseArgs({ options: { worktree: { type: "string" }, phase: { type: "string", default: "build" } } });
if (!values.worktree) {
  fail("--worktree is required.");
}
if (!PHASES.includes(values.phase)) {
  fail("--phase must be build, handoff or pull-request.");
}
const handoffPhase = values.phase !== "build";
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
const mainSync = record?.status === "active" && record?.operator ? readMainSyncProvenance(worktree) : undefined;
const baseCommit = mainSync?.mainSha ?? git(["merge-base", "HEAD", `origin/${baseBranch()}`]);
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
const retiredRecord = readRetiredTests(worktree);
const retiredFiles = new Set(retiredRecord.filter((entry) => entry.case === undefined).map((entry) => entry.path));
const testRepairs = changedFiles.filter((file) => isTestRepair(file));
const changedStatus = new Map(changedFiles.map((file) => [file.path, file.status]));
const retiredTests = retiredRecord.map((entry) => ({ ...entry, status: changedStatus.get(entry.path) ?? null }));
const shrinkOnlyAllowlists = changedFiles.filter((file) => isShrinkOnlyEdit(file));
const shrinkOnlyPaths = new Set(shrinkOnlyAllowlists.map((file) => file.path));
const forbidden = changedFiles.filter((file) => isForbidden(file.path) && !shrinkOnlyPaths.has(file.path));
const outsideAllowed = changedFiles.filter(
  (file) => !isForbidden(file.path) && !isAllowed(file) && !shrinkOnlyPaths.has(file.path)
);
const backendFiles = changedFiles.filter((file) => isBackend(file.path));
const componentsWithoutStories = findComponentsWithoutStories(changedFiles);
const v1Stories = findV1Stories(changedFiles);
const retitledStories = findRetitledStories(changedFiles);

const blocking = {
  forbiddenPaths: forbidden.length === 0,
  hasChanges: changedFiles.length > 0,
  storiesInV2Taxonomy: v1Stories.length === 0,
  existingStoryTitlesKept: retitledStories.every((story) => story.replacement !== null),
  ...(trackedLocalPlans.length ? { localPlansUntracked: false } : {}),
  ...(prototype ? { prototypePublicationCurrent: publicationProblem === undefined } : {}),
  ...(mainSync?.pendingMerge ? { mainSyncMergeCommitted: false } : {}),
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
  ...(mainSync ? { mainSync } : {}),
  ...(mainSync?.featureTestHistory.length ? { featureTestHistory: mainSync.featureTestHistory } : {}),
  blocking,
  changedFiles,
  localFixes,
  localPlans,
  trackedLocalPlans,
  forbidden,
  outsideAllowed,
  shrinkOnlyAllowlists,
  testRepairs,
  retiredTests,
  backendChanged: backendFiles.length > 0,
  backendFiles,
  componentsWithoutStories,
  v1Stories,
  retitledStories,
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

function isAllowed(file) {
  if (isTestFile(file.path)) {
    return isTestRepair(file) || isRetiredDeletion(file) ||
      (values.phase === "pull-request" && isPullRequestTest(file));
  }
  return isAllowedPath(file);
}

function isAllowedPath(file) {
  const filePath = file.path;
  if (handoffPhase && !prototype && isExistingDocsEdit(file)) {
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

function isPullRequestTest(file) {
  return isAllowedPath(file) || (isRootTest(file.path) && TEST_SPEC_PATTERN.test(file.path));
}

/** An existing test or fixture modified in place; never an added or deleted file or an updated snapshot. */
function isTestRepair(file) {
  return file.status === "M" && isTestFile(file.path) && !isSnapshot(file.path) &&
    (isRootTest(file.path) || isAllowedPath(file));
}

/** A deleted test file the writer recorded as covering only code the request retires. */
function isRetiredDeletion(file) {
  return file.status === "D" && retiredFiles.has(file.path) && (isRootTest(file.path) || isAllowedPath(file));
}

function isExistingDocsEdit(file) {
  return file.status === "M" && !file.path.startsWith(GENERATED_DOCS_PREFIX) &&
    file.path.startsWith(PRODUCT_DOCS_PREFIX) && file.path.endsWith(PRODUCT_DOCS_EXTENSION);
}

function findComponentsWithoutStories(files) {
  const changedPaths = new Set(files.map((file) => file.path));
  return files
    .filter(
      (file) =>
        file.status !== "D" &&
        COMPONENT_PATTERN.test(`/${file.path}`) &&
        !STORY_PATTERN.test(file.path) &&
        !isTestFile(file.path)
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

/**
 * Added story files whose meta title sits in a v1.0 root or whose tags include
 * v1.0, and modified ones that gained either; an existing v1.0 file keeps both.
 */
function findV1Stories(files) {
  return files
    .filter((file) => file.status !== "D" && STORY_PATTERN.test(file.path))
    .flatMap((file) => {
      const source = readWorktreeFile(file.path);
      if (source === undefined) {
        return [];
      }
      const base = file.status === "M" ? readBaseFile(file.path) : undefined;
      const gained = (pattern) => pattern.test(source) && !(base !== undefined && pattern.test(base));
      const reasons = [
        ...(gained(V1_STORY_TITLE) ? ["title"] : []),
        ...(gained(V1_STORY_TAG) ? ["tag"] : []),
      ];
      return reasons.length ? [{ ...file, reasons }] : [];
    });
}

/**
 * Story files present at the base whose meta title changed, in place or moved
 * to another path, each with the replacement it was recorded for or null.
 */
function findRetitledStories(files) {
  const modified = files
    .filter((file) => file.status === "M" && STORY_PATTERN.test(file.path))
    .map((file) => ({ path: file.path, from: file.path }));
  const replacements = new Map(
    (Array.isArray(record?.storyReplacements) ? record.storyReplacements : [])
      .filter((entry) => typeof entry?.path === "string")
      .map((entry) => [entry.path, entry.replacement ?? null])
  );
  return [...modified, ...findMovedStories()].flatMap(({ path: filePath, from }) => {
    const source = readWorktreeFile(filePath);
    const base = readBaseFile(from);
    if (source === undefined || base === undefined) {
      return [];
    }
    const baseTitle = storyMetaTitle(base);
    const title = storyMetaTitle(source);
    if (baseTitle === title) {
      return [];
    }
    return [{
      path: filePath,
      ...(from === filePath ? {} : { from }),
      baseTitle,
      title,
      replacement: replacements.get(filePath) ?? replacements.get(from) ?? null,
    }];
  });
}

/** Story files git sees as renamed since the base, tracked changes only. */
function findMovedStories() {
  const renames = git(["diff", "--name-status", "-M", "--diff-filter=R", baseCommit, "--", ...STORY_PATHSPECS]);
  return renames.split("\n").filter(Boolean).map((line) => {
    const [, from, to] = line.split("\t");
    return { path: to, from };
  });
}

function storyMetaTitle(source) {
  const start = source.search(STORY_META_START);
  return STORY_META_TITLE.exec(start === -1 ? source : source.slice(start))?.[2] ?? null;
}

function readWorktreeFile(filePath) {
  const absolute = path.join(worktree, filePath);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}

function readBaseFile(filePath) {
  try {
    return git(["show", `${baseCommit}:${filePath}`]);
  } catch {
    return undefined;
  }
}
