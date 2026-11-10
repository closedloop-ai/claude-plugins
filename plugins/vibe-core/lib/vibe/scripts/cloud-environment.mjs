/**
 * The Claude cloud environment a cloud worker runs in, and the setup check
 * for it. A hard-coded environment id that was not the operator's made the
 * first real cloud dispatch fail with HTTP 401.
 *
 * The id comes from the request's `claudeEnvironment`, then
 * VIBE_CLOUD_CLAUDE_ENV, then CLOUD_CLAUDE_ENV in the fleet home's config.env;
 * with none, the dispatch is refused. The RemoteTrigger API has no environment
 * list and no GitHub connection endpoint, so neither is discovered: the check
 * shows the environments this account's routines already use, and a refused
 * create or a fire that leaves no run is reported with its named error.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseConfig } from "../../codex-fleet-monitor/scripts/work-dir.mjs";
import { defaultHome } from "../../fleet-orchestrator/scripts/fleet-home.mjs";

export const CLAUDE_ENV_VAR = "VIBE_CLOUD_CLAUDE_ENV";
export const CLAUDE_ENV_CONFIG_KEY = "CLOUD_CLAUDE_ENV";
export const CloudSetupError = Object.freeze({
  EnvMissing: "CLOUD_ENV_MISSING",
  EnvInvalid: "CLOUD_ENV_INVALID",
  EnvUnknown: "CLOUD_ENV_UNKNOWN",
  AuthRefused: "CLOUD_AUTH_REFUSED",
  RunNotCreated: "CLOUD_RUN_NOT_CREATED",
  ApiError: "CLOUD_API_ERROR",
});

const ENV_ID = /^env_[A-Za-z0-9]+$/;
const REFUSED = new Set([401, 403]);
const SET_IT = `set ${CLAUDE_ENV_VAR}=<env id>, or ${CLAUDE_ENV_CONFIG_KEY}=<env id> in the fleet home's config.env, or "claudeEnvironment" in the request, to an environment of this account (Claude Code cloud environments on claude.ai); cloud-worker.mjs check lists the ones its routines use`;
const SIGN_IN = "sign in to Claude Code again with /login, using the claude.ai account that owns the cloud environment, then run cloud-worker.mjs check";

/** An Error whose message starts with its code, and carries it as `code`. */
export function cloudSetupError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
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
  } catch {
    return false;
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
  return cloudSetupError(CloudSetupError.RunNotCreated, `routine ${routineId} was fired but no run appeared; a fire that fails repository access, its token preflight or environment lookup leaves none.${reported} Fix: connect GitHub to the Claude account with access to ${repository} (the Claude GitHub App), confirm ${environment.id} (${environment.source}) is this account's environment, then run cloud-worker.mjs check and dispatch again.`);
}

/** The setup check: environment configured, API reachable, and whether any routine uses the environment. */
export function checkCloudSetup(request, { remote, env = process.env } = {}) {
  const checks = [];
  let environment = null;
  try {
    environment = resolveClaudeEnvironment(request, { env });
    checks.push({ check: "environment", ok: true, detail: `${environment.id} from ${environment.source}` });
  } catch (error) {
    checks.push({ check: "environment", ok: false, code: error.code, detail: error.message });
  }
  let routines = null;
  try {
    routines = remote("list", {})?.data ?? [];
    checks.push({ check: "api", ok: true, detail: `the routine API answers for this account (${routines.length} routines)` });
  } catch (error) {
    const status = statusOf(error);
    const code = REFUSED.has(status) ? CloudSetupError.AuthRefused : CloudSetupError.ApiError;
    const fix = REFUSED.has(status) ? SIGN_IN : "check that the claude CLI is installed and signed in, then rerun";
    checks.push({ check: "api", ok: false, code, detail: `${code}: ${error.message}. Fix: ${fix}.` });
  }
  if (environment && routines) {
    const used = [...new Set(routines.map((routine) => routine?.job_config?.ccr?.environment_id).filter(Boolean))];
    const owner = routines.find((routine) => routine?.job_config?.ccr?.environment_id === environment.id);
    checks.push(owner
      ? { check: "environment-use", ok: true, detail: `routine ${owner.id} on this account runs in ${environment.id}` }
      : { check: "environment-use", ok: null, detail: `no routine on this account uses ${environment.id} yet, so it is unverified until the first dispatch, which names CLOUD_ENV_UNKNOWN if it is not this account's${used.length ? `; this account's routines use ${used.join(", ")}` : ""}` });
  }
  checks.push({ check: "github", ok: null, detail: "not checkable here: the routine API has no GitHub connection endpoint; a fire that fails repository access leaves no run, which dispatch and validate report as CLOUD_RUN_NOT_CREATED with the fix" });
  return { ok: checks.every((entry) => entry.ok !== false), environment, checks };
}
