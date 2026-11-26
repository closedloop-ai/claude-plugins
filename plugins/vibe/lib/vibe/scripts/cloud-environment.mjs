/**
 * The Claude cloud environment a cloud worker runs in, and the setup check
 * for it. A hard-coded environment id that was not the operator's made the
 * first real cloud dispatch fail with HTTP 401.
 *
 * The id comes from the request's `claudeEnvironment`, then
 * VIBE_CLOUD_CLAUDE_ENV, then CLOUD_CLAUDE_ENV in the fleet home's config.env;
 * with none, the dispatch is refused. The RemoteTrigger API has no environment
 * list and no GitHub connection endpoint, so neither is discovered: the check
 * reads this machine's recorded standing routine with `get` (one routine, never
 * a list page that can outgrow the tool's inline limit) and shows
 * the environment it runs in; with none recorded it says so and reads nothing,
 * and when the recorded one is gone from the account it reads the routine list.
 * It reports a verified GitHub connection refusal retained by the create path.
 * A refused create or a fire that leaves no run is reported with its named error.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { measuredSetupTools } from "./cloud-validation-environment.mjs";
import { parseConfig } from "../../codex-fleet-monitor/scripts/work-dir.mjs";
import { defaultHome } from "../../fleet-orchestrator/scripts/fleet-home.mjs";

export const CLAUDE_ENV_VAR = "VIBE_CLOUD_CLAUDE_ENV";
export const CLAUDE_ENV_CONFIG_KEY = "CLOUD_CLAUDE_ENV";
const NOTHING_RECORDED = "no vibe cloud worker routine is recorded on this machine yet; the first cloud run creates it";
export const CloudSetupError = Object.freeze({
  EnvMissing: "CLOUD_ENV_MISSING",
  EnvInvalid: "CLOUD_ENV_INVALID",
  EnvUnknown: "CLOUD_ENV_UNKNOWN",
  AuthRefused: "CLOUD_AUTH_REFUSED",
  GitHubTokenMissing: "CLOUD_GITHUB_TOKEN_MISSING",
  RunNotCreated: "CLOUD_RUN_NOT_CREATED",
  ApiError: "CLOUD_API_ERROR",
  ResultTooLarge: "CLOUD_RESULT_TOO_LARGE",
});

import { checkEnvironmentPin, REPIN_CLAUDE_ENV } from "./cloud-account-pin.mjs";

const ENV_ID = /^env_[A-Za-z0-9]+$/;
const REFUSED = new Set([401, 403]);
const SET_IT = `set ${CLAUDE_ENV_VAR}=<env id>, or ${CLAUDE_ENV_CONFIG_KEY}=<env id> in the fleet home's config.env, or "claudeEnvironment" in the request, to an environment of this account (Claude Code cloud environments on claude.ai); cloud-worker.mjs check lists the ones its routines use`;
const SIGN_IN = "sign in to Claude Code again with /login, using the claude.ai account that owns the cloud environment, then run cloud-worker.mjs check";
const CONNECT_GITHUB = "Connect GitHub to your claude.ai account before saving a scheduled task using a GitHub repository.";

/** An Error whose message starts with its code, and carries it as `code`. */
export function cloudSetupError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** The verified GitHub connection refusal, distinct from Claude account authentication. */
export function githubTokenMissing(diagnostic = "") {
  const error = cloudSetupError(CloudSetupError.GitHubTokenMissing, `HTTP 401 github_token_missing. ${CONNECT_GITHUB}${diagnostic ? ` (${diagnostic})` : ""}`);
  return Object.assign(error, { httpStatus: 401 });
}

