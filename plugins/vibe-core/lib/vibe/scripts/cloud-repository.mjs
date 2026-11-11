/**
 * Which GitHub repository a cloud worker clones, and how it installs
 * dependencies, with no repository named in the plugin. A fixed list of two
 * repositories once refused a developer's own fork. Access is whatever the
 * developer's claude.ai GitHub connection reaches; a repository it cannot
 * reach surfaces as CLOUD_RUN_NOT_CREATED (cloud-environment.mjs).
 *
 * The repository is the request's `repository`, else the worktree's origin
 * remote (an HTTPS or SSH github.com URL). The install is the request's
 * `install`, else a command the cloud worker runs after checkout that picks
 * the install from the tree's lockfile.
 */
import { cloudSetupError } from "./cloud-environment.mjs";
import { githubRepository } from "./github-remote.mjs";

export const CloudRepoError = Object.freeze({
  NotGithub: "CLOUD_REPO_NOT_GITHUB",
  Invalid: "CLOUD_REPO_INVALID",
  Mismatch: "CLOUD_REPO_MISMATCH",
  CodexEnvMissing: "CLOUD_CODEX_ENV_MISSING",
});

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHELL_CONTROL = /[;&|`$<>\n]/;
const DEV_GROUP = String.raw`awk '/^\[/{s=($0=="[dependency-groups]")} s&&/^[[:space:]]*dev[[:space:]]*=/{f=1} END{exit !f}' pyproject.toml 2>/dev/null`;

/** Lockfile to install command, first match wins. */
export const INSTALL_RULES = Object.freeze([
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["uv.lock", "uv sync --frozen"],
  ["package-lock.json", "npm ci"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
]);

/** The repository to clone: the requested one (which a GitHub origin must match), else the origin's. */
export function resolveRepository(requested, origin) {
  const actual = githubRepository(origin);
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== "string" || !OWNER_REPO.test(requested)) {
      throw cloudSetupError(CloudRepoError.Invalid, `repository ${JSON.stringify(requested)} is not owner/repo. Fix: name the GitHub repository as owner/repo, or leave it out to use the worktree's origin.`);
    }
    if (actual && actual !== requested) throw cloudSetupError(CloudRepoError.Mismatch, `the worktree's origin is ${actual}, not the requested ${requested}. Fix: run from a checkout of ${requested}, or leave repository out.`);
    return requested;
  }
  if (!actual) {
    throw cloudSetupError(CloudRepoError.NotGithub, `the worktree's origin remote (${origin ? origin : "none"}) is not a github.com repository. Fix: cloud sessions clone from GitHub only; run from a checkout whose origin is on github.com, or name the GitHub repository as "repository" in the request.`);
  }
  return actual;
}

/** One shell command that installs from the tree's lockfile, or prints that there is none. */
export function installScript() {
  const branches = INSTALL_RULES.map(([lockfile, command]) => {
    const run = lockfile === "uv.lock" ? `if ${DEV_GROUP}; then ${command} --group dev; else ${command}; fi` : command;
    return `[ -f ${lockfile} ]; then ${run}`;
  });
  return `if ${branches.join("; elif ")}; else echo "no lockfile: no install"; fi`;
}

/** The brief's install instruction: the request's override, else the lockfile detection. */
export function installInstruction(request) {
  if (request.install !== undefined) {
    if (typeof request.install !== "string" || !request.install.trim() || SHELL_CONTROL.test(request.install) || request.install.length > 1000) {
      throw new Error("install must be one command without shell control");
    }
    return `Install dependencies with \`${request.install}\`.`;
  }
  return `Install dependencies by running this command from the repository root after checkout, as one call, exactly as written, with nothing added to it; it picks the install from the lockfile and installs nothing when there is none: \`${installScript()}\``;
}

/** Codex cloud runs only in a Codex environment configured for the repository; none is assumed. */
export function codexEnvironment(request) {
  const environment = request.codexEnvironment;
  if (typeof environment !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(environment)) {
    throw cloudSetupError(CloudRepoError.CodexEnvMissing, `Codex cloud needs a Codex environment configured for ${request.repository ?? "this repository"}. Fix: name it as "codexEnvironment" in the request, or use provider claude.`);
  }
  return environment;
}

/** Printed in the cloud before the lanes. A Claude cloud session sets CLAUDE_CODE_REMOTE; a local run leaves it unset. */
export const PROVENANCE_COMMAND = 'echo "host=$(hostname)"; echo "remote=${CLAUDE_CODE_REMOTE:-}"; echo "origin=$(git remote get-url origin)"; echo "commit=$(git rev-parse HEAD)"';

/** Why a reported provenance does not prove a cloud run of this repository and commit, or null. */
export function provenanceProblem(provenance, { repository, commit }) {
  if (!provenance || typeof provenance !== "object") return "reported no provenance";
  for (const field of ["host", "remote", "origin", "commit"]) {
    if (typeof provenance[field] !== "string" || !provenance[field].trim()) {
      return field === "remote" ? "reported no CLAUDE_CODE_REMOTE marker, so it did not run in a Claude cloud session" : `reported no provenance ${field}`;
    }
  }
  const ran = githubRepository(provenance.origin);
  if (ran?.toLowerCase() !== repository.toLowerCase()) return `ran in ${provenance.origin}, not ${repository}`;
  if (provenance.commit !== commit) return `reported provenance commit ${provenance.commit}, not ${commit}`;
  return null;
}
