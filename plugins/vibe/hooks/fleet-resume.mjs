// SessionStart guard for a compaction: an orchestrator whose context was just
// compacted is handed its program's reading list and the newest resume-log
// entry. fleet-orchestrator's state rules already said to re-read the resume
// log after a compaction, and two sessions acted on the harness summary alone
// (2026-10-22, twice; 2026-10-26), carrying the summary's wrong counts and
// dropping state it left out.
//
// It fires only when the session's transcript loaded the fleet-orchestrator
// skill and the fleet home (FLEET_HOME, else ~/fleet-orchestrator) has an
// active program, so a writer's compaction gets nothing.
//
// Runs from session-start.mjs.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHome, resumeLines } from "../skills/fleet-orchestrator/scripts/fleet-home.mjs";
import { loadsSkill, readTranscript } from "./skill-transcript.mjs";

const FLEET_HOME_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "fleet-orchestrator", "scripts", "fleet-home.mjs");
const ENTRY_HEADING = /^## /m;
const MAX_ENTRY_CHARS = 3000;

/** The SessionStart result after a compaction in an orchestrator session: its reading list as context, or null. */
export function fleetResume(event, env = process.env) {
  if (event?.source !== "compact" || !loadsSkill(readTranscript(event.transcript_path), "fleet-orchestrator")) return null;
  const home = defaultHome(env);
  if (!existsSync(path.join(home, "programs"))) return null;
  const lines = resumeLines(home);
  const active = lines.find((line) => line.startsWith("ACTIVE "));
  if (!active) return null;
  const programDir = active.split(" ").slice(2).join(" ");
  const entry = lastEntry(path.join(programDir, "resume-log.md"));
  return {
    context: [
      `Your context was just compacted, and the summary may be wrong or incomplete. Before any other action, run \`node "${FLEET_HOME_SCRIPT}" resume\` and read each READ file in order; it printed:`,
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