/** The environment id and where it came from; refuses a missing or malformed one with its fix. */
export function resolveClaudeEnvironment(request, { env = process.env } = {}) {
  const config = path.join(defaultHome(env), "config.env");
  const configured = existsSync(config) ? parseConfig(readFileSync(config, "utf8"))[CLAUDE_ENV_CONFIG_KEY] : undefined;
  const found = [
    ["request claudeEnvironment", request?.claudeEnvironment],
    [CLAUDE_ENV_VAR, env[CLAUDE_ENV_VAR]],
    [`${CLAUDE_ENV_CONFIG_KEY} in ${config}`, configured],
  ].find(([, value]) => typeof value === "string" && value.trim() !== "");
  if (!found) throw cloudSetupError(CloudSetupError.EnvMissing, `no Claude cloud environment is configured, and none is sent by default. Fix: ${SET_IT}.`);
  const [source, value] = found;
  const id = value.trim();
  if (!ENV_ID.test(id)) throw cloudSetupError(CloudSetupError.EnvInvalid, `${id} (${source}) is not an environment id, which is env_ followed by letters and digits. Fix: ${SET_IT}.`);
  return { id, source };
}

/** The HTTP status a RemoteTrigger failure carries, or null. */
function statusOf(error) {
  return error?.httpStatus ?? null;
}

/**
 * A refused create, named: an account whose routine list still answers refused
 * this environment, otherwise the sign-in itself was refused.
 */
export function createRefusal(error, environment, remote) {
  if (error?.code === CloudSetupError.GitHubTokenMissing) return error;
  if (error?.apiCode === "environment_not_found") {
    return cloudSetupError(CloudSetupError.EnvUnknown, `The routine API refused this Claude environment (HTTP ${statusOf(error)} environment_not_found). ${REPIN_CLAUDE_ENV}`);
  }
  const status = statusOf(error);
  if (status === 404 || (REFUSED.has(status) && accountAnswers(remote))) {
    return cloudSetupError(CloudSetupError.EnvUnknown, `RemoteTrigger create was refused (HTTP ${status}) for Claude environment ${environment.id} (${environment.source}) while this account's routine list answers, so the id is not one this account can use. Fix: ${SET_IT}.`);
  }
  if (REFUSED.has(status)) return cloudSetupError(CloudSetupError.AuthRefused, `the Claude cloud API refused this account (HTTP ${status}). Fix: ${SIGN_IN}.`);
  return error;
}

function accountAnswers(remote) {
  try {
    remote("list", {});
    return true;
  } catch (error) {
    // A reply too large to read here is still the account answering.
    return error?.code === CloudSetupError.ResultTooLarge;
  }
}

/** A started run that list_runs never shows: the API leaves no run when a fire fails its pre-creation checks. */
export function runNotCreated(routineId, environment, repository, remote) {
  let reported = "";
  try {
    const routine = remote("get", { trigger_id: routineId });
    const last = routine?.trigger?.last_run ?? routine?.last_run;
    if (last) reported = ` The routine reports last run ${last.status ?? "?"}, ${last.failure_reason ?? "no failure reason"}.`;
  } catch { /* the error below still names the fix */ }
  return cloudSetupError(CloudSetupError.RunNotCreated, `routine ${routineId} was fired but no run appeared; a fire that fails repository access, its token preflight or environment lookup leaves none.${reported} Fix: give the Claude account access to ${repository} by installing the Claude GitHub App on it, or by running /web-setup in Claude Code; confirm ${environment.id} (${environment.source}) is this account's environment, then run cloud-worker.mjs check and dispatch again.`);
}

/**
 * The init error an archived session's run log records, or null: the `env[error]` line, completed by the assistant line
 * that repeats it with the exit code (session cse_0197q285vNxoGtvUmBd3iqQ9: "Setup script failed with exit code 100").
 */
export function sessionInitError(log) {
  const text = typeof log === "string" ? log : "";
  const error = /\benv\[error\]: ([^\n]+)/.exec(text)?.[1]?.trim();
  if (!error) return null;
  const repeated = text.split("\n").map((line) => /\bassistant: (.+)$/.exec(line)?.[1]?.trim()).find((line) => line?.startsWith(error));
  return (repeated ?? error).replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 300);
}

