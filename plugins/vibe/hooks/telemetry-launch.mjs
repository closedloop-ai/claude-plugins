// PostToolUse guard for Agent: counts a worker launch in the vibe session
// record's telemetry (WS0 M4). It runs after the call, so a launch another
// PreToolUse guard denied is never counted. Outside a vibe session worktree it
// does nothing. It never returns a decision or context.

import { updateSessionTelemetry, withLaunch } from "../skills/vibe/scripts/session-telemetry.mjs";
import { inVibeSession } from "./foreground-guard.mjs";
import { eventCwd } from "./hook-dispatch.mjs";

/** Records the launch; always returns null. */
export function telemetryLaunch(event) {
  const cwd = eventCwd(event);
  if (!inVibeSession(cwd)) return null;
  const worker = event?.tool_input?.subagent_type;
  updateSessionTelemetry(cwd, (stored) => withLaunch(stored, { worker: typeof worker === "string" ? worker : "general-purpose" }));
  return null;
}
