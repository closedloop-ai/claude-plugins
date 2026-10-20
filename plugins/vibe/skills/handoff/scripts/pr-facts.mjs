#!/usr/bin/env node
// Computes the facts a vibe pull request body must state, from the session's
// diff rather than from anyone's summary, and checks a drafted body against
// them before the pull request is created or its body refreshed. Vibe pull
// request bodies kept getting these wrong: overlaps listed from memory missed
// open pull requests sharing six files, flipped and deleted assertions went
// unnamed, a behavior change was attributed to a file whose diff only removed
// a comment, and pull requests opened while device runs were still pending.
//
// Subcommands (each prints one JSON object; `check`, `cite-check` and
// `evidence` exit 1 when they find a problem):
//   overlap     open pull requests sharing a changed file, or a module a
//               changed file imports
//   assertions  flipped and removed assertions, added skips and deleted test files
//   contracts   changed or removed exported declarations, and new 4xx refusals
//               in apps/api
//   asks        every "say/state/decide/explain ... in the PR" instruction in
//               the ticket text
//   lanes       whether the diff is server-only, and the evidence lanes it needs
//   evidence    every required lane passed on the published commit
//   cite-check  the body against the facts
//   facts       everything above except the body and evidence checks
//   check       facts plus cite-check, plus evidence when --runs is given
//
// Usage:
//   pr-facts.mjs <subcommand> --worktree <wt> [--pr-base <branch>] [--base <ref>]
//     [--prs-json <file>] [--body <file>] [--ticket <file>] [--runs <file>] [--commit <sha>]
//     [--files <a,b,...>]
//
// `--files` replaces the diff with the files a plan will touch, so `overlap`
// can run before any code exists (requirements research).
// `--prs-json` reads `[{number, title, headRefName, files: [...]}]` instead of
// asking `gh`; without it the open pull requests come from
// `gh pr list` and `gh pr diff --name-only` on closedloop-ai/symphony-alpha.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";

const REPO = "closedloop-ai/symphony-alpha";
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const SUBCOMMANDS = ["overlap", "assertions", "contracts", "asks", "lanes", "evidence", "cite-check", "facts", "check"];

const DIFF_HEADER = /^diff --git a\/.+ b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const ASSERTION = /\b(?:expect|assert)\s*[.(]|\.(?:toBe|toEqual|toStrictEqual|toMatch|toHaveBeenCalled\w*|toThrow|toContain|toHaveLength|toHaveCount|toBeVisible|toHaveText)\b/;
const ADDED_SKIP = /\b(?:it|test|describe)\.(?:skip|todo|only)\s*\(|\bxit\s*\(/;
const EXPORT_DECLARATION = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const BODY_DECLARATION = /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface)\b/;
const REFUSAL_STATUS = /\bstatus\s*[:=(]\s*(4\d\d)\b|\b(?:NextResponse|Response)\.json\([^)]*\b(4\d\d)\b/;
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];
const ASK_SENTENCE = /[^.!?\n]*\b(?:say|state|explain|decide|note|document|justify|describe)\b[^.!?\n]*\bin\s+the\s+(?:PR|pull request)\b[^.!?\n]*[.!?]?/gi;
const CITATION = /(?<![\w/.-])((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z]{1,5}):(\d+)\b/g;
const PR_REFERENCE = /#(\d{3,6})\b/g;
const UNFINISHED = new Set(["pending", "running", "queued", "awaiting", "in_progress", "in-progress", "skipped", "unknown"]);
const UI_PREFIXES = [
  "apps/app/", "apps/web/", "apps/storybook/", "apps/prototypes/", "apps/desktop/src/renderer/",
  "packages/app/", "packages/design-system/",
];
const DESKTOP_HOST_PREFIXES = ["apps/desktop/src/renderer/", "packages/app/"];
const UI_FILE = /\.(?:tsx|jsx|css|scss)$/;
const STORY_FILE = /\.stories\.tsx?$/;

/** The sentence a pull request against a branch other than main must carry. */
export const STACKED_BASE_STATEMENT = "Stacked pull request: its base is not main, so no required CI lane runs on it; local evidence is listed below.";

/** The line a server-only session records instead of UI, Storybook and Desktop evidence. */
export const SERVER_ONLY_LINE = "Server-only change: no UI, Storybook or Desktop surface changed, so those checks were not run.";

export const LANE = {
  webHost: "web-host",
  desktopHost: "desktop-host",
  webkitIphone: "webkit-iphone",
  chromiumPixel: "chromium-pixel",
  storybookPlays: "storybook-plays",
  e2e: "e2e",
};

/** Parses `git diff -U0` output into per-file hunks with their added and removed lines. */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: null, oldPath: null, headerPath: DIFF_HEADER.exec(line)?.[1] ?? null, status: "M", hunks: [] };
      files.push(file);
      hunk = null;
    } else if (!file) {
      continue;
    } else if (line.startsWith("new file mode")) {
      file.status = "A";
    } else if (line.startsWith("deleted file mode")) {
      file.status = "D";
    } else if (line.startsWith("rename from ")) {
      file.status = "R";
      file.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      file.path = line.slice("rename to ".length);
    } else if (line.startsWith("--- ") && !hunk) {
      file.oldPath ??= line === "--- /dev/null" ? null : line.slice(6);
    } else if (line.startsWith("+++ ") && !hunk) {
      file.path ??= line === "+++ /dev/null" ? file.oldPath : line.slice(6);
    } else if (HUNK_HEADER.test(line)) {
      const [, oldStart, oldCount, newStart, newCount] = HUNK_HEADER.exec(line);
      hunk = {
        oldStart: Number(oldStart), oldCount: oldCount === undefined ? 1 : Number(oldCount),
        newStart: Number(newStart), newCount: newCount === undefined ? 1 : Number(newCount),
        removed: [], added: [],
      };
      file.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
    } else if (hunk && line.startsWith("-")) {
      hunk.removed.push({ line: oldLine++, text: line.slice(1) });
    } else if (hunk && line.startsWith("+")) {
      hunk.added.push({ line: newLine++, text: line.slice(1) });
    }
  }
  for (const entry of files) {
    entry.path ??= entry.oldPath ?? entry.headerPath;
    delete entry.headerPath;
  }
  return files.filter((entry) => entry.path);
}

