// PreToolUse guard for Bash: `gh pr merge` (a merge, an enqueue or armed
// auto-merge) runs only on a pull request the signed-in account authored. An
// orchestrator once enqueued a teammate's pull request under the operator's
// account because a worker misattributed it.
//
// Another author's pull request is merged only after the operator approves
// it: rerun as `MERGE_AUTHOR_OK=<author login> gh pr merge ...`. When gh
// cannot answer, the guard stays silent and says why on stderr.
//
// The pull request is looked up in the repository gh itself will use: -R or
// --repo, then GH_REPO, then the directory the command runs in after its cd,
// pushd and env -C, and only then the session's. A directory it cannot prove
// is refused with a request for -R; guessing the session's repository once
// checked claude-plugins #413 against symphony-alpha #413 (ISS-13886).
//
// Runs from pre-tool-use.mjs. MERGE_GUARD_GH overrides the gh binary.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { commandCalls, ghPrAt, UNKNOWN_VALUE } from "./command-calls.mjs";
import { deny, eventCwd } from "./hook-dispatch.mjs";

const VALUE_FLAGS = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--subject", "--match-head-commit", "-A", "--author-email"]);
const PULL_REQUEST_URL = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+(?:[/?#]|$)/;

/**
 * Each local `gh pr merge` in `command` run from `cwd`: `{ target, repo, allowed, cwd, byDirectory,
 * unresolved }`. `target` is null for the current branch's pull request; `repo` is the -R value,
 * else the GH_REPO gh will see, else null; `byDirectory` is whether gh takes the repository from
 * `cwd`; `unresolved` says why the repository cannot be told, or is null.
 */
export function mergeCalls(command, { cwd = process.cwd(), environment = process.env } = {}) {
  const calls = [];
  for (const call of commandCalls(command, cwd, { environment, expandEnvironment: false })) {
    if (call.unresolvedExecutable || call.remote) continue;
    const { words } = call;
    const at = ghPrAt(words, "merge");
    if (at < 0) continue;
    let target = null;
    let flagRepo;
    for (let index = 1; index < words.length; index += 1) {
      if (index === at || index === at + 1) continue;
      const [flag, inline] = words[index].split(/=(.*)/s);
      if (VALUE_FLAGS.has(flag)) {
        let value = inline;
        if (value === undefined) {
          index += 1;
          value = words[index];
        }
        if (flag === "-R" || flag === "--repo") flagRepo = value ?? "";
      } else if (/^-R.+/.test(words[index])) flagRepo = words[index].slice(2);
      else if (index > at && !words[index].startsWith("-") && target === null) target = words[index];
    }
    calls.push({ target, ...repository(call, flagRepo, target, environment), allowed: call.env.MERGE_AUTHOR_OK ?? null,
      cwd: call.cwd });
  }
  return calls;
}

/**
 * The deny reason for `command` run from `cwd`, or null. `gh(args, { cwd })` returns gh's stdout
 * for a lookup run in `cwd`; `environment` is the session's.
 */
export function mergeProblem(command, gh, { cwd, environment = process.env }) {
  const calls = mergeCalls(command, { cwd, environment });
  if (calls.length === 0) return null;
  for (const call of calls) {
    const unresolved = call.unresolved ?? (call.byDirectory ? missingDirectory(call) : null);
    if (unresolved) {
      return `gh pr merge ${call.target ?? "for this branch"} refused: cannot tell which repository it targets (${unresolved}); rerun with -R <owner/repo>`;
    }
  }
  const me = gh(["api", "user", "--jq", ".login"], { cwd }).trim();
  for (const call of calls) {
    const args = ["pr", "view", ...(call.target ? [call.target] : []), ...(call.repo ? ["-R", call.repo] : []), "--json", "author,headRefName"];
    const { author, headRefName } = JSON.parse(gh(args, { cwd: call.cwd }));
    if (author?.login && author.login !== me && call.allowed !== author.login) {
      return `pull request ${call.target ?? "for this branch"} is ${author.login}'s (branch ${headRefName}), not ${me}'s: never merge, enqueue or arm auto-merge on another author's pull request without asking the operator; once they approve, rerun as MERGE_AUTHOR_OK=${author.login} gh pr merge ...`;
    }
  }
  return null;
}

/** The PreToolUse result for a Bash call: a deny for `gh pr merge` on another author's pull request, or null. Throws when gh cannot answer. */
export function mergeGuard(event) {
  const command = event?.tool_input?.command;
  if (typeof command !== "string") return null;
  const cwd = eventCwd(event);
  if (mergeCalls(command, { cwd }).length === 0) return null;
  // Every GH_REPO the command would see is passed as -R, so the session's must not override a directory lookup.
  const { GH_REPO: _sessionRepo, ...env } = process.env;
  const gh = (args, options) => execFileSync(process.env.MERGE_GUARD_GH || "gh", args, { cwd: options.cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
  const problem = mergeProblem(command, gh, { cwd });
  return problem ? deny(problem) : null;
}

/** Where gh takes the repository from for one call: `{ repo, byDirectory, unresolved }`. */
function repository(call, flagRepo, target, environment) {
  const known = (repo) => ({ repo, byDirectory: false, unresolved: null });
  const unknown = (unresolved) => ({ repo: null, byDirectory: false, unresolved });
  if (call.substituted) return unknown("a command substitution in the gh command");
  if (flagRepo !== undefined) return call.value(flagRepo) ? known(call.value(flagRepo)) : unknown(`-R ${flagRepo || "with no value"}`);
  const ghRepo = Object.hasOwn(call.exported, "GH_REPO") ? call.exported.GH_REPO : environment.GH_REPO;
  if (ghRepo === UNKNOWN_VALUE) return unknown("GH_REPO is set from a value the guard cannot read");
  if (ghRepo) return known(ghRepo);
  if (target !== null && PULL_REQUEST_URL.test(target)) return known(null);
  if (call.uncertainCwd) return unknown(`cd ${call.unresolvedTarget ?? "to an unknown directory"}`);
  return { repo: null, byDirectory: true, unresolved: null };
}

/** Why `call.cwd` cannot run gh, or null: a cd to a missing directory leaves gh elsewhere or not run. */
function missingDirectory(call) {
  try {
    return statSync(call.cwd).isDirectory() ? null : `${call.cwd} is not a directory`;
  } catch {
    return `${call.cwd} does not exist`;
  }
}
