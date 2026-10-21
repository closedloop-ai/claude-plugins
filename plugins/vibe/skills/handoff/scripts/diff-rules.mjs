// Mechanical review gates over a vibe session's diff, for defects that shipped
// in vibe pull requests and repeated after a prose rule. handoff-inventory.mjs
// runs them and reports the result as `diffRules`, so no worker runs another
// command. Each blocking finding names the fix, or the change log line that
// records why the code stays; `requiredTests` and `requiredChecks` are what the
// diff needs run whatever the graph maps. Git reads and file reads only.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { git } from "../../vibe/scripts/session-record.mjs";
import { E2E_ROOT_PATHSPECS, isE2ePath, isTestFile, TEST_SPEC_PATTERN } from "../../vibe/scripts/test-files.mjs";
import { isUnversionedStory, storyExportNames, storyMetaTitle } from "./storybook-taxonomy.mjs";

const PRIVATE_PLANS = ".closedloop-ai/vibe-plans/";
const MIGRATION_DIR = /^packages\/database\/prisma\/migrations\/[^/]+\/migration\.sql$/;
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
const TICKETED = /\b(?:ISS|PRD|PLN|FEA)-\d+\b|https?:\/\/\S+/;
const TICKET_TOKENS = /\b(?:ISS|PRD|PLN|FEA)-\d+\b|https?:\/\/\S+/g;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const SHARED_PATH = /^(?:apps\/api\/lib\/.+|apps\/api\/app\/.*service[^/]*|packages\/app\/.*data-source[^/]*)\.tsx?$/;
const API_ROUTE = /^apps\/api\/app\/(.*)\/route\.ts$/;
const GRID_TABLE = /grid-table-v2/;
const GRID_SYMBOL = /\bGridTableV2\b/;
const GRID_PARITY_TEST = "apps/app/__tests__/grid-table-v2-surface-capability-parity.test.ts";
const HOST_PARITY_TEST = /^apps\/app\/__tests__\/[^/]+-host-capability-parity\.test\.ts$/;
const STORY_FILE = /\.stories\.tsx?$/;
const SIDEBAR_ORDER_FILES = new Set(["apps/storybook/story-group-order.ts", "apps/storybook/.storybook/preview.tsx", "apps/storybook/.storybook/manager.ts"]);
const SIDEBAR_ORDER_TESTS = ["apps/storybook/__tests__/preview-story-sort-order.test.ts", "apps/storybook/__tests__/story-group-order.test.ts"];
const STORY_VERSION_FILE = "apps/storybook/package.json";
const STORY_COMPONENT = /\bcomponent:\s*([A-Z]\w*)/;
const STORY_TITLE = /\btitle:\s*["'`]([^"'`]+)["'`]/;
const IMPORT_SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];
const FROZEN_CANDIDATE = String.raw`v1\.0|deprecated`;
const CLOSURE_LIMIT = 20000;
const STORY_ID_PATHSPECS = [...E2E_ROOT_PATHSPECS, "docs/", "apps/web/content/docs/", ".claude/", "*.test.*", "*.spec.*", "*.stories.*"];
const STORY_ID_WORD = /[A-Z]{2,}(?=[A-Z][a-z]|\b|\d)|[A-Z]?[a-z]+|[A-Z]|\d+/g;
const HARNESS_NAME = /harness|adapter/i;
const EXPECT_CALL = /\bexpect\(/;
const WINDOW = 25;
const COPY_FILE = /\.[jt]sx$/;
const COPY_LITERALS = [
  /\btoast(?:\.\w+)?\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g,
  /(?:\baria-label|\baria-description|\blabel|\btitle|\bplaceholder|\bdescription|\btooltip)\s*[=:]\s*\{?\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g,
  /()(?<=[\w"'}/])>([^<>{}=&|();]*[A-Za-z]{2,}[^<>{}=&|();]*)</g,
];
const WORDING = /[A-Z]|\s/;
const TEMPLATE_PART = /\$\{[^}]*\}/;
const TEMPLATE_PARTS = /\$\{[^}]*\}/g;
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|sh|bash|zsh|py)$/;
const ENV_DUMP = [
  /JSON\.stringify\(\s*process\.env\s*[,)]/,
  /Object\.(?:entries|values)\(\s*process\.env\s*\)/,
  /console\.\w+\([^)]*\bprocess\.env\s*\)/,
  /^\s*(?:printenv|env|export\s+-p|set)\s*(?:$|[>|])/,
  /(?:print|json\.dumps)\(\s*(?:dict\()?os\.environ\b(?!\s*[.[])/,
];
const JSX_MOUNT = /<([A-Z][A-Za-z0-9]*)\b/g;
const RESTORE_LIMIT = 40;
const ROUTE_SPEC_HOPS = 3;

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
 * text or null, `headFiles`
 * (tracked paths at head) and `importerCounts(paths)` (non-test files importing each).
 */
export function evaluateDiff(files, changeLog, repo) {
  const blocking = [];
  const requiredTests = [];
  const requiredChecks = [];
  const logged = (prefix, file) => changeLog.split("\n").some((line) => line.includes(prefix) && (file === undefined || line.includes(file)));
  const add = (rule, file, line, problem, fix) => blocking.push({ rule, file, line, problem, fix });
  const live = files.filter((file) => file.status !== "D");

  checkMigrations(live, repo, logged, add, requiredChecks);
  const shared = live.filter((file) => file.status === "M" && SHARED_PATH.test(file.path) && !logged("Shared path:", file.path));
  const importers = shared.length ? repo.importerCounts(shared.map((file) => file.path)) : new Map();
  for (const file of shared.filter((entry) => (importers.get(entry.path) ?? 0) >= 2)) {
    add("shared-path", file.path, file.added[0]?.line ?? 1, "changes a shared read or write path without recorded evidence that existing callers are unchanged", "record `Shared path: <path>: unchanged for existing callers; evidence: <test or missing test entry with legacy fixtures>` or `...: changed; ruling: <human source>`");
  }
  for (const file of live.filter((entry) => SCRIPT_FILE.test(entry.path) && !isTestFile(entry.path))) {
    for (const entry of file.added.filter((item) => ENV_DUMP.some((pattern) => pattern.test(item.text)))) {
      add("env-dump", file.path, entry.line, "prints or serializes the whole environment, which holds credentials", "read only the named non-secret keys the diagnostic needs; never print, log or write env or config wholesale");
    }
  }
  for (const file of live.filter((entry) => SOURCE_FILE.test(entry.path) && !isTestFile(entry.path))) {
    const head = repo.head(file.path) ?? "";
    checkActivityCapture(file, head, logged, add);
    checkTransactions(file, head, add);
    checkLinkDeletes(file, head, add);
  }
  checkDesktopLane(live, repo, logged, add);
  checkTicketedComments(files, repo, logged, add);
  checkStories(live, files, repo, logged, add);
  checkFrozenRenders(files, repo, logged, add);
  checkLostStoryIds(files, repo, add);
  checkCopyProvenance(live, files, repo, logged, add);
  checkRestoredRemovals(live, files, repo, changeLog, add);
  requiredTests.push(...routeSpecs(live, repo), ...gridParityTests(files, repo), ...sidebarOrderTests(files, repo));
  return { ok: blocking.length === 0, blocking, requiredTests, requiredChecks };
}

function checkMigrations(files, repo, logged, add, requiredChecks) {
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
    const sql = repo.head(file.path) ?? "";
    const created = new Set([...sql.matchAll(SQL_CREATE_TABLE)].map((found) => found[1]));
    const existing = new Set([...sql.matchAll(SQL_TABLE_TOUCH)].map((found) => found[1]).filter((table) => !created.has(table)));
    for (const table of existing) {
      if (!logged(`Migration precedent: ${table}:`)) {
        add("migration-precedent", file.path, 1, `changes existing table ${table} without a recorded lock-strategy precedent`, `copy the last three migrations on ${table} and record \`Migration precedent: ${table}: <folders>\``);
      }
    }
    for (const update of sql.matchAll(SQL_UPDATE_STATEMENT)) {
      if (!/\bWHERE\b/i.test(update[0]) && !logged(`Migration precedent: ${update[1]}:`)) {
        add("migration-backfill", file.path, 1, `full-table UPDATE of ${update[1]} in a schema migration`, `move or bound the backfill as ${update[1]}'s precedent does, and record \`Migration precedent: ${update[1]}: <folders>\``);
      }
    }
  }
  if (touched) {
    requiredChecks.push(
      { command: "pnpm check:destructive-migrations", reason: "a migration changed; the repo's index-lock and migration-order gate, rerun on the merged tree after every main sync (fix an out-of-order migration by renaming its folder, SQL unchanged)" },
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
  const addedComments = addedLines.filter((entry) => COMMENT_LINE.test(entry.text));
  const carried = new Set(addedComments.map((entry) => commentBody(entry.text)));
  const carriedTokens = new Set(addedComments.flatMap((entry) => entry.text.match(TICKET_TOKENS) ?? []));
  const addedTexts = new Set(addedLines.map((entry) => entry.text.trim()));
  for (const file of files.filter((entry) => entry.status !== "D" && SOURCE_FILE.test(entry.path))) {
    for (const entry of file.removed) {
      const body = commentBody(entry.text);
      const ticket = TICKETED.exec(entry.text)?.[0];
      if (COMMENT_LINE.test(entry.text) && ticket && !carried.has(body) && !carriedTokens.has(ticket) && !logged("Comment removed:", file.path)
        && explainedCodeSurvives(file, entry, repo.base(file.oldPath ?? file.path) ?? "", addedTexts)) {
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
      add("story-entry", file.path, 1, "gives a harness or adapter its own Storybook entry", "put its states on the consumed component's current entry, or record `Story entry: <path>: <reason>`");
      continue;
    }
    const current = component && repo.baseStoriesRendering(component).find((story) => {
      const text = repo.base(story) ?? "";
      return STORY_COMPONENT.exec(text)?.[1] === component && !isUnversionedStory(text) && !repo.isFrozenStory(text);
    });
    if (current) {
      add("story-entry", file.path, 1, `adds a new entry for ${component}, which already has the current entry ${current}`, "add the states to that entry, or record `Story entry: <path>: <sibling replacement or Placement block>`");
    }
  }
}

/** An import specifier resolved to a file in `files` (relative or `@repo/`), or undefined. */
function resolveImport(from, specifier, files) {
  let stem;
  if (specifier.startsWith(".")) {
    stem = path.posix.join(path.posix.dirname(from), specifier);
  } else if (specifier.startsWith("@repo/")) {
    stem = `packages/${specifier.slice("@repo/".length)}`;
  } else {
    return undefined;
  }
  stem = stem.replace(/\.js$/, "");
  return SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`).find((candidate) => files.has(candidate) && SOURCE_FILE.test(candidate));
}

/**
 * Every frozen v1.0 story on the base whose rendered dependency closure (its
 * file and everything it imports, transitively) the diff changed. Its render
 * and play against main must be identical, so a change needs the recorded
 * evidence; a byte-identical story file is not enough. Edits to the story file
 * itself are the inventory's `v1Stories` and `compileOnlyV1Repairs`.
 */
function checkFrozenRenders(files, repo, logged, add) {
  const changed = new Set(files.flatMap((file) => [file.path, file.oldPath].filter(Boolean)));
  const stories = repo.frozenStories();
  if (stories.length === 0) {
    return;
  }
  const imports = new Map();
  let frontier = stories;
  while (frontier.length && imports.size < CLOSURE_LIMIT) {
    const texts = repo.baseBlobs(frontier);
    const next = new Set();
    for (const file of frontier) {
      const targets = [...(texts.get(file) ?? "").matchAll(IMPORT_SPECIFIER)]
        .map((found) => resolveImport(file, found[1], repo.baseFiles)).filter(Boolean);
      imports.set(file, targets);
      targets.filter((target) => !imports.has(target)).forEach((target) => next.add(target));
    }
    frontier = [...next];
  }
  const affected = stories.filter((story) => {
    const seen = new Set([story]);
    const queue = [story];
    while (queue.length) {
      for (const target of imports.get(queue.shift()) ?? []) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    return [...seen].some((file) => file !== story && changed.has(file));
  });
  if (affected.length && !logged(`Frozen render unchanged: all ${affected.length} stories:`)) {
    add("frozen-render", affected[0], 1, `${affected.length} frozen v1.0 stories render files this diff changed: ${affected.join(", ")}`, `render their story IDs on the base and the branch with fixed args, globals and viewport and run their plays; when every one is identical record \`Frozen render unchanged: all ${affected.length} stories: <command and result>\`, otherwise keep the frozen renders unchanged`);
  }
}

