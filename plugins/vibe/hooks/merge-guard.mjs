#!/usr/bin/env node
// PreToolUse guard for Bash: `gh pr merge` (a merge, an enqueue or armed
// auto-merge) runs only on a pull request the signed-in account authored. An
// orchestrator once enqueued a teammate's pull request under the operator's
// account because a worker misattributed it.
//
// Another author's pull request is merged only after the operator approves
// it: rerun as `MERGE_AUTHOR_OK=<author login> gh pr merge ...`. When gh
// cannot answer, the guard stays silent and says why on stderr.
//
// Usage (hook): reads the PreToolUse JSON on stdin; prints a deny decision or nothing.
// MERGE_GUARD_GH overrides the gh binary.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { commandSegments } from "./command-segments.mjs";

const VALUE_FLAGS = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--subject", "--match-head-commit", "-A", "--author-email"]);

/** Each `gh pr merge` in `command`: `{ target, repo, allowed }` (target null for the current branch's PR). */
export function mergeCalls(command) {
  const calls = [];
  for (const { env, words } of commandSegments(command)) {
    if (path.basename(words[0] ?? "") !== "gh" || words[1] !== "pr" || words[2] !== "merge") continue;
    let target = null;
    let repo = null;
    for (let index = 3; index < words.length; index += 1) {
      const [flag, inline] = words[index].split(/=(.*)/s);
      if (VALUE_FLAGS.has(flag)) {
        let value = inline;
        if (value === undefined) {
          index += 1;
          value = words[index];
        }
        if (flag === "-R" || flag === "--repo") repo = value;
      } else if (!words[index].startsWith("-") && target === null) {
        target = words[index];
      }
    }
    calls.push({ target, repo, allowed: env.MERGE_AUTHOR_OK ?? null });
  }
  return calls;
}

/** The deny reason for `command`, or null; `gh(args)` returns gh's stdout. */
export function mergeProblem(command, gh) {
  const calls = mergeCalls(command);
  if (calls.length === 0) return null;
  const me = gh(["api", "user", "--jq", ".login"]).trim();
  for (const call of calls) {
    const args = ["pr", "view", ...(call.target ? [call.target] : []), ...(call.repo ? ["-R", call.repo] : []), "--json", "author,headRefName"];
    const { author, headRefName } = JSON.parse(gh(args));
    if (author?.login && author.login !== me && call.allowed !== author.login) {
      return `pull request ${call.target ?? "for this branch"} is ${author.login}'s (branch ${headRefName}), not ${me}'s: never merge, enqueue or arm auto-merge on another author's pull request without asking the operator; once they approve, rerun as MERGE_AUTHOR_OK=${author.login} gh pr merge ...`;
    }
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(0, "utf8") || "{}");
    const command = event?.tool_input?.command;
    if (event?.tool_name === "Bash" && typeof command === "string" && mergeCalls(command).length > 0) {
      const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
      const gh = (args) => execFileSync(process.env.MERGE_GUARD_GH || "gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
      const problem = mergeProblem(command, gh);
      if (problem) {
        process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: problem } })}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`merge-guard: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
