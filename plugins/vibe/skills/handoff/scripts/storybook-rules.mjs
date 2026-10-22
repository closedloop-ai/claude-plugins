// Storybook rules a repository declares in `.vibe/storybook-rules.json`, for
// Storybook defects vibe pull requests merged while every repo check stayed
// green: a release that reused a version or bumped the wrong semver level, new
// stories in a frozen root, a no-op handler on an editable story, hand-rolled
// table cells, a missing controls decision hidden by a gate allowlist, a
// lifecycle tag outside its roots, a computed options list, and a story kept
// alive by a story-local copy of a deleted component. diff-rules.mjs runs them.
//
// Every repository fact lives in the declaration; a rule whose key is absent
// does not run, and a repository with no declaration runs none:
//   {"release": {"versionFile": "apps/storybook/package.json", "versionField": "version",
//                "historyFiles": ["apps/storybook/stories/start-here-version-history*"]},
//    "frozenRoots": {"titlePattern": "^[^/]+ v1\\.0/", "tags": ["deprecated"]},
//    "tagRoots": {"preview": "(^|/)Labs(/|$)"},
//    "noOpHandler": {"pattern": "\\bonUpdate\\w*:\\s*\\(\\)\\s*=>\\s*undefined", "exemptPaths": []},
//    "handRolledCells": {"patterns": ["<td\\b"], "canonical": "TableTextCell from ..."},
//    "controlsDecision": {"comment": "No controls:", "exemptTags": ["deprecated"], "allowlist": "..."},
//    "literalOptions": true,
//    "storySupportPaths": ["apps/storybook/stories/**"],
//    "checks": [{"name": "validate-catalog", "command": "pnpm ...", "paths": ["..."]}]}
// Paths are path-gates.mjs globs. `checks` become required tests whose path is
// the command when a story file or a listed path changes, so the evidence gate
// needs a passing run of each on the published commit.

import path from "node:path";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { pathMatcher } from "./path-gates.mjs";
import { escapeRegExp, SOURCE_FILE } from "./source-imports.mjs";
import { storyExportNames, storyMetaTags, storyMetaTitle } from "./storybook-taxonomy.mjs";

export const STORYBOOK_RULES_FILE = ".vibe/storybook-rules.json";

