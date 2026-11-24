// Checks removed imports, changed contracts, SQL ownership and keyset fixture coverage.
import path from "node:path";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { escapeRegExp, importSpecifiers, resolveImport } from "./source-imports.mjs";

const SOURCE = /\.[jt]sx?$/;
const STORY = /\.stories\.[jt]sx?$/;
const SUPPORT = /\/(?:__tests__|test-fixtures|__fixtures__|fixtures|storybook|test-support)\//;
const COMMENT = /\/\*[\s\S]*?\*\/|^[ \t]*\/\/[^\n]*/gm;
const ACTIVE_CONTRACT = /\b(?:only while|only when|otherwise|falls back|read site|routes?|opens?|calls?|uses?|requires?|flag(?:s|ged)?)\b/i;
const HISTORICAL = /\b(?:formerly|previously|retired|removed|no longer|used to|never)\b/i;
const HOOK_CALL = /\buse[A-Z]\w*\s*\(/;
const HOOK_MODULE = /^use(?:-[a-z0-9]|[A-Z])[\w.-]*\.(?:[cm]?[jt]sx?)$/;
const HOOK_DECLARATION = /^(?:export\s+)?(?:async\s+)?function\s+(use[A-Z]\w*)\s*\([^{}]*?(?:\)\s*:\s*[^{}\n]+|\))\s*\{([\s\S]*?)^}/gm;
const NAME_SQL = /\bconcat_ws\s*\(\s*'\s+'\s*,\s*(\w+)\.first_name\s*,\s*\1\.last_name\s*\)/i;
const SQL = /(?:\bPrisma\.)?\bsql\s*\x60([^\x60]+)\x60/g;

function productionModule(file) {
  return SOURCE.test(file) && !STORY.test(file) && !isTestFile(file) && !SUPPORT.test(file) && !/\.d\.ts$/.test(file);
}

function stripComments(source) {
  return source.replace(COMMENT, "");
}