/** The api check for a failed call: a too-large reply is named as itself, never with sign-in or CLI advice. */
function apiFailure(error) {
  if (error?.code === CloudSetupError.ResultTooLarge) return { check: "api", ok: false, code: error.code, detail: error.message };
  const status = statusOf(error);
  const code = REFUSED.has(status) ? CloudSetupError.AuthRefused : CloudSetupError.ApiError;
  const fix = REFUSED.has(status) ? SIGN_IN : "check that the claude CLI is installed and signed in, then rerun";
  return { check: "api", ok: false, code, detail: `${code}: ${error.message}. Fix: ${fix}.` };
}

/** The recorded standing routine as `get` returns it, or null when the account no longer has it (HTTP 404). */
function standingRoutine(remote, standing) {
  try {
    const answer = remote("get", { trigger_id: standing.id });
    return answer?.trigger ?? answer;
  } catch (error) {
    if (statusOf(error) === 404) return null;
    throw error;
  }
}

/** Whether the recorded routine proves its environment setup reached a worker turn. */
function environmentSetupCheck(routine) {
  const last = routine?.last_run;
  if (!last) return { check: "environment-setup", ok: null,
    detail: "not exercised: the recorded routine has no run yet, so check did not run the environment setup script" };
  const status = String(last.status ?? "").toLowerCase();
  const turns = last.turn_count ?? last.turns_count ?? last.num_turns;
  if (status.includes("archiv") && (!Number.isInteger(turns) || turns === 0)) {
    return { check: "environment-setup", ok: false, code: "CLOUD_ENV_SETUP_FAILED",
      detail: `CLOUD_ENV_SETUP_FAILED: the last run was archived before any worker turn${last.failure_reason ? `: ${last.failure_reason}` : ""}. Fix the environment setup script, then rerun cloud-worker.mjs check.` };
  }
  if (Number.isInteger(turns) && turns > 0) return { check: "environment-setup", ok: true,
    detail: `the last run reached ${turns} worker turn(s) after environment setup` };
  return { check: "environment-setup", ok: null,
    detail: `not exercised: the last run status ${last.status ?? "unknown"} does not prove the environment setup script completed` };
}

/**
 * The setup check: environment configured, the account pin, API reachable, the environment this machine's standing
 * routine (`standing`, from the routine ledger) runs in, the GitHub connection, and the lane tools (zsh, uv, Python
 * 3.13, Node 24, pnpm and Chromium headless shell 1254) a current measured run on this account and environment
 * verified; `pending` is the routine-removal line when routines vibe created are still recorded for removal.
 */
