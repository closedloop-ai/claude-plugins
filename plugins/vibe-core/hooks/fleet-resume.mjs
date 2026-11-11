// SessionStart guard for a compaction: an orchestrator whose context was just
// compacted is handed its program's reading list and the newest resume-log
// entry. fleet-orchestrator's state rules already said to re-read the resume
// log after a compaction, and two sessions acted on the harness summary alone
// (2026-10-22, twice; 2026-10-26), carrying the summary's wrong counts and
// dropping state it left out.
//
// Its first line says to invoke the skill again, because compaction keeps only
// the start of it. It fires only when the session's transcript loaded the fleet-orchestrator
// skill and the fleet home (FLEET_HOME, else ~/fleet-orchestrator) has an
// active program, so a writer's compaction gets nothing.
//
// Runs from session-start.mjs.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defaultHome, resumeLines } from "../lib/fleet-orchestrator/scripts/fleet-home.mjs";
import { loadsSkill, readTranscript } from "./skill-transcript.mjs";
import { readHookSkill } from "./hook-session-scope.mjs";
import { vibeScriptPath } from "../shared/vibe-install.mjs";

const FLEET_HOME_SCRIPT = "skills/fleet-orchestrator/scripts/fleet-home.mjs";
const ENTRY_HEADING = /^## /m;
const MAX_ENTRY_CHARS = 3000;
// Claude Code re-attaches only the first 5,000 tokens of each invoked skill after compaction
// (code.claude.com/docs/en/skills, "Skill content lifecycle"); invoking it again appends the full copy
// and gives the plugin-version guard the load evidence it checks (operator ruling, 2026-11-11).
export const REINVOKE_LINE = "First invoke the fleet-orchestrator skill again (the Skill tool with `vibe:fleet-orchestrator` in Claude Code, `$fleet-orchestrator` in Codex): after compaction only the first 5,000 tokens of it are left in context.";

/** The SessionStart result after a compaction in an orchestrator session: its reading list as context, or null. */
export function fleetResume(event, env = process.env) {
  if (event?.source !== "compact" || !(loadsSkill(readTranscript(event.transcript_path), "fleet-orchestrator")
    || readHookSkill(event?.session_id, env.HOME) === "fleet-orchestrator")) return null;
  const home = defaultHome(env);
  if (!existsSync(path.join(home, "programs"))) return null;
  const lines = resumeLines(home);
  const active = lines.find((line) => line.startsWith("ACTIVE "));
  if (!active) return null;
  const programDir = active.split(" ").slice(2).join(" ");
  const entry = lastEntry(path.join(programDir, "resume-log.md"));
  return {
    context: [
      REINVOKE_LINE,
      `Your context was just compacted, and the summary may be wrong or incomplete. Before any other action, run \`node "${vibeScriptPath(FLEET_HOME_SCRIPT)}" resume\` and read each READ file in order; it printed:`,
      ...lines,
      ...(entry ? ["", "The newest resume-log entry:", entry] : []),
    ].join("\n"),
  };
}

function lastEntry(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const starts = [...text.matchAll(new RegExp(ENTRY_HEADING.source, "gm"))].map((match) => match.index);
  const entry = (starts.length ? text.slice(starts.at(-1)) : text).trim();
  if (!entry) return null;
  return entry.length > MAX_ENTRY_CHARS ? `${entry.slice(0, MAX_ENTRY_CHARS)}\n(cut; read the file for the rest)` : entry;
}