/** The session diff against `base`: committed and uncommitted work, plus untracked files as added. */
export function readDiff(worktree, base) {
  const files = parseDiff(git(worktree, ["diff", "-U0", "--no-color", "--no-ext-diff", "-M", base]));
  const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  for (const file of untracked) {
    const lines = readFileSync(path.join(worktree, file), "utf8").split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    files.push({
      path: file, oldPath: null, status: "A",
      hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length, removed: [],
        added: lines.map((text, index) => ({ line: index + 1, text })) }],
    });
  }
  return files;
}

/** Open pull requests that share a changed file, or a file a changed file imports. */
export function computeOverlap({ changed, imported = [], prs, ownBranch }) {
  const changedSet = new Set(changed);
  const importedSet = new Set(imported.filter((file) => !changedSet.has(file)));
  const overlaps = [];
  for (const pr of prs) {
    if (ownBranch && pr.headRefName === ownBranch) {
      continue;
    }
    const files = pr.files ?? [];
    const sharedFiles = files.filter((file) => changedSet.has(file)).sort();
    const importedFiles = files.filter((file) => importedSet.has(file)).sort();
    if (sharedFiles.length > 0 || importedFiles.length > 0) {
      overlaps.push({ number: pr.number, title: pr.title, sharedFiles, importedFiles });
    }
  }
  return overlaps.sort((a, b) => a.number - b.number);
}

/** Repo-relative files that the given source files import and that exist in the worktree. */
export function importedModules(worktree, files) {
  const found = new Set();
  for (const file of files) {
    const absolute = path.join(worktree, file);
    if (!SOURCE_FILE.test(file) || !existsSync(absolute)) {
      continue;
    }
    for (const match of readFileSync(absolute, "utf8").matchAll(IMPORT_SPECIFIER)) {
      const resolved = resolveSpecifier(worktree, file, match[1]);
      if (resolved) {
        found.add(resolved);
      }
    }
  }
  return [...found].sort();
}

function resolveSpecifier(worktree, importer, specifier) {
  let bases;
  if (specifier.startsWith(".")) {
    bases = [path.posix.join(path.posix.dirname(importer), specifier)];
  } else if (specifier.startsWith("@repo/")) {
    const [, pkg, ...rest] = specifier.split("/");
    const sub = rest.join("/");
    bases = sub ? [`packages/${pkg}/${sub}`, `packages/${pkg}/src/${sub}`] : [`packages/${pkg}/index`, `packages/${pkg}/src/index`];
  } else {
    return null;
  }
  for (const base of bases) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = `${base}${suffix}`;
      if (SOURCE_FILE.test(candidate) && existsSync(path.join(worktree, candidate))) {
        return candidate;
      }
    }
  }
  return null;
}

