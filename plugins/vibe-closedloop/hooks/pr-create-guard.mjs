// A vibe PR needs its current private handoff witness, or the operator's
// documented ticketed exception for a known handoff gate bug. Its diff also
// needs visual QA when it touches the repository's UI paths
// (required-visual-qa.mjs): the findings file the handoff gate bound into the
// witness must still be the same and cover the PR head. An override covers
// only the checks it names (`Vibe gate override: <ticket>: <check>[, <check>]:
// <reason>`); a bare one covers nothing and visual QA is never implied. A PR
// with 41 UI files once opened with no visual QA under an override given for
// unrelated tool false positives. A call that overrides head ownership or the
// session record has no gate witness, so it names its findings inline, as
// merge-guard.mjs reads them: `VISUAL_QA_FINDINGS=<findings.json> gh pr create ...`.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { commandCalls, ghPrAt, UNKNOWN_VALUE } from "./command-calls.mjs";
import { deny, eventCwd } from "./hook-dispatch.mjs";
import { inVibeSession } from "./foreground-guard.mjs";
import { gatePath, handoffGateProblem, resolvePrBase } from "../lib/handoff/scripts/handoff-gate-check.mjs";
import { evidenceFingerprint } from "../lib/handoff/scripts/handoff-evidence.mjs";
import { cloudPrProblem } from "../lib/vibe/scripts/cloud-worker.mjs";
import { githubRepository } from "../lib/vibe/scripts/github-remote.mjs";
import { upstreamBranchName } from "../lib/vibe/scripts/upstream-branch.mjs";
import { isProviderBroken, recordedBinding } from "../lib/vibe/scripts/provider.mjs";
import { assertIsolatedTestRead } from "../lib/vibe/scripts/test-state-isolation.mjs";
import { conversationSkill } from "./hook-session-scope.mjs";
import { changedPaths, declaresUiPaths, visualQaFindingsProblems, visualQaRequired, VISUAL_QA_STEP } from "../lib/vibe/scripts/required-visual-qa.mjs";
import { deliveryPlacementProblem, deliveryRepository } from "../lib/fleet-orchestrator/scripts/delivery-placement.mjs";
import { validChat } from "../lib/fleet-orchestrator/scripts/chat-binding.mjs";
import os from "node:os";
import { BodyFileError, gateOverrideEntries, readPrBodyFile } from "../lib/handoff/scripts/gate-override.mjs";

const VIBE_BRANCH = "vibe/";
/** The checks an override line can name; anything a line does not name stays enforced. */
const OVERRIDE_CHECKS = Object.freeze({ HeadOwnership: "head ownership", SessionRecord: "session record", HandoffGate: "handoff gate", VisualQa: "visual QA" });
const overrideHint = (check) => `if every real check and review passed and known Vibe gate bugs are the only blocker (operator ruling 2026-11-08), add \`Vibe gate override: <ticket>[, <ticket>...]: ${check}: <reason>\` naming each bug ticket and the check it overrides to the PR body file`;
const LOCAL_RETRY = "run gh pr create on this machine from a checkout of the target repository so the guard can find the session that owns the head";
const LITERAL_CWD_RETRY = "cd to a literal checkout path, then run gh pr create";
const CLOUD_RETRY = "pass the handoff gate, then finish the cloud task with cloud-worker.mjs import, the independent review (Codex or Fable 5.2 for a Claude import, Claude for a Codex import) and refresh-import, and rerun gh pr create";
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
    const inlineFindings = Object.hasOwn(call.env, "VISUAL_QA_FINDINGS") ? call.exported.VISUAL_QA_FINDINGS : null;
    calls.push({ cwd, base, head, title, bodyFile: bodyFile ? path.resolve(cwd, bodyFile) : null,
      findings: typeof inlineFindings === "string" && inlineFindings !== "" && inlineFindings !== UNKNOWN_VALUE ? path.resolve(cwd, inlineFindings) : null,
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
  assertIsolatedTestRead(file);
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
    // `--head` may name the remote branch the worktree's branch is pushed to under another name (#438); it stands for
    // that local branch, so its owner and handoff gate are the local branch's.
    const local = localBranchExists(cwd, head) ? head : pushedUpstreamBranch(cwd, head) ?? head;
    headCommit = git(cwd, ["rev-parse", "--verify", `refs/heads/${local}^{commit}`]);
    for (const entry of git(cwd, ["worktree", "list", "--porcelain"]).split(/\n\s*\n/)) {
      const worktree = /^worktree (.+)$/m.exec(entry)?.[1];
      if (!worktree) continue;
      if (entry.split("\n").includes(`branch refs/heads/${local}`)) { target = worktreeHeadOwner(worktree, local); break; }
      const record = worktreeRecord(worktree);
      if (record && typeof record === "object" && record.branch === local) { target = { uncertain: true }; break; }
    }
    target ??= local.startsWith(VIBE_BRANCH) ? { unownedVibe: true } : { nonVibe: true };
  } catch { return null; }
  if (target.nonVibe && sessionCwd && carriesSessionWork(cwd, headCommit)) return { cwd };
  return target;
}

