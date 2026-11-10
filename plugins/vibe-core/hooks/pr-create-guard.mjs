// A vibe PR must carry a current private handoff witness for its exact source.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { commandCalls, ghPrAt } from "./command-calls.mjs";
import { deny, eventCwd } from "./hook-dispatch.mjs";
import { inVibeSession } from "./foreground-guard.mjs";
import { handoffGateProblem } from "../lib/handoff/scripts/handoff-gate-check.mjs";
import { cloudPrProblem } from "../lib/vibe/scripts/cloud-worker.mjs";
import { conversationSkill } from "./hook-session-scope.mjs";
import os from "node:os";

const VIBE_BRANCH = "vibe/";

/** Whether a shell call opens a PR through GitHub CLI. */
export function createsPullRequest(command) {
  return prCreateCalls(command, process.cwd()).length > 0;
}

/** Resolve each PR call against its execution scope, so child cwd and variables cannot escape. */
export function prCreateCalls(command, initialCwd) {
  const calls = [];
  for (const call of commandCalls(command, initialCwd)) {
    const { words, cwd, remote, uncertainCwd, unresolvedTarget, unresolvedExecutable } = call;
    if (unresolvedExecutable) {
      calls.push({ cwd, remote, uncertainCwd, unresolvedTarget, unresolvedExecutable });
      continue;
    }
    const actionAt = ghPrAt(words, "create");
    if (actionAt < 0) continue;
    let base = null;
    let bodyFile = null;
    for (let i = actionAt + 2; i < words.length; i += 1) {
      const word = words[i];
      if (["--base", "-B", "--body-file", "-F"].includes(word)) {
        const value = words[++i];
        if (word === "--base" || word === "-B") base = value;
        else bodyFile = value;
      } else if (word.startsWith("--base=")) base = word.slice(7);
      else if (word.startsWith("--body-file=")) bodyFile = word.slice(12);
    }
    calls.push({ cwd, base, bodyFile: bodyFile ? path.resolve(cwd, bodyFile) : null,
      remote, uncertainCwd, unresolvedTarget });
  }
  return calls;
}

/**
 * Whether a session-less PR from `cwd` is vibe work, judged by that worktree alone: null outside a
 * git repository, true on a vibe/ branch, else false. Other worktrees' session records never
 * decide, because an abandoned session keeps an `active` record indefinitely (PR #371 review: a
 * repository with any such record refused every scoped conversation's PRs in all its worktrees).
 */
export function vibeWorktree(cwd) {
  try { git(cwd, ["rev-parse", "--git-dir"]); }
  catch { return null; }
  try { return git(cwd, ["branch", "--show-current"]).startsWith(VIBE_BRANCH); }
  catch { return false; }
}

/** Refuse PR publication in a vibe session without the final handoff witness. */
export function prCreateGuard(event, home = os.homedir()) {
  const command = event?.tool_input?.command;
  if (typeof command !== "string") return null;
  const calls = prCreateCalls(command, eventCwd(event));
  if (calls.length === 0) return null;
  const startingCwd = eventCwd(event);
  const recorded = inVibeSession(startingCwd) || vibeWorktree(startingCwd) === true ||
    calls.some(call => !call.remote && !call.uncertainCwd &&
      (inVibeSession(call.cwd) || vibeWorktree(call.cwd) === true));
  if (!conversationSkill(event, home) && !recorded) return null;
  for (const call of calls) {
    if (call.unresolvedExecutable) {
      if (call.remote || call.uncertainCwd || inVibeSession(call.cwd) || vibeWorktree(call.cwd) === true) {
        return deny(`gh pr create refused: ${call.unresolvedExecutable} in ${call.cwd}`);
      }
      continue;
    }
    if (call.remote) return deny("gh pr create refused: remote or unresolved shell cwd cannot prove a local vibe handoff gate");
    if (call.uncertainCwd) return deny(`gh pr create refused: unresolved shell cwd ${call.unresolvedTarget ?? "unknown"} from ${call.cwd} cannot prove a local vibe handoff gate`);
    if (!inVibeSession(call.cwd)) {
      if (vibeWorktree(call.cwd) === false) continue;
      return deny("gh pr create refused: no vibe session record in the command worktree");
    }
    const cloudProblem = cloudPrProblem(call.cwd, { base: call.base, bodyFile: call.bodyFile });
    if (cloudProblem) return deny(`gh pr create refused: ${cloudProblem}`);
    const problem = handoffGateProblem(call.cwd, { base: call.base, bodyFile: call.bodyFile });
    if (problem) return deny(`gh pr create refused: ${problem}; run the final handoff gate on the published source`);
  }
  return null;
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
