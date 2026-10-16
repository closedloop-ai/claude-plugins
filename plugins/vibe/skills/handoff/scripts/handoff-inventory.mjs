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
// Nothing agent-written goes into public docs (operator ruling, 2026-10-16):
// any change under apps/web/content/docs/ or the internal docs/ folder stays
// in `outsideAllowed` in every phase.
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
// Story files are judged by the Storybook scheme the session's base uses
// (storybook-taxonomy.mjs), reported as `storybookScheme`. From symphony-alpha
// #8867 on (the lifecycle scheme) the v1.0 baseline is every story file titled
// under a `<Level> v1.0/` root or tagged `deprecated`, and new work goes under
// the plain current roots with one lifecycle tag; on an older base (the
// version scheme) it is the plain roots and the `v1.0` tag, and new work goes
// under `<Level> v2.0/`. A story file newly titled under or tagged for the
// v1.0 baseline is listed under `v1Stories` and blocks. A story file that was
// v1.0 at the base is frozen: any edit or move of it is listed under
// `v1Stories` with the reason `frozen` and blocks, so new states of its
// component go in a new entry under the current roots instead. The one
// exception is a compile-only repair (design ruling, 2026-10-15): an in-place edit that
// keeps the meta title, the meta tags and the set of exported story names, and
// so every story ID, is listed under `compileOnlyV1Repairs` and does not block;
// the ticket asks engineering to confirm it changed no visuals. Any other existing
// story file keeps its meta title, because Storybook builds story IDs from it:
// a title changed from the base, moves included, is listed under
// `retitledStories` and blocks unless the session record lists the file as a
// replacement's entry (`vibe-sessions.mjs story-replacement`). The base is the
// main the session last synced, so the retitles a main import brought (#8867
// renamed every root) are in the base and never counted as the session's. A
// base whose story-group-order.ts exports `StorybookLifecycle` in a shape
// storybook-taxonomy.mjs cannot read blocks a session that changed a story
// file (`storybookSchemeRecognized`) instead of guessing its rules.
//
// A story file whose meta title is under the `Start Here/` root, at the base
// or now, is exempt from the freeze, the v1.0 title and tag checks and the
// retitle check (design ruling, 2026-10-06): Start Here is unversioned, as
// symphony-alpha's .storybook/manager.ts treats it, and its Version History
// page is edited by every Storybook release, so a tag there is not a version.
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
import {
  isUnversionedStory,
  STORY_GROUP_ORDER_PATH,
  StorybookScheme,
  storybookSchemeOf,
  storyExportNames,
  storyMetaTags,
  storyMetaTitle,
} from "./storybook-taxonomy.mjs";

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
const STORY_PATHSPECS = ["*.stories.ts", "*.stories.tsx"];
// Tests are written only when the person explicitly asks for a pull request
// (operator ruling, 2026-10-13); earlier phases may only repair existing
// tests and fixtures the session's change broke (operator ruling,
// 2026-10-13, after the PRD-720 live test) or delete a recorded retired-only
// test (operator ruling, 2026-10-13).
const PHASES = ["build", "handoff", "pull-request"];

const { values } = parseArgs({ options: { worktree: { type: "string" }, phase: { type: "string", default: "build" } } });
if (!values.worktree) {
  fail("--worktree is required.");
}
if (!PHASES.includes(values.phase)) {
  fail("--phase must be build, handoff or pull-request.");
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
const movedStories = findMovedStories();
const storybookScheme = storybookSchemeOf(readBaseFile(STORY_GROUP_ORDER_PATH));
const storybookSchemeUnreadable = storybookScheme.summary.name === StorybookScheme.Unrecognized &&
  changedFiles.some((file) => STORY_PATTERN.test(file.path));
const { v1Stories, compileOnlyV1Repairs } = findV1Stories(changedFiles);
const retitledStories = findRetitledStories(changedFiles);

const blocking = {
  forbiddenPaths: forbidden.length === 0,
  hasChanges: changedFiles.length > 0,
  storiesInV2Taxonomy: v1Stories.length === 0,
  existingStoryTitlesKept: retitledStories.every((story) => story.replacement !== null),
  ...(storybookSchemeUnreadable ? { storybookSchemeRecognized: false } : {}),
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
  storybookScheme: storybookScheme.summary,
  v1Stories,
  compileOnlyV1Repairs,
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
 * `v1Stories`: story files whose meta title sits in a v1.0 root or whose tags
 * mark the v1.0 baseline, by the base's scheme, where the base had neither,
 * and every modified or moved story file that was v1.0 at the base
 * (`frozen`), except under the unversioned Start Here root. `compileOnlyV1Repairs`: the in-place edits of a v1.0 file
 * that keep its story IDs and tags.
 */
function findV1Stories(files) {
  const movedFrom = new Map(movedStories.map((story) => [story.path, story.from]));
  const v1 = [];
  const compileOnly = [];
  for (const file of files) {
    if (file.status === "D" || !STORY_PATTERN.test(file.path)) {
      continue;
    }
    const source = readWorktreeFile(file.path);
    if (source === undefined) {
      continue;
    }
    const from = movedFrom.get(file.path);
    const basePath = file.status === "M" ? file.path : from;
    const base = basePath === undefined ? undefined : readBaseFile(basePath);
    if (isUnversionedStory(base) || isUnversionedStory(source)) {
      continue;
    }
    const gained = (isV1) => isV1(source) && !(base !== undefined && isV1(base));
    const reasons = [
      ...(gained(storybookScheme.frozenTitle) ? ["title"] : []),
      ...(gained(storybookScheme.frozenTag) ? ["tag"] : []),
      ...(base !== undefined && isV1Story(base) ? ["frozen"] : []),
    ];
    if (reasons.length === 1 && reasons[0] === "frozen" && file.status === "M" && keepsStoryIdentity(base, source)) {
      compileOnly.push(file);
    } else if (reasons.length) {
      v1.push({ ...file, ...(from === undefined ? {} : { from }), reasons });
    }
  }
  return { v1Stories: v1, compileOnlyV1Repairs: compileOnly };
}

/** Same meta title, same meta tags and same exported story names, so the same story IDs. */
function keepsStoryIdentity(base, source) {
  return (
    storyMetaTitle(base) === storyMetaTitle(source) &&
    JSON.stringify(storyMetaTags(base)) === JSON.stringify(storyMetaTags(source)) &&
    JSON.stringify(storyExportNames(base)) === JSON.stringify(storyExportNames(source))
  );
}

function isV1Story(source) {
  return storybookScheme.frozenTitle(source) || storybookScheme.frozenTag(source);
}

/**
 * Story files present at the base whose meta title changed, in place or moved
 * to another path, each with the replacement it was recorded for or null.
 * Start Here is unversioned, so a retitle into, out of or within it is not listed.
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
  return [...modified, ...movedStories].flatMap(({ path: filePath, from }) => {
    const source = readWorktreeFile(filePath);
    const base = readBaseFile(from);
    if (source === undefined || base === undefined || isUnversionedStory(base) || isUnversionedStory(source)) {
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