function sourceLine(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function resolution(from, source, files) {
  return new Set(importSpecifiers(from, source ?? "").map((specifier) => resolveImport(from, specifier, files)).filter(Boolean));
}

/** Report an existing production module when the diff drops its last production importer. */
export function checkOrphanedModules(files, repo, add) {
  if (!repo.baseFiles || !repo.importersOf) return;
  const beforeFiles = new Set(repo.baseFiles);
  const deleted = new Set(files.filter((file) => file.status === "D").map((file) => file.path));
  const afterFiles = new Set(repo.headFiles.filter((file) => !deleted.has(file)));
  const lost = new Map();
  const changed = files.filter((file) => file.status !== "A" && (file.removed.length || file.status === "D") && productionModule(file.path));
  for (const file of changed) {
    const previousPath = file.oldPath ?? file.path;
    const previous = resolution(previousPath, repo.base(previousPath), beforeFiles);
    const current = resolution(file.path, repo.head(file.path), afterFiles);
    for (const target of previous) {
      if (!current.has(target) && afterFiles.has(target) && productionModule(target)) {
        lost.set(target, file);
      }
    }
  }
  const importers = repo.importersOf([...lost.keys()]);
  const changedSources = files.filter((file) => file.status !== "D" && productionModule(file.path)).map((file) => file.path);
  for (const [target, cause] of lost) {
    if (![...importers.get(target) ?? [], ...changedSources].some((file) => file !== target && productionModule(file)
      && resolution(file, repo.head(file), afterFiles).has(target))) {
      add("orphaned-module", target, 1, "lost its last production importer after " + cause.path + " stopped importing it",
        "remove the orphan shell or helper and its retired-only tests, or retain a real production owner");
    }
  }
}

/** Catch an old active comment that still names a branch, flag or call removed from its file. */
export function checkRetainedContractComments(files, repo, add) {
  for (const file of files.filter((entry) => entry.status !== "D" && productionModule(entry.path) && entry.removed.length)) {
    const before = repo.base(file.oldPath ?? file.path) ?? "";
    const head = repo.head(file.path) ?? "";
    const current = stripComments(head);
    const removed = file.removed.filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line.text)).map((line) => line.text).join("\n");
    const references = new Set([...removed.matchAll(/(?:\b([a-z]\w{5,})\s*\(|(["'])([a-z][\w-]*-[\w-]+)\2)/g)]
      .map((match) => match[1] ?? match[3]));
    // The old call can name a constant while the docstring names its key.
    for (const [, name] of removed.matchAll(/\b([A-Z][A-Z_0-9]*)_FEATURE_FLAG_KEY\b/g)) {
      const symbol = name + "_FEATURE_FLAG_KEY";
      if (!new RegExp("\\b" + symbol + "\\b").test(current)) references.add(name.toLowerCase().replaceAll("_", "-"));
    }
    for (const comment of head.matchAll(COMMENT)) {
      if (!before.includes(comment[0]) || !ACTIVE_CONTRACT.test(comment[0]) || HISTORICAL.test(comment[0])) continue;
      for (const [, reference] of comment[0].matchAll(/\x60([a-z]\w*(?:-[\w-]+)*)\x60/g)) {
        if (!references.has(reference) || new RegExp("(?<![\\w-])" + escapeRegExp(reference) + "(?![\\w-])").test(current)) continue;
        add("stale-behavior-comment", file.path, sourceLine(head, comment.index),
          "unchanged contract comment still names removed behavior " + reference,
          "describe the current behavior or identify the reference as historical with its exact source");
      }
    }
  }
}

/** A changed React hook declaration cannot keep its hook name after its last call disappears. */
export function checkOrphanedHookNames(files, repo, add) {
  for (const file of files.filter((entry) => entry.status !== "D" && productionModule(entry.path) && entry.removed.some(({ text }) => HOOK_CALL.test(text)))) {
    const previous = new Map([...(repo.base(file.oldPath ?? file.path) ?? "").matchAll(HOOK_DECLARATION)].map((match) => [match[1], match[2]]));
    const head = repo.head(file.path) ?? "";
    for (const match of head.matchAll(HOOK_DECLARATION)) {
      if (!HOOK_CALL.test(stripComments(previous.get(match[1]) ?? "")) || HOOK_CALL.test(stripComments(match[2]))) continue;
      add("orphaned-hook-name", file.path, sourceLine(head, match.index), match[1] + " no longer calls any React hook",
        "rename it to an ordinary function and update production and test callers");
    }
    // A hook-named module whose functions all stopped calling hooks is no longer a hook owner: its functions move to an
    // ordinary module, so the use- file name does not keep promising a hook.
    const stillHooks = [...head.matchAll(HOOK_DECLARATION)].some((match) => HOOK_CALL.test(stripComments(match[2])));
    const hadHooks = [...previous.values()].some((body) => HOOK_CALL.test(stripComments(body)));
    if (HOOK_MODULE.test(path.basename(file.path)) && hadHooks && !stillHooks) {
      add("hook-module-without-hooks", file.path, 1, path.basename(file.path) + " no longer declares a function that calls a React hook",
        "move its functions to an ordinary module named for what they do and update production and test importers");
    }
  }
}

function displayNameExpressions(source) {
  return [...(source ?? "").matchAll(SQL)].filter((match) => {
    const names = NAME_SQL.exec(match[1]);
    return names && new RegExp("\\b" + names[1] + "\\.email\\b").test(match[1]);
  });
}

/** Consolidate an added SQL person-display-name calculation with its existing owner, including empty-name handling. */
export function checkDisplayNameSqlOwners(files, repo, add) {
  if (!repo.wordFiles) return;
  const possible = files.filter((file) => productionModule(file.path) && file.status !== "D"
    && file.added.some(({ text }) => /first_name|last_name|concat_ws/.test(text)));
  if (!possible.length) return;
  const owners = repo.wordFiles("concat_ws").filter((file) => productionModule(file) && displayNameExpressions(repo.base(file)).length);
  for (const file of possible) {
    const owner = owners.find((candidate) => candidate !== file.path);
    if (!owner) continue;
    const head = repo.head(file.path) ?? "";
    const previous = new Set(displayNameExpressions(repo.base(file.oldPath ?? file.path)).map((match) => match[1]));
    for (const hit of displayNameExpressions(head).filter((match) => !previous.has(match[1]))) {
      const low = sourceLine(head, hit.index);
      const high = sourceLine(head, hit.index + hit[0].length);
      if (!file.added.some(({ line }) => line >= low && line <= high)) continue;
      add("copied-sql-name-expression", file.path, low, "duplicates the SQL name and email transformation owned by " + owner,
        "call the canonical helper and test populated, blank and null names and email fallbacks through the owning SQL boundary");
    }
  }
}

function equalKey(seed, field) {
  if (field === "Project") return /project\s*:\s*(["'])([^"']+)\1/.exec(seed)?.[2] ?? null;
  const tags = /\btags\s*:\s*\[([^\]]*)\]/.exec(seed)?.[1] ?? "";
  return [...tags.matchAll(/(["'])([^"']+)\1/g)].map((tag) => tag[2]).sort().join(" ") || null;
}

function testedTieGroups(caseText) {
  const field = /(?:DocumentListField|ListSortField)\.(Project|Tags)\b/.exec(caseText)?.[1];
  const fixture = /\bseedCorpus\s*\(\s*\[([\s\S]*?)\]\s*\)/.exec(caseText)?.[1];
  if (!field || fixture === undefined) return null;
  const records = [...fixture.matchAll(/\{([^{}]*)\}/g)];
  if (!records.length || fixture.replace(/\{[^{}]*\}|[\s,]/g, "")) return null;
  const rows = records.map((record) => equalKey(record[1], field));
  const orders = [...caseText.matchAll(/\b(?:Asc|Desc)\s*,\s*\[([\d,\s]+)\]/g)].map((match) =>
    match[1].split(",").filter((value) => value.trim()).map(Number));
  if (!orders.length || orders.some((order) => order.length !== rows.length || new Set(order).size !== rows.length
    || order.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= rows.length))) return null;
  return { rows, orders };
}

/** Compare a recoverable integration fixture's expected keyset boundaries to its actual equal-key seeds. */
export function checkTieBreakerFixtureReach(files, repo, add, requiredTests = []) {
  for (const file of files.filter((entry) => entry.status !== "D" && isTestFile(entry.path)
    && entry.added.some(({ text }) => /\b(?:keyset|tie(?:s|break)|seedCorpus|PAGE_SIZE)\b/i.test(text)))) {
    const head = repo.head(file.path) ?? "";
    const size = Number(/\bconst\s+PAGE_SIZE\s*=\s*([1-9]\d*)\s*;/.exec(head)?.[1]);
    if (!size || !/\blimit\s*:\s*PAGE_SIZE\b/.test(head)) continue;
    const cases = [...head.matchAll(/\bit\.each\s*\([\s\S]+?(?=\n\s*it(?:\.each)?\s*\(|$)/g)];
    for (const match of cases) {
      if (!/["'][^"'\n]*\bties?\b/.test(match[0])) continue;
      const fixture = testedTieGroups(match[0]);
      if (!fixture) continue;
      const { rows, orders } = fixture;
      if (orders.every((order) => order.some((index, offset) =>
        offset > 0 && offset % size === 0 && rows[index] === rows[order[offset - 1]]))) {
        if (!requiredTests.some((entry) => entry.path === file.path)) {
          requiredTests.push({ path: file.path, reason: "exercise an actual keyset tie crossing instead of a same-page tie" });
        }
        continue;
      }
      add("unreached-cursor-tiebreak", file.path, sourceLine(head, match.index),
        "at least one claimed tied sort never splits equal keys across an actual " + size + "-row page",
        "change the fixture so a same-key run straddles the boundary, then remove the tie-breaker and prove the exact test fails");
    }
  }
}
