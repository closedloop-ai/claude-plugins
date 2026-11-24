// Diff rules for two defects a fresh-context audit caught after a merge: a new
// sort comparator with no tie fixture (it was not a total order), and new
// exports nothing uses (left behind by descoped work). diff-rules.mjs runs them.

import path from "node:path";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { escapeRegExp, SOURCE_FILE } from "./source-imports.mjs";
import { isGeneratedFile } from "./generated-files.mjs";
import { awaitedLocalCompareLines } from "../../vibe/scripts/dist/qa-impact-parser.mjs";

const INLINE_COMPARATOR = /\.(?:sort|toSorted)\(/;
const COMPARATOR = /\.(?:sort|toSorted)\(\s*(?:\(\s*[\w$]+\s*,\s*[\w$]+\s*\)\s*=>|function\b)|\bconst\s+compare[A-Z]?\w*\s*=\s*\(\s*[\w$]+\s*,\s*[\w$]+\s*\)|\bfunction\s+compare[A-Z]?\w*\s*\(\s*(?:[\w$]+\s*(?::[^,()]+)?\s*,\s*[\w$]+\s*(?::[^,()]+)?\s*,?\s*\)|(?:[\w$]+\s*(?::[^,()]+)?\s*,?\s*)?$)/;
const NAMED_EXPORT = /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface)\s+([\w$]+)/;
// Names a framework reaches by convention rather than by import.
const CONVENTION_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "metadata", "generateMetadata", "generateStaticParams", "viewport", "config", "dynamic", "revalidate", "runtime", "loader", "action", "handler", "meta", "middleware"]);
// Build output says so on its first line, and a bundler labels each source it inlined with a comment line
// holding its path, `// ../../plugins/vibe/shared/owner.mjs`, above that source's code.
const GENERATED_BANNER = /^\/\/[^\n]*\bgenerated\b[^\n]*\bdo not edit\b/i;
const MODULE_LABEL = /^\/\/ (?:\.{1,2}\/)*((?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[cm]?[jt]sx?)$/;
const HELPER_DECL = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+([a-z]\w*)\s*\([^)]*\)(?:\s*:\s*[^\n{]+)?\s*\{\s*$/;

function sources(files) {
  return files.filter((file) => file.status !== "D" && SOURCE_FILE.test(file.path) && !isTestFile(file.path) && !/\.stories\.[jt]sx?$/.test(file.path));
}

/**
 * A new comparator needs `Comparator: <file>: tie test <test path>` naming a test that exists. Outside the
 * pull-request phase the session writes no tests, so there `Comparator: <file>: missing test listed`, with the
 * tie test on the Missing tests list, stands in for it.
 */
export function checkComparators(files, repo, logged, add, changeLog, phase = "pull-request") {
  const comparatorRecords = changeLog.split("\n").filter((line) => line.includes("Comparator:"));
  for (const file of sources(files)) {
    const candidates = file.added.filter((item) => isComparatorLine(item.text));
    if (candidates.length === 0) continue;
    const head = repo.head(file.path);
    const awaited = typeof head === "string" ? new Set(awaitedLocalCompareLines(file.path, head) ?? []) : new Set();
    const entry = candidates.find(({ line, text }) => !awaited.has(line) || INLINE_COMPARATOR.test(text));
    if (!entry) continue;
    const lines = comparatorRecords.filter((line) => line.includes(file.path));
    const cited = lines.map((line) => /tie test\s+(\S+)/.exec(line)?.[1]).filter(Boolean);
    if (phase !== "pull-request" && lines.some((line) => /:\s*missing test listed\s*$/.test(line))) continue;
    if (!cited.some((test) => repo.head(test) !== null && repo.head(test) !== undefined)) {
      const record = phase === "pull-request" ? "add a fixture with a tie, and record `Comparator: <file>: tie test <test path>`"
        : "list the tie test under Missing tests, and record `Comparator: <file>: missing test listed`";
      add("comparator-tie", file.path, entry.line, "adds a sort comparator with no test that sorts two rows tied on the ranked key; a comparator that returns 0 for distinct rows is not a total order", `break ties on a unique key, ${record}`);
    }
  }
}

/**
 * Named parser/matcher modules need a current layout table and a differential property check before review.
 * Keep this syntax check at the caller's existing quick gate; the test runner owns the result.
 */
export function checkParserLayoutProof(files, repo, changeLog, add, requiredTests) {
  const records = [...changeLog.matchAll(/^\s*(?:-\s+)?Parser layouts: (\S+): base ([0-9a-f]{40}), rows ((?:[A-Z]+-[A-Z0-9.-]+ ?)+), property test (\S+)\s*$/gm)];
  for (const file of sources(files)) {
    if (!/(?:^|[-/])(?:parser|matcher|criteria-list)\.[cm]?[jt]s$/.test(file.path)) continue;
    const code = file.added.find((entry) => !/^\s*(?:\/\/|\*|import\b)/.test(entry.text) && entry.text.trim());
    if (!code) continue;
    const proof = records.find(([, filePath, base, rows, test]) => filePath === file.path && base === repo.baseCommit
      && rows.split(/\s+/).every((row) => repo.sessionIds?.includes(row)) && isTestFile(test) && typeof repo.head(test) === "string");
    if (proof) {
      requiredTests.push({ path: proof[4], reason: `base differential layout proof for ${file.path}` });
    } else {
      add("parser-layout-proof", file.path, code.line, "changes a parser or matcher without its complete layout and base property proof",
        "record `Parser layouts: <file>: base <full SHA>, rows <row ids>, property test <path>` and rerun the full layout corpus if a row changes");
    }
  }
}

/** Refuse tests whose text locator gets its expected copy from the helper under test. */
export function checkRenderedCopyAssertions(files, repo, add) {
  const locator = /\b(?:get|query|find)(?:All)?ByText\s*\(\s*([^,\n]+)/g;
  const helper = /^(?:await\s+)?([A-Za-z_$][\w$.]*)\s*\(/;
  for (const file of files.filter((entry) => isTestFile(entry.path) || /\.stories\.[jt]sx?$/.test(entry.path))) {
    const source = repo.head(file.path) ?? "";
    for (const entry of file.added) {
      for (const [, argument] of entry.text.matchAll(locator)) {
        const variable = /^\s*([A-Za-z_$][\w$]*)\s*\)/.exec(argument)?.[1];
        const assignment = variable && new RegExp("\\bconst\\s+" + escapeRegExp(variable) + "\\s*=\\s*([^;\\n]+)").exec(source)?.[1];
        const computed = helper.exec(argument) ?? (assignment ? helper.exec(assignment) : null);
        if (!computed) continue;
        add("rendered-copy-oracle", file.path, entry.line, "the text locator derives its expected copy from " + computed[1],
          "query the rendered surface by its copy constant, then mutate the rendered value and prove this assertion fails");
      }
    }
  }
}

/** A URL query key must use its in-tree owner rather than a second string. */
export function checkRangeParamCopies(files, repo, add) {
  if (!repo.wordFiles) return;
  const receivers = /\b(?:searchParams|params|query|urlParams)(?:\??\.)?(?:get|set|has|delete|append)\(\s*(["'])range\1/;
  const options = /(?:\b(?:get|set|has|delete|append)\(\s*(["'])range\1|\bURLSearchParams\s*\([^\n]*[?&]range=)/;
  const owners = repo.wordFiles("LIST_RANGE_PARAM").filter((file) => !isTestFile(file)
    && /\bexport\s+const\s+LIST_RANGE_PARAM\s*=\s*(["'])range\1/.test(repo.head(file) ?? ""));
  if (owners.length !== 1) return;
  for (const file of files.filter((candidate) => candidate.path !== owners[0])) {
    const source = repo.head(file.path) ?? "";
    const hasParamOwner = /\b(?:URLSearchParams|useSearchParams|searchParams)\b/.test(source);
    for (const { line, text } of file.added) {
      if (/^\s*(?:\/\/|\/\*|\*)/.test(text)) continue;
      if (receivers.test(text) || (hasParamOwner && options.test(text))) add("copied-query-key", file.path, line,
        "retypes the URL query key owned by " + owners[0], "import and use LIST_RANGE_PARAM from its owner");
    }
  }
}

/** A fixture uses the owning storage prefix import instead of another copy of its string. */
export function checkStoragePrefixCopies(files, repo, add) {
  const fixtures = files.filter((file) => isTestFile(file.path) || /(?:^|\/)(?:fixtures|test-fixtures)\//.test(file.path))
    .filter((file) => file.added.some((entry) => /["'\x60][\w-]+:[\w-]+:/.test(entry.text)));
  if (!fixtures.length || !repo.wordFiles) return;
  const owners = new Map();
  for (const file of repo.wordFiles("keyPrefix").filter((entry) => !isTestFile(entry))) {
    const declarations = (repo.head(file) ?? "").matchAll(/\bkeyPrefix\s*:\s*(["'])([a-zA-Z0-9_-]+:[a-zA-Z0-9_:-]+:)\1/g);
    for (const [, , prefix] of declarations) if (!owners.has(prefix)) owners.set(prefix, file);
  }
  for (const fixture of fixtures) {
    for (const entry of fixture.added) {
      if (/^\s*(?:\/\/|\/\*|\*)/.test(entry.text)) continue;
      for (const [prefix, owningFile] of owners) {
        if (fixture.path === owningFile || !new RegExp("[\"'\\x60]" + escapeRegExp(prefix)).test(entry.text)) continue;
        add("copied-storage-prefix", fixture.path, entry.line, "fixture retypes storage prefix owned by " + owningFile,
          "import the canonical keyPrefix and construct the key from it");
      }
    }
  }
}

/**
 * Prove a removed value belonged to a linked exported type before reporting an orphan.
 * Computed keys, complex types and assignments outside linked files stay review evidence.
 */
export function checkOrphanedTypeMembers(files, repo, add) {
  if (!repo.wordFiles) return;
  const removed = new Set(files.flatMap((file) => file.removed.flatMap(({ text }) => {
    const match = /^\s*([a-z]\w*)\s*:\s*(?!\{|[;,}]).+/.exec(text);
    return match ? [match[1]] : [];
  })));
  if (!removed.size) return;
  const acted = new Set();
  for (const file of files.filter((entry) => /\.tsx?$/.test(entry.path) && !isTestFile(entry.path) && entry.removed.length)) {
    for (const member of removed) {
      if (!file.removed.some(({ text }) => new RegExp("^\\s*" + member + "\\s*:").test(text))) continue;
      for (const owner of repo.wordFiles(member).filter((entry) => path.dirname(entry) === path.dirname(file.path) && !isTestFile(entry))) {
        const source = repo.head(owner) ?? "";
        const types = source.matchAll(/(?:^|\n)export\s+(?:type|interface)\s+([A-Z]\w+)(?:\s*=\s*|\s+)\{([^{}]*)\}/g);
        for (const match of types) {
          const declared = new RegExp("^\\s*" + member + "\\??\\s*:", "m").test(match[2]);
          const use = repo.base(file.path) ?? "";
          const ownerModule = "./" + path.basename(owner).replace(/\.tsx?$/, "");
          const linked = new RegExp("\\b" + match[1] + "\\b").test(use) || use.includes(ownerModule);
          if (!declared || !linked) continue;
          const identity = owner + ":" + match[1] + "." + member;
          if (acted.has(identity)) continue;
          const assignment = new RegExp("(?:^|[{,])\\s*" + member + "\\s*:\\s*(?:[^;\\n,}]+,|[<{\\[\"'\\x60])", "m");
          const linkedFiles = new Set([owner, file.path, ...repo.wordFiles(match[1])]);
          const stillProduced = [...linkedFiles].filter((related) => !isTestFile(related)).some((related) => {
            const text = repo.head(related) ?? "";
            return assignment.test(related === owner ? text.replace(match[0], "") : text);
          });
          if (stillProduced) continue;
          acted.add(identity);
          const line = source.slice(0, match.index).split("\n").length;
          add("orphaned-type-member", owner, line, match[1] + "." + member + " lost its producer but is still part of the exported type",
            "delete the orphaned field or identify the remaining real producer and its consumers");
        }
      }
    }
  }
}

/** A named export new in this diff that no other file names is dead on arrival unless recorded. */
export function checkUnusedExports(files, repo, logged, add) {
  const candidates = sources(files).flatMap((file) => {
    const added = file.added.filter((entry) => NAMED_EXPORT.test(entry.text));
    return added.length > 0 ? [{ file, added }] : [];
  });
  repo.prefetchWords?.(candidates.flatMap(({ added }) => added.map((entry) => NAMED_EXPORT.exec(entry.text)[1])));
  const bases = repo.baseBlobs?.(candidates.map(({ file }) => file.path));
  for (const { file, added } of candidates) {
    const base = bases ? bases.get(file.path) ?? "" : repo.base(file.path) ?? "";
    for (const entry of added) {
      const name = NAMED_EXPORT.exec(entry.text)?.[1];
      if (!name || CONVENTION_EXPORTS.has(name) || logged(`Export: ${name}:`)) continue;
      if (new RegExp(`\\bexport\\b[^\\n]*\\b${name.replace(/\$/g, "\\$")}\\b`).test(base)) continue;
      if (repo.wordFiles(name).filter((other) => other !== file.path).length === 0) {
        add("unused-export", file.path, entry.line, `exports ${name}, which no other file uses`, `remove it (or the export keyword), or record \`Export: ${name}: <the consumer that will import it and its ticket>\``);
      }
    }
  }
}

/** Index the first closed declaration of each requested name using one split per file. */
function helperBodies(source, names) {
  const lines = source.split("\n");
  const closingByIndent = new Map();
  const bodies = new Map();
  for (let line = lines.length - 1; line >= 0; line -= 1) {
    const text = lines[line];
    if (/^\s*}$/.test(text)) closingByIndent.set(text.slice(0, -1), line);
    const declaration = HELPER_DECL.exec(text);
    if (!declaration || !names.has(declaration[2])) continue;
    const close = closingByIndent.get(declaration[1]);
    if (close === undefined) continue;
    bodies.set(declaration[2], lines.slice(line + 1, close).map((bodyLine) => bodyLine.trim()).join("\n"));
  }
  return bodies;
}

/** All simple named helpers, indexed once per current source file. */
function helperIndex(repo, names, textOf) {
  const index = new Map();
  for (const file of [...repo.headFiles].filter((entry) => SOURCE_FILE.test(entry) && !isTestFile(entry) && !/\.stories\.[jt]sx?$/.test(entry)
    && !isGeneratedFile(repo, entry, { header: false })).sort()) {
    const source = textOf(file);
    if (typeof source !== "string") continue;
    for (const [name, body] of helperBodies(source, names)) {
      const entries = index.get(name) ?? [];
      entries.push({ file, body });
      index.set(name, entries);
    }
  }
  return index;
}

/**
 * In build output (a generated banner on its first line), the module label of the section that defines
 * helper `name`: the nearest label line above its declaration. Null for a hand-written file. A `dist/`
 * path proves nothing, so it exempts nothing.
 */
function bundledFrom(output, name) {
  if (!GENERATED_BANNER.test(output ?? "")) return null;
  const lines = output.split("\n");
  const at = lines.findIndex((line) => HELPER_DECL.exec(line)?.[2] === name);
  for (let index = at - 1; index > 0; index -= 1) {
    const label = MODULE_LABEL.exec(lines[index])?.[1];
    if (label) return label;
  }
  return null;
}

/** True when a module label names `source`: the whole repo path, or its tail from a directory boundary on, never a bare file name. */
function labels(label, source) {
  return label === source || (label.includes("/") && source.endsWith(`/${label}`));
}

/**
 * True when a bundle whose module label is `label` inlined `file`: the label names the file, or names the source
 * the file is a built copy of under a build marker (a launcher bundle against the built copy of its own source).
 */
function inlines(label, file, sourceOf) {
  if (labels(label, file)) return true;
  const source = sourceOf(file);
  return source !== null && labels(label, source);
}

/** True when `file`'s helper and `other`'s (whose head text is `otherText`) are one definition: either bundle inlined the other file, or both bundles inlined one source. */
function oneBundledDefinition(name, file, ownSource, otherText, other, sourceOf) {
  const otherSource = bundledFrom(otherText, name);
  if (ownSource && inlines(ownSource, other, sourceOf)) return true;
  if (otherSource && inlines(otherSource, file, sourceOf)) return true;
  return Boolean(ownSource && otherSource && ownSource === otherSource);
}

/**
 * A newly added helper must not copy an identical existing or fellow-diff helper. A bundle and the
 * source it inlined are one definition, whichever of the two the diff adds, and so are two bundles that
 * inlined it from the same source.
 */
export function checkDuplicateHelpers(files, repo, add) {
  const declarations = sources(files).flatMap((file) => file.added.flatMap((entry) => {
    const name = HELPER_DECL.exec(entry.text)?.[2];
    return name ? [{ name, file: file.path, line: entry.line }] : [];
  }));
  if (declarations.length === 0) return;
  const changed = new Set(files.map((file) => file.path));
  const texts = new Map();
  const textOf = (file) => {
    if (!texts.has(file)) texts.set(file, repo.head(file));
    return texts.get(file);
  };
  const indexed = helperIndex(repo, new Set(declarations.map(({ name }) => name)), textOf);
  const markerPaths = new Set([...repo.headFiles, ...(repo.baseFiles ?? [])]
    .filter((file) => file.endsWith(`/${BUILD_MARKER}`)));
  const mirrorSources = new Map();
  const sourceOf = (file) => {
    if (!mirrorSources.has(file)) mirrorSources.set(file, builtSource(file, repo, markerPaths));
    return mirrorSources.get(file);
  };
  for (const { name, file, line } of declarations) {
    const candidates = indexed.get(name) ?? [];
    const body = candidates.find((candidate) => candidate.file === file)?.body;
    if (!body || body.length < 16) continue;
    const ownSource = bundledFrom(textOf(file), name);
    const duplicate = candidates.find((candidate) => candidate.file !== file
      && (!changed.has(candidate.file) || candidate.file < file) && candidate.body === body
      && sourceOf(file) !== candidate.file && sourceOf(candidate.file) !== file
      && !oneBundledDefinition(name, file, ownSource, textOf(candidate.file), candidate.file, sourceOf))?.file;
    if (duplicate) add("duplicate-helper", file, line,
      `new helper ${name} duplicates ${duplicate}`,
      `move the shared behavior to one owner and import it from ${duplicate}`);
  }
}

// The generated file a build writes at the root of its output, `{"builtFrom": "<source dir from the repo root>"}`.
const BUILD_MARKER = ".vibe-build.json";

/** The source path of a built file, from the nearest build marker above it; null when there is none or it proves nothing. */
function builtSource(file, repo, markerPaths) {
  const parts = file.split("/");
  for (let depth = parts.length - 1; depth > 0; depth -= 1) {
    const marker = `${parts.slice(0, depth).join("/")}/${BUILD_MARKER}`;
    if (!markerPaths.has(marker)) continue;
    const text = repo.head(marker) ?? repo.base(marker);
    if (text == null) continue;
    let builtFrom;
    try { builtFrom = JSON.parse(text)?.builtFrom; } catch { return null; }
    if (typeof builtFrom !== "string" || !/^[^/]/.test(builtFrom) || builtFrom.split("/").some((part) => !part || part === "." || part === "..")) return null;
    const source = `${builtFrom}/${parts.slice(depth).join("/")}`;
    return (repo.head(source) ?? repo.base(source)) == null ? null : source;
  }
  return null;
}

/** Whether an added line declares a sort comparator: a two-parameter sort callback or `const compare* = (a, b)`, or a `compare*` function with two typed or untyped parameters or a parameter list wrapped onto later lines. */
export function isComparatorLine(text) {
  return COMPARATOR.test(text);
}
