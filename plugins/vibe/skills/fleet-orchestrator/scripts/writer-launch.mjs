// Launch checks for a Codex fleet writer that codex-session.mjs runs before a thread or turn
// starts: where the thread starts, whether a thread with no session may take a
// recovery turn, and whether vibe-core's Codex hooks (which run vibe's guards) are installed
// and approved so its first turn records load evidence for itself.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { ADD_VIBE_CORE, APPROVE_HOOKS, HookApproval, runningHookApproval, UNKNOWN_METHOD } from '../../vibe/scripts/vibe-core-hooks.mjs';
import { issueKey, requirementsKey, trackerBound } from "../../vibe/scripts/tracker-key.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

export const { briefProviderProblem, briefWithProviderLine, providerLine } = await vibeCore("lib/vibe/scripts/provider-brief.mjs");

export const VIBE_PROMPT = /^\s*\$vibe\b/;
/**
 * The work item a `$vibe` brief names: the bound tracker's issue or requirements key (tracker-key.mjs), or with no
 * tracker a local work id (`#123`), as fleet units are named then.
 */
export const vibeBriefTicket = () => new RegExp(String.raw`^\s*\$vibe[^\r\n]*?(?<![\w#])(${trackerBound() ? `${issueKey()}|${requirementsKey()}` : String.raw`#\d+`})\b`);

const WORKTREES = path.join('.claude', 'worktrees');

function checkoutTop(dir) {
  try {
    return realpathSync(execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null;
  }
}

/**
 * The directory a writer's thread runs in. Codex runs hooks with the thread's cwd as their working
 * directory, so a worktree `vibe new` has not created yet runs no hook; such a thread starts in the
 * checkout that owns `<checkout>/.claude/worktrees/<name>`, where `vibe new` then creates it.
 */
export function launchCwd(worktree) {
  if (existsSync(worktree)) return worktree;
  const owner = path.dirname(path.dirname(path.dirname(worktree)));
  if (path.dirname(worktree) === path.join(owner, WORKTREES) && existsSync(owner) && checkoutTop(owner) === realpathSync(owner)) return owner;
  throw new Error(`--cwd ${worktree} does not exist and is not <checkout>/.claude/worktrees/<name> under an existing checkout; `
    + "pass the session's worktree path inside the repository's main checkout, where the writer's vibe new creates it");
}

/** launchCwd for a thread already admitted at launch: a path it cannot place is used as given. */
export function threadCwd(worktree) {
  try {
    return launchCwd(worktree);
  } catch {
    return worktree;
  }
}

/**
 * Whether a saved thread whose first turn ended before `vibe new` may take this turn: only a
 * `$vibe` brief for the thread's own ticket, while its worktree still does not exist. Returns the
 * reason it may not, or null.
 */
export function recoveryTurnProblem(saved, prompt) {
  const recovery = `a thread whose first turn created no session takes only a $vibe ${saved.ticket ?? '<ticket>'} recovery turn`;
  if (existsSync(saved.cwd)) return `no vibe session record in ${saved.cwd}; the first $vibe turn must create it before any resume`;
  if (!VIBE_PROMPT.test(String(prompt ?? ''))) return `no vibe session record in ${saved.cwd} yet; ${recovery}`;
  const ticket = vibeBriefTicket().exec(prompt)?.[1];
  if (!ticket || (saved.ticket && ticket !== saved.ticket)) {
    return `recovery turn names ticket ${ticket ?? 'none'}, but this thread is for ${saved.ticket ?? 'no recorded ticket'}; ${recovery}`;
  }
  return null;
}

/**
 * Why vibe's guards cannot run in Codex for a writer started in `cwd`, judged on the hooks that will run there:
 * an older vibe's own when it lists any, else vibe-core's, which must be listed, enabled and approved.
 * Null when they all run; an App Server without hooks/list is not checked.
 */
export async function vibeHookTrustProblem(client, cwd) {
  let listing;
  try {
    listing = await client.request('hooks/list', { cwds: [cwd] });
  } catch (error) {
    if (UNKNOWN_METHOD.test(error.message)) return null;
    return `could not list Codex hooks: ${error.message}`;
  }
  const approval = runningHookApproval(listing);
  if (approval.plugin === "vibe" && approval.state === HookApproval.Needed) {
    return `vibe's Codex hooks cannot run (${approval.blocked.join(', ')}); open Codex once and approve vibe's hooks in /hooks (each vibe release before vibe-core changes the plugin bundle Codex approved), then launch again`;
  }
  if (approval.state === HookApproval.Missing) {
    return `vibe-core's Codex hooks are not installed, so vibe's guards cannot run; run \`${ADD_VIBE_CORE}\`, then ${APPROVE_HOOKS}, then launch again`;
  }
  if (approval.state === HookApproval.Needed) {
    return `vibe-core's Codex hooks cannot run (${approval.blocked.join(', ')}); ${APPROVE_HOOKS} (each vibe-core release changes the plugin bundle Codex approved), then launch again`;
  }
  return null;
}
