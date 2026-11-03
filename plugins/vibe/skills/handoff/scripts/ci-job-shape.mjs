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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

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
