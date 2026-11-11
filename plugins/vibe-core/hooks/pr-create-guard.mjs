// A vibe PR needs its current private handoff witness, or the operator's
// documented ticketed exception for a known handoff gate bug.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { commandCalls, ghPrAt, UNKNOWN_VALUE } from "./command-calls.mjs";
import { deny, eventCwd } from "./hook-dispatch.mjs";
import { inVibeSession } from "./foreground-guard.mjs";
import { handoffGateProblem } from "../lib/handoff/scripts/handoff-gate-check.mjs";
import { cloudPrProblem } from "../lib/vibe/scripts/cloud-worker.mjs";
import { githubRepository } from "../lib/vibe/scripts/github-remote.mjs";
import { conversationSkill } from "./hook-session-scope.mjs";
import os from "node:os";

const VIBE_BRANCH = "vibe/";
const OVERRIDE_HINT = "if every real check and review passed and a known Vibe gate bug is the only blocker (operator ruling 2026-11-08), add the line `Vibe gate override: ISS-<number>: <reason>` naming that bug's ticket to the PR body file";
const LOCAL_RETRY = "run gh pr create on this machine from a checkout of the target repository so the guard can find the session that owns the head";
const LITERAL_CWD_RETRY = "cd to a literal checkout path, then run gh pr create";
const CLOUD_RETRY = "pass the handoff gate, then finish the cloud task with cloud-worker.mjs import, the opposite-harness review and refresh-import, and rerun gh pr create";
const PLAIN_GH_RETRY = "run gh pr create as a plain command, not inside nested shells, from a checkout of the target repository";
const PR_CREATE_DATA_OPTIONS = new Set(["--body", "-b", "--title", "-t", "--template", "-T",
  "--assignee", "-a", "--reviewer", "-r", "--label", "-l", "--milestone", "-m", "--project", "-p"]);

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
    const actionAt = Math.max(ghPrAt(words, "create"), ghPrAt(words, "new"));
    if (actionAt < 0) continue;
    let base = null;
    let bodyFile = null;
    let head = null;
    let title;
    const repositoryOverrides = [];
    for (let i = 1; i < actionAt; i += 1) {
      const word = words[i];
      if (word === "--repo" || word === "-R") repositoryOverrides.push(words[++i] ?? "");
      else if (word.startsWith("--repo=")) repositoryOverrides.push(word.slice(7));
      else if (/^-R.+/.test(word)) repositoryOverrides.push(word.slice(word.startsWith("-R=") ? 3 : 2));
    }
    for (let i = actionAt + 2; i < words.length; i += 1) {
      const word = words[i];
      if (["--base", "-B", "--body-file", "-F", "--head", "-H", "--repo", "-R"].includes(word)) {
        const value = words[++i];
        if (word === "--base" || word === "-B") base = value;
        else if (word === "--head" || word === "-H") head = value ?? "";
        else if (word === "--repo" || word === "-R") repositoryOverrides.push(value ?? "");
        else bodyFile = value;
      } else if (word.startsWith("--base=")) base = word.slice(7);
      else if (word.startsWith("--body-file=")) bodyFile = word.slice(12);
      else if (word.startsWith("--head=")) head = word.slice(7);
      else if (word.startsWith("--repo=")) repositoryOverrides.push(word.slice(7));
      else if (/^-R.+/.test(word)) repositoryOverrides.push(word.slice(word.startsWith("-R=") ? 3 : 2));
      else if (word === "--title" || word === "-t") title = words[++i];
      else if (word.startsWith("--title=")) title = word.slice(8);
      else if (PR_CREATE_DATA_OPTIONS.has(word)) i += 1;
      else {
        const attached = /^-([BFHt])(?:=(.*)|(.+))$/.exec(word);
        if (attached) {
          const value = attached[2] ?? attached[3];
          if (attached[1] === "B") base = value;
          else if (attached[1] === "F") bodyFile = value;
          else if (attached[1] === "t") title = value;
          else head = value;
        }
      }
    }
    const explicitRepository = repositoryOverrides.at(-1);
    repositoryOverrides.length = 0;
    if (explicitRepository !== undefined && explicitRepository !== "") repositoryOverrides.push(explicitRepository);
    else {
      // GH_REPO as gh will see it; a value the command line sets but the guard cannot read stays unproven.
      const environmentRepository = Object.hasOwn(call.exported, "GH_REPO") ? call.exported.GH_REPO : process.env.GH_REPO;
      if (environmentRepository === UNKNOWN_VALUE) repositoryOverrides.push(null);
      else if (typeof environmentRepository === "string" && environmentRepository !== "") repositoryOverrides.push(environmentRepository);
    }
    calls.push({ cwd, base, head, title, bodyFile: bodyFile ? path.resolve(cwd, bodyFile) : null,
      repositoryOverrides, remote, uncertainCwd, unresolvedTarget });
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