function localBranchExists(cwd, branch) {
  try { git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]); return true; }
  catch { return false; }
}

/**
 * The command worktree's current branch when `head` names its pushed upstream on origin: the branch tracks
 * `origin` with `refs/heads/<head>` and the fetched `refs/remotes/origin/<head>` exists. Otherwise null.
 */
function pushedUpstreamBranch(cwd, head) {
  try {
    const branch = git(cwd, ["branch", "--show-current"]);
    if (!branch) return null;
    if (upstreamBranchName(cwd, branch) !== head) return null;
    git(cwd, ["rev-parse", "--verify", `refs/remotes/origin/${head}^{commit}`]);
    return branch;
  } catch { return null; }
}

/**
 * The checks the PR body's override lines cover. A bounded, explicit declaration names the blocking Vibe issue, as
 * a reference the session's tracker recognizes (with a tracker bound only its issue, `data.tickets.issuePattern`;
 * with none a GitHub issue `#<number>` or an issue URL, `ticketReference`), then the OVERRIDE_CHECKS it overrides,
 * then a nonempty reason. A line naming no check, or any name that is not a check, covers nothing.
 */
function overriddenChecks(bodyFile, binding) {
  const covered = new Set();
  if (!bodyFile) return covered;
  const known = new Map(Object.values(OVERRIDE_CHECKS).map((check) => [check.toLowerCase(), check]));
  for (const { reason } of gateOverrideEntries(readPrBodyFile(bodyFile), binding)) {
    const named = /^(?<checks>[^:]+):\s*\S/.exec(reason)?.groups.checks.split(",").map((check) => check.trim().toLowerCase()) ?? [];
    if (named.length > 0 && named.every((check) => known.has(check))) for (const check of named) covered.add(known.get(check));
  }
  return covered;
}

/**
 * Why the PR from `cwd` (head `head`, or the worktree's HEAD) to `base` lacks visual QA, or null: a diff under the
 * repository's UI paths needs the findings file the handoff gate in `witnessWorktree` bound, unchanged since, for
 * this head's tree; with no witness (an override path), the `inlineFindings` file the command names. A diff the
 * guard cannot read is treated as needing it.
 */
function prVisualQaProblem({ cwd, head = null, base, binding, witnessWorktree = null, inlineFindings = null }) {
  if (!declaresUiPaths(binding)) return null;
  const run = (...args) => git(cwd, args);
  let headCommit;
  let verdict;
  try {
    headCommit = run("rev-parse", "--verify", `${head ? prHeadRef(cwd, head) : "HEAD"}^{commit}`);
    verdict = visualQaRequired(binding, changedPaths(run, resolvePrBase(cwd, base).oid, headCommit));
  } catch {
    verdict = { required: true, reason: "the guard cannot read the PR diff, so it is treated as changing UI" };
  }
  if (!verdict.required) return null;
  let findings = null;
  try {
    const witness = witnessWorktree ? gatePath(witnessWorktree) : null;
    const saved = witness && existsSync(witness) ? JSON.parse(readFileSync(witness, "utf8")).visualQa?.findings : null;
    if (saved?.path) {
      if (JSON.stringify(evidenceFingerprint(saved.path)) !== JSON.stringify(saved)) return `visual QA is required (${verdict.reason}): handoff visual QA findings changed since the gate`;
      findings = saved.path;
    }
  } catch {
    return `visual QA is required (${verdict.reason}): the handoff gate's visual QA findings could not be verified`;
  }
  if (!witnessWorktree) findings = inlineFindings;
  if (!findings) {
    return witnessWorktree
      ? `visual QA is required (${verdict.reason}): the handoff gate bound no visual QA findings; ${VISUAL_QA_STEP}, then rerun the handoff gate with --visual-qa`
      : `visual QA is required (${verdict.reason}): no visual QA findings were named; ${VISUAL_QA_STEP}, then rerun as VISUAL_QA_FINDINGS=<findings.json> gh pr create ... with findings for the PR head`;
  }
  const problems = headCommit ? visualQaFindingsProblems(findings, headCommit, run, binding) : ["the PR head cannot be read"];
  return problems.length ? `visual QA is required (${verdict.reason}): ${problems.join("; ")}` : null;
}

