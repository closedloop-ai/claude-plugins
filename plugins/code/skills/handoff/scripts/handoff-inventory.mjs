#!/usr/bin/env node
// Inventory a vibe session's uncommitted work for handoff and run the
// mechanical guardrail checks. Prints one JSON object; exits 0 when every
// blocking check passes and 1 otherwise. Changes nothing.
//
// Usage: handoff-inventory.mjs --worktree <path>

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const BRANCH_PREFIX = "andy/";
const PREVIEW_ALIAS_SUFFIX = ".preview.closedloop-stage.ai";
const PREVIEW_PROJECT = "app-stage";
const MAX_DNS_LABEL = 63;

const ALLOWED_PREFIXES = [
  "apps/app/",
  "packages/app/",
  "packages/design-system/",
  "apps/desktop/src/renderer/",
  "apps/storybook/",
];
// Full scope (ISS-12046) builds the backend too, and an engineer reviews the
// PR, so these move from forbidden to allowed.
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

const scope = sessionScope();
const baseCommit = git(["merge-base", "HEAD", `origin/${baseBranch()}`]);
const changedFiles = listChangedFiles(baseCommit);
const forbidden = changedFiles.filter((file) => isForbidden(file.path));
const outsideAllowed = changedFiles.filter(
  (file) => !isForbidden(file.path) && !isAllowed(file.path)
);
const stubs = changedFiles
  .filter((file) => file.path.endsWith(STUB_SUFFIX) && file.status !== "D")
  .map((file) => file.path);
const stubImportViolations = findStubImportViolations(changedFiles);
const componentsWithoutStories = findComponentsWithoutStories(changedFiles);
const previewAlias = previewAliasFor(branch);

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
  baseCommit,
  blocking,
  changedFiles,
  forbidden,
  outsideAllowed,
  stubs,
  stubImportViolations,
  componentsWithoutStories,
  previewAlias,
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

function previewAliasFor(branchName) {
  const slug = branchName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const label = `${PREVIEW_PROJECT}-git-${slug}`;
  if (label.length > MAX_DNS_LABEL) {
    return { url: null, reason: "branch name too long for a predictable alias" };
  }
  return { url: `https://${label}${PREVIEW_ALIAS_SUFFIX}`, reason: null };
}

function baseBranch() {
  try {
    return git(["config", "--get", "vibe.baseRef"]) || "main";
  } catch {
    return "main";
  }
}

function sessionScope() {
  const file = path.join(git(["rev-parse", "--absolute-git-dir"]), RECORD_FILE);
  if (!existsSync(file)) {
    return SessionScope.Draft;
  }
  const scopeValue = JSON.parse(readFileSync(file, "utf8")).scope;
  return scopeValue === SessionScope.Full ? SessionScope.Full : SessionScope.Draft;
}
