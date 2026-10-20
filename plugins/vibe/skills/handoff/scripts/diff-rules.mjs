#!/usr/bin/env node
// Mechanical review gates over a vibe session's diff, for defects that shipped
// in vibe pull requests and repeated after a prose rule
// (../../vibe/references/review-gates.md). Each blocking finding names the fix
// or the change log line that records why the code stays as it is. Also lists
// the tests and repo checks the diff requires whatever the graph maps.
// Prints one JSON object; exits 1 when anything blocks. Changes nothing.
//
// Usage: diff-rules.mjs --worktree <wt> --base <inventory baseCommit> [--change-log <file>]

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "../../vibe/scripts/session-record.mjs";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";

const PRIVATE_PLANS = ".closedloop-ai/vibe-plans/";
const MIGRATIONS = "packages/database/prisma/migrations/";
const MIGRATION_DIR = /^packages\/database\/prisma\/migrations\/(\d{8,})_[^/]+\/migration\.sql$/;
const DESKTOP_MIGRATION = /^apps\/desktop\/prisma\/migrations\/[^/]+\/migration\.sql$/;
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const SQL_TABLE_TOUCH = /\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*?\bON\s+(?:ONLY\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?|(?<!\bON\s{1,10})UPDATE\s+)"?(\w+)"?/gi;
const SQL_CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi;
const SQL_UPDATE_STATEMENT = /(?<!\bON\s{1,10})\bUPDATE\s+"?(\w+)"?[^;]*;/gi;
const ARTIFACT_WRITE = /\.artifact\.(?:update|updateMany|upsert)\(|\bUPDATE\s+"?artifacts"?\s/i;
const CAPTURED_FIELD = /\b(?:status|priority|assigneeId|approverId|projectId|title|dueDate)\s*:|"(?:status|priority|assignee_id|approver_id|project_id|title|due_date)"\s*=/;
const CAPTURE_CALL = /\bcapture[A-Z]\w*\(/;
const TX_OPEN = /withDb\.tx\(/g;
const TX_WRITE = /\btx\.(?:\w+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw)/;
const RESULT_ERR_RETURN = /\breturn\s+(?:Result\.)?err\(/;
const LINK_DELETE = /\.artifactLink\.deleteMany\(|\bDELETE\s+FROM\s+"?artifact_links"?/i;
const LINK_EDGE_KEYS = [/\bsourceId\b|\bsource_id\b/, /\btargetId\b|\btarget_id\b/, /\blinkType\b|\blink_type\b/];
const DESKTOP_LANE_FILE = /^apps\/desktop\/src\/main\/.*(?:outbox|lane|sync)[^/]*\.ts$/;
const SYNC_TABLE = /outbox|sync/i;
const GIVE_UP_IMPORT = /from\s+["'][^"']*(?:shared\/lane-give-up|sync-lane-give-up-telemetry)(?:\.js)?["']/;
const HAND_ROLLED_BACKOFF = /\*\*\s*\(?\s*\w*(?:attempt|retry|retries|n)\b/i;
const TICKETED = /\b(?:ISS|PRD|PLN|FEA)-\d+\b|https?:\/\//;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const SHARED_PATH = /^(?:apps\/api\/lib\/.+|apps\/api\/app\/.*service[^/]*|packages\/app\/.*data-source[^/]*)\.tsx?$/;
const API_ROUTE = /^apps\/api\/app\/(.*)\/route\.ts$/;
const GRID_TABLE = /grid-table-v2/;
const GRID_SYMBOL = /\bGridTableV2\b/;
const GRID_PARITY_TEST = "apps/app/__tests__/grid-table-v2-surface-capability-parity.test.ts";
const HOST_PARITY_TEST = /^apps\/app\/__tests__\/[^/]+-host-capability-parity\.test\.ts$/;
const STORY_FILE = /\.stories\.tsx?$/;
const STORY_VERSION_FILE = "apps/storybook/package.json";
const STORY_COMPONENT = /\bcomponent:\s*([A-Z]\w*)/;
const STORY_TITLE = /\btitle:\s*["'`]([^"'`]+)["'`]/;
const FROZEN_TITLE = / v1\.0\/|^Start Here\//;
const HARNESS_NAME = /harness|adapter|preview/i;
const EXPECT_CALL = /\bexpect\(/;
const WINDOW = 25;

/** Parses `git diff --unified=0` output into per-file added and removed lines. */
export function parseUnifiedDiff(text) {
  const files = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: null, oldPath: null, status: "M", added: [], removed: [] };
      files.push(current);
    } else if (current === null) {
      continue;
    } else if (line.startsWith("new file mode")) {
      current.status = "A";
    } else if (line.startsWith("deleted file mode")) {
      current.status = "D";
    } else if (line.startsWith("rename from ")) {
      current.status = "R";
      current.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
    } else if (line.startsWith("--- ")) {
      current.oldPath ??= line === "--- /dev/null" ? null : line.slice("--- a/".length);
    } else if (line.startsWith("+++ ")) {
      current.path ??= line === "+++ /dev/null" ? current.oldPath : line.slice("+++ b/".length);
    } else if (line.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLine = Number(match?.[1] ?? 0);
      newLine = Number(match?.[2] ?? 0);
    } else if (line.startsWith("+")) {
      current.added.push({ line: newLine++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.removed.push({ line: oldLine++, text: line.slice(1) });
    }
  }
  return files.filter((file) => file.path && !file.path.startsWith(PRIVATE_PLANS));
}

/**
 * Applies every rule. `repo` supplies reads: `head(path)` and `base(path)` file
 * text or null, `baseMigrations` (folder names on the base), `headFiles`
 * (tracked paths at head) and `importers(path)` (non-test files importing it).
 */
export function evaluateDiff(files, changeLog, repo) {
  const blocking = [];
  const requiredTests = [];
  const requiredChecks = [];
  const logged = (prefix, file) => changeLog.split("\n").some((line) => line.includes(prefix) && (file === undefined || line.includes(file)));
  const add = (rule, file, line, problem, fix) => blocking.push({ rule, file, line, problem, fix });
  const live = files.filter((file) => file.status !== "D");

  checkMigrations(live, repo, logged, add, requiredChecks);
  for (const file of live.filter((entry) => SOURCE_FILE.test(entry.path) && !isTestFile(entry.path))) {
    const head = repo.head(file.path) ?? "";
    checkActivityCapture(file, head, logged, add);
    checkTransactions(file, head, add);
    checkLinkDeletes(file, head, add);
    checkSharedPath(file, repo, logged, add);
  }
  checkDesktopLane(live, repo, logged, add);
  checkTicketedComments(files, repo, logged, add);
  checkStories(live, files, repo, logged, add);
  requiredTests.push(...routeSpecs(live, repo), ...gridParityTests(files, repo));
  return { ok: blocking.length === 0, blocking, requiredTests, requiredChecks };
}

function checkMigrations(files, repo, logged, add, requiredChecks) {
  const newest = repo.baseMigrations.map((name) => /^(\d{8,})_/.exec(name)?.[1]).filter(Boolean).sort().at(-1) ?? "";
  let touched = false;
  for (const file of files) {
    const match = MIGRATION_DIR.exec(file.path);
    if (!match && !DESKTOP_MIGRATION.test(file.path)) {
      continue;
    }
    touched = true;
    if (!match || file.status !== "A") {
      continue;
    }
    if (match[1] <= newest) {
      add("migration-order", file.path, 1, `timestamp ${match[1]} is not newer than the base's newest migration ${newest}`, "rename the folder to a timestamp after the base's newest migration");
    }
    const sql = repo.head(file.path) ?? "";
    const created = new Set([...sql.matchAll(SQL_CREATE_TABLE)].map((found) => found[1]));
    const existing = new Set([...sql.matchAll(SQL_TABLE_TOUCH)].map((found) => found[1]).filter((table) => !created.has(table)));
    for (const table of existing) {
      if (!logged("Migration precedent:", table)) {
        add("migration-precedent", file.path, 1, `changes existing table ${table} without a recorded lock-strategy precedent`, `copy the last three migrations on ${table} and record \`Migration precedent: ${table}: <folders>\``);
      }
    }
    for (const update of sql.matchAll(SQL_UPDATE_STATEMENT)) {
      if (!/\bWHERE\b/i.test(update[0]) && !logged("Migration precedent:", update[1])) {
        add("migration-backfill", file.path, 1, `full-table UPDATE of ${update[1]} in a schema migration`, `move or bound the backfill as ${update[1]}'s precedent does, and record \`Migration precedent: ${update[1]}: <folders>\``);
      }
    }
  }
  if (touched) {
    requiredChecks.push(
      { command: "pnpm check:destructive-migrations", reason: "a migration changed; the repo's index-lock gate" },
      { command: "pnpm check:migration-immutability", reason: "a migration changed" }
    );
  }
}

function headWindow(head, line) {
  return head.split("\n").slice(line - 1, line - 1 + WINDOW).join("\n");
}

function checkActivityCapture(file, head, logged, add) {
  if (CAPTURE_CALL.test(head) || logged("Activity capture:", file.path)) {
    return;
  }
  for (const entry of file.added) {
    if (ARTIFACT_WRITE.test(entry.text) && CAPTURED_FIELD.test(headWindow(head, entry.line))) {
      add("activity-capture", file.path, entry.line, "writes a captured artifact field with no capture call in the file", "call the canonical capture from apps/api/lib/artifact-activity-capture.ts on the same transaction, or record `Activity capture: <path>: <covering call>`");
    }
  }
}

/** Line ranges (1-based, inclusive) of each `withDb.tx(` callback body in `head`. */
export function transactionBodies(head) {
  const bodies = [];
  for (const open of head.matchAll(TX_OPEN)) {
    const start = head.indexOf("{", open.index);
    if (start < 0) {
      continue;
    }
    let depth = 0;
    for (let index = start; index < head.length; index += 1) {
      depth += head[index] === "{" ? 1 : head[index] === "}" ? -1 : 0;
      if (depth === 0) {
        bodies.push([lineAt(head, start), lineAt(head, index)]);
        break;
      }
    }
  }
  return bodies;
}

function lineAt(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function checkTransactions(file, head, add) {
  const lines = head.split("\n");
  const added = new Set(file.added.map((entry) => entry.line));
  for (const [first, last] of transactionBodies(head)) {
    let wroteAt = 0;
    for (let line = first; line <= last; line += 1) {
      const text = lines[line - 1] ?? "";
      if (TX_WRITE.test(text)) {
        wroteAt ||= line;
      } else if (wroteAt && RESULT_ERR_RETURN.test(text) && (added.has(line) || added.has(wroteAt))) {
        add("tx-result-after-write", file.path, line, `returns an error after the write at line ${wroteAt}, so the transaction commits a partial change`, "validate before the first write, or throw so withDb.tx rolls back");
      }
    }
  }
}

function checkLinkDeletes(file, head, add) {
  for (const entry of file.added.filter((item) => LINK_DELETE.test(item.text))) {
    const window = headWindow(head, entry.line);
    if (!LINK_EDGE_KEYS.every((key) => key.test(window))) {
      add("artifact-link-delete", file.path, entry.line, "deletes artifact links not scoped to sourceId, targetId and linkType", "delete only the exact edge the write replaces");
    }
  }
}

function checkSharedPath(file, repo, logged, add) {
  if (file.status === "M" && SHARED_PATH.test(file.path) && repo.importers(file.path) >= 2 && !logged("Shared path:", file.path)) {
    add("shared-path", file.path, file.added[0]?.line ?? 1, "changes a shared read or write path without recorded evidence that existing callers are unchanged", "record `Shared path: <path>: unchanged for existing callers; evidence: <test or missing test entry with legacy fixtures>` or `...: changed; ruling: <human source>`");
  }
}

function checkDesktopLane(files, repo, logged, add) {
  const laneFiles = files.filter((file) => file.status === "A" && DESKTOP_LANE_FILE.test(file.path) && !isTestFile(file.path));
  const syncTables = files
    .filter((file) => file.status === "A" && DESKTOP_MIGRATION.test(file.path))
    .flatMap((file) => [...(repo.head(file.path) ?? "").matchAll(SQL_CREATE_TABLE)].map((found) => ({ file: file.path, table: found[1] })))
    .filter((entry) => SYNC_TABLE.test(entry.table));
  if (laneFiles.length === 0 && syncTables.length === 0) {
    return;
  }
  const where = laneFiles[0]?.path ?? syncTables[0].file;
  if (!logged("Synchronizing-susan:")) {
    add("desktop-sync-lane", where, 1, "adds a Desktop sync lane without a recorded synchronizing-susan pass", "run the repo's synchronizing-susan agent and record `Synchronizing-susan: <verdict and findings>`");
  }
  if (laneFiles.length > 0 && !laneFiles.some((file) => GIVE_UP_IMPORT.test(repo.head(file.path) ?? ""))) {
    add("desktop-sync-lane", where, 1, "the new lane does not import the shared give-up (shared/lane-give-up.ts or telemetry/sync-lane-give-up-telemetry.ts)", "use the shared give-up and re-arm (apps/desktop/src/main/sync/AGENTS.md, invariant 3)");
  }
  for (const file of laneFiles) {
    for (const entry of file.added.filter((item) => HAND_ROLLED_BACKOFF.test(item.text))) {
      add("desktop-sync-lane", file.path, entry.line, "hand-rolls an exponential backoff", "use exponentialBackoffMs from apps/desktop/src/shared/exponential-backoff.ts (invariant 5)");
    }
  }
  if (syncTables.length > 0 && !logged("Engineering needed (forbidden path): apps/desktop/src/main/sync/AGENTS.md")) {
    add("desktop-sync-lane", syncTables[0].file, 1, `new sync table ${syncTables[0].table} is not on the lane roster`, "record `Engineering needed (forbidden path): apps/desktop/src/main/sync/AGENTS.md; why: the lane roster names the new lane`");
  }
}

function commentBody(text) {
  return text.replace(/^\s*(?:\/\/+|\/\*+|\*+)\s?/, "").replace(/\*\/\s*$/, "").trim();
}

/**
 * Whether the code a removed comment sat above is still in the change: the
 * next code line on the base was kept, or was removed and added elsewhere
 * (moved). Code deleted outright takes its comment with it.
 */
function explainedCodeSurvives(file, entry, baseText, addedTexts) {
  const removedLines = new Set(file.removed.map((item) => item.line));
  const lines = baseText.split("\n");
  for (let line = entry.line + 1; line <= lines.length; line += 1) {
    const text = lines[line - 1];
    if (text.trim() === "" || COMMENT_LINE.test(text)) {
      continue;
    }
    return !removedLines.has(line) || addedTexts.has(text.trim());
  }
  return false;
}

function checkTicketedComments(files, repo, logged, add) {
  const addedLines = files.flatMap((file) => file.added);
  const carried = new Set(addedLines.filter((entry) => COMMENT_LINE.test(entry.text)).map((entry) => commentBody(entry.text)));
  const addedTexts = new Set(addedLines.map((entry) => entry.text.trim()));
  for (const file of files.filter((entry) => entry.status !== "D" && SOURCE_FILE.test(entry.path))) {
    const baseText = repo.base(file.oldPath ?? file.path) ?? "";
    for (const entry of file.removed) {
      const body = commentBody(entry.text);
      const ticket = TICKETED.exec(entry.text)?.[0];
      if (COMMENT_LINE.test(entry.text) && ticket && !carried.has(body) && !logged("Comment removed:", file.path)
        && explainedCodeSurvives(file, entry, baseText, addedTexts)) {
        add("ticketed-comment", file.oldPath ?? file.path, entry.line, `removes a comment citing ${ticket} that no added line carries`, "keep the comment with the code it explains, or record `Comment removed: <path>: <slug or URL>: <what the change made false>`");
      }
    }
  }
}

function checkStories(files, allFiles, repo, logged, add) {
  const versionChanged = allFiles.some((file) => file.path === STORY_VERSION_FILE && file.added.some((entry) => entry.text.includes('"version"')));
  for (const file of files.filter((entry) => STORY_FILE.test(entry.path))) {
    const flipped = file.removed.some((entry) => EXPECT_CALL.test(entry.text)) && file.added.some((entry) => EXPECT_CALL.test(entry.text));
    if (file.status !== "A" && flipped && !versionChanged && !logged("Story outcome unchanged:", file.path)) {
      add("story-outcome", file.path, file.added.find((entry) => EXPECT_CALL.test(entry.text)).line, "changes what a story asserts without a Storybook release", "rename a story whose asserted outcome flipped (a release: bump plus one Version History entry), or record `Story outcome unchanged: <path>: <why>`");
    }
    if (file.status !== "A" || logged("Story entry:", file.path)) {
      continue;
    }
    const head = repo.head(file.path) ?? "";
    const title = STORY_TITLE.exec(head)?.[1] ?? "";
    const component = STORY_COMPONENT.exec(head)?.[1];
    if (HARNESS_NAME.test(title) || HARNESS_NAME.test(path.basename(file.path))) {
      add("story-entry", file.path, 1, "gives a harness, adapter or preview its own Storybook entry", "put its states on the consumed component's current entry, or record `Story entry: <path>: <reason>`");
      continue;
    }
    const current = component && repo.baseStoriesRendering(component).find((story) => {
      const text = repo.base(story) ?? "";
      return STORY_COMPONENT.exec(text)?.[1] === component && !FROZEN_TITLE.test(STORY_TITLE.exec(text)?.[1] ?? "") && !/["']deprecated["']/.test(text);
    });
    if (current) {
      add("story-entry", file.path, 1, `adds a new entry for ${component}, which already has the current entry ${current}`, "add the states to that entry, or record `Story entry: <path>: <sibling replacement or Placement block>`");
    }
  }
}

/** The e2e specs that name each changed API route's endpoint. */
export function routeSpecs(files, repo) {
  const specs = repo.headFiles.filter((file) => file.startsWith("e2e/") && SOURCE_FILE.test(file));
  const required = [];
  for (const file of files) {
    const match = API_ROUTE.exec(file.path);
    if (!match) {
      continue;
    }
    const segments = match[1].split("/").filter((segment) => !/^\(.*\)$/.test(segment));
    const pattern = new RegExp(`/${segments.map((segment) => (/^\[.*\]$/.test(segment) ? "[^/\"'`?\\s]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}(?![\\w-])`);
    for (const spec of specs.filter((candidate) => pattern.test(repo.head(candidate) ?? ""))) {
      required.push({ path: spec, reason: `names the changed endpoint in ${file.path}; specs pin request bodies and untagged specs do not run on the pull request` });
    }
  }
  return required;
}

/** GridTableV2 parity tests read other files' source, so the graph never maps them. */
export function gridParityTests(files, repo) {
  const touched = files.some((file) => GRID_TABLE.test(file.path) || [...file.added, ...file.removed].some((entry) => GRID_SYMBOL.test(entry.text)));
  if (!touched) {
    return [];
  }
  return [GRID_PARITY_TEST, ...repo.headFiles.filter((file) => HOST_PARITY_TEST.test(file))]
    .filter((file) => repo.headFiles.includes(file))
    .map((file) => ({ path: file, reason: "a GridTableV2 type, adapter or mount changed; this parity test is not mapped by code_tests_for" }));
}

function gitRepo(worktree, base) {
  const headFiles = git(worktree, ["ls-files"]).split("\n").filter(Boolean);
  const read = (file) => {
    const absolute = path.join(worktree, file);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  };
  const baseRead = (file) => {
    try {
      return git(worktree, ["show", `${base}:${file}`]);
    } catch {
      return null;
    }
  };
  return {
    head: read,
    base: baseRead,
    headFiles,
    baseMigrations: lines(() => git(worktree, ["ls-tree", "--name-only", `${base}:${MIGRATIONS}`])),
    baseStoriesRendering: (component) =>
      lines(() => git(worktree, ["grep", "-l", "-E", `component:[[:space:]]*${component}([^[:alnum:]_]|$)`, base, "--", "*.stories.tsx", "*.stories.ts"]))
        .map((hit) => hit.slice(base.length + 1)),
    importers: (file) => {
      const stem = path.basename(file).replace(/\.tsx?$/, "");
      const directory = path.dirname(file);
      const quote = `(\\.js)?["']`;
      const elsewhere = lines(() => git(worktree, ["grep", "-l", "-E", `from ["'][^"']*/${path.basename(directory)}/${stem}${quote}`, "--", "*.ts", "*.tsx"]));
      const sibling = lines(() => git(worktree, ["grep", "-l", "-E", `from ["']\\./${stem}${quote}`, "--", `${directory}/*.ts`, `${directory}/*.tsx`]));
      return new Set([...elsewhere, ...sibling].filter((hit) => hit !== file && !isTestFile(hit))).size;
    },
  };
}

/** Non-empty output lines of a git read; a command that matches nothing (grep's exit 1) or a missing path is empty. */
function lines(read) {
  try {
    return read().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function untrackedAsAdded(worktree) {
  return git(worktree, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)
    .filter((file) => !file.startsWith(PRIVATE_PLANS))
    .map((file) => ({
      path: file,
      oldPath: null,
      status: "A",
      added: readFileSync(path.join(worktree, file), "utf8").split("\n").map((text, index) => ({ line: index + 1, text })),
      removed: [],
    }));
}

export function runDiffRules({ worktree, base, changeLog }) {
  const files = [...parseUnifiedDiff(git(worktree, ["diff", "--no-color", "--unified=0", "-M", base])), ...untrackedAsAdded(worktree)];
  const logFile = changeLog ?? path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "vibe-changes.md");
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  return evaluateDiff(files, log, gitRepo(worktree, base));
}

function main() {
  const { values } = parseArgs({
    options: { worktree: { type: "string" }, base: { type: "string" }, "change-log": { type: "string" } },
  });
  try {
    if (!values.worktree || !values.base) {
      throw new Error("--worktree and --base are required.");
    }
    const result = runDiffRules({ worktree: path.resolve(values.worktree), base: values.base, changeLog: values["change-log"] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