/** The local ref `head` stands for: its local branch, else the local branch pushed under that name, else origin's. */
function prHeadRef(cwd, head) {
  if (localBranchExists(cwd, head)) return `refs/heads/${head}`;
  const local = pushedUpstreamBranch(cwd, head);
  return local ? `refs/heads/${local}` : `refs/remotes/origin/${head}`;
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
  const scope = conversationSkill(event, home);
  if (!scope && !recorded) return null;
  const placement = (call) => {
    try {
      return deliveryPlacementProblem({ content: call.bodyFile ? readPrBodyFile(call.bodyFile) : "", operation: "pull-request",
        repository: deliveryRepository(call.cwd), chat: validChat(event.session_id) });
    } catch (error) {
      if (error instanceof BodyFileError) return error.message;
      throw error;
    }
  };
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
    let target = targets[index];
    if (!target && !vibeNamedHead(call.head)) {
      // An unresolvable non-Vibe head (remote-only, a fork, another repository) is judged by the
      // command worktree, as before head resolution existed.
      if (inVibeSession(call.cwd)) target = { cwd: call.cwd };
      else if (vibeWorktree(call.cwd) === false) continue;
    }
    if (target?.nonVibe) continue;
    let covered;
    try { covered = overriddenChecks(call.bodyFile, recordedBinding({ worktree: call.cwd, conversation: event?.session_id ?? null, home })); }
    catch (error) {
      if (isProviderBroken(error)) throw error;
      if (error instanceof BodyFileError) return refuse(error.message, "pass one literal readable path to --body-file or -F, then rerun gh pr create");
      throw error;
    }
    const override = (check) => covered.has(check);
    const missingVisualQa = (worktree, head, witnessWorktree = null) => {
      if (override(OVERRIDE_CHECKS.VisualQa)) return null;
      const problem = prVisualQaProblem({ cwd: worktree, head, base: call.base, witnessWorktree, inlineFindings: call.findings,
        binding: recordedBinding({ worktree, conversation: event?.session_id ?? null, home }) });
      return problem ? refuse(problem, overrideHint(OVERRIDE_CHECKS.VisualQa)) : null;
    };
    const missingPlacement = () => {
      if (!scope && worktreeRecord(target?.cwd ?? call.cwd)?.status !== "active") return null;
      const problem = placement(call);
      return problem ? refuse(problem, "record where the work will be delivered before opening a pull request") : null;
    };
    if (target?.unownedVibe || target?.uncertain) {
      if (override(OVERRIDE_CHECKS.HeadOwnership)) {
        const problem = missingPlacement() ?? missingVisualQa(call.cwd, call.head);
        if (problem) return problem;
        continue;
      }
      return refuse(target.unownedVibe ? "no vibe session record for the PR head branch" : "PR head ownership cannot be verified", overrideHint(OVERRIDE_CHECKS.HeadOwnership));
    }
    if (!target) return refuse("PR head branch cannot be proved local and unrelated to a vibe session", LOCAL_RETRY);
    if (!inVibeSession(target.cwd)) {
      if (vibeWorktree(target.cwd) === false) continue;
      if (override(OVERRIDE_CHECKS.SessionRecord)) {
        const problem = missingPlacement() ?? missingVisualQa(target.cwd, call.head);
        if (problem) return problem;
        continue;
      }
      return refuse("no vibe session record in the command worktree", overrideHint(OVERRIDE_CHECKS.SessionRecord));
    }
    // Cloud import readiness, its own rerun of the handoff gate included, is a separate protection the override does not clear.
    const cloudProblem = cloudPrProblem(target.cwd, { base: call.base, bodyFile: call.bodyFile, title: call.title });
    if (cloudProblem) return refuse(cloudProblem, CLOUD_RETRY);
    const problem = handoffGateProblem(target.cwd, { base: call.base, bodyFile: call.bodyFile, title: call.title });
    if (problem && !override(OVERRIDE_CHECKS.HandoffGate)) return refuse(problem, `run the final handoff gate on the published source, or ${overrideHint(OVERRIDE_CHECKS.HandoffGate)}`);
    const placementProblem = missingPlacement() ?? missingVisualQa(target.cwd, null, target.cwd);
    if (placementProblem) return placementProblem;
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
