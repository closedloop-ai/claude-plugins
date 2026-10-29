#!/usr/bin/env node
// Classifies only the changes made since the last automated QA pass. The
// result decides whether local QA needs nothing, selected functional lanes,
// or visual QA for named screens and their previously checked states.
// Evidence is screen-addressed. A commit id is only a diff boundary and is
// never part of the evidence identity.
// Importer JSON shape: {"importers":{"changed/file":["importer/file"]}}.
// Evidence JSON shape: {"screens":[{"id":"screen","states":[],"flagArms":[]}]}.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";

export const QaImpact = Object.freeze({ None: "None", LanesOnly: "Lanes only", Visual: "Visual QA" });

const SAFE_ROOT_FILES = new Set(["CHANGELOG.md", "CHANGES.md", "HISTORY.md", "RELEASE.md", "RELEASES.md", "README.md"]);
const CI_CONFIG = /^(?:\.github\/(?:workflows\/[^/]+\.ya?ml|dependabot\.ya?ml|CODEOWNERS)|\.circleci\/config\.ya?ml|\.buildkite\/[^/]+\.ya?ml|Dockerfile|Jenkinsfile)$/i;
const TOKENIZED_SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
const UI_CAPABLE = /\.(?:tsx|jsx|vue|svelte|css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|html?|mdx|woff2?|ttf|otf|eot)$/i;
const DOC_FILE = /\.(?:md|rst|txt)$/i;
const LOCKFILE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/;
const UI_PACKAGES = new Set(["react", "react-dom", "next", "tailwindcss", "storybook", "lucide-react", "framer-motion", "motion", "cmdk", "recharts", "sonner", "vaul", "date-fns", "react-markdown"]);
const UI_PACKAGE_SCOPES = ["@radix-ui/", "@tailwindcss/", "@storybook/", "@floating-ui/", "@tanstack/", "@tiptap/"];
const UI_CONFIG = /(?:^|\/)(?:tailwind|postcss)\.config\.(?:[cm]?[jt]s)$|(?:^|\/)\.storybook\/preview\.(?:[cm]?[jt]sx?)$/i;
const VERSIONED_JSON = /(?:^|\/)(?:package|plugin)\.json$/;
const FEATURE_MAP_DEFAULT = ".claude/skills/control/feature-map.json";
const CONFIG_DEFAULT = ".vibe/qa-impact.json";

