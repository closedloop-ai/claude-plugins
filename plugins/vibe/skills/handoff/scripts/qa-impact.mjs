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
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { reportLanes } from "../../vibe/scripts/pre-pr-lanes.mjs";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";

export const QaImpact = Object.freeze({ None: "None", LanesOnly: "Lanes only", Visual: "Visual QA" });

const DOC_OR_RELEASE = /(?:^|\/)(?:CHANGELOG|CHANGES|HISTORY|RELEASES?|README)(?:\.|$)|\.(?:md|mdx|rst|txt)$/i;
const CI_CONFIG = /^(?:\.github\/|\.circleci\/|\.buildkite\/|Dockerfile$|Jenkinsfile$)/i;
const SOURCE = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|py|rb|go|rs|java|kt|swift|vue|svelte)$/i;
const UI_ASSET = /\.(?:svg|png|jpe?g|gif|webp|avif|ico|html?)$/i;
const DATA_ASSET = /\.json$/i;
const UI_LOCATION = /^(?:apps\/(?:app|storybook)\/|apps\/desktop\/src\/renderer\/|packages\/(?:app|design-system)\/|public\/)/;
const LOCKFILE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/;
const UI_PACKAGES = new Set(["react", "react-dom", "next", "tailwindcss", "storybook", "lucide-react", "framer-motion", "motion", "cmdk", "recharts", "sonner", "vaul"]);
const UI_PACKAGE_SCOPES = ["@radix-ui/", "@tailwindcss/", "@storybook/", "@floating-ui/"];
const GLOBAL_UI = /(?:^|\/)(?:tokens?|themes?|global-styles?|feature-flags?|ui-flags?)(?:\/|\.|$)|(?:^|\/)(?:globals?|tailwind)\.(?:css|scss|sass|less)$/i;
const VERSIONED_JSON = /(?:^|\/)(?:package|plugin)\.json$/;
const FEATURE_MAP_DEFAULT = ".claude/skills/control/feature-map.json";

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

/** Removes only whole-line comments whose syntax is unambiguous for the file. */
export function semanticSourceText(file, source) {
  if (source === null) return source;
  const hashComments = /\.(?:py|rb|sh|bash|zsh|ya?ml)$/i.test(file);
  const slashComments = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|vue|svelte)$/i.test(file);
  const htmlComments = /\.html?$/i.test(file);
  if (!hashComments && !slashComments && !htmlComments) return source;
  const comment = hashComments
    ? /^\s*#.*$/
    : htmlComments
      ? /^\s*<!--(?:[^]|\n)*?-->\s*$/
      : /^\s*(?:(?:\/\/|\/\*|\*|\*\/).*)$/;
  return source.split("\n").filter((line) => !comment.test(line)).map((line) => line.trim()).filter(Boolean).join("\n");
}

