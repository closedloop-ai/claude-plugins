// Whether vibe's guards can run in Codex: vibe-core carries them, and Codex runs a
// plugin's hooks only after a person approves them in /hooks (and again after the
// plugin's bundle changes). Codex's App Server `hooks/list` reports each hook's
// trust. The setup check, the version update, the fleet writer launch check and the
// fleet watcher all read it through here, so they agree on when to ask a person to
// approve, and they ask only when a hook actually needs it.

import { codexAppServerRequest } from "./codex-app-server.mjs";
import { VIBE_CORE_INSTALL } from "../../../shared/vibe-core.mjs";

export const HookApproval = Object.freeze({ Approved: "approved", Needed: "needed", Missing: "missing", Unchecked: "unchecked" });
/** The one step only the developer can take; the orchestrator often runs in Claude Code, so it names Codex. */
export const APPROVE_HOOKS = "open Codex once and approve vibe-core's hooks in /hooks";
export const ADD_VIBE_CORE = VIBE_CORE_INSTALL.codex;

/** The first vibe release whose hooks ship in vibe-core; an older vibe runs its own. */
export const FIRST_SPLIT_VIBE = "1.1.69";
const HOOKS_PLUGIN = "vibe-core@";
/** A vibe older than FIRST_SPLIT_VIBE registers hooks under its own id. */
const OWN_HOOKS_PLUGIN = "vibe@";
const APPROVED = new Set(["trusted", "managed"]);
export const UNKNOWN_METHOD = /unknown variant|method not found/i;
const LIST_TIMEOUT_MS = 20_000;

/**
 * The approval state of vibe-core's hooks in a `hooks/list` result: missing when it lists none,
 * needed when any is disabled or neither trusted nor managed (with `blocked` naming each), else approved.
 */
export function vibeCoreHookApproval(listing) {
  return pluginHookApproval(listing, HOOKS_PLUGIN);
}

/**
 * The approval state of the vibe hooks that will actually run: an older vibe that lists hooks of its own
 * runs those (and vibe-core's stand down beside it), so they must be approved; otherwise vibe-core's must.
 * `plugin` names whose they are.
 */
export function runningHookApproval(listing) {
  const own = pluginHookApproval(listing, OWN_HOOKS_PLUGIN);
  return own.state === HookApproval.Missing ? { ...vibeCoreHookApproval(listing), plugin: "vibe-core" } : { ...own, plugin: "vibe" };
}

function pluginHookApproval(listing, prefix) {
  const hooks = (listing?.data ?? []).flatMap((entry) => entry?.hooks ?? [])
    .filter((hook) => String(hook?.pluginId ?? "").startsWith(prefix));
  if (hooks.length === 0) return { state: HookApproval.Missing };
  const blocked = [...new Set(hooks.filter((hook) => hook.enabled === false || !APPROVED.has(hook.trustStatus))
    .map((hook) => `${hook.key} is ${hook.enabled === false ? "disabled" : hook.trustStatus}`))];
  return blocked.length ? { state: HookApproval.Needed, blocked } : { state: HookApproval.Approved };
}

/** `vibeCoreHookApproval` from `client.request("hooks/list")`; an App Server without the method is unchecked. */
export async function hookApprovalFromClient(client, cwd) {
  try {
    return vibeCoreHookApproval(await client.request("hooks/list", { cwds: [cwd] }));
  } catch (error) {
    // An App Server that does not know hooks/list never will; a timeout or a closed connection may pass.
    return UNKNOWN_METHOD.test(error.message)
      ? { state: HookApproval.Unchecked, reason: "this Codex App Server has no hooks/list", final: true }
      : { state: HookApproval.Unchecked, reason: error.message };
  }
}

/** `vibeCoreHookApproval` from a short-lived App Server of the Codex CLI `executable`, started in `cwd`. */
export function codexHookApproval(executable, cwd = process.cwd(), { timeoutMs = LIST_TIMEOUT_MS } = {}) {
  const client = { request: (method, params) => codexAppServerRequest(executable, cwd, method, params, { timeoutMs, label: "Codex hook listing" }) };
  return hookApprovalFromClient(client, cwd);
}

/** The plain line for the developer, or null when vibe-core's hooks are approved. */
export function hookApprovalLine(approval) {
  switch (approval?.state) {
    case HookApproval.Missing:
      return `vibe-core is not installed in Codex, so vibe's guards cannot run there: run \`${ADD_VIBE_CORE}\`, then ${APPROVE_HOOKS}`;
    case HookApproval.Needed:
      return `vibe-core's hooks are not approved in Codex (${approval.blocked.join(", ")}), so vibe's guards cannot run there: ${APPROVE_HOOKS}`;
    case HookApproval.Unchecked:
      return `couldn't check whether vibe-core's hooks are approved in Codex (${approval.reason})`;
    default:
      return null;
  }
}
