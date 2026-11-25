// Mechanical review gates over a vibe session's diff, for defects that shipped
// in vibe pull requests and repeated after a prose rule. handoff-inventory.mjs
// runs them and reports the result as `diffRules`, so no worker runs another
// command. Each blocking finding names the fix, or the change log line that
// records why the code stays; `requiredTests` and `requiredChecks` are what the
// diff needs run whatever the graph maps. Git reads and file reads only.
// The rules that name one repository's paths, commands and models (its
// migrations, Desktop sync lanes, host parity tests, Storybook order files and
// docs folders) are the bound provider's `recipes.diffRules`; without one those
// rules do not run and only the generic rules apply.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isLocalPlanPath, localPlanPaths, localPlanPrefix } from "../../vibe/scripts/local-plans.mjs";
import { lineIndex } from "./line-index.mjs";
import { migrationId, migrationProblems } from "../../vibe/scripts/migration-publish.mjs";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { pathGateTests } from "./path-gates.mjs";
import { checkComparators, checkDuplicateHelpers, checkUnusedExports } from "./review-gap-rules.mjs";
import { checkCommentRules, citationPattern, commentBody } from "./comment-rules.mjs";
import { sharedComponentTests } from "./shared-consumers.mjs";
import { checkSpecChanges } from "./spec-rules.mjs";
import { checkFlagRetirement } from "./flag-retirement.mjs";
import { routeSpecs } from "./route-specs.mjs";
import { escapeRegExp, SOURCE_FILE } from "./source-imports.mjs";
import { repositoryLayout } from "../../vibe/scripts/area-paths.mjs";
import { isGeneratedFile } from "./generated-files.mjs";
import { frozenAffectedStoryFiles, frozenInputs } from "./frozen-render.mjs";
import { DEEPEN_STEPS, gitRepo, lines } from "./diff-rules-repo.mjs";
import { checkStorybookRules, storybookRuleTests } from "./storybook-rules.mjs";
import { isUnversionedStory, storyExportNames, storyMetaTitle } from "./storybook-taxonomy.mjs";
import { isVisualBaseline, visualBaselineLedgerProblems } from "./visual-baseline-ledger.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { git } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { providerDataOr, sessionBinding, ticketReference } = await vibeCore("lib/vibe/scripts/provider.mjs");

