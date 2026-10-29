#!/usr/bin/env node
// Classifies only the changes made since the last automated QA pass. The
// result decides whether local QA needs nothing, selected functional lanes,
// or visual QA for named screens and their previously checked states.
// Evidence is screen-addressed. A commit id is only a diff boundary and is
// never part of the evidence identity.
// Importer JSON shape: {"importers":{"changed/file":["importer/file"]}}.
// Evidence JSON shape: {"screens":[{"id":"screen","states":[],"flagArms":[]}]}.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { reportLanes } from "../../vibe/scripts/pre-pr-lanes.mjs";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";

export const QaImpact = Object.freeze({ None: "None", LanesOnly: "Lanes only", Visual: "Visual QA" });

const DOC_OR_RELEASE = /(?:^|\/)(?:CHANGELOG|CHANGES|HISTORY|RELEASES?|README)(?:\.|$)|\.(?:md|mdx|rst|txt)$/i;
const CI_CONFIG = /^(?:\.github\/|\.circleci\/|\.buildkite\/)|(?:^|\/)(?:Dockerfile|Jenkinsfile)$|(?:^|\/)(?:ci|workflows?)\//i;
const SOURCE = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|py|rb|go|rs|java|kt|swift|vue|svelte)$/i;
const COMMENTABLE = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|py|rb|sh|bash|zsh|yml|yaml|vue|svelte)$/i;
const LOCKFILE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/;
const UI_LIBRARY = /(?:react|radix|tailwind|storybook|lucide|floating-ui|framer-motion|cmdk|design-system)/i;
const GLOBAL_UI = /(?:^|\/)(?:tokens?|themes?|styles?|flags?)\b|(?:^|\/)tailwind\.|\.css$/i;
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
  const absolute = path.join(worktree, file);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

/** Removes comments and formatting that cannot change executable or rendered behavior. */
export function semanticSourceText(file, source) {
  if (source === null || !COMMENTABLE.test(file)) return source;
  let text = source;
  if (/\.(?:py|rb|sh|bash|zsh|ya?ml)$/i.test(file)) {
    text = text.split("\n").map((line) => {
      let quote = null;
      let escaped = false;
      for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (escaped) {
          escaped = false;
        } else if (char === "\\" && quote) {
          escaped = true;
        } else if (quote) {
          if (char === quote) quote = null;
        } else if (char === "'" || char === '"') {
          quote = char;
        } else if (char === "#") {
          return line.slice(0, index);
        }
      }
      return line;
    }).join("\n");
  } else {
    let result = "";
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      const next = text[index + 1];
      if (lineComment) {
        if (char === "\n") {
          lineComment = false;
          result += char;
        }
      } else if (blockComment) {
        if (char === "*" && next === "/") {
          blockComment = false;
          index++;
        } else if (char === "\n") {
          result += char;
        }
      } else if (escaped) {
        result += char;
        escaped = false;
      } else if (quote) {
        result += char;
        if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
      } else if (char === "'" || char === '"' || char === "`") {
        quote = char;
        result += char;
      } else if (char === "/" && next === "/") {
        lineComment = true;
        index++;
      } else if (char === "/" && next === "*") {
        blockComment = true;
        index++;
      } else {
        result += char;
      }
    }
    text = result.replace(/<!--[^]*?-->/g, "");
  }
  return text.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
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
  return (after ?? "").split("\n").some((line) => !oldLines.has(line) && UI_LIBRARY.test(line));
}

function normalizeCodePath(value) {
  const text = String(value).trim();
  return text.includes(": ") ? text.slice(text.indexOf(": ") + 2).replace(/\/$/, "") : text.replace(/\/$/, "");
}

function pathMatches(file, owner) {
  return file === owner || file.startsWith(`${owner}/`) || owner.startsWith(`${file}/`) || file.startsWith(owner);
}

function featurePaths(entry) {
  return [...(entry.webPages ?? []), ...(entry.code ?? []).map(normalizeCodePath)].filter(Boolean);
}

