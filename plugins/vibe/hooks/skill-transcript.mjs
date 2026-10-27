// Which vibe-plugin skills a hook event's session loaded, read from the
// transcript the event names (Claude Code and Codex both pass transcript_path).
// A guard whose rule binds one skill's sessions checks it here, so a worker's
// or another skill's session never gets that skill's refusals or reminders.

import { readFileSync } from "node:fs";

/**
 * Each skill's load markers, never a mention of its files: Claude Code's skill base line
 * ("Base directory for this skill: <...>/skills/<name>"), a Skill tool call, and Codex's
 * injected `<skill><name>vibe:<name></name>` block. A plain Read or a file listing of
 * skills/vibe/SKILL.md once made any session in the plugin's own repository a vibe session
 * (PR #350 review).
 */
const SKILL_MARKERS = Object.freeze({
  vibe: /Base directory for this skill: [^"\\\n]*\/skills\/vibe(?=\\n|\n|"|$)|"skill":\s*"vibe:vibe"|<name>vibe:vibe<\/name>/gm,
  "fleet-orchestrator": /Base directory for this skill: [^"\\\n]*\/skills\/fleet-orchestrator(?=\\n|\n|"|$)|"skill":\s*"vibe:fleet-orchestrator"|<name>vibe:fleet-orchestrator<\/name>/gm,
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
  return lastLoad(text, skill) >= 0;
}

/** Of `skills`, the one transcript `text` loaded most recently, or null when it loaded none. */
export function latestSkill(text, skills) {
  let latest = null;
  let at = -1;
  for (const skill of skills) {
    const position = lastLoad(text, skill);
    if (position > at) {
      latest = skill;
      at = position;
    }
  }
  return latest;
}

function lastLoad(text, skill) {
  if (typeof text !== "string") return -1;
  let position = -1;
  for (const match of text.matchAll(SKILL_MARKERS[skill])) position = match.index;
  return position;
}
