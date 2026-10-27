// Which vibe-plugin skills a hook event's session loaded, read from the
// transcript the event names (Claude Code and Codex both pass transcript_path).
// A guard whose rule binds one skill's sessions checks it here, so a worker's
// or another skill's session never gets that skill's refusals or reminders.

import { readFileSync } from "node:fs";

/** Each skill's load markers: its SKILL.md path, the Claude skill base line, or a Skill tool call. */
const SKILL_MARKERS = Object.freeze({
  vibe: /skills\/vibe\/SKILL\.md|skills\/vibe(?=\\n|\n|"|$)|"skill":\s*"vibe:vibe"/m,
  "fleet-orchestrator": /skills\/fleet-orchestrator(?=\/SKILL\.md|\\n|\n|"|$)|"skill":\s*"vibe:fleet-orchestrator"/m,
});

/** The transcript text at `file`, or null when there is none to read. */
export function readTranscript(file) {
  if (typeof file !== "string" || file === "") return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Whether transcript `text` shows the session loaded `skill` (a key of SKILL_MARKERS). */
export function loadsSkill(text, skill) {
  return typeof text === "string" && SKILL_MARKERS[skill].test(text);
}
