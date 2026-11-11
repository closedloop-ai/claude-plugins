// Private hook-owned skill state survives a missing or unreadable transcript.
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoadBasis, loadedSkillEvidence } from "../lib/vibe/scripts/loaded-skill.mjs";
import { latestSkill, readTranscript } from "./skill-transcript.mjs";
import { vibeRoot } from "../shared/vibe-install.mjs";

const SESSION = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SCOPED = new Map([["vibe:vibe", "vibe"], ["vibe:fleet-orchestrator", "fleet-orchestrator"]]);
const VIBE_PLUGIN_SKILL = /^vibe:[a-z0-9-]+$/;

function scopePath(sessionId, home) {
  if (!SESSION.test(sessionId ?? "")) return null;
  return path.join(home, ".vibe-hook-scope", `${sessionId}.json`);
}

/** A hook's private per-session state file under `~/.vibe-hook-scope/<hook>/`, or null for an unusable session id. */
export function hookStatePath(sessionId, hook, home = os.homedir()) {
  if (!SESSION.test(sessionId ?? "")) return null;
  return path.join(home, ".vibe-hook-scope", hook, `${sessionId}.json`);
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

/**
 * Records a skill start in this session's hook record. Only a vibe-plugin skill writes: it marks the
 * chat activated for vibe-core's hooks, and vibe or fleet-orchestrator also becomes the scoped skill.
 * Any other skill leaves the record as it was (operator ruling, 2026-11-11: activation lasts until the
 * chat ends or the 7-day expiry, and an unrelated later Skill call no longer clears it), so a chat that
 * never loads a vibe-plugin skill gets no record at all. `runtime` comes from hookRuntime, `cwd` is the
 * event's (the vibe install it resolves is the one the stand-down chose).
 */
export function recordHookSkill(sessionId, skill, home = os.homedir(), now = new Date(), runtime = null, cwd = process.cwd()) {
  const file = scopePath(sessionId, home);
  if (!file || !isVibePluginSkill(skill)) return null;
  const scoped = SCOPED.get(skill) ?? null;
  const previous = scoped ? null : readOwnRecord(file, sessionId, home, now);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const record = scoped
    ? { sessionId, skill: scoped, activated: true, recordedAt: now.toISOString(),
      ...(runtime ? { loadedSkill: loadedSkillEvidence(sessionId, runtime, vibeRoot(cwd), scoped, LoadBasis.HookObserved) } : {}) }
    : { ...(previous ?? { sessionId, skill: null }), activated: true, recordedAt: now.toISOString() };
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return record.skill;
}

/** Whether `skill` (a Skill tool name such as "vibe:handoff") is one of the vibe plugin's skills. */
export function isVibePluginSkill(skill) {
  return typeof skill === "string" && VIBE_PLUGIN_SKILL.test(skill);
}

/** Whether this exact session's hook record says it activated vibe within the last 7 days. */
export function hookActivated(sessionId, home = os.homedir(), now = new Date()) {
  const file = scopePath(sessionId, home);
  return file !== null && readOwnRecord(file, sessionId, home, now)?.activated === true;
}

function readOwnRecord(file, sessionId, home, now) {
  const record = readSmallJson(file);
  return record?.sessionId === sessionId && fresh(record.recordedAt, now) ? record : null;
}

function fresh(recordedAt, now) {
  const age = now.getTime() - Date.parse(recordedAt ?? "");
  return age >= 0 && age <= MAX_AGE_MS;
}

function readSmallJson(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch { return null; }
}

/** Only a recent marker for this exact harness session scopes a PR call. */
export function readHookSkill(sessionId, home = os.homedir(), now = new Date()) {
  const file = scopePath(sessionId, home);
  if (!file) return null;
  const record = readOwnRecord(file, sessionId, home, now);
  return ["vibe", "fleet-orchestrator"].includes(record?.skill) ? record.skill : null;
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