/** Storybook's story ID: the sanitized title, `--`, the sanitized start-cased export name. */
export function storyId(title, exportName) {
  const sanitize = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${sanitize(title)}--${sanitize((exportName.match(STORY_ID_WORD) ?? []).join(" "))}`;
}

function storyIds(source) {
  const title = source ? storyMetaTitle(source) : null;
  return title ? storyExportNames(source).map((name) => storyId(title, name)) : [];
}

/**
 * Story IDs the base has and the session lost block unless the file is a
 * recorded sibling replacement's entry (a retitle is the inventory's
 * `retitledStories`), and every reference to a lost ID left in specs, tests,
 * docs, agent files or stories blocks.
 */
function checkLostStoryIds(files, repo, add) {
  const still = new Set(files.filter((file) => file.status !== "D" && STORY_FILE.test(file.path)).flatMap((file) => storyIds(repo.head(file.path))));
  for (const file of files.filter((entry) => entry.status !== "A" && STORY_FILE.test(entry.oldPath ?? entry.path))) {
    const baseText = repo.base(file.oldPath ?? file.path);
    const lost = storyIds(baseText).filter((id) => !still.has(id));
    const headTitle = file.status === "D" ? null : storyMetaTitle(repo.head(file.path) ?? "");
    const retitled = headTitle !== null && headTitle !== storyMetaTitle(baseText ?? "");
    if (lost.length && !retitled && !repo.storyReplacements.has(file.path)) {
      add("lost-story-id", file.path, 1, `loses story IDs ${lost.join(", ")}`, "keep the title and export names, or record the file as a sibling replacement's entry (`vibe-sessions.mjs story-replacement`)");
    }
    for (const id of lost) {
      for (const hit of repo.filesNaming(id)) {
        add("lost-story-id", hit, 1, `still names the removed or renamed story ID ${id}`, "point it at the story's current ID");
      }
    }
  }
}

/**
 * The e2e specs, under every e2e root, that reach each changed API route's
 * endpoint: naming it themselves, or importing a helper that names it (up to
 * ROUTE_SPEC_HOPS imports away). A helper is never listed; it cannot run.
 */
export function routeSpecs(files, repo) {
  const routes = files.flatMap((file) => {
    const match = API_ROUTE.exec(file.path);
    return match ? [{ route: file.path, pattern: endpointPattern(match[1]) }] : [];
  });
  if (routes.length === 0) {
    return [];
  }
  const e2eFiles = repo.headFiles.filter((file) => isE2ePath(file) && SOURCE_FILE.test(file));
  const importers = e2eImporters(e2eFiles, repo);
  const required = new Map();
  for (const { route, pattern } of routes) {
    for (const named of e2eFiles.filter((candidate) => pattern.test(repo.head(candidate) ?? ""))) {
      for (const [spec, hops] of specsReaching(named, importers)) {
        const via = hops === 0 ? "names" : `imports ${named}${hops > 1 ? ` (${hops} imports away)` : ""}, which names`;
        if (!required.has(spec)) {
          required.set(spec, { path: spec, reason: `${via} the changed endpoint in ${route}; specs pin request bodies and untagged specs do not run on the pull request` });
        }
      }
    }
  }
  return [...required.values()];
}

function endpointPattern(routeDirectory) {
  const segments = routeDirectory.split("/").filter((segment) => !/^\(.*\)$/.test(segment));
  return new RegExp(`/${segments.map((segment) => (/^\[.*\]$/.test(segment) ? "[^/\"'`?\\s]+" : escapeRegExp(segment))).join("/")}(?![\\w-])`);
}

/** Each e2e file mapped to the e2e files that import it. */
function e2eImporters(e2eFiles, repo) {
  const known = new Set(e2eFiles);
  const importers = new Map();
  for (const file of e2eFiles) {
    for (const found of (repo.head(file) ?? "").matchAll(IMPORT_SPECIFIER)) {
      const target = resolveImport(file, found[1], known);
      if (target && target !== file) {
        importers.set(target, (importers.get(target) ?? new Set()).add(file));
      }
    }
  }
  return importers;
}

/** Specs that are `file` or import it within ROUTE_SPEC_HOPS, with their distance; the walk stops at a spec. */
function specsReaching(file, importers) {
  const reached = new Map();
  const seen = new Set([file]);
  let frontier = [file];
  for (let hops = 0; frontier.length && hops <= ROUTE_SPEC_HOPS; hops += 1) {
    const next = [];
    for (const current of frontier) {
      if (TEST_SPEC_PATTERN.test(current)) {
        reached.set(current, hops);
        continue;
      }
      for (const importer of importers.get(current) ?? []) {
        if (!seen.has(importer)) {
          seen.add(importer);
          next.push(importer);
        }
      }
    }
    frontier = next;
  }
  return reached;
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

/**
 * A new toast, label, title, placeholder, description or aria string, or JSX text, that the base tree never had
 * needs a cited human source; a prose provenance rule did not stop agent-written toasts.
 */
function checkCopyProvenance(files, allFiles, repo, logged, add) {
  const removed = allFiles.flatMap((file) => file.removed.map((entry) => entry.text)).join("\n");
  for (const file of files.filter((entry) => COPY_FILE.test(entry.path) && !isTestFile(entry.path) && !STORY_FILE.test(entry.path))) {
    for (const entry of file.added) {
      for (const text of copyLiterals(entry.text)) {
        if (!removed.includes(text) && !logged(`Copy: "${text}":`) && !repo.baseContains(text)) {
          add("copy-provenance", file.path, entry.line, `new user-visible string "${text}" with no cited human source`, `reuse the shared constant or label map that renders it, or record \`Copy: "${text}": <ticket, PRD or person's words that give it>\`; the session's own ticket, plan or change log is not a source`);
        }
      }
    }
  }
}