/** Flipped and removed assertions, added skips, and deleted test files, with file and line. */
export function assertionChanges(files) {
  const changes = [];
  for (const file of files.filter((entry) => isTestFile(entry.path) || (entry.oldPath && isTestFile(entry.oldPath)))) {
    if (file.status === "D") {
      changes.push({ kind: "deleted-test-file", path: file.path });
      continue;
    }
    for (const hunk of file.hunks) {
      const removed = hunk.removed.filter((line) => ASSERTION.test(line.text));
      const added = hunk.added.filter((line) => ASSERTION.test(line.text));
      removed.forEach((line, index) => {
        const replacement = added[index];
        if (replacement) {
          changes.push({ kind: "flipped", path: file.path, line: replacement.line, oldLine: line.line,
            before: line.text.trim(), after: replacement.text.trim() });
        } else {
          changes.push({ kind: "removed", path: file.path, line: hunk.newStart, oldLine: line.line, before: line.text.trim() });
        }
      });
      for (const line of hunk.added.filter((entry) => ADDED_SKIP.test(entry.text))) {
        changes.push({ kind: "skip-added", path: file.path, line: line.line, after: line.text.trim() });
      }
    }
  }
  return changes;
}

/** Changed or removed exported declarations outside tests, and new 4xx refusals in apps/api. */
export function contractChanges(files) {
  const contracts = [];
  const refusals = [];
  for (const file of files.filter((entry) => SOURCE_FILE.test(entry.path) && !isTestFile(entry.path))) {
    for (const hunk of file.hunks) {
      const addedNames = new Map(hunk.added
        .map((line) => [EXPORT_DECLARATION.exec(line.text)?.[1], line])
        .filter(([name]) => name));
      for (const line of hunk.removed) {
        const name = EXPORT_DECLARATION.exec(line.text)?.[1];
        if (!name) {
          continue;
        }
        const replacement = addedNames.get(name);
        if (replacement) {
          if (declarationSignature(replacement.text) !== declarationSignature(line.text)) {
            contracts.push({ kind: "changed", name, path: file.path, line: replacement.line,
              before: line.text.trim(), after: replacement.text.trim() });
          }
        } else if (!fileAddsExport(file, name)) {
          contracts.push({ kind: "removed", name, path: file.path, line: hunk.newStart, before: line.text.trim() });
        }
      }
      if (file.path.startsWith("apps/api/")) {
        for (const line of hunk.added) {
          const match = REFUSAL_STATUS.exec(line.text);
          if (match) {
            refusals.push({ path: file.path, line: line.line, status: Number(match[1] ?? match[2]), text: line.text.trim() });
          }
        }
      }
    }
  }
  return { contracts, refusals };
}

/** A function, class or interface is compared up to its body; a type, constant or enum by its whole line. */
function declarationSignature(text) {
  const trimmed = text.trim();
  return BODY_DECLARATION.test(trimmed) ? trimmed.split("{")[0].trim() : trimmed;
}

function fileAddsExport(file, name) {
  return file.hunks.some((hunk) => hunk.added.some((line) => EXPORT_DECLARATION.exec(line.text)?.[1] === name));
}

/** Every sentence in the ticket that asks for something to be said in the pull request. */
export function extractAsks(ticketText) {
  return [...new Set([...ticketText.matchAll(ASK_SENTENCE)].map((match) => normalize(match[0])))].filter(Boolean);
}

/** Whether the diff touches any UI surface, and the evidence lanes the pull request needs. */
export function classifyLanes(changed, { touchFlows = [] } = {}) {
  const ui = changed.filter((file) => UI_PREFIXES.some((prefix) => file.startsWith(prefix)) || (UI_FILE.test(file) && !isTestFile(file)));
  if (ui.length === 0) {
    const e2e = changed.some((file) => file.startsWith("e2e/"));
    return { serverOnly: true, line: SERVER_ONLY_LINE, uiFiles: [], requiredLanes: e2e ? [LANE.e2e] : [] };
  }
  const lanes = [LANE.webHost];
  if (changed.some((file) => DESKTOP_HOST_PREFIXES.some((prefix) => file.startsWith(prefix)))) {
    lanes.push(LANE.desktopHost);
  }
  if (touchFlows.length > 0) {
    lanes.push(LANE.webkitIphone, LANE.chromiumPixel);
  }
  if (changed.some((file) => STORY_FILE.test(file))) {
    lanes.push(LANE.storybookPlays);
  }
  if (changed.some((file) => file.startsWith("e2e/"))) {
    lanes.push(LANE.e2e);
  }
  return { serverOnly: false, uiFiles: ui, requiredLanes: lanes };
}

