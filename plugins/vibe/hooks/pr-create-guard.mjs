// A vibe PR must carry a current private handoff witness for its exact source.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { commandSegments } from "./command-segments.mjs";
import { deny, eventCwd } from "./hook-dispatch.mjs";
import { inVibeSession } from "./foreground-guard.mjs";
import { handoffGateProblem } from "../skills/handoff/scripts/handoff-gate.mjs";
import { conversationSkill } from "./hook-session-scope.mjs";
import os from "node:os";

const VIBE_BRANCH = "vibe/";

/** Whether a shell call opens a PR through GitHub CLI. */
export function createsPullRequest(command) {
  return prCreateCalls(command, process.cwd()).length > 0;
}

/** Expand shell wrappers and carry `cd` into each PR command's effective cwd. */
export function prCreateCalls(command, initialCwd) {
  let cwd = initialCwd;
  let uncertainCwd = false;
  const directoryStack = [];
  const remote = commandSegments(command).some(({ words }) => path.basename(words[0] ?? "") === "ssh");
  const calls = [];
  for (const { words } of commandSegments(command, { expandShellPayloads: true })) {
    if (words[0] === "cd" || words[0] === "pushd") {
      if (words.length !== 2 || /[$`*?]/.test(words[1])) uncertainCwd = true;
      else {
        if (words[0] === "pushd") directoryStack.push(cwd);
        cwd = path.resolve(cwd, words[1]);
      }
      continue;
    }
    if (words[0] === "popd") {
      if (words.length !== 1 || directoryStack.length === 0) uncertainCwd = true;
      else cwd = directoryStack.pop();
      continue;
    }
    if (path.basename(words[0] ?? "") !== "gh" || words[1] !== "pr" || words[2] !== "create") continue;
    let base = null;
    let bodyFile = null;
    for (let i = 3; i < words.length; i += 1) {
      const word = words[i];
      if (["--base", "-B", "--body-file", "-F"].includes(word)) {
        const value = words[++i];
        if (word === "--base" || word === "-B") base = value;
        else bodyFile = value;
      } else if (word.startsWith("--base=")) base = word.slice(7);
      else if (word.startsWith("--body-file=")) bodyFile = word.slice(12);
    }
    calls.push({ cwd, base, bodyFile: bodyFile ? path.resolve(cwd, bodyFile) : null, remote, uncertainCwd });
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
  const recorded = inVibeSession(eventCwd(event)) || calls.some(call => !call.remote && !call.uncertainCwd && inVibeSession(call.cwd));
  if (!conversationSkill(event, home) && !recorded) return null;
  for (const call of calls) {
    if (call.remote || call.uncertainCwd) return deny("gh pr create refused: remote or unresolved shell cwd cannot prove a local vibe handoff gate");
    if (!inVibeSession(call.cwd)) {
      if (vibeWorktree(call.cwd) === false) continue;
      return deny("gh pr create refused: no vibe session record in the command worktree");
    }
    const problem = handoffGateProblem(call.cwd, { base: call.base, bodyFile: call.bodyFile });
    if (problem) return deny(`gh pr create refused: ${problem}; run the final handoff gate on the published source`);
  }
  return null;
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