export function checkCloudSetup(request, { remote, env = process.env, home = os.homedir(), standing = null, pending = null, ledgerProblem = null, githubTokenMissingAt = null, account, environmentPin = null } = {}) {
  const checks = [];
  let environment = null;
  try {
    environment = resolveClaudeEnvironment(request, { env });
    checks.push({ check: "environment", ok: true, detail: `${environment.id} from ${environment.source}` });
  } catch (error) {
    checks.push({ check: "environment", ok: false, code: error.code, detail: error.message });
  }
  const accountProblem = account === undefined ? null
    : account.error ?? (environment ? checkEnvironmentPin(environment, environmentPin, account.uuid) : null);
  if (accountProblem) checks.push({ check: "account-pin", ok: false, code: accountProblem.code, detail: accountProblem.message });
  else if (account !== undefined && environmentPin) checks.push({ check: "account-pin", ok: true, detail: "the exact environment and current account match the recorded pin" });
  let routines = null;
  const refusedAt = typeof githubTokenMissingAt === "string" && Number.isFinite(Date.parse(githubTokenMissingAt))
    ? new Date(githubTokenMissingAt).toISOString() : null;
  let githubRefused = Boolean(refusedAt);
  try {
    // An unreadable ledger is its own failure, never "nothing recorded".
    if (ledgerProblem) checks.push({ check: "ledger", ok: false, detail: ledgerProblem });
    const recorded = !accountProblem && standing?.id ? standingRoutine(remote, standing) : null;
    if (ledgerProblem || accountProblem || (account !== undefined && !environment)) { /* keep the local refusal */ } else if (!standing?.id && account === undefined) {
      checks.push({ check: "api", ok: null, detail: NOTHING_RECORDED });
    } else if (recorded && (account === undefined || recorded.job_config?.ccr?.environment_id === environment?.id)) {
      routines = [recorded];
      checks.push({ check: "api", ok: true, detail: `the routine API answers for this account (routine ${standing.id})` });
      checks.push(environmentSetupCheck(recorded));
    } else {
      routines = remote("list", {})?.data ?? [];
      if (recorded && !routines.some((routine) => routine.id === recorded.id)) routines = [...routines, recorded];
      checks.push({ check: "api", ok: true, detail: `the routine API answers for this account (${routines.length} routines)` });
    }
  } catch (error) {
    if (error?.code === CloudSetupError.GitHubTokenMissing) {
      githubRefused = true;
      checks.push({ check: "api", ok: true, detail: "the routine API answered with a GitHub connection refusal" });
    } else checks.push(apiFailure(error));
  }
  if (environment && routines) {
    const used = [...new Set(routines.map((routine) => routine?.job_config?.ccr?.environment_id).filter(Boolean))];
    const owner = routines.find((routine) => routine?.job_config?.ccr?.environment_id === environment.id);
    checks.push(owner
      ? { check: "environment-use", ok: true, detail: `routine ${owner.id} on this account runs in ${environment.id}` }
      : account !== undefined && used.length > 0
        ? { check: "environment-use", ok: false, code: CloudSetupError.EnvUnknown,
          detail: `No routine on this account uses the pinned environment. Other environments are in use. ${REPIN_CLAUDE_ENV}` }
        : { check: "environment-use", ok: null, detail: `no routine on this account uses ${environment.id} yet${used.length ? `; this account's routines use ${used.join(", ")}` : ""}` });
  }
  checks.push(githubRefused ? { check: "github", ok: false, code: CloudSetupError.GitHubTokenMissing,
    detail: `The routine API reported github_token_missing${refusedAt ? ` on ${refusedAt}` : ""}. ${CONNECT_GITHUB}` }
    : { check: "github", ok: null, detail: "No GitHub connection refusal is recorded. This read-only check does not create a task to test repository access." });
  const ownsEnvironment = checks.some((row) => row.check === "environment-use" && row.ok === true);
  const observed = ownsEnvironment && !accountProblem && account?.uuid && environment
    ? measuredSetupTools(home, environmentPin, account.uuid, environment.id) : null;
  const missing = ["zsh", "uv", "python313", "node24", "pnpm", "chromium1254"].filter((key) => observed?.[key] !== true);
  const template = fileURLToPath(new URL("../../../skills/fleet-orchestrator/templates/cloud-env-setup.sh", import.meta.url));
  checks.push(missing.length ? { check: "lane-tools", ok: false, code: "CLOUD_SETUP_UNVERIFIED",
    detail: `Missing current account/environment measurements for ${missing.join(", ")}. At https://claude.ai/code open the environment selector, select the cloud environment's settings (or New environment), paste ${template} into Setup script and save. Set CLOUD_CLAUDE_ENV=<that environment ID> in ${path.join(defaultHome(env), "config.env")}. Re-pin with cloud-worker.mjs pin, run the cloud-capabilities lane on a pushed tooling head, then run check.` }
    : { check: "lane-tools", ok: true, detail: "A current measured run on this account and environment verified zsh, uv, Python 3.13, Node 24, pnpm and Chromium headless shell 1254." });
  if (pending) checks.push({ check: "routine-removal", ok: null, detail: pending });
  return { ok: checks.every((entry) => entry.ok !== false), environment, checks };
}