/** Every required lane has a finished, passing run on the published commit with its command and outcome. */
export function checkEvidence(runsFile, changed, commit) {
  const problems = [];
  if (!Array.isArray(runsFile?.touchFlows)) {
    problems.push("the runs file has no touchFlows list; list every touched card, narrow or touch flow, or [] with touchFlowsReason");
  } else if (runsFile.touchFlows.length === 0 && !runsFile.touchFlowsReason) {
    problems.push("touchFlows is empty without a touchFlowsReason");
  }
  const lanes = classifyLanes(changed, { touchFlows: runsFile?.touchFlows ?? [] });
  const runs = Array.isArray(runsFile?.runs) ? runsFile.runs : [];
  for (const lane of lanes.requiredLanes) {
    const laneRuns = runs.filter((run) => run.lane === lane);
    if (laneRuns.length === 0) {
      problems.push(`${lane}: no run recorded`);
      continue;
    }
    for (const run of laneRuns) {
      const status = String(run.status ?? "").toLowerCase();
      if (UNFINISHED.has(status) || status === "") {
        problems.push(`${lane}: ${status || "no status"}; a pull request never opens on an unfinished run`);
      } else if (status !== "passed") {
        problems.push(`${lane}: ${status}`);
      }
      if (!run.command) {
        problems.push(`${lane}: no command recorded`);
      }
      if (!run.outcome) {
        problems.push(`${lane}: no visible outcome recorded`);
      }
      if (commit && run.commit !== commit) {
        problems.push(`${lane}: ran on ${run.commit ?? "an unrecorded commit"}, not the published commit ${commit}`);
      }
    }
  }
  return { ok: problems.length === 0, requiredLanes: lanes.requiredLanes, serverOnly: lanes.serverOnly, problems };
}

/** Checks a drafted pull request body against the diff's facts. */
export function citeCheck(body, { files, overlap = [], assertions = [], contracts = [], refusals = [], asks = [], prBase = "main" }) {
  const problems = [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const match of body.matchAll(CITATION)) {
    const [cited, file, lineText] = match;
    const entry = byPath.get(file);
    if (!entry) {
      problems.push(`${cited}: the diff does not change ${file}`);
    } else if (entry.status === "D") {
      problems.push(`${cited}: ${file} is deleted; cite the deletion, not a line`);
    } else if (!lineInDiff(entry, Number(lineText))) {
      problems.push(`${cited}: line ${lineText} is not a changed line of ${file}`);
    }
  }
  const mentioned = new Set([...body.matchAll(PR_REFERENCE)].map((match) => Number(match[1])));
  for (const pr of overlap) {
    if (!mentioned.has(pr.number)) {
      problems.push(`overlap with open #${pr.number} (${[...pr.sharedFiles, ...pr.importedFiles].join(", ")}) is not stated`);
    }
  }
  for (const change of assertions) {
    const cite = change.kind === "deleted-test-file" ? change.path : `${change.path}:${change.line}`;
    if (!body.includes(cite)) {
      problems.push(`${change.kind} assertion change ${cite} is not listed`);
    }
  }
  for (const contract of contracts) {
    if (!body.includes(contract.name)) {
      problems.push(`${contract.kind} export ${contract.name} (${contract.path}:${contract.line}) is not listed`);
    }
  }
  for (const refusal of refusals) {
    if (!body.includes(`${refusal.path}:${refusal.line}`)) {
      problems.push(`new ${refusal.status} refusal ${refusal.path}:${refusal.line} is not listed under Breaking changes`);
    }
  }
  const flatBody = normalize(body);
  for (const ask of asks) {
    if (!flatBody.includes(ask)) {
      problems.push(`the ticket asks "${ask}" and the body does not quote and answer it`);
    }
  }
  if (prBase !== "main" && !flatBody.includes(normalize(STACKED_BASE_STATEMENT))) {
    problems.push(`the base is ${prBase}, not main, and the body does not carry the stacked-base statement`);
  }
  return { ok: problems.length === 0, problems };
}