/**
 * A component mounted again, or a file added back, that a base commit removed needs a human's restore
 * authorization naming the removal it overrides.
 */
function checkRestoredRemovals(files, allFiles, repo, changeLog, add) {
  const authorized = (name) => new RegExp(String.raw`^\s*(?:[-*]\s+)?Restore authorization:\s*${escapeRegExp(name)}:\s*(?:operator ruling|[A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)+),\s*\d{4}-\d{2}-\d{2},\s*[^;\n]+;\s*overrides\s+(?:ISS|PRD|PLN|FEA)-\d+`, "m").test(changeLog);
  const removed = new Set(allFiles.flatMap((file) => file.removed.flatMap((entry) => [...entry.text.matchAll(JSX_MOUNT)].map((match) => match[1]))));
  let checked = 0;
  for (const file of files.filter((entry) => COPY_FILE.test(entry.path) && !isTestFile(entry.path) && !STORY_FILE.test(entry.path))) {
    if (file.status === "A" && !authorized(file.path) && checked++ < RESTORE_LIMIT) {
      const removal = repo.deletionOf(file.path);
      if (removal) {
        add("restored-removal", file.path, 1, `adds back a file deleted by ${removal}`, `remove it, or record \`Restore authorization: ${file.path}: <human name or operator ruling>, <YYYY-MM-DD>, <where>; overrides <removal ticket>\``);
      }
    }
    const before = repo.base(file.path) ?? "";
    const mounted = new Set(file.added.flatMap((entry) => [...entry.text.matchAll(JSX_MOUNT)].map((match) => match[1])));
    for (const name of [...mounted].filter((item) => !before.includes(`<${item}`) && !removed.has(item) && !authorized(item))) {
      if (checked++ >= RESTORE_LIMIT) {
        return;
      }
      const removal = repo.unmountOf(name);
      if (removal) {
        const line = file.added.find((entry) => entry.text.includes(`<${name}`))?.line ?? 1;
        add("restored-removal", file.path, line, `mounts ${name}, removed by ${removal}`, `find that removal's ticket and its human ruling; remove the mount, or record \`Restore authorization: ${name}: <human name or operator ruling>, <YYYY-MM-DD>, <where>; overrides <removal ticket>\``);
      }
    }
  }
}