function commentOnly(file, before, after) {
  return before !== after && semanticSourceText(file, before) === semanticSourceText(file, after);
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

/** Exact UI package named by one lockfile line, or null. */
export function lockfileUiPackage(line) {
  const text = line.trim().replace(/^['"]/, "").replace(/^\/?node_modules\//, "");
  const found = /^(?<name>@[^/\s:'"]+\/[^@\s:'"]+|[^@/\s:'"]+)(?:@[^\s:'"]+)?['"]?:/.exec(text)?.groups?.name;
  if (!found) return null;
  return UI_PACKAGES.has(found) || UI_PACKAGE_SCOPES.some((scope) => found.startsWith(scope)) ? found : null;
}

function normalizeCodePath(value) {
  const text = String(value).trim();
  return text.includes(": ") ? text.slice(text.indexOf(": ") + 2) : text;
}

function pathMatches(file, owner) {
  if (file === owner) return true;
  if (owner.endsWith("/")) return file.startsWith(owner);
  if (!file.startsWith(owner)) return false;
  return ["/", ".", "-", "_"].includes(file[owner.length]);
}

function featurePaths(entry) {
  return [...(entry.webPages ?? []), ...(entry.code ?? []).map(normalizeCodePath)].filter(Boolean);
}

function normalizeImporters(raw) {
  if (raw === undefined || raw === null) return null;
  const source = raw?.importers ?? raw?.files ?? raw ?? {};
  if (Array.isArray(source)) {
    return new Map(source.map((entry) => [entry.file, entry.importers ?? entry.paths ?? []]));
  }
  return new Map(Object.entries(source));
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
  return (evidence?.screens ?? []).map((screen) => ({
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

/** Classifies a prepared changed-file inventory. */
export function classifyQaImpact({ files, before, after, importers, featureMap, evidence, lanes, ownFiles = new Set() }) {
  const recorded = evidenceById(evidence);
  const tests = [];
  const candidates = [];
  const globalUiFiles = new Set();
  for (const file of files) {
    const oldText = before.get(file) ?? null;
    const newText = after.get(file) ?? null;
    if (DOC_OR_RELEASE.test(file) || CI_CONFIG.test(file) || commentOnly(file, oldText, newText) || versionOnly(file, oldText, newText)) continue;
    if (isTestFile(file)) {
      tests.push(file);
      continue;
    }
    if (LOCKFILE.test(file)) {
      if (lockfileMovesUi(oldText, newText)) globalUiFiles.add(file);
      continue;
    }
    if (!SOURCE.test(file) && !UI_ASSET.test(file) && !DATA_ASSET.test(file)) continue;
    candidates.push(file);
    if (GLOBAL_UI.test(file)) globalUiFiles.add(file);
  }

  if (candidates.length === 0 && globalUiFiles.size === 0) {
    return tests.length
      ? { outcome: QaImpact.LanesOnly, lanes, screens: [], changedFiles: files, testFiles: tests, reason: "only tests can be affected" }
      : { outcome: QaImpact.None, lanes: [], screens: [], changedFiles: files, reason: "the changes cannot affect automated QA" };
  }

  const entries = Array.isArray(featureMap?.entries) ? featureMap.entries : null;
  const affected = new Map();
  const warnings = [];
  if (entries === null) warnings.push("FEATURE_MAP is unavailable; UI-reaching changes use the recorded PR screens");
  let classifyUp = globalUiFiles.size > 0;
  for (const file of candidates) {
    const importing = importers?.get(file);
    if (importers === null || importing === undefined) {
      classifyUp = true;
      warnings.push(`code importers missing for ${file}; classified as Visual QA for the PR screens`);
      continue;
    }
    const paths = [file, ...importing];
    if (entries === null) {
      if (UI_LOCATION.test(file) || UI_ASSET.test(file) || importing.some((item) => UI_LOCATION.test(item))) classifyUp = true;
      continue;
    }
    const matched = entries.filter((entry) => featurePaths(entry).some((owner) => paths.some((item) => pathMatches(item, owner))));
    for (const entry of matched) {
      if (ownFiles.has(file) || recorded.has(entry.id)) affected.set(entry.id, entry);
    }
    const reachesUi = UI_LOCATION.test(file) || importing.some((item) => UI_LOCATION.test(item));
    if (matched.length === 0 && (globalUiFiles.has(file) || reachesUi || (UI_ASSET.test(file) && reachesUi) || (DATA_ASSET.test(file) && reachesUi))) {
      classifyUp = true;
      warnings.push(`no FEATURE_MAP screen resolved for ${file}; classified as Visual QA for the PR screens`);
    }
  }
  let screens = [...affected.values()].map((entry) => screenEvidence(entry, recorded.get(entry.id)));
  if (classifyUp) {
    const known = new Set(screens.map((screen) => screen.id));
    screens = [...screens, ...recordedScreens(evidence).filter((screen) => !known.has(screen.id))];
  }
  if (screens.length === 0) {
    return withWarnings(tests.length
      ? { outcome: QaImpact.LanesOnly, lanes, screens: [], changedFiles: files, testFiles: tests, reason: "no changed source reaches a rendered screen; only changed tests select lanes" }
      : { outcome: QaImpact.None, lanes: [], screens: [], changedFiles: files, reason: "no changed source reaches a rendered value checked by QA" }, warnings);
  }
  return withWarnings({ outcome: QaImpact.Visual, lanes, screens, changedFiles: files, testFiles: tests,
    reason: "changed source can alter rendered output" }, warnings);
}

export function qaImpact({ worktree, since, evidence, graphImporters, featureMap, laneReport }) {
  const problems = evidenceProblems(evidence);
  if (problems.length) throw new Error(problems.join("; "));
  const files = changedFiles(worktree, since);
  const before = new Map(files.map((file) => [file, readAt(worktree, since, file)]));
  const after = new Map(files.map((file) => [file, readHead(worktree, file)]));
  const lanes = laneReport === undefined ? [] : reportLanes(laneReport);
  if (lanes === null) throw new Error("the lane report names no lane and does not say nothing changed");
  const origins = changeOrigins(worktree, since);
  const result = classifyQaImpact({ files, before, after, importers: normalizeImporters(graphImporters), featureMap, evidence, lanes, ownFiles: origins.ownFiles });
  if (result.outcome === QaImpact.LanesOnly && laneReport === undefined) {
    throw new Error("a Lanes only result needs the repository lane report for the same diff");
  }
  if (lanes.length === 0) return result;
  const relevant = [...new Set([...(result.testFiles ?? []), ...files.filter((file) => SOURCE.test(file) || UI_ASSET.test(file) || DATA_ASSET.test(file) || LOCKFILE.test(file))])].sort();
  const hash = createHash("sha256").update(JSON.stringify(lanes));
  for (const file of relevant) hash.update(`\n${file}\0${semanticSourceText(file, after.get(file) ?? null) ?? "deleted"}`);
  return { ...result, laneKey: hash.digest("hex").slice(0, 16) };
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
    "feature-map": { type: "string" }, "lane-report": { type: "string" },
  } });
  if (!values.worktree || !values.since || !values.evidence) {
    throw new Error("Usage: qa-impact.mjs --worktree <path> --since <last QA boundary> --evidence <screen evidence JSON> [--graph-importers <code_importers JSON>] [--feature-map <feature map JSON>] [--lane-report <lane report>]");
  }
  const featureMapFile = values["feature-map"] ?? path.join(values.worktree, FEATURE_MAP_DEFAULT);
  const result = qaImpact({
    worktree: values.worktree,
    since: values.since,
    evidence: load(values.evidence, "screen evidence"),
    graphImporters: loadOptional(values["graph-importers"]),
    featureMap: loadOptional(featureMapFile),
    laneReport: values["lane-report"] ? readFileSync(values["lane-report"], "utf8") : undefined,
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
