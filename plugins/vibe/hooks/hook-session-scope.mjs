// Private hook-owned skill state survives a missing or unreadable transcript.
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadedSkillEvidence } from "../skills/vibe/scripts/loaded-skill.mjs";

const SESSION = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SCOPED = new Map([["vibe:vibe", "vibe"], ["vibe:fleet-orchestrator", "fleet-orchestrator"]]);
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scopePath(sessionId, home) {
  if (!SESSION.test(sessionId ?? "")) return null;
  return path.join(home, ".vibe-hook-scope", `${sessionId}.json`);
}

/** Persist the latest Skill hook event, including a later non-vibe skill. */
export function recordHookSkill(sessionId, skill, home = os.homedir(), now = new Date(), runtime = null) {
  const file = scopePath(sessionId, home);
  if (!file) return null;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const scoped = SCOPED.get(skill) ?? null;
  const harness = runtime ?? (process.env.CLAUDE_CODE_SESSION_ID ? "claude" : process.env.CODEX_THREAD_ID ? "codex" : null);
  const record = { sessionId, skill: scoped, recordedAt: now.toISOString(),
    ...(scoped && harness ? { loadedSkill: loadedSkillEvidence(sessionId, harness, PLUGIN_ROOT, scoped) } : {}) };
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return record.skill;
}

/** Only a recent marker for this exact harness session scopes a PR call. */
export function readHookSkill(sessionId, home = os.homedir(), now = new Date()) {
  const file = scopePath(sessionId, home);
  if (!file) return null;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const record = JSON.parse(readFileSync(file, "utf8"));
    const age = now.getTime() - Date.parse(record.recordedAt ?? "");
    return record.sessionId === sessionId && age >= 0 && age <= MAX_AGE_MS
      && ["vibe", "fleet-orchestrator"].includes(record.skill) ? record.skill : null;
  } catch { return null; }
}

/** Full exact-session hook record, including machine-observed loaded definition. */
export function readHookSkillRecord(sessionId, home = os.homedir()) {
  const file = scopePath(sessionId, home);
  if (!file) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return null; }
}
