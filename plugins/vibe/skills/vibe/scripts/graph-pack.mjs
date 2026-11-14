#!/usr/bin/env node
// One context pack for the writer and the Spec Card: for each file or directory a request will touch, the owner,
// the importing hosts, the tests and stories that cover it, the feature map
// entries that name it (when the bound provider's recipe names the
// repository's feature map file), and the precedents for the request's terms,
// read from the worktree in one pass. It replaces the three advisor launches
// that each searched for the same things (`vibe-backend-worker`,
// `vibe-primitive-worker`, `vibe-storybook-decomposer` placement mode), and it
// is the evidence a session without a graph reads in its place.
//
// It is worktree evidence, not graph evidence: a bound graph provider's tools
// are MCP calls this script cannot make, so the pack lists them under
// `graphCallsStillOwed` (the provider's `data.graph.packCallsOwed`; none
// without one), and a required Graph block is not satisfied by it.
//
// Usage: graph-pack.mjs --worktree <path> --paths <a,b,...> [--terms <t1,t2,...>] [--out <file>]
// Prints the pack JSON (`vibe.graph-pack/1`); with --out writes it too. Reads
// only: `git ls-files`, `git grep`, the CODEOWNERS and feature map files.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { escapeRegExp, IMPORT_SPECIFIER, resolveImport, SOURCE_FILE } from "../../handoff/scripts/source-imports.mjs";
import { isTestFile } from "./test-files.mjs";
import { execCommand } from "./ws3-exec.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { failScript } = await vibeCore("lib/vibe/scripts/provider.mjs");

export const PACK_SCHEMA = "vibe.graph-pack/1";
const STORY = /\.stories\.[jt]sx?$/;
const COMPONENT = /\.[jt]sx$/;
const WORKTREE_SOURCE = "worktree: git ls-files, git grep and CODEOWNERS";
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
const MAX_LIST = 25;
const MAX_PRECEDENTS = 10;
const MIN_TERM = 3;
const MIN_TOKEN = 8;

