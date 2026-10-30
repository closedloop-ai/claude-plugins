// Private hook-owned skill state survives a missing or unreadable transcript.
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LoadBasis, loadedSkillEvidence } from "../skills/vibe/scripts/loaded-skill.mjs";
import { latestSkill, readTranscript } from "./skill-transcript.mjs";

const SESSION = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SCOPED = new Map([["vibe:vibe", "vibe"], ["vibe:fleet-orchestrator", "fleet-orchestrator"]]);
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scopePath(sessionId, home) {
  if (!SESSION.test(sessionId ?? "")) return null;
  return path.join(home, ".vibe-hook-scope", `${sessionId}.json`);
}

/**
 * The harness that sent a hook event, read from the event itself rather than the environment.
 * Codex adds `model` to every hook's input and `turn_id` to turn-scoped ones
 * (learn.chatgpt.com/docs/hooks, common input fields and UserPromptSubmit); Claude Code sends
 * neither at the top level of UserPromptSubmit or PreToolUse input, and `model` only on
 * SessionStart (code.claude.com/docs/en/hooks). CODEX_THREAD_ID is not documented for hooks.
 */
export function hookRuntime(event) {
  return typeof event?.turn_id === "string" || typeof event?.model === "string" ? "codex" : "claude";
}

/** Persist the latest Skill hook event, including a later non-vibe skill; `runtime` comes from hookRuntime. */
export function recordHookSkill(sessionId, skill, home = os.homedir(), now = new Date(), runtime = null) {
  const file = scopePath(sessionId, home);
  if (!file) return null;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const scoped = SCOPED.get(skill) ?? null;
  const record = { sessionId, skill: scoped, recordedAt: now.toISOString(),
    ...(scoped && runtime ? { loadedSkill: loadedSkillEvidence(sessionId, runtime, PLUGIN_ROOT, scoped, LoadBasis.HookObserved) } : {}) };
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

/** Full exact-session hook record, including the hook-observed loaded definition. */
export function readHookSkillRecord(sessionId, home = os.homedir()) {
  const file = scopePath(sessionId, home);
  if (!file) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return null; }
}

/** The vibe skill this hook event's conversation runs ("vibe" or "fleet-orchestrator"): its transcript first, then a recent hook record. */
export function conversationSkill(event, home = os.homedir()) {
  const transcript = readTranscript(event?.transcript_path);
  return (transcript === null ? null : latestSkill(transcript, ["vibe", "fleet-orchestrator"])) ?? readHookSkill(event?.session_id, home);
}
