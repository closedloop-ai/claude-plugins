// Which vibe-plugin skills a hook event's session loaded, read from the
// transcript the event names (Claude Code and Codex both pass transcript_path).
// A guard whose rule binds one skill's sessions checks it here, so a worker's
// or another skill's session never gets that skill's refusals or reminders.

import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * How much of a transcript a hook reads: all of it up to TRANSCRIPT_LIMIT_BYTES, else its first
 * HEAD_BYTES and last TAIL_BYTES. A long chat's transcript grows past what one string can hold
 * (Node's limit is about 512 MiB), and a whole read then returned nothing at all; the sticky hook
 * record (hook-session-scope.mjs) carries a load that falls between the two ends.
 */
export const TRANSCRIPT_LIMIT_BYTES = 64 * 1024 * 1024;
const HEAD_BYTES = 16 * 1024 * 1024;
const TAIL_BYTES = 48 * 1024 * 1024;

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
  // Any skill of the vibe plugin: its base line under the plugin's own folder (a checkout's
  // plugins/vibe, or vibe/<version> in a harness cache), a Skill call, or a Codex skill block.
  "vibe-plugin": /Base directory for this skill: [^"\\\n]*\/(?:plugins\/vibe|vibe\/[^/"\\\n]+)\/skills\/[a-z0-9-]+(?=\\n|\n|"|$)|"skill":\s*"vibe:[a-z0-9-]+"|<name>vibe:[a-z0-9-]+<\/name>/gm,
});

/** The transcript text at `file` (both ends of one past TRANSCRIPT_LIMIT_BYTES), or null when there is none to read. */
export function readTranscript(file) {
  if (typeof file !== "string" || file === "") return null;
  let fd = null;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    if (size <= TRANSCRIPT_LIMIT_BYTES) return readRange(fd, 0, size);
    return `${readRange(fd, 0, HEAD_BYTES)}\n${readRange(fd, size - TAIL_BYTES, TAIL_BYTES)}`;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readRange(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, position + read);
    if (count === 0) break;
    read += count;
  }
  return buffer.subarray(0, read).toString("utf8");
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
