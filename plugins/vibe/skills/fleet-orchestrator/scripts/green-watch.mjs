#!/usr/bin/env node
// The green-watch duty's report. A watcher that listed main's batch runs once,
// when it started, never saw a push-triggered batch that began later, so an
// accessibility red from a program PR went unreported. Every call re-lists
// the runs for main from the code host, and every lane (job) of every run whose
// commit contains a program PR's merge commit is reported.
//
// Usage: green-watch.mjs --repo <owner/repo> --worktree <a clone with main fetched> --program <merge sha>[,<merge sha>...] [--branch main]
//
// Prints `RED <workflow> #<run> <sha> <job>` for each failed lane,
// `PENDING <workflow> #<run> <sha> <job>` for each unfinished one, `NO-RUN <sha>`
// when no run exists yet for the branch head, then `green-watch: <runs> runs,
// <red> red, <pending> pending`; exits 1 on any RED or NO-RUN and 2 when gh or
// git cannot answer. `GREEN_WATCH_GH` overrides the gh binary.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);

/** The report lines for runs whose commit contains a program PR, read fresh each time. */
export function greenReport({ runs, jobsOf, head, includesProgram }) {
  const watched = runs.filter((run) => includesProgram(run.headSha));
  const lines = [];
  let red = 0;
  let pending = 0;
  for (const run of watched) {
    for (const job of jobsOf(run.databaseId)) {
      const where = `${run.workflowName ?? run.name} #${run.databaseId} ${String(run.headSha).slice(0, 10)} ${job.name}`;
      if (job.status !== "completed") {
        pending += 1;
        lines.push(`PENDING ${where}`);
      } else if (FAILED.has(job.conclusion)) {
        red += 1;
        lines.push(`RED ${where}`);
      }
    }
  }
  const noRun = runs.some((run) => run.headSha === head) ? [] : [`NO-RUN ${head}`];
  return { lines: [...lines, ...noRun, `green-watch: ${watched.length} runs, ${red} red, ${pending} pending`], ok: red === 0 && noRun.length === 0 };
}

function gh(args) {
  return JSON.parse(execFileSync(process.env.GREEN_WATCH_GH || "gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }));
}

function isAncestor(worktree, ancestor, sha) {
  try {
    execFileSync("git", ["-C", worktree, "merge-base", "--is-ancestor", ancestor, sha], { stdio: "ignore" });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw new Error(`git cannot compare ${ancestor} with ${sha}; fetch the branch into ${worktree} first`);
  }
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { repo: { type: "string" }, worktree: { type: "string" }, program: { type: "string" }, branch: { type: "string" } } });
  const program = (values.program ?? "").split(",").map((sha) => sha.trim()).filter(Boolean);
  if (!values.repo || !values.worktree || program.length === 0) {
    throw new Error("Usage: green-watch.mjs --repo <owner/repo> --worktree <clone> --program <merge sha>[,...] [--branch main]");
  }
  const branch = values.branch ?? "main";
  const runs = gh(["run", "list", "-R", values.repo, "--branch", branch, "--limit", "100", "--json", "databaseId,headSha,status,conclusion,name,workflowName,event,createdAt"]);
  const head = gh(["api", `repos/${values.repo}/commits/${branch}`]).sha;
  const { lines, ok } = greenReport({
    runs,
    head,
    jobsOf: (id) => gh(["run", "view", String(id), "-R", values.repo, "--json", "jobs"]).jobs ?? [],
    includesProgram: (sha) => program.some((merge) => isAncestor(values.worktree, merge, sha)),
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