function lineInDiff(file, line) {
  return file.hunks.some((hunk) => {
    if (hunk.added.some((entry) => entry.line === line)) {
      return true;
    }
    return hunk.newCount === 0 && (line === hunk.newStart || line === hunk.newStart + 1);
  });
}

function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

function git(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER }).trim();
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER }).trim();
}

/** Every open pull request on symphony-alpha with its changed files. */
export function loadOpenPrs() {
  const prs = JSON.parse(gh(["pr", "list", "--repo", REPO, "--state", "open", "--limit", "200", "--json", "number,title,headRefName"]));
  return prs.map((pr) => ({
    ...pr,
    files: gh(["pr", "diff", String(pr.number), "--repo", REPO, "--name-only"]).split("\n").filter(Boolean),
  }));
}

function collectFacts(values) {
  const worktree = path.resolve(values.worktree);
  const prBase = values["pr-base"] ?? "main";
  const base = values.base ?? git(worktree, ["merge-base", "HEAD", `origin/${prBase}`]);
  const planned = values.files ? values.files.split(",").map((file) => file.trim()).filter(Boolean) : null;
  const files = planned ? [] : readDiff(worktree, base);
  const changed = planned ?? files.map((file) => file.path);
  const live = planned ?? files.filter((file) => file.status !== "D").map((file) => file.path);
  const facts = { base, prBase, changed, files };
  const needs = (name) => values.subcommand === name || values.subcommand === "facts" || values.subcommand === "check";
  if (needs("overlap") || values.subcommand === "cite-check") {
    const prs = values["prs-json"] ? JSON.parse(readFileSync(values["prs-json"], "utf8")) : loadOpenPrs();
    const ownBranch = git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
    facts.overlap = computeOverlap({ changed, imported: importedModules(worktree, live), prs, ownBranch });
  }
  facts.assertions = assertionChanges(files);
  Object.assign(facts, contractChanges(files));
  facts.asks = values.ticket ? extractAsks(readFileSync(values.ticket, "utf8")) : [];
  facts.lanes = classifyLanes(changed);
  return facts;
}

function run(values) {
  const facts = collectFacts(values);
  const { files, ...shown } = facts;
  switch (values.subcommand) {
    case "overlap":
      return { ok: true, overlap: facts.overlap };
    case "assertions":
      return { ok: true, assertions: facts.assertions };
    case "contracts":
      return { ok: true, contracts: facts.contracts, refusals: facts.refusals };
    case "asks":
      return { ok: true, asks: facts.asks };
    case "lanes":
      return { ok: true, ...facts.lanes };
    case "evidence":
      return checkEvidence(readRuns(values), facts.changed, values.commit);
    case "facts":
      return { ok: true, ...shown, ...(facts.prBase === "main" ? {} : { requiredStatements: [STACKED_BASE_STATEMENT] }) };
    default: {
      if (!values.body) {
        throw new Error(`${values.subcommand} needs --body.`);
      }
      const cite = citeCheck(readFileSync(values.body, "utf8"), facts);
      if (values.subcommand === "cite-check") {
        return cite;
      }
      const evidence = values.runs ? checkEvidence(readRuns(values), facts.changed, values.commit) : null;
      const problems = [...cite.problems, ...(evidence?.problems ?? [])];
      return { ok: problems.length === 0, ...shown, ...(evidence ? { evidence } : {}), problems };
    }
  }
}

function readRuns(values) {
  if (!values.runs) {
    throw new Error("evidence needs --runs <file>.");
  }
  return JSON.parse(readFileSync(values.runs, "utf8"));
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      worktree: { type: "string" }, base: { type: "string" }, "pr-base": { type: "string" },
      "prs-json": { type: "string" }, body: { type: "string" }, ticket: { type: "string" },
      runs: { type: "string" }, commit: { type: "string" }, files: { type: "string" },
    },
  });
  try {
    const subcommand = positionals[0];
    if (!SUBCOMMANDS.includes(subcommand)) {
      throw new Error(`Usage: pr-facts.mjs <${SUBCOMMANDS.join("|")}> --worktree <wt> [options]`);
    }
    if (!values.worktree) {
      throw new Error("--worktree is required.");
    }
    const result = run({ ...values, subcommand });
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