export function copyLiterals(line) {
  if (COMMENT_LINE.test(line)) {
    return [];
  }
  const found = new Set();
  for (const pattern of COPY_LITERALS) {
    for (const match of line.matchAll(pattern)) {
      const text = match[2].trim();
      if (/[A-Za-z]{2,}/.test(text.replace(TEMPLATE_PARTS, "")) && WORDING.test(text)) {
        found.add(text);
      }
    }
  }
  return [...found];
}

/** The sidebar order is copied into preview.tsx; only these tests catch the copy drifting. */
export function sidebarOrderTests(files, repo) {
  const touched = files.some((file) => SIDEBAR_ORDER_FILES.has(file.path) || (STORY_FILE.test(file.path)
    && (file.status !== "M" || [...file.added, ...file.removed].some((entry) => STORY_TITLE.test(entry.text)))));
  return touched
    ? SIDEBAR_ORDER_TESTS.filter((test) => repo.headFiles.includes(test)).map((test) => ({ path: test, reason: "the sidebar order or a story title changed" }))
    : [];
}

function gitRepo(worktree, base, isFrozenStory, storyReplacements) {
  const headFiles = git(worktree, ["ls-files"]).split("\n").filter(Boolean);
  const baseFiles = new Set(lines(() => git(worktree, ["ls-tree", "-r", "--name-only", base])));
  const blobs = new Map();
  const baseBlobs = (paths) => {
    const missing = [...new Set(paths)].filter((file) => !blobs.has(file) && baseFiles.has(file));
    if (missing.length) {
      readBlobs(worktree, base, missing).forEach((text, file) => blobs.set(file, text));
    }
    return new Map(paths.map((file) => [file, blobs.get(file)]));
  };
  const read = memoize((file) => {
    const absolute = path.join(worktree, file);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  });
  const baseRead = memoize((file) => {
    try {
      return git(worktree, ["show", `${base}:${file}`]);
    } catch {
      return null;
    }
  });
  return {
    head: read,
    base: baseRead,
    headFiles,
    baseFiles,
    baseBlobs,
    storyReplacements,
    deletionOf: (file) => {
      const hit = lines(() => git(worktree, ["log", "--diff-filter=D", "-n", "1", "--format=%h %s", base, "--", file]))[0];
      return hit ? `commit ${hit}` : null;
    },
    unmountOf: (name) => {
      const mount = new RegExp(`<${name}\\b`);
      for (const hit of lines(() => git(worktree, ["log", "-G", `<${name}([^A-Za-z0-9]|$)`, "-n", "20", "--format=%H %h %s", base]))) {
        const [sha, ...summary] = hit.split(" ");
        const diff = lines(() => git(worktree, ["show", "--format=", "--unified=0", sha]));
        const count = (sign) => diff.filter((text) => text.startsWith(sign) && !text.startsWith(`${sign}${sign}${sign}`) && mount.test(text)).length;
        if (count("-") > count("+")) {
          return `commit ${summary.join(" ")}`;
        }
      }
      return null;
    },
    baseContains: (text) => {
      const parts = text.split(TEMPLATE_PART);
      const search = parts.length > 1 ? ["-E", "-e", parts.map((part) => part.replace(/[.[\]()*+?{}|^$\\]/g, "\\$&")).join(".*")] : ["-F", "-e", text];
      try {
        git(worktree, ["grep", "-q", ...search, base]);
        return true;
      } catch {
        return false;
      }
    },
    filesNaming: (text) => lines(() => git(worktree, ["grep", "-l", "-F", text, "--", ...STORY_ID_PATHSPECS])),
    isFrozenStory,
    frozenStories: () => {
      const candidates = lines(() => git(worktree, ["grep", "-l", "-E", FROZEN_CANDIDATE, base, "--", "*.stories.tsx", "*.stories.ts"]))
        .map((hit) => hit.slice(base.length + 1));
      const texts = baseBlobs(candidates);
      return candidates.filter((story) => !isUnversionedStory(texts.get(story)) && isFrozenStory(texts.get(story) ?? ""));
    },
    baseStoriesRendering: (component) =>
      lines(() => git(worktree, ["grep", "-l", "-E", `component:[[:space:]]*${component}([^[:alnum:]_]|$)`, base, "--", "*.stories.tsx", "*.stories.ts"]))
        .map((hit) => hit.slice(base.length + 1)),
    importerCounts: (files) => {
      const targets = files.map((file) => {
        const stem = path.basename(file).replace(/\.tsx?$/, "");
        const directory = path.dirname(file);
        return { file, directory, elsewhere: `${path.basename(directory)}/${stem}`, sibling: `./${stem}`, stem };
      });
      const hits = lines(() => git(worktree, ["grep", "-F", ...targets.flatMap((target) => ["-e", target.elsewhere, "-e", target.sibling]), "--", "*.ts", "*.tsx"]));
      const counts = new Map();
      for (const target of targets) {
        const elsewhere = new RegExp(`from ["'][^"']*/${escapeRegExp(target.elsewhere)}(?:\\.js)?["']`);
        const sibling = new RegExp(`from ["']\\./${escapeRegExp(target.stem)}(?:\\.js)?["']`);
        const importing = new Set();
        for (const hit of hits) {
          const at = hit.indexOf(":");
          const hitFile = hit.slice(0, at);
          const text = hit.slice(at + 1);
          if (hitFile !== target.file && !isTestFile(hitFile)
            && (elsewhere.test(text) || (path.dirname(hitFile) === target.directory && sibling.test(text)))) {
            importing.add(hitFile);
          }
        }
        counts.set(target.file, importing.size);
      }
      return counts;
    },
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function memoize(read) {
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) {
      cache.set(key, read(key));
    }
    return cache.get(key);
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

/** Reads many base blobs through one `git cat-file --batch`. */
function readBlobs(worktree, base, files) {
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: worktree, input: files.map((file) => `${base}:${file}`).join("\n") + "\n", maxBuffer: 512 * 1024 * 1024,
  });
  const texts = new Map();
  let offset = 0;
  for (const file of files) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString();
    const size = Number(header.split(" ")[2]);
    offset = end + 1;
    if (header.endsWith("missing")) {
      continue;
    }
    texts.set(file, output.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  return texts;
}

/**
 * Runs every rule on the session diff. `exclude` holds paths that are not the
 * session's work (local fixes); `isFrozenStory` is the base's v1.0 predicate
 * (storybook-taxonomy.mjs, by the base's scheme); `storyReplacements` holds
 * story files recorded as a sibling replacement's entry.
 */
export function runDiffRules({ worktree, base, changeLog, exclude = new Set(), isFrozenStory = () => false, storyReplacements = new Set() }) {
  const files = [...parseUnifiedDiff(git(worktree, ["diff", "--no-color", "--unified=0", "-M", base])), ...untrackedAsAdded(worktree)]
    .filter((file) => !exclude.has(file.path));
  const logFile = changeLog ?? path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "vibe-changes.md");
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  return evaluateDiff(files, log, gitRepo(worktree, base, isFrozenStory, storyReplacements));
}