function git(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function lines(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function readAt(worktree, ref, file) {
  try {
    return git(worktree, ["show", `${ref}:${file}`]);
  } catch {
    return null;
  }
}

function readHead(worktree, file) {
  return readAt(worktree, "HEAD", file);
}

export function loadTypeScript(worktree) {
  try {
    return createRequire(path.join(worktree, "package.json"))("typescript");
  } catch {
    return null;
  }
}

/** Token identity with TypeScript's real scanner, excluding only comments and whitespace trivia. */
export function semanticSourceText(file, source, typescript) {
  if (source === null || !TOKENIZED_SOURCE.test(file) || !typescript?.createScanner) return null;
  const { SyntaxKind } = typescript;
  const ignored = new Set([
    SyntaxKind.WhitespaceTrivia,
    SyntaxKind.NewLineTrivia,
    SyntaxKind.SingleLineCommentTrivia,
    SyntaxKind.MultiLineCommentTrivia,
    SyntaxKind.ShebangTrivia,
  ]);
  const variant = /\.[jt]sx$/i.test(file) ? typescript.LanguageVariant.JSX : typescript.LanguageVariant.Standard;
  const scanner = typescript.createScanner(typescript.ScriptTarget.Latest, false, variant, source);
  const tokens = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (!ignored.has(kind)) tokens.push(`${kind}:${scanner.getTokenText()}`);
  }
  return tokens.join("\0");
}

function tokenizerSafeOnly(file, before, after, typescript) {
  if (before === after) return true;
  const oldTokens = semanticSourceText(file, before, typescript);
  const newTokens = semanticSourceText(file, after, typescript);
  return oldTokens !== null && newTokens !== null && oldTokens === newTokens;
}

function versionOnly(file, before, after) {
  if (!VERSIONED_JSON.test(file) || before === null || after === null) return false;
  try {
    const clean = (text) => {
      const value = JSON.parse(text);
      delete value.version;
      return value;
    };
    return JSON.stringify(clean(before)) === JSON.stringify(clean(after));
  } catch {
    return false;
  }
}

function lockfileMovesUi(before, after) {
  const oldLines = new Set((before ?? "").split("\n"));
  return (after ?? "").split("\n").some((line) => !oldLines.has(line) && lockfileUiPackage(line));
}

function isUiPackage(name) {
  return UI_PACKAGES.has(name) || UI_PACKAGE_SCOPES.some((scope) => name.startsWith(scope));
}

function manifestMovesUi(file, before, after) {
  if (path.posix.basename(file) !== "package.json" || before === null || after === null) return false;
  try {
    const oldManifest = JSON.parse(before);
    const newManifest = JSON.parse(after);
    const oldDeps = { ...oldManifest.dependencies, ...oldManifest.devDependencies, ...oldManifest.peerDependencies };
    const newDeps = { ...newManifest.dependencies, ...newManifest.devDependencies, ...newManifest.peerDependencies };
    return [...new Set([...Object.keys(oldDeps), ...Object.keys(newDeps)])].some((name) => isUiPackage(name) && oldDeps[name] !== newDeps[name]);
  } catch {
    return false;
  }
}

/** Exact UI package named by one lockfile line, or null. */
export function lockfileUiPackage(line) {
  const text = line.trim().replace(/^['"]/, "").replace(/^\/?node_modules\//, "");
  const found = /^(?<name>@[^/\s:'"]+\/[^@\s:'"]+|[^@/\s:'"]+)(?:@[^\s:'"]+)?['"]?:/.exec(text)?.groups?.name;
  if (!found) return null;
  return isUiPackage(found) ? found : null;
}

function normalizeCodePath(value) {
  const text = String(value).trim();
  return text.includes(": ") ? text.slice(text.indexOf(": ") + 2) : text;
}

function pathMatches(file, owner) {
  if (file === owner) return true;
  if (owner.endsWith("-")) return file.startsWith(owner);
  if (owner.endsWith("/")) return file.startsWith(owner);
  if (!file.startsWith(owner)) return false;
  return ["/", ".", "-", "_"].includes(file[owner.length]);
}

function featurePaths(entry) {
  return [...(entry.webPages ?? []), ...(entry.code ?? []).map(normalizeCodePath)].filter(Boolean);
}

function configuredPaths(config, key) {
  return Array.isArray(config?.[key]) ? config[key].map((item) => String(item)) : [];
}

function inConfiguredPath(file, paths) {
  return paths.some((owner) => pathMatches(file, owner.endsWith("/") ? owner : `${owner}/`));
}

function normalizeImporters(raw) {
  if (raw === undefined || raw === null) return null;
  const source = raw?.importers ?? raw?.files ?? raw ?? {};
  if (Array.isArray(source)) {
    return new Map(source.map((entry) => [entry.file, entry.importers ?? entry.paths ?? []]));
  }
  return new Map(Object.entries(source));
}

function normalizeLaneSelections(raw) {
  if (!raw) return null;
  const source = raw?.files ?? raw;
  return new Map(Object.entries(source).map(([file, lanes]) => [file, Array.isArray(lanes) ? lanes : []]));
}

function evidenceById(evidence) {
  return new Map((evidence?.screens ?? []).map((screen) => [screen.id ?? screen.screen, screen]));
}

/** Validates screen and state evidence without accepting a commit hash as identity. */
export function evidenceProblems(evidence) {
  const problems = [];
  if (!Array.isArray(evidence?.screens)) return ["QA evidence needs a screens array"];
  for (const key of ["head", "sha", "commit", "headSha", "commitSha"]) {
    if (key in evidence) problems.push(`QA evidence records ${key}; QA evidence is screen and state based`);
  }
  for (const [index, screen] of evidence.screens.entries()) {
    const name = screen?.id ?? screen?.screen;
    if (!name) problems.push(`screen ${index + 1} has no id`);
    if (!Array.isArray(screen?.states) || screen.states.length === 0) problems.push(`${name ?? `screen ${index + 1}`} has no checked states`);
    if (!Array.isArray(screen?.flagArms)) problems.push(`${name ?? `screen ${index + 1}`} has no flagArms array`);
    for (const key of ["head", "sha", "commit", "headSha", "commitSha"]) {
      if (key in (screen ?? {})) problems.push(`${name ?? `screen ${index + 1}`} records ${key}; QA evidence is screen and state based`);
    }
  }
  return problems;
}

function changedBetween(worktree, from, to) {
  return new Set(lines(git(worktree, ["diff", "--name-only", "--no-renames", from, to])));
}

function differsBetween(worktree, from, to, file) {
  try {
    execFileSync("git", ["-C", worktree, "diff", "--quiet", from, to, "--", file], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

/** Files changed by branch commits versus files arriving only through main merges. */
export function changeOrigins(worktree, since) {
  const ownFiles = new Set();
  const mergeFiles = new Set();
  for (const row of lines(git(worktree, ["rev-list", "--first-parent", "--reverse", "--parents", `${since}..HEAD`]))) {
    const [commit, firstParent, secondParent] = row.split(/\s+/);
    if (!firstParent) continue;
    if (!secondParent) {
      for (const file of changedBetween(worktree, firstParent, commit)) ownFiles.add(file);
      continue;
    }
    const incoming = changedBetween(worktree, firstParent, commit);
    for (const file of incoming) mergeFiles.add(file);
    const mergeBase = git(worktree, ["merge-base", firstParent, secondParent]);
    const branchSide = changedBetween(worktree, mergeBase, firstParent);
    const mainSide = changedBetween(worktree, mergeBase, secondParent);
    for (const file of incoming) {
      if (branchSide.has(file) && mainSide.has(file) && differsBetween(worktree, secondParent, commit, file)) ownFiles.add(file);
    }
  }
  for (const file of ownFiles) mergeFiles.delete(file);
  return { ownFiles, mergeFiles };
}

function changedFiles(worktree, since) {
  return lines(git(worktree, ["diff", "--name-only", "--no-renames", `${since}..HEAD`]));
}

function screenEvidence(entry, recorded) {
  if (recorded) return { id: entry.id, title: entry.title, states: recorded.states, flagArms: recorded.flagArms, ...(recorded.hosts ? { hosts: recorded.hosts } : {}) };
  return {
    id: entry.id,
    title: entry.title,
    states: ["all affected states"],
    flagArms: [...new Set([...(entry.webGates ?? []), ...(entry.desktopGates ?? [])])],
  };
}

function recordedScreens(evidence) {
  return [...(evidence?.screens ?? []), ...(evidence?.touchedScreens ?? [])].map((screen) => ({
    id: screen.id ?? screen.screen,
    ...(screen.title ? { title: screen.title } : {}),
    states: screen.states,
    flagArms: screen.flagArms,
    ...(screen.hosts ? { hosts: screen.hosts } : {}),
  }));
}

function withWarnings(result, warnings) {
  return warnings.length ? { ...result, warnings: [...new Set(warnings)] } : result;
}

/** Classifies by proving safe files first; every unproven file is at least Lanes only. */
export function classifyQaImpact({ files, before, after, importers, featureMap, evidence, laneSelections, ownFiles = new Set(), mergeFiles = new Set(), config, typescript }) {
  const recorded = evidenceById(evidence);
  const entries = Array.isArray(featureMap?.entries) ? featureMap.entries : null;
  const docs = configuredPaths(config, "docs");
  const configuredUi = configuredPaths(config, "ui");
  const tests = [];
  const unsafe = [];
  for (const file of files) {
    const oldText = before.get(file) ?? null;
    const newText = after.get(file) ?? null;
    if (isTestFile(file)) {
      tests.push(file);
    } else if ((!file.includes("/") && SAFE_ROOT_FILES.has(file))
      || CI_CONFIG.test(file)
      || versionOnly(file, oldText, newText)
      || (DOC_FILE.test(file) && inConfiguredPath(file, docs))
      || tokenizerSafeOnly(file, oldText, newText, typescript)) {
      // Explicitly proven unable to change rendered behavior.
    } else {
      unsafe.push(file);
    }
  }

  const warnings = [];
  if (entries === null && unsafe.length) warnings.push("screen map unavailable; unproven UI changes classify upward");
  const info = unsafe.map((file) => {
    const importing = importers?.get(file);
    const graphAvailable = importing !== undefined;
    const paths = [file, ...(importing ?? [])];
    const matched = entries?.filter((entry) => featurePaths(entry).some((owner) => paths.some((item) => pathMatches(item, owner)))) ?? [];
    const mergeOnly = mergeFiles.has(file) && !ownFiles.has(file);
    const configuredAsUi = inConfiguredPath(file, configuredUi);
    const uiCapable = UI_CAPABLE.test(file) || UI_CONFIG.test(file) || configuredAsUi || matched.length > 0
      || (LOCKFILE.test(file) && lockfileMovesUi(before.get(file) ?? null, after.get(file) ?? null))
      || manifestMovesUi(file, before.get(file) ?? null, after.get(file) ?? null);
    return { file, importing, graphAvailable, matched, mergeOnly, uiCapable };
  });

  const prScreenIds = new Set(recorded.keys());
  for (const item of info.filter((entry) => !entry.mergeOnly)) for (const entry of item.matched) prScreenIds.add(entry.id);
  const affected = new Map();
  const laneFiles = [...tests];
  let visual = false;
  for (const item of info) {
    if (!item.graphAvailable) warnings.push(`import graph unavailable for ${item.file}; classification used file type and screen-map evidence`);
    if (item.mergeOnly && item.graphAvailable && entries !== null) {
      const reached = item.matched.filter((entry) => prScreenIds.has(entry.id));
      if (reached.length === 0) {
        laneFiles.push(item.file);
        continue;
      }
      visual ||= item.uiCapable;
      reached.forEach((entry) => affected.set(entry.id, entry));
      laneFiles.push(item.file);
      continue;
    }
    if (item.mergeOnly && (!item.graphAvailable || entries === null)) {
      warnings.push(`import graph or screen map unavailable for incoming ${item.file}; classified upward for the PR scope`);
    }
    laneFiles.push(item.file);
    if (item.uiCapable) {
      visual = true;
      if (!item.mergeOnly || item.graphAvailable) item.matched.forEach((entry) => affected.set(entry.id, entry));
    }
  }

  const laneMap = normalizeLaneSelections(laneSelections);
  const lanes = [...new Set(laneFiles.flatMap((file) => laneMap?.get(file) ?? []))];
  if (laneFiles.length && lanes.length === 0) warnings.push("no narrowed lane selection was provided for the changed files");
  if (visual) {
    let screens = [...affected.values()].map((entry) => screenEvidence(entry, recorded.get(entry.id)));
    if (screens.length === 0) screens = recordedScreens(evidence);
    if (screens.length === 0) warnings.push("Visual QA is required but no mapped or PR-touched screen was supplied");
    return withWarnings({ outcome: QaImpact.Visual, lanes, screens, changedFiles: files, testFiles: tests,
      reason: "a changed file is UI-capable" }, warnings);
  }
  if (laneFiles.length) {
    return withWarnings({ outcome: QaImpact.LanesOnly, lanes, screens: [], changedFiles: files, testFiles: tests,
      reason: "changed files are not proven safe for local functional coverage" }, warnings);
  }
  return { outcome: QaImpact.None, lanes: [], screens: [], changedFiles: files, reason: "every changed file is explicitly proven safe" };
}

export function qaImpact({ worktree, since, evidence, graphImporters, featureMap, laneSelections, config, typescript = loadTypeScript(worktree) }) {
  const problems = evidenceProblems(evidence);
  if (problems.length) throw new Error(problems.join("; "));
  const files = changedFiles(worktree, since);
  const before = new Map(files.map((file) => [file, readAt(worktree, since, file)]));
  const after = new Map(files.map((file) => [file, readHead(worktree, file)]));
  const origins = changeOrigins(worktree, since);
  const result = classifyQaImpact({ files, before, after, importers: normalizeImporters(graphImporters), featureMap, evidence,
    laneSelections, ownFiles: origins.ownFiles, mergeFiles: origins.mergeFiles, config, typescript });
  if (result.lanes.length === 0) return result;
  const relevant = [...new Set([...(result.testFiles ?? []), ...files.filter((file) => !SAFE_ROOT_FILES.has(file))])].sort();
  const hash = createHash("sha256").update(JSON.stringify(result.lanes));
  for (const file of relevant) hash.update(`\n${file}\0${semanticSourceText(file, after.get(file) ?? null, typescript) ?? after.get(file) ?? "deleted"}`);
  return { ...result, laneKey: hash.digest("hex").slice(0, 16) };
}

/** Recomputes a caller's impact request in the current worktree. */
export function qaImpactRequest(worktree, request) {
  return qaImpact({ worktree, since: request.since, evidence: request.evidence, graphImporters: request.graphImporters,
    featureMap: request.featureMap, laneSelections: request.laneSelections, config: request.config });
}

function load(file, label) {
  if (!file || !existsSync(file)) throw new Error(`${label} is required and must exist`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function loadOptional(file) {
  return file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    worktree: { type: "string" }, since: { type: "string" }, evidence: { type: "string" }, "graph-importers": { type: "string" },
    "feature-map": { type: "string" }, "lane-selections": { type: "string" }, config: { type: "string" }, request: { type: "string" },
  } });
  if (!values.worktree || (!values.request && (!values.since || !values.evidence))) {
    throw new Error("Usage: qa-impact.mjs --worktree <path> (--request <classification request JSON> | --since <last QA boundary> --evidence <screen evidence JSON> [inputs])");
  }
  if (values.request) {
    process.stdout.write(`${JSON.stringify(qaImpactRequest(values.worktree, load(values.request, "classification request")), null, 2)}\n`);
    return;
  }
  const featureMapFile = values["feature-map"] ?? path.join(values.worktree, FEATURE_MAP_DEFAULT);
  const configFile = values.config ?? path.join(values.worktree, CONFIG_DEFAULT);
  const result = qaImpact({
    worktree: values.worktree,
    since: values.since,
    evidence: load(values.evidence, "screen evidence"),
    graphImporters: loadOptional(values["graph-importers"]),
    featureMap: loadOptional(featureMapFile),
    laneSelections: loadOptional(values["lane-selections"]),
    config: loadOptional(configFile),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