/** An explicit CLI or GH_REPO target must match the Git repository used for head proof. */
function repositoryMatches(cwd, overrides) {
  if (overrides.length === 0) return true;
  try {
    const actual = githubRepository(git(cwd, ["remote", "get-url", "origin"]))?.toLowerCase();
    if (!actual) return false;
    return overrides.every(value => {
      const selected = /^(?:github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(value ?? "");
      return selected?.[1].toLowerCase() === actual;
    });
  } catch { return false; }
}

/** The session record of a worktree: null without one, "corrupt" when unreadable. Reads files only. */
function worktreeRecord(worktree) {
  let gitDir = path.join(worktree, ".git");
  try {
    if (lstatSync(gitDir).isFile()) {
      const pointer = /^gitdir: (.+)$/m.exec(readFileSync(gitDir, "utf8"))?.[1]?.trim();
      if (!pointer) return null;
      gitDir = path.resolve(worktree, pointer);
    }
  } catch { return null; }
  const file = path.join(gitDir, "vibe-session.json");
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return "corrupt"; }
}

/** A marker for another branch cannot own this head; an unreadable selected marker stays uncertain. */
function worktreeHeadOwner(worktree, head) {
  const record = worktreeRecord(worktree);
  if (record === null) return head.startsWith(VIBE_BRANCH) ? { cwd: worktree } : { nonVibe: true };
  if (record === "corrupt" || typeof record !== "object") return { uncertain: true };
  if (record.branch === head || (record.branch === undefined && head.startsWith(VIBE_BRANCH))) return { cwd: worktree };
  if (typeof record.branch === "string") return head.startsWith(VIBE_BRANCH) ? { unownedVibe: true } : { nonVibe: true };
  return { uncertain: true };
}

/**
 * From inside a recorded session worktree, a head that contains the session's unmerged commits is
 * that session's work under any branch name. Session work is the worktree's HEAD and the recorded
 * branch's tip; merged means reachable from origin's default branch, and without that ref, work
 * past the record's `baseCommit` is unmerged.
 */
function carriesSessionWork(cwd, headCommit) {
  try {
    const record = worktreeRecord(git(cwd, ["rev-parse", "--show-toplevel"]));
    const tips = [git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])];
    if (record && typeof record === "object" && typeof record.branch === "string") {
      try { tips.push(git(cwd, ["rev-parse", "--verify", `refs/heads/${record.branch}^{commit}`])); } catch { /* A renamed branch leaves HEAD. */ }
    }
    const main = defaultBranchCommit(cwd);
    const base = record && typeof record === "object" && /^[0-9a-f]{40}$/.test(record.baseCommit ?? "") ? record.baseCommit : null;
    return tips.some(tip => {
      if (main ? isAncestor(cwd, tip, main) : !base || base === tip) return false;
      return isAncestor(cwd, tip, headCommit);
    });
  } catch { return false; }
}

function defaultBranchCommit(cwd) {
  for (const ref of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main"]) {
    try { return git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]); } catch { /* Try the next ref. */ }
  }
  return null;
}

function isAncestor(cwd, ancestor, descendant) {
  try { git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; }
  catch { return false; }
}

/** Find the local worktree that owns the PR head, or prove a local non-Vibe branch has no owner. */
function prHeadTarget(cwd, head, repositoryOverrides) {
  if (!repositoryMatches(cwd, repositoryOverrides)) return null;
  const sessionCwd = inVibeSession(cwd);
  if (head === null) {
    // A session worktree's own PR is its session's work whatever its current branch is called.
    if (sessionCwd) return { cwd };
    try {
      const branch = git(cwd, ["branch", "--show-current"]);
      return branch ? worktreeHeadOwner(cwd, branch) : { cwd };
    } catch { return { cwd }; }
  }
  if (typeof head !== "string" || !head || head.startsWith("-") || head.includes(":")) return null;
  let target;
  let headCommit;
  try {
    git(cwd, ["check-ref-format", "--branch", head]);
    headCommit = git(cwd, ["rev-parse", "--verify", `refs/heads/${head}^{commit}`]);
    for (const entry of git(cwd, ["worktree", "list", "--porcelain"]).split(/\n\s*\n/)) {
      const worktree = /^worktree (.+)$/m.exec(entry)?.[1];
      if (!worktree) continue;
      if (entry.split("\n").includes(`branch refs/heads/${head}`)) { target = worktreeHeadOwner(worktree, head); break; }
      const record = worktreeRecord(worktree);
      if (record && typeof record === "object" && record.branch === head) { target = { uncertain: true }; break; }
    }
    target ??= head.startsWith(VIBE_BRANCH) ? { unownedVibe: true } : { nonVibe: true };
  } catch { return null; }
  if (target.nonVibe && sessionCwd && carriesSessionWork(cwd, headCommit)) return { cwd };
  return target;
}