function normalizeImporters(raw) {
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

function mergeOnly(worktree, since) {
  const commits = lines(git(worktree, ["rev-list", "--first-parent", "--parents", `${since}..HEAD`]));
  return commits.length > 0 && commits.every((line) => line.split(/\s+/).length > 2);
}

function changedFiles(worktree, since) {
  return lines(git(worktree, ["diff", "--name-only", "--no-renames", `${since}..HEAD`]));
}

function changedDiff(worktree, since, file) {
  try {
    return git(worktree, ["diff", "--unified=0", "--no-renames", `${since}..HEAD`, "--", file]);
  } catch {
    return "";
  }
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

/** Classifies a prepared changed-file inventory. */
export function classifyQaImpact({ files, before, after, diffs, importers, featureMap, evidence, lanes, onlyMerges }) {
  const recorded = evidenceById(evidence);
  const tests = [];
  const source = [];
  let globalUi = false;
  for (const file of files) {
    const oldText = before.get(file) ?? null;
    const newText = after.get(file) ?? null;
    if (DOC_OR_RELEASE.test(file) || CI_CONFIG.test(file) || commentOnly(file, oldText, newText) || versionOnly(file, oldText, newText)) continue;
    if (isTestFile(file)) {
      tests.push(file);
      continue;
    }
    if (LOCKFILE.test(file)) {
      globalUi ||= lockfileMovesUi(oldText, newText);
      continue;
    }
    if (!SOURCE.test(file)) continue;
    source.push(file);
    globalUi ||= GLOBAL_UI.test(file) || /(?:copy|label|title|route|flag)/i.test(diffs.get(file) ?? "");
  }

  if (source.length === 0 && !globalUi) {
    return tests.length
      ? { outcome: QaImpact.LanesOnly, lanes, screens: [], changedFiles: files, testFiles: tests, reason: "only tests can be affected" }
      : { outcome: QaImpact.None, lanes: [], screens: [], changedFiles: files, reason: "the changes cannot affect automated QA" };
  }

  const missingGraph = source.filter((file) => !importers.has(file));
  if (missingGraph.length) throw new Error(`graph importer results are missing for: ${missingGraph.join(", ")}`);
  const reached = new Set(source);
  for (const file of source) for (const importer of importers.get(file) ?? []) reached.add(importer);
  let entries = (featureMap.entries ?? []).filter((entry) => featurePaths(entry).some((owner) => [...reached].some((file) => pathMatches(file, owner))));
  if (globalUi && entries.length === 0) entries = (featureMap.entries ?? []).filter((entry) => recorded.has(entry.id));
  if (onlyMerges) entries = entries.filter((entry) => recorded.has(entry.id));
  const screens = entries.map((entry) => screenEvidence(entry, recorded.get(entry.id)));
  if (screens.length === 0) {
    return tests.length
      ? { outcome: QaImpact.LanesOnly, lanes, screens: [], changedFiles: files, testFiles: tests, reason: "no changed source reaches a rendered screen; only changed tests select lanes" }
      : { outcome: QaImpact.None, lanes: [], screens: [], changedFiles: files, reason: "no changed source reaches a rendered value checked by QA" };
  }
  return { outcome: QaImpact.Visual, lanes, screens, changedFiles: files, testFiles: tests,
    reason: onlyMerges ? "the main merge changed dependencies of previously checked screens" : "changed source can alter rendered output" };
}

export function qaImpact({ worktree, since, evidence, graphImporters, featureMap, laneReport }) {
  const problems = evidenceProblems(evidence);
  if (problems.length) throw new Error(problems.join("; "));
  const files = changedFiles(worktree, since);
  const before = new Map(files.map((file) => [file, readAt(worktree, since, file)]));
  const after = new Map(files.map((file) => [file, readHead(worktree, file)]));
  const diffs = new Map(files.map((file) => [file, changedDiff(worktree, since, file)]));
  const lanes = laneReport === undefined ? [] : reportLanes(laneReport);
  if (lanes === null) throw new Error("the lane report names no lane and does not say nothing changed");
  const result = classifyQaImpact({ files, before, after, diffs, importers: normalizeImporters(graphImporters), featureMap, evidence, lanes, onlyMerges: mergeOnly(worktree, since) });
  if (result.outcome === QaImpact.LanesOnly && laneReport === undefined) {
    throw new Error("a Lanes only result needs the repository lane report for the same diff");
  }
  return result;
}

function load(file, label) {
  if (!file || !existsSync(file)) throw new Error(`${label} is required and must exist`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    worktree: { type: "string" }, since: { type: "string" }, evidence: { type: "string" }, "graph-importers": { type: "string" },
    "feature-map": { type: "string" }, "lane-report": { type: "string" },
  } });
  if (!values.worktree || !values.since || !values.evidence || !values["graph-importers"]) {
    throw new Error("Usage: qa-impact.mjs --worktree <path> --since <last QA boundary> --evidence <screen evidence JSON> --graph-importers <code_importers JSON> [--feature-map <feature map JSON>] [--lane-report <lane report>]");
  }
  const featureMapFile = values["feature-map"] ?? path.join(values.worktree, FEATURE_MAP_DEFAULT);
  const result = qaImpact({
    worktree: values.worktree,
    since: values.since,
    evidence: load(values.evidence, "screen evidence"),
    graphImporters: load(values["graph-importers"], "graph importer results"),
    featureMap: load(featureMapFile, "feature map"),
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