/** The CODEOWNERS pattern as a RegExp, or null for one it cannot express. */
export function ownersPattern(pattern) {
  if (!pattern || pattern.startsWith("!") || pattern.includes("[")) return null;
  const anchored = pattern.startsWith("/");
  const body = pattern.replace(/^\//, "");
  const directory = body.endsWith("/");
  const source = escapeRegExp(directory ? body.slice(0, -1) : body)
    .replace(/\\\*\\\*/g, "\u0000").replace(/\\\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${anchored || body.includes("/") ? "" : "(?:.*/)?"}${source}${directory ? "(?:/.*)?" : "(?:/.*)?"}$`);
}

/** The owners the last matching CODEOWNERS line gives `file`, or an empty list. */
export function codeowners(text, file) {
  let owners = [];
  for (const line of text.split("\n")) {
    const [pattern, ...rest] = line.replace(/#.*/, "").trim().split(/\s+/);
    if (!pattern || rest.length === 0) continue;
    const matcher = ownersPattern(pattern);
    if (matcher?.test(file)) owners = rest;
  }
  return owners;
}

/** The feature map entry ids whose block names `file`, or a folder holding it, in backticks. */
export function featureMapIds(text, file) {
  const ids = [];
  for (const block of text.split(/^### /m).slice(1)) {
    const id = /\(`([^`]+)`\)/.exec(block.split("\n")[0])?.[1];
    if (!id) continue;
    const tokens = [...block.matchAll(/`([^`\n]*\/[^`\n]*)`/g)].flatMap((match) => match[1].split(/[,\s]+/).map((token) => token.replace(/^[a-z-]+:\s*/i, "")));
    if (tokens.some((token) => token.length >= MIN_TOKEN && (file === token || file.startsWith(token.endsWith("/") ? token : `${token}`) || (token.startsWith(`${file}/`))))) ids.push(id);
  }
  return ids;
}

/** The graph calls a pack leaves owed for `binding`: the bound graph provider's, or none. */
export function graphCallsStillOwed(binding) {
  return Object.freeze([...providerDataOr(binding, "graph", "packCallsOwed", [])]);
}

/**
 * `binding` is the session's provider binding (by default the one recorded for the worktree each pack reads).
 */
export function createGraphPack({ run = execCommand, read = (file) => readFileSync(file, "utf8"), binding } = {}) {
  const git = (worktree, args) => run("git", ["-C", worktree, ...args]);

  function trackedFiles(worktree) {
    return new Set(git(worktree, ["ls-files"]).stdout.split("\n").filter(Boolean));
  }

  /** The nearest tracked AGENTS.md at or above `file`'s folder, and the nearest package.json name. */
  function nearest(worktree, file, tracked) {
    let directory = path.posix.dirname(file);
    let agentsMd = null;
    let packageName = null;
    for (;;) {
      const prefix = directory === "." ? "" : `${directory}/`;
      if (!agentsMd && tracked.has(`${prefix}AGENTS.md`)) agentsMd = `${prefix}AGENTS.md`;
      if (!packageName && tracked.has(`${prefix}package.json`)) {
        try { packageName = JSON.parse(read(path.join(worktree, `${prefix}package.json`))).name ?? null; } catch { packageName = null; }
        if (packageName === null) packageName = `${prefix}package.json`;
      }
      if (directory === "." || directory === "/") break;
      directory = path.posix.dirname(directory);
    }
    return { agentsMd, package: packageName };
  }

  /** Tracked source files whose imports resolve to `file`. */
  function importers(worktree, file, tracked) {
    const stem = path.posix.basename(file).replace(/\.[jt]sx?$/, "");
    const hits = git(worktree, ["grep", "-lF", "-e", stem, "--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs"]).stdout.split("\n").filter(Boolean);
    const found = [];
    for (const hit of hits.filter((candidate) => candidate !== file && SOURCE_FILE.test(candidate))) {
      let text;
      try { text = read(path.join(worktree, hit)); } catch { continue; }
      for (const match of text.matchAll(IMPORT_SPECIFIER)) {
        if (resolveImport(hit, match[1], tracked) === file) { found.push(hit); break; }
      }
    }
    return found.sort();
  }

  function siblingTests(file, tracked) {
    const stem = path.posix.basename(file).replace(/\.[jt]sx?$/, "");
    const directory = path.posix.dirname(file);
    const names = [directory, path.posix.join(directory, "__tests__")];
    return [...tracked].filter((candidate) => names.includes(path.posix.dirname(candidate))
      && new RegExp(`^${escapeRegExp(stem)}\\.(?:test|spec)\\.[jt]sx?$`).test(path.posix.basename(candidate))).sort();
  }

  function siblingStories(file, tracked) {
    const stem = path.posix.basename(file).replace(/\.[jt]sx?$/, "");
    const directory = path.posix.dirname(file);
    return [...tracked].filter((candidate) => path.posix.dirname(candidate) === directory && path.posix.basename(candidate).startsWith(`${stem}.stories.`)).sort();
  }

  function describePath(worktree, file, tracked, texts) {
    const normalized = file.replace(/^\.\//, "").replace(/\/$/, "");
    const isFile = tracked.has(normalized);
    const entry = { path: normalized, tracked: isFile || [...tracked].some((candidate) => candidate.startsWith(`${normalized}/`)), kind: isFile ? "file" : "directory" };
    const owner = nearest(worktree, isFile ? normalized : `${normalized}/x`, tracked);
    const ownersFile = texts.codeowners;
    entry.owner = { ...owner, codeowners: ownersFile ? codeowners(ownersFile, normalized) : [] };
    entry.featureMap = texts.featureMap ? featureMapIds(texts.featureMap, normalized) : [];
    if (!isFile) return { ...entry, importers: null, tests: null, stories: null };
    const all = importers(worktree, normalized, tracked);
    const tests = [...new Set([...all.filter((item) => isTestFile(item)), ...siblingTests(normalized, tracked)])].sort();
    const stories = [...new Set([...all.filter((item) => STORY.test(item)), ...siblingStories(normalized, tracked)])].sort();
    const hosts = all.filter((item) => !isTestFile(item) && !STORY.test(item));
    return {
      ...entry,
      importers: {
        components: hosts.filter((item) => COMPONENT.test(item)).slice(0, MAX_LIST),
        other: hosts.filter((item) => !COMPONENT.test(item)).slice(0, MAX_LIST),
        total: hosts.length,
      },
      tests: tests.slice(0, MAX_LIST),
      stories: stories.slice(0, MAX_LIST),
    };
  }

  function precedents(worktree, term) {
    const grepped = git(worktree, ["grep", "-liwF", "-e", term, "--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs"]).stdout.split("\n").filter(Boolean)
      .filter((file) => !isTestFile(file));
    return { term, total: grepped.length, files: grepped.slice(0, MAX_PRECEDENTS) };
  }

  function pack({ worktree, paths, terms = [] }) {
    const bound = binding === undefined ? sessionBinding(worktree) : binding;
    const featureMap = providerDataOr(bound, "recipes", "featureMap", null);
    const tracked = trackedFiles(worktree);
    const readIf = (candidates) => {
      const found = candidates.find((file) => tracked.has(file));
      return found ? read(path.join(worktree, found)) : null;
    };
    const texts = {
      codeowners: readIf(CODEOWNERS_PATHS),
      featureMap: featureMap ? readIf([...tracked].filter((file) => new RegExp(featureMap).test(file)).slice(0, 1)) : null,
    };
    return {
      schema: PACK_SCHEMA,
      head: git(worktree, ["rev-parse", "HEAD"]).stdout.trim(),
      source: providerDataOr(bound, "graph", "packSource", WORKTREE_SOURCE),
      paths: paths.map((file) => describePath(worktree, file, tracked, texts)),
      precedents: terms.filter((term) => term.length >= MIN_TERM).map((term) => precedents(worktree, term)),
      graphCallsStillOwed: graphCallsStillOwed(bound),
    };
  }

  return { pack };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { worktree: { type: "string" }, paths: { type: "string" }, terms: { type: "string" }, out: { type: "string" } } });
  if (!values.worktree || !values.paths) throw new Error("--worktree and --paths are required.");
  const list = (text) => (text ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const result = createGraphPack().pack({ worktree: path.resolve(values.worktree), paths: list(values.paths), terms: list(values.terms) });
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) {
    mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
    writeFileSync(values.out, text);
  }
  process.stdout.write(text);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.exit(failScript(error, 2));
  }
}
