// Whether a hook event comes from a chat that activated vibe (operator ruling, 2026-11-11). A hook
// marked `activated` in its route does nothing at all elsewhere: no output, no context, no refusal,
// no state write and no network call, so a chat that never used vibe pays nothing for having it
// installed. A chat is activated when any of these holds:
// - it loaded a skill of the vibe plugin: the sticky hook record (hook-session-scope.mjs), or a load
//   marker in the readable ends of its transcript;
// - it is a worker the vibe launcher started (a headless writer runs with the agent flag and loads no
//   skill, so the launcher records its session id);
// - its working directory is inside a vibe session's worktree.
// Activation lasts until the chat ends or the 7-day expiry of the record.
//
// hook-dispatch.mjs computes it at most once per event, and only when a gated guard is routed.

import os from "node:os";
import { inVibeSession } from "./foreground-guard.mjs";
import { eventCwd } from "./hook-dispatch.mjs";
import { hookActivated } from "./hook-session-scope.mjs";
import { launcherWorker } from "../lib/vibe/scripts/worker-scope.mjs";
import { loadsSkill, readTranscript } from "./skill-transcript.mjs";

/** How a chat is activated ("hook-record", "launcher-worker", "transcript", "vibe-worktree"), or null when it is not. */
export function activationBasis(event, home = os.homedir()) {
  const session = event?.session_id;
  if (hookActivated(session, home)) return "hook-record";
  if (launcherWorker(session, home)) return "launcher-worker";
  if (loadsSkill(readTranscript(event?.transcript_path), "vibe-plugin")) return "transcript";
  if (inVibeSession(eventCwd(event))) return "vibe-worktree";
  return null;
}

/** Whether `event` comes from an activated chat. */
export function activated(event, home = os.homedir()) {
  return activationBasis(event, home) !== null;
}