/** A bounded, explicit PR-body declaration names the blocking Vibe issue and a nonempty reason. */
function hasTicketedGateOverride(bodyFile) {
  if (!bodyFile) return false;
  try {
    const stat = lstatSync(bodyFile);
    if (!stat.isFile() || stat.size > 65536) return false;
    return readFileSync(bodyFile, "utf8").split(/\r?\n/).some(line =>
      /^Vibe gate override: ISS-\d+:\s*\S.*$/.test(line));
  } catch { return false; }
}

/** A Vibe-named head the guard cannot resolve stays refused rather than falling back to the command cwd. */
function vibeNamedHead(head) {
  return typeof head === "string" && head.split(":").at(-1).startsWith(VIBE_BRANCH);
}

/** Refuse PR publication in a vibe session without the final handoff witness. */
export function prCreateGuard(event, home = os.homedir()) {
  const command = event?.tool_input?.command;
  if (typeof command !== "string") return null;
  const calls = prCreateCalls(command, eventCwd(event));
  if (calls.length === 0) return null;
  const startingCwd = eventCwd(event);
  const targets = calls.map(call => call.remote || call.uncertainCwd || call.unresolvedExecutable
    ? null : prHeadTarget(call.cwd, call.head, call.repositoryOverrides));
  const recorded = inVibeSession(startingCwd) || vibeWorktree(startingCwd) === true ||
    calls.some(call => !call.remote && !call.uncertainCwd &&
      (inVibeSession(call.cwd) || vibeWorktree(call.cwd) === true)) ||
    targets.some(target => target?.uncertain ||
      (target?.cwd && (inVibeSession(target.cwd) || vibeWorktree(target.cwd) === true)));
  if (!conversationSkill(event, home) && !recorded) return null;
  for (const [index, call] of calls.entries()) {
    if (call.unresolvedExecutable) {
      if (call.remote || call.uncertainCwd || inVibeSession(call.cwd) || vibeWorktree(call.cwd) === true) {
        return refuse(`${call.unresolvedExecutable} in ${call.cwd}`, PLAIN_GH_RETRY);
      }
      continue;
    }
    if (call.remote) return refuse("remote or unresolved shell cwd cannot prove a local vibe handoff gate", LOCAL_RETRY);
    if (call.uncertainCwd) {
      return refuse(`unresolved shell cwd ${call.unresolvedTarget ?? "unknown"} from ${call.cwd} cannot prove a local vibe handoff gate`, LITERAL_CWD_RETRY);
    }
    const override = hasTicketedGateOverride(call.bodyFile);
    let target = targets[index];
    if (!target && !vibeNamedHead(call.head)) {
      // An unresolvable non-Vibe head (remote-only, a fork, another repository) is judged by the
      // command worktree, as before head resolution existed.
      if (inVibeSession(call.cwd)) target = { cwd: call.cwd };
      else if (vibeWorktree(call.cwd) === false) continue;
    }
    if (target?.nonVibe) continue;
    if (target?.unownedVibe || target?.uncertain) {
      if (override) continue;
      return refuse(target.unownedVibe ? "no vibe session record for the PR head branch" : "PR head ownership cannot be verified", OVERRIDE_HINT);
    }
    if (!target) return refuse("PR head branch cannot be proved local and unrelated to a vibe session", LOCAL_RETRY);
    if (!inVibeSession(target.cwd)) {
      if (vibeWorktree(target.cwd) === false || override) continue;
      return refuse("no vibe session record in the command worktree", OVERRIDE_HINT);
    }
    // Cloud import readiness, its own rerun of the handoff gate included, is a separate protection the override does not clear.
    const cloudProblem = cloudPrProblem(target.cwd, { base: call.base, bodyFile: call.bodyFile });
    if (cloudProblem) return refuse(cloudProblem, CLOUD_RETRY);
    const problem = handoffGateProblem(target.cwd, { base: call.base, bodyFile: call.bodyFile, title: call.title });
    if (problem && !override) return refuse(problem, `run the final handoff gate on the published source, or ${OVERRIDE_HINT}`);
  }
  return null;
}

/** Every vibe-gating refusal names a supported way forward, so a tooling bug never leaves only a manual step. */
function refuse(reason, retry) {
  return deny(retry ? `gh pr create refused: ${reason}; ${retry}` : `gh pr create refused: ${reason}`);
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
