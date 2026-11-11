#!/usr/bin/env node
// The shape of each CI job that runs a check: its event tier, checkout depth,
// the env names it binds and its `if`. #9230 added a gate inside a batch-only
// job that checks out at depth 1 with no base ref. It passed in a full local
// clone, where origin/main exists, and every post-merge batch went red until
// #9237. Reproduce a changed check in this shape before calling it done, and
// record the run in `ciCheckRepros` (pr-facts.mjs).
//
// Usage: ci-job-shape.mjs --worktree <path> --needle <package script, file path or command> [--needle ...]
//
// Prints one JSON object per job whose block names a needle:
// {"workflow","job","tier","fetchDepth","env","if","checkout"}, and `NO-JOB <needle>`
// for a needle no job names (a needle reached only through another script needs that
// script as a needle too). The tier comes from `.github/pr-test-event-tiers.md`, else
// "unlisted". Exits 2 on bad usage. Changes nothing.

import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { workflowLaneDefinitions } from "../../vibe/scripts/dist/main-sync.mjs";
import { laneSourceShapeProblems, laneReportShapeProblems } from "./pr-evidence-schema.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { committedFile } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const { agentsTestCommand } = await vibeCore("lib/vibe/scripts/repository-commands.mjs");
export { agentsTestCommand };
const { providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");
export { workflowLaneDefinitions };

const JOB_KEY = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const TOP_KEY = /^\S/;
const FETCH_DEPTH = /^\s*fetch-depth:\s*(\d+)/m;
const ENV_NAME = /^\s+([A-Z][A-Z0-9_]{2,}):/gm;
const JOB_IF = /^ {4}if:\s*(.+)$/m;

/** Each job of a workflow's text as `{ job, block }`. */
export function workflowJobs(text) {
  const jobs = [];
  let inJobs = false;
  let current;
  for (const line of text.split("\n")) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (TOP_KEY.test(line)) { inJobs = false; current = undefined; continue; }
    const key = JOB_KEY.exec(line);
    if (key) { current = { job: key[1], block: "" }; jobs.push(current); continue; }
    if (current) current.block += `${line}\n`;
  }
  return jobs;
}

/** The tier the repository's event-tier table gives `job`, or "unlisted". */
export function tierOf(tiers, job) {
  const row = new RegExp(`^\\|\\s*\`${job.replace(/[-]/g, "\\-")}\`\\s*\\|\\s*\`([^\`]+)\``, "m").exec(tiers);
  return row ? row[1] : "unlisted";
}

/** The shape of every job that names one of `needles`, with the needles no job names. */
export function jobShapes(workflows, tiers, needles) {
  const shapes = [];
  const found = new Set();
  for (const { workflow, text } of workflows) {
    for (const { job, block } of workflowJobs(text)) {
      const hits = needles.filter((needle) => block.includes(needle));
      if (hits.length === 0) continue;
      for (const hit of hits) found.add(hit);
      const fetchDepth = Number(FETCH_DEPTH.exec(block)?.[1] ?? 1);
      const env = [...new Set([...block.matchAll(ENV_NAME)].map((match) => match[1]))].sort();
      shapes.push({ workflow, job, tier: tierOf(tiers, job), fetchDepth, env, if: JOB_IF.exec(block)?.[1]?.trim() ?? null,
        checkout: `fetch-depth ${fetchDepth === 0 ? "0 (full history)" : `${fetchDepth}, so no origin/main or base ref unless a step fetches one`}` });
    }
  }
  return { shapes, missing: needles.filter((needle) => !found.has(needle)) };
}

/** Exact repository lane source and matching commands, read from immutable declared workflow bytes. */
export function repositoryLaneReportProblems(report, worktree, commit) {
  const problems = laneReportShapeProblems(report);
  if (problems.length) return problems;
  const source = report.source ?? { kind: "command", command: report.command };
  let declared;
  if (worktree) {
    let content;
    try { content = committedFile(worktree, commit, "vibe-handoff-paths.json"); }
    catch {
      // No declaration: the built-in default takes the lanes from a committed CI workflow, or the test
      // command the repository's AGENTS.md names (or the bound provider's lane report).
      if (source.kind === "command") return defaultLaneCommands(worktree, commit).includes(source.command) ? []
        : ["undeclared repository lane command: without vibe-handoff-paths.json it must be the test command AGENTS.md names"];
      declared = { kind: source.kind, path: source.path };
    }
    if (content) try { declared = JSON.parse(content).laneSource; }
    catch { return ["invalid committed repository lane declaration JSON"]; }
  }
  if (declared !== undefined && laneSourceShapeProblems(declared).length) return ["invalid repository lane source declaration"];
  if (source.kind === "command") {
    if (declared && !isDeepStrictEqual(declared, source)) return ["lane report differs from the repository-declared lane source"];
    return declared || defaultLaneCommands(worktree, commit).includes(source.command) ? []
      : ["undeclared repository lane command"];
  }
  if (!worktree || source.commit !== commit || !isDeepStrictEqual(declared, { kind: source.kind, path: source.path })) {
    return ["workflow lane source differs from the verified repository declaration/commit"];
  }
  try {
    const content = committedFile(worktree, commit, source.path);
    if (createHash("sha256").update(content).digest("hex") !== source.sha256) return ["workflow lane definition hash changed"];
    const lanes = workflowLaneDefinitions(content.toString("utf8"));
    if (report.matches.length !== lanes.length || report.matches.some((lane, index) => lane.name !== lanes[index].name || lane.command !== lanes[index].command
      || lane.mentionOnly !== undefined || lane.notRunReason !== undefined)) return ["workflow lane report must contain every exact workflow job/matrix recipe in declaration order"];
    return [];
  } catch (error) { return [`workflow lane source could not be verified: ${error.message}`]; }
}