const SQL_TABLE_TOUCH = /\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*?\bON\s+(?:ONLY\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?|(?<!\bON\s{1,10})UPDATE\s+)"?(\w+)"?/gi;
const SQL_CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi;
const SQL_UPDATE_STATEMENT = /(?<!\bON\s{1,10})\bUPDATE\s+"?(\w+)"?[^;]*;/gi;
const ARTIFACT_WRITE = /\.artifact\.(?:update|updateMany|upsert)\(|\bUPDATE\s+"?artifacts"?\s/i;
const CAPTURED_FIELD = /\b(?:status|priority|assigneeId|approverId|projectId|title|dueDate)\s*:|"(?:status|priority|assignee_id|approver_id|project_id|title|due_date)"\s*=/;
const CAPTURE_CALL = /\bcapture[A-Z]\w*\(/;
const TX_OPEN = /withDb\.tx\(/g;
const TX_WRITE = /\btx\.(?:\w+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw)/;
const RESULT_ERR_RETURN = /\breturn\s+(?:Result\.)?err\(/;
const BATCH_LIMIT_SIGNAL = /\b(?:BATCH|BULK)[A-Z0-9_]*LIMIT\b|\b(?:batch|bulk)\s+limit\b/i;
const SET_TRANSFORM_SIGNAL = /\b(?:collapse|dedupe|deduplicate|normaliz|distinct|unique)[A-Za-z0-9_]*\b/i;
// A collection of ids on the transform line or the two added lines after it (a wrapped call): `selectedIds`,
// `artifactUUIDs`, `ids`, or a user's `selection`. A lone `id` field or a file that merely mentions ids elsewhere is
// not a set of user-supplied ids.
const ID_COLLECTION_SIGNAL = /[a-z0-9_](?:Ids|IDs|UUIDs|Uuids)\b|\b(?:ids|uuids|IDs|UUIDs|selection)\b/;
const TRANSACTION_SCALE_RECORD = /^\s*(?:[-*]\s+)?Transaction scale:\s*(\S+):\s*limit\s+\d+;\s*duration\s+\d+(?:\.\d+)?ms;\s*timeout\s+\d+ms;\s*ambient timeout\s+(?:honored|ignored);\s*lock hold\s+\d+(?:\.\d+)?ms;\s*test\s+(\S+)\s*$/im;
const INPUT_SET_RECORD = /^\s*(?:[-*]\s+)?Input set:\s*(\S+):(?=[^\n]*\border permutations\b)(?=[^\n]*\bcase\b)(?=[^\n]*\bduplicates\b)(?=[^\n]*\bwhitespace\b)[^\n]*;\s*test\s+(\S+)\s*$/gim;
const LINK_DELETE = /\.artifactLink\.deleteMany\(|\bDELETE\s+FROM\s+"?artifact_links"?/i;
const LINK_EDGE_KEYS = [/\bsourceId\b|\bsource_id\b/, /\btargetId\b|\btarget_id\b/, /\blinkType\b|\blink_type\b/];
const SYNC_TABLE = /outbox|sync/i;
const HAND_ROLLED_BACKOFF = /\*\*\s*\(?\s*\w*(?:attempt|retry|retries|n)\b/i;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const BREADCRUMB_SIGNAL = /breadcrumb|crumb|ancestor/i;
const BREADCRUMB_BUILDER = /^(?:export\s+)?(?:function|const|let)\s+\w*(?:breadcrumb|crumb|ancestor)\w*\b/i;
/** A story source file; the one pattern the frozen-story checks share. */
export const STORY_FILE = /\.stories\.tsx?$/;
// A human source with no tracker bound: an issue or pull request number, or a URL.
const GENERIC_SOURCE = String.raw`(?:#\d+|https?:\/\/\S+)`;
// Docs and agent folders a session may not edit, without a provider naming the repository's own.
const GENERIC_DOCS = ["docs/", ".claude/"];
const STORY_COMPONENT = /\bcomponent:\s*([A-Z]\w*)/;
const STORY_TITLE = /\btitle:\s*["'`]([^"'`]+)["'`]/;
const FROZEN_LINE_BASE = /: frozen-render\.mjs --base (\S+)/;
const FROZEN_LINE_INPUTS = /; inputs ([0-9a-f]{16});/;
const FROZEN_LINE_STATES = /; states ([^;]*);/;
const FORBIDDEN_REFERENCE = /^(?:AGENTS|CLAUDE|AGENTS\.override)\.md$/;
const STORY_ID_WORD = /[A-Z]{2,}(?=[A-Z][a-z]|\b|\d)|[A-Z]?[a-z]+|[A-Z]|\d+/g;
const HARNESS_NAME = /harness|adapter/i;
const EXPECT_CALL = /\bexpect\(/;
const WINDOW = 25;
const COPY_FILE = /\.[jt]sx$/;
const UI_PATH = /\.(?:[jt]sx|css|scss|sass|less|html?|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|og[gv]|mp3|wav)$/i;
const COPY_LITERALS = [
  /\bsearchLabel\s*[=:]\s*\{?\s*(["'\x60])((?:(?!\1)[^\\]|\\.)*)\1/g,
  /\btoast(?:\.\w+)?\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g,
  /(?:\baria-label|\baria-description|\blabel|\btitle|\bplaceholder|\bdescription|\btooltip)\s*[=:]\s*\{?\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g,
  /()(?<=[\w"'}/])>([^<>{}=&|();]*[A-Za-z]{2,}[^<>{}=&|();]*)</g,
];
const WORDING = /[A-Z]|\s/;
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
const CONTROL_PROP = /\b((?:show|enable|allow|with|render|on)[A-Z][A-Za-z0-9]*)\s*(?::|=)/;
const CONTROL_TERM = /selectall|checkbox|button|menu|action|toolbar|filter|search|picker|popover|dialog|drawer|toggle|favorite|star|bulk|control|disclosure|pagination/i;
const CONTROL_MOUNT = /<([A-Z][A-Za-z0-9]*)\b/g;
const DEFINED_COMPONENT = /^\s*export\s+(?:default\s+)?(?:const|function)\s+([A-Z][A-Za-z0-9]*)\b/;
const IMPORT_DECLARATION = /\bimport\s+(?!["'])([\s\S]*?)\s+from\s+["']([^"']+)["'];?/g;
const DESIGN_SYSTEM_CONTROL = /^@repo\/design-system\/components\/ui\//;
const CAPABILITY_COMPONENT = /search|filter|sort|range|toolbar|pagination|control|picker|menu|popover/i;
const PRIMITIVE_LEAF = /(?:Item|Content|Trigger)$/;
// The file-name words that mark a page composer; matched as whole words, so "pager" is not "page".
const PAGE_COMPOSER_WORDS = new Set(["page", "route", "toolbar", "list", "shell", "surface", "adapter"]);

/**
 * Parses `git diff --unified=0` output into per-file added and removed lines, leaving out the in-worktree
 * local plan folder `planPrefix` (local-plans.mjs; null when the plans live in the git directory).
 */
export function parseUnifiedDiff(text, planPrefix = null) {
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
  return files.filter((file) => file.path && !isLocalPlanPath(file.path, planPrefix));
}

/** Whether a diff touches a rendered UI path; tests and snapshots are evidence, not product UI. */
export function touchesUiPath(files) {
  return files.some((file) => file.status !== "D" && UI_PATH.test(file.path) && !isTestFile(file.path));
}

/**
 * Applies every rule. `repo` supplies reads: `head(path)` and `base(path)` file
 * text or null, `headFiles`
 * (tracked paths at head), `importerCounts(paths)` (non-test files importing each) and optional `generatedFiles`
 * (head paths the repository marks `linguist-generated`); a generator header is read through `head` and `base`.
 */
export function evaluateDiff(changedFiles, changeLog, repo, phase = "pull-request") {
  // One predicate for every rule: build output repeats its hand-written source, which carries any finding; the build
  // lanes byte-check the output. duplicate-helper skips only linguist-generated files (isGeneratedFile).
  const files = changedFiles.filter((file) => !isGeneratedFile(repo, file.path));
  const blocking = [];
  const requiredTests = [];
  const requiredChecks = [];
  const logged = (prefix, file) => changeLog.split("\n").some((line) => line.includes(prefix) && (file === undefined || line.includes(file)));
  const add = (rule, file, line, problem, fix) => blocking.push({ rule, file, line, problem, fix });
  const live = files.filter((file) => file.status !== "D");

  if (repo.rules?.migrations) checkMigrations(live, repo, logged, add, requiredChecks);
  const newMigrations = live.filter((file) => file.status === "A" && migrationId(file.path)).map((file) => ({ path: file.path, sql: repo.head(file.path) ?? "" }));
  for (const problem of migrationProblems(newMigrations, changeLog, (file) => repo.headFiles.includes(file) || repo.head(file) !== null)) {
    add("migration-test", problem.slice(0, problem.indexOf(":")), 1, problem.slice(problem.indexOf(":") + 2), "add the test (and the measured scale test for per-row work) and record it; vibe-environment-worker runs migration-publish.mjs before every push");
  }
  const rules = repo.rules ?? compileDiffRules(null);
  const shared = rules.sharedPaths
    ? live.filter((file) => file.status === "M" && rules.sharedPaths.test(file.path) && !logged("Shared path:", file.path)) : [];
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
    if (rules.activityCapture) checkActivityCapture(file, head, logged, add, rules.activityCapture);
    checkTransactions(file, head, add);
    checkLinkDeletes(file, head, add);
  }
  checkHighRiskBatchChanges(live, changeLog, repo, add, requiredTests);
  checkOwnerTestRules(live, changeLog, repo, add, requiredTests);
  if (rules.desktopLane) checkDesktopLane(live, repo, logged, add, rules);
  checkTicketedComments(files, repo, logged, add, rules);
  checkCommentRules(live, repo, add);
  checkStories(live, files, repo, logged, add);
  checkFrozenRenders(files, repo, changeLog, add);
  checkLostStoryIds(files, repo, logged, add);
  checkCopyProvenance(live, files, repo, logged, add);
  checkNewControls(live, files, changeLog, add, rules);
  checkSharedCapabilityOwners(live, changeLog, repo, add, rules);
  for (const problem of visualBaselineLedgerProblems(changeLog, live.filter((file) => isVisualBaseline(file.path)).map((file) => file.path))) {
    const file = problem.slice(0, problem.indexOf(":"));
    add("visual-baseline-ledger", file, 1, problem.slice(problem.indexOf(":") + 2), "compare the baseline diff with the requirement inventory; record its counted `Baseline inventory:` and one cited `Baseline element:` line per new element");
  }
  checkCapabilityRemovals(live, files, repo, logged, add);
  checkSpecChanges(files, changeLog, add);
  const flagRetirements = checkFlagRetirement(files, repo, changeLog, add);
  checkRestoredRemovalsDeepening(live, files, repo, changeLog, add);
  checkComparators(live, repo, logged, add, changeLog, phase);
  checkUnusedExports(live, repo, logged, add);
  checkDuplicateHelpers(changedFiles.filter((file) => file.status !== "D" && !isGeneratedFile(repo, file.path, { header: false })), repo, add);
  checkStorybookRules(files, repo, logged, add);
  requiredTests.push(...routeSpecs(live, repo), ...gridParityTests(files, repo, add), ...sidebarOrderTests(files, repo), ...pathGateTests(live, (file) => repo.head(file)), ...storybookRuleTests(files, (file) => repo.head(file)), ...sharedComponentTests(live, repo, logged, add));
  return { ok: blocking.length === 0, blocking, requiredTests, requiredChecks, ...(flagRetirements.length ? { flagRetirements } : {}) };
}

/** Consolidated transactions and user-id set transforms need measured, mutation-backed evidence before review. */
function checkHighRiskBatchChanges(files, changeLog, repo, add, requiredTests) {
  const source = files.filter((file) => SOURCE_FILE.test(file.path) && !isTestFile(file.path));
  const addedText = source.flatMap((file) => file.added.map((entry) => entry.text)).join("\n");
  const transaction = source.find((file) => file.added.some((entry) => /\bwithDb\.tx\(/.test(entry.text))
    && /\b(?:updateMany|createMany|deleteMany|\$executeRaw)\b/.test(repo.head(file.path) ?? ""));
  if (transaction && BATCH_LIMIT_SIGNAL.test(addedText)) {
    const record = TRANSACTION_SCALE_RECORD.exec(changeLog);
    if (!record || record[1] !== transaction.path || repo.head(record[2]) === null) {
      add("transaction-scale", transaction.path, transaction.added.find((entry) => /\bwithDb\.tx\(/.test(entry.text))?.line ?? 1,
        "consolidates batch work into one transaction without measured limit, duration, effective timeout, ambient-timeout and lock-hold evidence",
        "measure the documented batch limit before review and record `Transaction scale: <file>: limit <n>; duration <ms>; timeout <ms>; ambient timeout honored|ignored; lock hold <ms>; test <path>`");
    } else {
      requiredTests.push({ path: record[2], reason: `transaction scale evidence for ${transaction.path}` });
    }
  }
  const inputSetRecords = [...changeLog.matchAll(INPUT_SET_RECORD)];
  for (const file of source) {
    const code = file.added.filter((entry) => !COMMENT_LINE.test(entry.text));
    const transform = code.find((entry, index) => SET_TRANSFORM_SIGNAL.test(entry.text)
      && code.slice(index, index + 3).some((next) => next.line - entry.line <= 2 && ID_COLLECTION_SIGNAL.test(next.text)));
    if (!transform) continue;
    const record = inputSetRecords.find((match) => match[1] === file.path && repo.head(match[2]) != null);
    if (!record) {
      add("input-set-proof", file.path, transform.line,
        "adds set, dedupe, normalization or collapse logic over a user-supplied id collection without order and normalization evidence",
        "test order permutations plus case, duplicates and whitespace, then record `Input set: <file>: order permutations; case; duplicates; whitespace; test <path>`");
    } else {
      requiredTests.push({ path: record[2], reason: `input set evidence for ${file.path}` });
    }
  }
}

/** Repository-owned UI bug rules must stay source-bound and cover every mounted shell. */
function checkOwnerTestRules(files, changeLog, repo, add, requiredTests) {
  const rules = repo.rules?.ownerTestRules;
  if (!rules || !rules.bugSignal.test(changeLog) || !files.some((file) => rules.paths.test(file.path))) return;
  for (const requirement of rules.requirements) {
    const source = repo.base(requirement.owner) ?? "";
    if (!source.includes(requirement.sentence)) {
      add("owner-test-rule-source", requirement.owner, 1,
        `the provider's owner test rule no longer matches its source sentence: ${requirement.sentence}`,
        "update the provider rule from the repository owner file before relying on it");
      continue;
    }
    const added = files.find((file) => file.status === "A" && requirement.tests.test(file.path));
    const record = changeLog.split("\n").find((line) => line.includes(`Owner test: ${requirement.owner}:`));
    const recordedTest = record ? /:\s*test\s+(\S+)\s*$/.exec(record)?.[1] : null;
    if (added) requiredTests.push({ path: added.path, reason: requirement.sentence });
    else if (recordedTest && requirement.tests.test(recordedTest) && repo.head(recordedTest) !== null) {
      requiredTests.push({ path: recordedTest, reason: requirement.sentence });
    } else if (!record || !/:\s*missing tests\b/i.test(record)) {
      add("owner-test-rule", files.find((file) => rules.paths.test(file.path))?.path ?? requirement.owner, 1,
        `UI bug fix has no ${requirement.tests.source} regression E2E or Missing tests record; source: ${requirement.owner}: ${requirement.sentence}`,
        `add the required spec, or record \`Owner test: ${requirement.owner}: missing tests <shell and behavior>\``);
    }
  }
}

/**
 * Mounts the whole diff removed, and components it defines, are moved or wrapped, not newly enabled:
 * extracting a control into a shared parent counted twice, once in the parent and once in the
 * consumer that mounts it. The parent's own new controls are still checked in its file.
 */
function movedMounts(allFiles) {
  return new Set([
    ...allFiles.flatMap((file) => file.removed.flatMap((entry) => [...entry.text.matchAll(CONTROL_MOUNT)].map((match) => match[1]))),
    ...allFiles.flatMap((file) => file.added.map((entry) => DEFINED_COMPONENT.exec(entry.text)?.[1]).filter(Boolean)),
  ]);
}

function controlSignals(file, removedMounts) {
  const signals = new Map();
  for (const entry of file.added) {
    const prop = CONTROL_PROP.exec(entry.text)?.[1];
    if (prop && CONTROL_TERM.test(prop)) {
      signals.set(prop, entry.line);
    }
    for (const match of entry.text.matchAll(CONTROL_MOUNT)) {
      if (CONTROL_TERM.test(match[1]) && !removedMounts.has(match[1])) {
        signals.set(`<${match[1]}>`, entry.line);
      }
    }
  }
  return signals;
}

/** A newly wired control needs a cited criterion or ruling that names it on this surface. */
function checkNewControls(files, allFiles, changeLog, add, { criterionSource }) {
  const moved = movedMounts(allFiles);
  for (const file of files.filter((entry) => COPY_FILE.test(entry.path) && !isTestFile(entry.path) && !STORY_FILE.test(entry.path))) {
    for (const [signal, line] of controlSignals(file, moved)) {
      const prefix = `Control: ${file.path}: ${signal}:`;
      const record = changeLog.split("\n").find((entry) => entry.trimStart().startsWith(prefix));
      const cited = new RegExp(String.raw`^\s*[^:\n]+:\s*(?:${criterionSource}\s+(?:AC(?:-?\d+)?|acceptance criterion|ruling)\b|operator ruling\b)`, "i");
      if (!record || !cited.test(record.slice(record.indexOf(prefix) + prefix.length))) {
        add("control-provenance", file.path, line, `newly enables ${signal} with no surface-specific ticket acceptance criterion or ruling`, `remove it, or record \`Control: ${file.path}: ${signal}: <surface>: <ticket AC or ruling that names this control on that surface>\`; "preserve" in another mode is not authorization`);
      }
    }
  }
}

/** Import declarations with their original exported names and one-based line range. */
function componentImports(source) {
  const imports = [];
  const lineOf = lineIndex(source);
  for (const match of source.matchAll(IMPORT_DECLARATION)) {
    const clause = match[1].trim();
    if (clause.startsWith("type ")) continue;
    const names = [];
    const named = /\{([\s\S]*?)\}/.exec(clause)?.[1];
    if (named) {
      for (const item of named.split(",")) {
        if (/^type\s/.test(item.trim())) continue;
        const original = item.trim().split(/\s+as\s+/)[0];
        if (original) names.push(original);
      }
    }
    const defaultName = clause.split(/[,{]/)[0].trim();
    if (defaultName && !defaultName.startsWith("*")) names.push(defaultName);
    const start = lineOf(match.index);
    const end = start + match[0].split("\n").length - 1;
    imports.push({ source: match[2], names, start, end });
  }
  return imports;
}

/**
 * A low-level capability newly composed by a second page adapter is visible
 * in the import graph. It belongs behind one parent unless a human explicitly
 * rules that the pages need separate compositions. Only a page that did not
 * compose it on the base counts, and never a type or a primitive's leaf part:
 * one more menu item on a page that already had the menu once demanded a
 * repo-wide refactor.
 */
function checkSharedCapabilityOwners(files, changeLog, repo, add, { slugSource }) {
  const checked = new Set();
  for (const file of files.filter((entry) => isPageComposer(entry.path) && !isTestFile(entry.path) && !STORY_FILE.test(entry.path))) {
    const addedLines = new Set(file.added.map((entry) => entry.line));
    const baseImports = componentImports(repo.base(file.oldPath ?? file.path) ?? "");
    const composedOnBase = (source, name) => baseImports.some((entry) => entry.source === source && entry.names.includes(name));
    for (const imported of componentImports(repo.head(file.path) ?? "").filter((entry) => DESIGN_SYSTEM_CONTROL.test(entry.source))) {
      const changedImport = [...addedLines].some((line) => line >= imported.start && line <= imported.end);
      const changedNames = imported.names.filter((name) =>
        CAPABILITY_COMPONENT.test(name) && !PRIMITIVE_LEAF.test(name) && !composedOnBase(imported.source, name)
        && (changedImport || file.added.some((entry) => new RegExp(`<${escapeRegExp(name)}\\b`).test(entry.text)))
      );
      for (const name of changedNames) {
        const key = `${imported.source}:${name}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const composers = repo.wordFiles(name).filter((candidate) =>
          isPageComposer(candidate) && !isTestFile(candidate) && !STORY_FILE.test(candidate) &&
          componentImports(repo.head(candidate) ?? "").some((entry) => entry.source === imported.source && entry.names.includes(name))
        );
        if (composers.length < 2) continue;
        const exception = new RegExp(String.raw`^\s*(?:[-*]\s+)?Shared capability exception:\s*${escapeRegExp(name)}:\s*(?:${slugSource}\s+ruling\b|operator ruling\b)`, "im");
        if (exception.test(changeLog)) continue;
        const line = file.added.find((entry) => entry.line >= imported.start && entry.line <= imported.end)?.line ?? imported.start;
        add("shared-capability-owner", file.path, line, `${name} is composed directly by ${composers.length} page-level adapters instead of one shared parent`, `move ${name} into one shared parent and make every consumer inherit it; only an explicit ruling for separate compositions may record \`Shared capability exception: ${name}: <ticket ruling or operator ruling>\``);
      }
    }
  }
}

function checkMigrations(files, repo, logged, add, requiredChecks) {
  const { migrations } = repo.rules;
  let touched = false;
  for (const file of files) {
    const match = migrations.server?.exec(file.path);
    if (!match && !migrations.desktop?.test(file.path)) {
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
    requiredChecks.push(...migrations.checks.map(({ command, reason }) => ({ command, reason })));
  }
}

function headWindow(head, line) {
  return head.split("\n").slice(line - 1, line - 1 + WINDOW).join("\n");
}

function checkActivityCapture(file, head, logged, add, { fix }) {
  if (CAPTURE_CALL.test(head) || logged("Activity capture:", file.path)) {
    return;
  }
  for (const entry of file.added) {
    if (ARTIFACT_WRITE.test(entry.text) && CAPTURED_FIELD.test(headWindow(head, entry.line))) {
      add("activity-capture", file.path, entry.line, "writes a captured artifact field with no capture call in the file", fix);
    }
  }
}

/** Line ranges (1-based, inclusive) of each `withDb.tx(` callback body in `head`. */
export function transactionBodies(head) {
  const bodies = [];
  const lineAt = lineIndex(head);
  for (const open of head.matchAll(TX_OPEN)) {
    const start = head.indexOf("{", open.index);
    if (start < 0) {
      continue;
    }
    let depth = 0;
    for (let index = start; index < head.length; index += 1) {
      depth += head[index] === "{" ? 1 : head[index] === "}" ? -1 : 0;
      if (depth === 0) {
        bodies.push([lineAt(start), lineAt(index)]);
        break;
      }
    }
  }
  return bodies;
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

function checkDesktopLane(files, repo, logged, add, { desktopLane: lane, migrations }) {
  const movedFromBase = (file) => {
    const lines = file.added.map((entry) => entry.text.trim()).filter((text) => text && !COMMENT_LINE.test(text));
    return lines.length >= 3 && lines.every((text) => repo.baseContains(text));
  };
  const ruledNotLane = (file) => {
    if (!logged("Synchronizing-susan: not a sync lane")) return false;
    const token = path.posix.basename(file.path).replace(/\.[^.]+$/, "");
    const roster = `${repo.head(lane.roster) ?? ""}\n${repo.base(lane.roster) ?? ""}`;
    const rostered = roster.includes(file.path) || roster.includes(token);
    const importedBySync = repo.wordFiles(token).some((candidate) => candidate.startsWith(lane.importPrefix));
    return !rostered && !importedBySync;
  };
  const laneFiles = files.filter((file) => file.status === "A" && lane.files.test(file.path) && !isTestFile(file.path)
    && !movedFromBase(file) && !ruledNotLane(file));
  const syncTables = files
    .filter((file) => file.status === "A" && migrations?.desktop?.test(file.path))
    .flatMap((file) => [...(repo.head(file.path) ?? "").matchAll(SQL_CREATE_TABLE)].map((found) => ({ file: file.path, table: found[1] })))
    .filter((entry) => SYNC_TABLE.test(entry.table));
  if (laneFiles.length === 0 && syncTables.length === 0) {
    return;
  }
  const where = laneFiles[0]?.path ?? syncTables[0].file;
  if (!logged("Synchronizing-susan:")) {
    add("desktop-sync-lane", where, 1, "adds a Desktop sync lane without a recorded synchronizing-susan pass", "run the repo's synchronizing-susan agent and record `Synchronizing-susan: <verdict and findings>`");
  }
  if (laneFiles.length > 0 && !laneFiles.some((file) => lane.giveUpImport.test(repo.head(file.path) ?? ""))) {
    add("desktop-sync-lane", where, 1, lane.giveUpProblem, lane.giveUpFix);
  }
  for (const file of laneFiles) {
    for (const entry of file.added.filter((item) => HAND_ROLLED_BACKOFF.test(item.text))) {
      add("desktop-sync-lane", file.path, entry.line, "hand-rolls an exponential backoff", lane.backoffFix);
    }
  }
  if (syncTables.length > 0 && !logged(`Engineering needed (forbidden path): ${lane.roster}`)) {
    add("desktop-sync-lane", syncTables[0].file, 1, `new sync table ${syncTables[0].table} is not on the lane roster`, `record \`Engineering needed (forbidden path): ${lane.roster}; why: the lane roster names the new lane\``);
  }
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

function checkTicketedComments(files, repo, logged, add, { ticketed }) {
  const addedLines = files.flatMap((file) => file.added);
  const addedComments = addedLines.filter((entry) => COMMENT_LINE.test(entry.text));
  const carried = new Set(addedComments.map((entry) => commentBody(entry.text)));
  const tokens = new RegExp(ticketed.source, "g");
  const carriedTokens = new Set(addedComments.flatMap((entry) => entry.text.match(tokens) ?? []));
  const addedTexts = new Set(addedLines.map((entry) => entry.text.trim()));
  for (const file of files.filter((entry) => entry.status !== "D" && SOURCE_FILE.test(entry.path))) {
    for (const entry of file.removed) {
      const body = commentBody(entry.text);
      const ticket = ticketed.exec(entry.text)?.[0];
      if (COMMENT_LINE.test(entry.text) && ticket && !carried.has(body) && !carriedTokens.has(ticket) && !logged("Comment removed:", file.path)
        && explainedCodeSurvives(file, entry, repo.base(file.oldPath ?? file.path) ?? "", addedTexts)) {
        add("ticketed-comment", file.oldPath ?? file.path, entry.line, `removes a comment citing ${ticket} that no added line carries`, "keep the comment with the code it explains, or record `Comment removed: <path>: <slug or URL>: <what the change made false>`");
      }
    }
  }
}

function checkStories(files, allFiles, repo, logged, add) {
  const versionFile = repo.rules?.storybook?.versionFile;
  const versionChanged = allFiles.some((file) => file.path === versionFile && file.added.some((entry) => entry.text.includes('"version"')));
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

/**
 * Every frozen v1.0 story on the base whose rendered dependency closure (its
 * file and everything it imports, transitively) the diff changed. Its render
 * and play against main must be identical, so a change needs the recorded
 * evidence; a byte-identical story file is not enough. Edits to the story file
 * itself are the inventory's `v1Stories` and `compileOnlyV1Repairs`.
 */
function checkFrozenRenders(files, repo, changeLog, add) {
  // A ticket-authorized move or retirement is no longer frozen, so its render is not held to main's.
  const stories = repo.frozenStories().filter((story) => !repo.frozenStoryMoves?.has(story));
  if (stories.length === 0) {
    return;
  }
  if (Object.keys(repositoryLayout() ?? {}).length === 0) {
    add("frozen-render", stories[0], 1, "no vibe provider layout is bound; selection cannot be computed", "bind the session's vibe provider, then run the inventory again");
    return;
  }
  const affected = frozenAffectedStoryFiles({ changed: files, stories, baseFiles: repo.baseFiles, headFiles: new Set(repo.headFiles),
    baseText: repo.base, headText: repo.head, baseBlobs: repo.baseBlobs });
  // Only the shipped driver's line counts; a hand-rolled capture skipped real play completion.
  // It counts story files, as `affected` does; their stories follow in parentheses. It names the
  // rendered states and their dependency inputs. Unrelated branch changes do not invalidate that evidence.
  const prefix = `Frozen render unchanged: all ${affected.length} story files (`;
  const current = (line) => {
    const base = FROZEN_LINE_BASE.exec(line)?.[1];
    const inputs = FROZEN_LINE_INPUTS.exec(line)?.[1];
    const exactFiles = affected.every((file) => line.includes(`--story-file ${file}`));
    const expectedStates = affected.flatMap((story) => storyIds(repo.base(story))).sort();
    const recordedStates = (FROZEN_LINE_STATES.exec(line)?.[1] ?? "").split(",").filter(Boolean).sort();
    const exactStates = expectedStates.length === recordedStates.length
      && expectedStates.every((state, index) => state === recordedStates[index]);
    return Boolean(base && inputs && exactFiles && exactStates) && repo.frozenInputs(base, affected) === inputs;
  };
  const recorded = changeLog.split("\n").some((line) => line.includes(prefix) && line.includes(": frozen-render.mjs ") && current(line));
  if (affected.length && !recorded) {
    add("frozen-render", affected[0], 1, `${affected.length} frozen v1.0 story files render files this diff changed: ${affected.join(", ")}`, `run handoff's scripts/frozen-render-gate.mjs as its own shell step, never a capture of your own; on FROZEN PASS it records the \`Frozen render unchanged\` line itself, on FROZEN BLOCK keep the frozen renders unchanged; rerun it only when qa-impact.mjs names one of these story states or its dependency inputs changed`);
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
 * docs, agent files or stories blocks; in docs and agent files, which the
 * session may not edit, a recorded `Engineering needed (forbidden path)` line
 * for the file clears it.
 */
function checkLostStoryIds(files, repo, logged, add) {
  const still = new Set(files.filter((file) => file.status !== "D" && STORY_FILE.test(file.path)).flatMap((file) => storyIds(repo.head(file.path))));
  for (const file of files.filter((entry) => entry.status !== "A" && STORY_FILE.test(entry.oldPath ?? entry.path))) {
    const baseText = repo.base(file.oldPath ?? file.path);
    const lost = storyIds(baseText).filter((id) => !still.has(id));
    const headTitle = file.status === "D" ? null : storyMetaTitle(repo.head(file.path) ?? "");
    const retitled = headTitle !== null && headTitle !== storyMetaTitle(baseText ?? "");
    if (lost.length && !retitled && !repo.storyReplacements.has(file.path) && !repo.frozenStoryMoves?.has(file.oldPath ?? file.path)) {
      add("lost-story-id", file.path, 1, `loses story IDs ${lost.join(", ")}`, "keep the title and export names, or record the file as a sibling replacement's entry (`vibe-sessions.mjs story-replacement`)");
    }
    for (const id of lost) {
      for (const hit of repo.filesNaming(id)) {
        // A session may not edit docs or agent files, so there the engineering line stands in for the edit.
        if ((repo.rules ?? compileDiffRules(null)).docs.some((folder) => hit.startsWith(folder)) || FORBIDDEN_REFERENCE.test(path.basename(hit))) {
          if (!logged("Engineering needed (forbidden path):", hit)) {
            add("lost-story-id", hit, 1, `still names the removed or renamed story ID ${id}`, `the session may not edit this file: record \`Engineering needed (forbidden path): ${hit}; why: point it at the story's current ID instead of ${id}\``);
          }
          continue;
        }
        add("lost-story-id", hit, 1, `still names the removed or renamed story ID ${id}`, "point it at the story's current ID");
      }
    }
  }
}

/** Changed lines inside a breadcrumb builder matter even when they only alter a target href. */
function changedBreadcrumbBuilder(file, repo) {
  const inBuilder = (source, changes) => {
    if (!source || !changes.length) return false;
    const ranges = [];
    let start = null;
    for (const [index, line] of source.split("\n").entries()) {
      if (start === null && BREADCRUMB_BUILDER.test(line)) start = index + 1;
      if (start !== null && /^}\s*;?\s*$/.test(line)) {
        ranges.push([start, index + 1]);
        start = null;
      }
    }
    return changes.some((entry) => ranges.some(([first, last]) => entry.line >= first && entry.line <= last));
  };
  return inBuilder(repo.head(file.path), file.added) || inBuilder(repo.base(file.oldPath ?? file.path), file.removed);
}

/**
 * The provider's host parity tests (a shared grid table's and an Issue breadcrumb's) read other files' source, so
 * the graph never maps them. None without a provider naming them.
 */
export function gridParityTests(files, repo, add = () => {}) {
  const parity = repo.rules?.hostParity;
  if (!parity) return [];
  const touched = files.some((file) => parity.gridTable.test(file.path) || [...file.added, ...file.removed].some((entry) => parity.gridSymbol.test(entry.text)));
  const breadcrumbFiles = files.filter((file) => parity.breadcrumbPaths.test(file.path)
    && ([...file.added, ...file.removed].some((entry) => BREADCRUMB_SIGNAL.test(entry.text))
      || (file.path === parity.headerFile
        && [...file.added, ...file.removed].some((entry) => parity.headerInput.test(entry.text))
        && [repo.head(file.path), repo.base(file.oldPath ?? file.path)].some((source) => parity.headerUse.test(source ?? "")))
      || changedBreadcrumbBuilder(file, repo)));
  const addedFiles = files.filter((file) => file.status !== "D").map((file) => file.path);
  const present = (file) => (repo.headFiles.includes(file) || addedFiles.includes(file)) && repo.head(file) != null;
  if (breadcrumbFiles.length && !present(parity.issueDetailTest)) {
    for (const file of breadcrumbFiles) {
      add("host-parity-missing", file.path, file.added[0]?.line ?? 1,
        "changes the Issue breadcrumb model without a shared web and Desktop host parity test",
        `add ${parity.issueDetailTest} with one fixture checking both host trails and navigation targets`);
    }
  }
  const selected = [...(touched ? [parity.gridTest, ...[...repo.headFiles, ...addedFiles].filter((file) => parity.hostTests.test(file))] : []),
    ...(breadcrumbFiles.length ? [parity.issueDetailTest] : [])];
  return [...new Set(selected)]
    .filter(present)
    .map((file) => ({ path: file, reason: breadcrumbFiles.length && file === parity.issueDetailTest
      ? parity.issueDetailReason
      : parity.gridReason }));
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
 * In a shallow clone a removal older than the shallow boundary is invisible, so while a lookup finds
 * nothing the history is deepened step by step (`repo.deepen`) and the check reruns. It blocks only
 * when a fetch fails, with git's reason.
 */
function checkRestoredRemovalsDeepening(files, allFiles, repo, changeLog, add) {
  let findings = [];
  const collect = (...finding) => findings.push(finding);
  let unresolved = checkRestoredRemovals(files, allFiles, repo, changeLog, collect);
  let failure = null;
  for (let attempt = 0; unresolved > 0 && repo.shallow() && failure === null; attempt += 1) {
    const step = attempt < DEEPEN_STEPS.length ? repo.deepen() : { ok: false, reason: "the clone is still shallow after every step" };
    if (step.ok) {
      findings = [];
      unresolved = checkRestoredRemovals(files, allFiles, repo, changeLog, collect);
    } else {
      failure = step.reason;
    }
  }
  if (failure !== null) {
    collect("restored-removal", files[0].path, 1, `the clone is shallow and deepening it failed (${failure}), so a removal older than its shallow boundary is invisible to this check`, "for the writer: fix the fetch (network, remote or credentials) and rerun, or run `git fetch --unshallow` in the worktree; never a step for the person");
  }
  findings.forEach((finding) => add(...finding));
}

/**
 * A component mounted again, or a file added back, that a base commit removed needs a human's restore
 * authorization naming the removal it overrides. Only a removal from the same file counts (a deleted
 * module comes back as an added file): a removal anywhere in the repo blamed every new mount of a
 * common component on an unrelated cleanup. Returns how many history lookups found no removal.
 */
function checkRestoredRemovals(files, allFiles, repo, changeLog, add) {
  const { slugSource } = repo.rules ?? compileDiffRules(null);
  const authorized = (name) => new RegExp(String.raw`^\s*(?:[-*]\s+)?Restore authorization:\s*${escapeRegExp(name)}:\s*(?:operator ruling|[A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)+),\s*\d{4}-\d{2}-\d{2},\s*[^;\n]+;\s*overrides\s+${slugSource}`, "m").test(changeLog);
  const removed = new Set(allFiles.flatMap((file) => file.removed.flatMap((entry) => [...entry.text.matchAll(JSX_MOUNT)].map((match) => match[1]))));
  let checked = 0;
  let unresolved = 0;
  for (const file of files.filter((entry) => COPY_FILE.test(entry.path) && !isTestFile(entry.path) && !STORY_FILE.test(entry.path))) {
    if (file.status === "A" && !authorized(file.path) && checked++ < RESTORE_LIMIT) {
      const removal = repo.deletionOf(file.path);
      unresolved += removal ? 0 : 1;
      if (removal) {
        add("restored-removal", file.path, 1, `adds back a file deleted by ${removal}`, `remove it, or record \`Restore authorization: ${file.path}: <human name or operator ruling>, <YYYY-MM-DD>, <where>; overrides <removal ticket>\``);
      }
    }
    // An added file has no history of its own; a file deleted and added back is the finding above.
    if (file.status === "A") continue;
    const before = repo.base(file.path) ?? "";
    // A shared primitive is mounted everywhere and unmounted by every cleanup, so mounting one is never a restore.
    const primitives = new Set(componentImports(repo.head(file.path) ?? "").filter((entry) => DESIGN_SYSTEM_CONTROL.test(entry.source)).flatMap((entry) => entry.names));
    const mounted = new Set(file.added.flatMap((entry) => [...entry.text.matchAll(JSX_MOUNT)].map((match) => match[1])));
    for (const name of [...mounted].filter((item) => !before.includes(`<${item}`) && !removed.has(item) && !primitives.has(item) && !authorized(item))) {
      if (checked++ >= RESTORE_LIMIT) {
        return unresolved;
      }
      const removal = repo.unmountOf(name, file.path);
      unresolved += removal ? 0 : 1;
      if (removal) {
        const line = file.added.find((entry) => entry.text.includes(`<${name}`))?.line ?? 1;
        add("restored-removal", file.path, line, `mounts ${name}, removed by ${removal}`, `find that removal's ticket and its human ruling; remove the mount, or record \`Restore authorization: ${name}: <human name or operator ruling>, <YYYY-MM-DD>, <where>; overrides <removal ticket>\``);
      }
    }
  }
  return unresolved;
}

/**
 * A component mount or a user-visible string the base ships that the diff takes away, and adds nowhere
 * else, needs the human source that retires it: matching a prototype once dropped a shipped menu item.
 */
function checkCapabilityRemovals(files, allFiles, repo, logged, add) {
  const added = allFiles.flatMap((file) => file.added.map((entry) => entry.text)).join("\n");
  for (const file of files.filter((entry) => COPY_FILE.test(entry.path) && !isTestFile(entry.path) && !STORY_FILE.test(entry.path))) {
    const head = repo.head(file.path) ?? "";
    const seen = new Set();
    for (const entry of file.removed) {
      const mounts = [...entry.text.matchAll(JSX_MOUNT)].map((match) => match[1])
        .filter((name) => !added.includes(`<${name}`) && !new RegExp(`<${name}\\b`).test(head))
        .map((name) => ({ key: name, what: `the ${name} mount` }));
      const strings = copyLiterals(entry.text).filter((text) => !added.includes(text) && !head.includes(text))
        .map((text) => ({ key: `"${text}"`, what: `"${text}"` }));
      for (const { key, what } of [...mounts, ...strings].filter((item) => !seen.has(item.key) && !logged(`Removal: ${item.key}:`))) {
        seen.add(key);
        add("capability-removal", file.path, 1, `removes ${what} that the base ships, with no recorded human source`, `keep it, or record \`Removal: ${key}: <ticket, PRD or human ruling that retires it>\`; matching a prototype or design is not a source`);
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
  const order = repo.rules?.storybook;
  if (!order) return [];
  const touched = files.some((file) => order.sidebarOrderFiles.has(file.path) || (STORY_FILE.test(file.path)
    && (file.status !== "M" || [...file.added, ...file.removed].some((entry) => STORY_TITLE.test(entry.text)))));
  return touched
    ? order.sidebarOrderTests.filter((test) => repo.headFiles.includes(test)).map((test) => ({ path: test, reason: "the sidebar order or a story title changed" }))
    : [];
}

function untrackedAsAdded(worktree, planPrefix) {
  return git(worktree, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)
    .filter((file) => !isLocalPlanPath(file, planPrefix))
    .map((file) => ({
      path: file,
      oldPath: null,
      status: "A",
      added: readFileSync(path.join(worktree, file), "utf8").split("\n").map((text, index) => ({ line: index + 1, text })),
      removed: [],
    }));
}

/**
 * Runs every rule on the session diff. `exclude` holds paths that are not the
 * session's work (local fixes); `isFrozenStory` is the base's v1.0 predicate
 * (storybook-taxonomy.mjs, by the base's scheme); `storyReplacements` holds
 * story files recorded as a sibling replacement's entry; `frozenStoryMoves`
 * holds the base paths of ticket-authorized frozen story moves and retirements
 * (frozen-story-moves.mjs), whose own story IDs neither rule below blocks; `phase` is the
 * inventory's (only the pull-request phase writes tests); `binding` is the
 * session's provider binding, whose `recipes.diffRules` and tracker slugs the
 * repository rules read (none without one).
 */
export function runDiffRules({ worktree, base, changeLog, exclude = new Set(), isFrozenStory = () => false, storyReplacements = new Set(),
  frozenStoryMoves = new Set(), phase = "pull-request", binding = sessionBinding(worktree) }) {
  const planPrefix = localPlanPrefix(binding);
  const files = [...parseUnifiedDiff(git(worktree, ["diff", "--no-color", "--unified=0", "-M", base]), planPrefix), ...untrackedAsAdded(worktree, planPrefix)]
    .filter((file) => !exclude.has(file.path));
  const logFile = changeLog ?? path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), "vibe-changes.md");
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  const repo = gitRepo(worktree, base, isFrozenStory, storyReplacements,
    compileDiffRules(providerDataOr(binding, "recipes", "diffRules", null), binding), sessionInternalIds(worktree, log));
  return evaluateDiff(files, log, { ...repo, frozenStoryMoves }, phase);
}

/** The private row ids (decision tables, change log) the copy rules treat as session-internal. */
export function sessionInternalIds(worktree, changeLog) {
  const texts = [changeLog];
  const directory = path.dirname(localPlanPaths(worktree).decisionTable);
  try {
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".md"))) {
      texts.push(readFileSync(path.join(directory, name), "utf8"));
    }
  } catch { /* A session with no table contributes no private row ids. */ }
  return [...new Set(texts.flatMap((text) => text.match(/\b(?:DT|ROW|DEC)-[A-Za-z0-9.-]+\b/g) ?? []))];
}

/**
 * `data` (a provider's `recipes.diffRules`, or null) with its patterns compiled. A missing group is null, and the
 * rule it feeds does not run; `ticketed` is the reference a ticketed comment carries for `binding`.
 */
export function compileDiffRules(data, binding = null) {
  const pattern = (source) => (typeof source === "string" ? new RegExp(source) : null);
  const migrations = data?.migrations
    ? { server: pattern(data.migrations.server), desktop: pattern(data.migrations.desktop), checks: data.migrations.checks ?? [] } : null;
  const lane = data?.desktopLane;
  const parity = data?.hostParity;
  const ownerTests = data?.ownerTestRules;
  return {
    migrations,
    activityCapture: data?.activityCapture?.fix ? { fix: data.activityCapture.fix } : null,
    desktopLane: lane?.files ? { ...lane, files: pattern(lane.files), giveUpImport: pattern(lane.giveUpImport),
      importPrefix: typeof lane.importPrefix === "string" ? lane.importPrefix : "\0" } : null,
    sharedPaths: pattern(data?.sharedPaths),
    flagRetirementRegistry: data?.flagRetirementRegistry,
    ownerTestRules: ownerTests?.paths ? { paths: pattern(ownerTests.paths), bugSignal: pattern(ownerTests.bugSignal),
      requirements: (ownerTests.requirements ?? []).map((item) => ({ ...item, tests: pattern(item.tests) })) } : null,
    hostParity: parity?.gridTest ? { ...parity, gridTable: pattern(parity.gridTable), gridSymbol: pattern(parity.gridSymbol),
      hostTests: pattern(parity.hostTests), breadcrumbPaths: pattern(parity.breadcrumbPaths), headerInput: pattern(parity.headerInput),
      headerUse: pattern(parity.headerUse) } : null,
    storybook: data?.storybook ? { ...data.storybook, sidebarOrderFiles: new Set(data.storybook.sidebarOrderFiles ?? []),
      sidebarOrderTests: data.storybook.sidebarOrderTests ?? [] } : null,
    docs: data?.docs ?? GENERIC_DOCS,
    ticketed: ticketReference(binding),
    citations: citationPattern(binding),
    slugSource: providerDataOr(binding, "tickets", "slugSource", null) ?? GENERIC_SOURCE,
    criterionSource: providerDataOr(binding, "tickets", "criterionSource", null) ?? GENERIC_SOURCE,
  };
}

/** Whether a .jsx/.tsx file name holds a page-composer word, split at `-`, `_`, `.` and camelCase boundaries. */
export function isPageComposer(file) {
  const name = /(?:^|\/)([^/]+)\.[jt]sx$/i.exec(file)?.[1];
  if (!name) return false;
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_.\s]+/).some((word) => PAGE_COMPOSER_WORDS.has(word.toLowerCase()));
}