const STORY_FILE = /\.stories\.[jt]sx?$/;
const DEFAULT_SUPPORT_PATH = /(?:^|\/)(?:stories|storybook)\//;
const META_START = /\b(?:const\s+meta\b[^=]*=|export\s+default)\s*\{/;
const META_COMPONENT = /\bcomponent:\s*[A-Za-z_$]/;
const ARG_TYPES = /\bargTypes\s*:/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const HISTORY_VERSION = /\bversion:\s*(["'`])(\d+\.\d+\.\d+)\1/g;
const OPTIONS = /\boptions:\s*(\S.*)$/;
const LITERAL_OPTIONS = /^\[\s*(?:["'`\d\]-]|true\b|false\b|null\b|$)/;
const LIST_CONTROL = /\bcontrol\s*:\s*(?:\{[^{}]*?\btype\s*:\s*)?["'`](?:select|multi-select|radio|inline-radio|check|inline-check)["'`]/;
const ARG_TYPES_KEY = /\bargTypes\s*[:=]\s*$/;
const TAG_LIST = /\btags:\s*\[([^\]]*)\]/g;
const STRING_LITERAL = /(["'`])((?:(?!\1).)*)\1/g;
const EXPORTED_NAME = /\bexport\s+(?:default\s+)?(?:function|const|class)\s+([A-Z][\w$]*)/g;
const LEVELS = ["patch", "minor", "major"];
const LISTED = 4;

/** The parsed declaration from `read` (null when absent), or `{problem}` when it cannot be used. */
export function readStorybookRules(read) {
  const text = read(STORYBOOK_RULES_FILE);
  if (text === null || text === undefined) {
    return null;
  }
  try {
    const raw = JSON.parse(text);
    const regex = (source) => (typeof source === "string" ? new RegExp(source) : null);
    return {
      config: {
        ...raw,
        frozenTitle: regex(raw.frozenRoots?.titlePattern),
        tagRootPatterns: Object.entries(raw.tagRoots ?? {}).map(([tag, source]) => [tag, regex(source)]),
        noOp: regex(raw.noOpHandler?.pattern),
        cells: (raw.handRolledCells?.patterns ?? []).map(regex),
        supportPaths: Array.isArray(raw.storySupportPaths) ? raw.storySupportPaths.map(pathMatcher) : null,
      },
    };
  } catch (error) {
    return { problem: `${STORYBOOK_RULES_FILE} cannot be used (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** Blocking findings for the declared rules; `repo` reads `head`, `base`, `headFiles` and `baseFiles`. */
export function checkStorybookRules(files, repo, logged, add) {
  const loaded = readStorybookRules(repo.head);
  if (loaded === null) {
    return;
  }
  if (loaded.problem) {
    add("storybook-rules", STORYBOOK_RULES_FILE, 1, loaded.problem, "fix the declaration so its Storybook rules run");
    return;
  }
  const { config } = loaded;
  const stories = files.filter((file) => STORY_FILE.test(file.path) || STORY_FILE.test(file.oldPath ?? ""));
  const live = stories.filter((file) => file.status !== "D");
  if (config.release) {
    checkRelease(files, stories, repo, config.release, logged, add);
  }
  for (const file of live) {
    const head = repo.head(file.path) ?? "";
    const base = file.status === "A" ? "" : repo.base(file.oldPath ?? file.path) ?? "";
    checkFrozenAdditions(file, head, base, config, logged, add);
    checkAddedLines(file, head, config, logged, add);
    checkControlsDecision(file, head, config.controlsDecision, logged, add);
    checkTagRoots(file, head, config.tagRootPatterns, logged, add);
  }
  checkStoryCopies(files, repo, config, logged, add);
}

/** The declared checks as required tests when a story file or a listed path changed. */
export function storybookRuleTests(files, read) {
  const config = readStorybookRules(read)?.config;
  if (!Array.isArray(config?.checks)) {
    return [];
  }
  return config.checks.filter((check) => typeof check?.command === "string").flatMap((check) => {
    const matchers = (Array.isArray(check.paths) ? check.paths : []).map(pathMatcher);
    const hit = files.flatMap((file) => [file.path, file.oldPath].filter(Boolean))
      .find((file) => STORY_FILE.test(file) || matchers.some((matches) => matches(file)));
    return hit ? [{ path: check.command, reason: `${check.name ?? "a Storybook check"} in ${STORYBOOK_RULES_FILE}: ${hit} changed; record a passing run of this command on the published commit` }] : [];
  });
}

function storyKeys(source) {
  const title = source ? storyMetaTitle(source) : null;
  return title ? storyExportNames(source).map((name) => `${title} › ${name}`) : [];
}

function titleOf(key) {
  return key.slice(0, key.lastIndexOf(" › "));
}

function bumpLevel(from, to) {
  const before = SEMVER.exec(from ?? "");
  const after = SEMVER.exec(to ?? "");
  if (!before || !after || from === to) {
    return null;
  }
  const index = [1, 2, 3].find((part) => before[part] !== after[part]);
  return Number(after[index]) > Number(before[index]) ? LEVELS[3 - index] : "downgrade";
}

function listed(keys) {
  return keys.slice(0, LISTED).join(", ") + (keys.length > LISTED ? ` and ${keys.length - LISTED} more` : "");
}

/**
 * Adding, renaming, moving, promoting or removing stories is a release: a
 * removed or renamed story ID needs a major, a new entry (title) or a changed
 * lifecycle tag a minor, a story added to an existing entry at least a patch,
 * and the release record names the new version exactly once.
 */
function checkRelease(files, stories, repo, release, logged, add) {
  if (logged("Storybook release ruling:")) {
    return;
  }
  const before = new Set();
  const after = new Set();
  let retagged = false;
  for (const file of stories) {
    const baseText = file.status === "A" ? null : repo.base(file.oldPath ?? file.path);
    const headText = file.status === "D" ? null : repo.head(file.path);
    storyKeys(baseText).forEach((key) => before.add(key));
    storyKeys(headText).forEach((key) => after.add(key));
    retagged ||= Boolean(baseText && headText) && String(storyMetaTags(baseText)) !== String(storyMetaTags(headText));
  }
  const removed = [...before].filter((key) => !after.has(key));
  const added = [...after].filter((key) => !before.has(key));
  const titles = new Set([...before].map(titleOf));
  const entries = [...new Set(added.map(titleOf))].filter((title) => !titles.has(title));
  const need = removed.length ? "major" : entries.length || retagged ? "minor" : added.length ? "patch" : null;
  const what = removed.length ? `removes or renames ${listed(removed)}`
    : entries.length ? `adds the entries ${listed(entries)}`
    : retagged ? "changes a lifecycle tag" : `adds ${listed(added)}`;
  const field = release.versionField ?? "version";
  const versionOf = (text) => {
    try {
      return JSON.parse(text ?? "")[field];
    } catch {
      return undefined;
    }
  };
  const from = versionOf(repo.base(release.versionFile));
  const to = versionOf(repo.head(release.versionFile));
  const bump = bumpLevel(from, to);
  const fix = `bump ${field} in ${release.versionFile} by a ${need} and add one release record entry for it`;
  if (need && bump === null) {
    add("storybook-release", release.versionFile, 1, `the diff ${what} with no release (${field} stays ${from})`, fix);
  } else if (need && LEVELS.indexOf(bump) < LEVELS.indexOf(need)) {
    add("storybook-release", release.versionFile, 1, `the diff ${what}, which needs a ${need} release, but ${from} -> ${to} is a ${bump}`, fix);
  }
  const history = (release.historyFiles ?? []).map(pathMatcher);
  const isHistory = (file) => history.some((matches) => matches(file));
  if (bump === null && !files.some((file) => isHistory(file.path))) {
    return;
  }
  const count = (paths, read) => {
    const counts = new Map();
    for (const file of paths.filter(isHistory)) {
      for (const match of (read(file) ?? "").matchAll(HISTORY_VERSION)) {
        counts.set(match[2], (counts.get(match[2]) ?? 0) + 1);
      }
    }
    return counts;
  };
  const headCounts = count(repo.headFiles, repo.head);
  const baseCounts = count([...repo.baseFiles], repo.base);
  const record = repo.headFiles.find(isHistory) ?? release.versionFile;
  if (bump !== null && headCounts.get(to) !== 1) {
    add("storybook-release", record, 1, `the release record has ${headCounts.get(to) ?? 0} entries for ${to}; it needs exactly one`, "add one entry for the new version, newest first");
  }
  for (const [version, total] of headCounts) {
    if (total > 1 && total > (baseCounts.get(version) ?? 0) && !(bump !== null && version === to)) {
      add("storybook-release", record, 1, `the release record reuses ${version}, which an earlier release already took`, `give this release its own version above ${to ?? from} and bump ${release.versionFile} to match`);
    }
  }
}

function isFrozen(source, frozenRoots, frozenTitle) {
  const title = storyMetaTitle(source) ?? "";
  const tags = storyMetaTags(source) ?? [];
  return Boolean(frozenTitle?.test(title)) || (frozenRoots?.tags ?? []).some((tag) => tags.includes(tag));
}

function lineOf(text, needle) {
  const index = text.indexOf(needle);
  return index < 0 ? 1 : text.slice(0, index).split("\n").length;
}

function checkFrozenAdditions(file, head, base, config, logged, add) {
  if (!config.frozenRoots || !isFrozen(head, config.frozenRoots, config.frozenTitle) || logged("Frozen story:", file.path)) {
    return;
  }
  const had = new Set(storyExportNames(base));
  const fresh = storyExportNames(head).filter((name) => !had.has(name));
  if (fresh.length) {
    add("frozen-story-added", file.path, lineOf(head, ` ${fresh[0]}`), `adds ${listed(fresh)} under the frozen ${storyMetaTitle(head)}`, "put new stories on the component's current entry (copy it out of the frozen root when it has none), or record `Frozen story: <path>: <ruling>`");
  }
}

function checkAddedLines(file, head, config, logged, add) {
  // A frozen file is restored to its earlier bytes, never edited, so its no-op handlers stay.
  const frozen = Boolean(config.frozenRoots) && isFrozen(head, config.frozenRoots, config.frozenTitle);
  const exempt = frozen || (config.noOpHandler?.exemptPaths ?? []).map(pathMatcher).some((matches) => matches(file.path));
  const starts = lineStarts(head);
  for (const entry of file.added) {
    if (config.noOp?.test(entry.text) && !exempt && !logged("Story no-op:", file.path)) {
      add("story-no-op-handler", file.path, entry.line, "wires an editable story's handler to a no-op, so the edit shows no state transition", "hold the value in story state, update it from the handler, and assert the change in the play; or record `Story no-op: <path>: <why the handler is not an edit>`");
    }
    if (config.cells.some((pattern) => pattern?.test(entry.text)) && !logged("Story table:", file.path)) {
      add("story-hand-rolled-cell", file.path, entry.line, "hand-rolls a table row or cell in a story", `render the row through the repo's grid and canonical cells (${config.handRolledCells?.canonical ?? "see the repo's table cell contract"}), or record \`Story table: <path>: <reason>\``);
    }
    const options = config.literalOptions === true ? OPTIONS.exec(entry.text) : null;
    if (options && !LITERAL_OPTIONS.test(options[1]) && isControlOptionsList(head, (starts[entry.line - 1] ?? 0) + options.index, options[1]) && !logged("Story options:", file.path)) {
      add("story-computed-options", file.path, entry.line, `a control's options are computed (${options[1].replace(/,\s*$/, "")}), so the manifest gets no literal list`, "write the options as a literal array of the values, or record `Story options: <path>: <reason>`");
    }
  }
}

function lineStarts(text) {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/** The offset of the unmatched `{` that encloses `offset`, or -1. */
function enclosingBrace(text, offset) {
  let depth = 0;
  for (let index = offset - 1; index >= 0; index -= 1) {
    depth += text[index] === "}" ? 1 : text[index] === "{" ? -1 : 0;
    if (depth < 0) {
      return index;
    }
  }
  return -1;
}

/**
 * Whether an `options:` at `offset` is a control's options list: its value is
 * not an object (a prop named `options` with `{ control: false }`), its object
 * has a sibling list control (select, radio or check), and that object sits
 * directly in `argTypes`, so a prop value under `args` never counts.
 */
function isControlOptionsList(head, offset, value) {
  if (value.startsWith("{")) {
    return false;
  }
  const open = enclosingBrace(head, offset);
  const parent = open < 0 ? -1 : enclosingBrace(head, open);
  if (parent < 0 || !ARG_TYPES_KEY.test(head.slice(Math.max(0, parent - 40), parent))) {
    return false;
  }
  let depth = 0;
  let close = open;
  while (close < head.length) {
    depth += head[close] === "{" ? 1 : head[close] === "}" ? -1 : 0;
    if (depth === 0) {
      break;
    }
    close += 1;
  }
  return LIST_CONTROL.test(head.slice(open, close + 1));
}

/** The default-exported meta object's text, by brace depth from its opening brace. */
function metaBlock(source) {
  const match = META_START.exec(source);
  if (!match) {
    return "";
  }
  const start = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    depth += source[index] === "{" ? 1 : source[index] === "}" ? -1 : 0;
    if (depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}

function checkControlsDecision(file, head, decision, logged, add) {
  if (!decision || (file.status !== "A" && !file.added.some((entry) => entry.text.trim()))) {
    return;
  }
  const comment = decision.comment ?? "No controls:";
  const tags = storyMetaTags(head) ?? [];
  if (!META_COMPONENT.test(metaBlock(head)) || ARG_TYPES.test(head) || head.includes(comment)
    || (decision.exemptTags ?? []).some((tag) => tags.includes(tag)) || logged("Story controls:", file.path)) {
    return;
  }
  const allowlist = decision.allowlist ? `; an entry in ${decision.allowlist} does not count, so delete this file's entry there` : "";
  add("story-controls-decision", file.path, lineOf(head, "component:"), "a story this diff adds or edits names a component with no controls decision", `add argTypes for the props that change what it shows, or a \`// ${comment} <reason>\` comment${allowlist}`);
}

function checkTagRoots(file, head, tagRootPatterns, logged, add) {
  const touched = file.status === "A" || file.added.some((entry) => /\b(?:tags|title):/.test(entry.text));
  if (!tagRootPatterns.length || !touched || logged("Story tag:", file.path)) {
    return;
  }
  const title = storyMetaTitle(head) ?? "";
  const storyTags = file.added.flatMap((entry) => [...entry.text.matchAll(TAG_LIST)])
    .flatMap((list) => [...list[1].matchAll(STRING_LITERAL)].map((found) => found[2]));
  const tags = new Set([...(storyMetaTags(head) ?? []), ...storyTags].filter((tag) => !tag.startsWith("!")));
  for (const [tag, roots] of tagRootPatterns.filter(([name, pattern]) => pattern && tags.has(name))) {
    if (!roots.test(title)) {
      add("story-tag-root", file.path, lineOf(head, "tags:"), `tags a story ${tag} under ${title}, outside the roots that tag is for (${roots.source})`, `use the tag the repo's taxonomy gives this root, or record \`Story tag: <path>: <ruling>\``);
    }
  }
}

/**
 * A component the diff deletes must not live on as a story-local copy: an
 * added file under the story paths that carries the deleted file's name or
 * defines one of its exported components.
 */
function checkStoryCopies(files, repo, config, logged, add) {
  const deleted = files.filter((file) => file.status === "D" && SOURCE_FILE.test(file.path) && !STORY_FILE.test(file.path) && !isTestFile(file.path));
  if (!deleted.length) {
    return;
  }
  const isSupport = (file) => (config.supportPaths ? config.supportPaths.some((matches) => matches(file)) : DEFAULT_SUPPORT_PATH.test(file));
  const added = files.filter((file) => file.status === "A" && SOURCE_FILE.test(file.path) && !isTestFile(file.path) && isSupport(file.path));
  for (const gone of deleted) {
    const stem = path.basename(gone.path).replace(/\.[^.]+$/, "");
    const names = [...(repo.base(gone.path) ?? "").matchAll(EXPORTED_NAME)].map((match) => match[1]);
    for (const copy of added.filter((file) => !logged("Story copy:", file.path))) {
      const text = repo.head(copy.path) ?? "";
      const defined = names.find((name) => new RegExp(String.raw`\b(?:function|const|class)\s+${escapeRegExp(name)}\b`).test(text));
      if (path.basename(copy.path).includes(stem) || defined) {
        add("story-local-copy", copy.path, 1, `keeps stories alive with a story-local copy of the deleted ${gone.path}${defined ? ` (${defined})` : ""}`, "remove the stories that rendered it in the same release (a major), or keep the component; or record `Story copy: <path>: <ruling>`");
      }
    }
  }
}