/** One-time metadata migration only when base, freshly fetched target and candidate have the same sole regular workflow. */
export function laneSourceBootstrap(worktree, base, mergeTarget) {
  try {
    const run = args => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const file = "vibe-handoff-paths.json";
    const before = JSON.parse(committedFile(worktree, base, file));
    const target = JSON.parse(committedFile(worktree, mergeTarget, file));
    if (Object.hasOwn(before, "laneSource") || Object.hasOwn(target, "laneSource") || !isDeepStrictEqual(before, target)) return null;
    for (const commit of [base, mergeTarget]) if (run(["ls-tree", "--format=%(objectmode)", commit, "--", file]).trim() !== "100644") return null;
    const absolute = path.join(worktree, file); const stat = lstatSync(absolute);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o644) return null;
    const bytes = readFileSync(absolute);
    const { laneSource, ...permissions } = JSON.parse(bytes);
    if (!isDeepStrictEqual(permissions, before) || laneSourceShapeProblems(laneSource).length || laneSource.kind !== "github-workflow") return null;
    const workflowsAt = commit => run(["ls-tree", "-rz", "--full-tree", commit, "--", ".github/workflows"]).split("\0").filter(Boolean)
      .map(line => { const tab = line.indexOf("\t"); return { path: line.slice(tab + 1), mode: line.slice(0, tab).split(" ")[0] }; })
      .filter(entry => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.path));
    const original = workflowsAt(base); const fetched = workflowsAt(mergeTarget);
    if (original.length !== 1 || !isDeepStrictEqual(original, fetched) || original[0].path !== laneSource.path
      || !["100644", "100755"].includes(original[0].mode)) return null;
    for (const directory of [".github", ".github/workflows"]) if (!lstatSync(path.join(worktree, directory)).isDirectory()) return null;
    const candidate = readdirSync(path.join(worktree, ".github/workflows")).filter(name => /\.ya?ml$/.test(name)).map(name => `.github/workflows/${name}`);
    if (candidate.length !== 1 || candidate[0] !== laneSource.path) return null;
    const workflow = path.join(worktree, laneSource.path); const currentMode = lstatSync(workflow);
    if (!currentMode.isFile() || (currentMode.mode & 0o7777) !== (original[0].mode === "100755" ? 0o755 : 0o644)) return null;
    const definition = committedFile(worktree, base, laneSource.path);
    if (!definition.equals(committedFile(worktree, mergeTarget, laneSource.path)) || !definition.equals(readFileSync(workflow))) return null;
    workflowLaneDefinitions(definition.toString("utf8"));
    return { base, mergeTarget, workflow: laneSource.path, workflowSha256: createHash("sha256").update(definition).digest("hex"),
      declarationSha256: createHash("sha256").update(bytes).digest("hex") };
  } catch { return null; }
}

/** Human-readable source identity without pretending a workflow is a pnpm command. */
export function laneReportLabel(report) {
  return report?.source?.kind === "github-workflow" ? report.source.path : report?.source?.command ?? report?.command;
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { worktree: { type: "string" }, needle: { type: "string", multiple: true } } });
  if (!values.worktree || !values.needle?.length) {
    process.stderr.write("Usage: ci-job-shape.mjs --worktree <path> --needle <script or path> [--needle ...]\n");
    return 2;
  }
  const dir = path.join(values.worktree, ".github", "workflows");
  const workflows = existsSync(dir) ? readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort()
    .map((name) => ({ workflow: name, text: readFileSync(path.join(dir, name), "utf8") })) : [];
  const tiersFile = path.join(values.worktree, ".github", "pr-test-event-tiers.md");
  const { shapes, missing } = jobShapes(workflows, existsSync(tiersFile) ? readFileSync(tiersFile, "utf8") : "", values.needle);
  for (const shape of shapes) process.stdout.write(`${JSON.stringify(shape)}\n`);
  for (const needle of missing) process.stdout.write(`NO-JOB ${needle}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

/** The lane commands a repository with no declaration accepts: its AGENTS.md test command and the provider's lane report. */
function defaultLaneCommands(worktree, commit) {
  let agents = null;
  try { agents = worktree ? committedFile(worktree, commit, "AGENTS.md").toString("utf8") : null; } catch { agents = null; }
  return [agentsTestCommand(agents), providerDataOr(sessionBinding(worktree ?? null), "recipes", "prEvidence", null)?.laneReport]
    .filter((command) => typeof command === "string" && command);
}
