// PostToolUse guard for a long-running fleet-orchestrator chat whose per-request
// context has grown large. Every request re-reads the whole conversation from the
// prompt cache: on 2026-11-09 one orchestrator chat spent $87 on 409 requests,
// almost all of it cache reads at 320k to 420k tokens per request, and nothing
// told the operator. The operator's ruling (ISS-13859): detect it, keep the limits in a
// file the operator can edit, and recommend a handoff for the operator to decide,
// never a hard stop.
//
// Context = input + cache read + cache write tokens of the latest assistant
// request in the transcript. The thresholds are <fleetHome>/context-guard.json
// (fleet-home.mjs contextGuardConfig), read on every call. At the warn threshold
// it says so once; at the handoff threshold it recommends a handoff and repeats
// that every remindEveryMinutes. A drop below warn (a compaction) re-arms both.
// Each chat is told its own handoff file, in the home's active program dir (else
// the home), named for its session id and the day it was first named, so it
// never shares a path or points at another chat's notes (ticket v3, after the
// local version had an unrelated chat offer another chat's handoff).
//
// Only sessions that loaded fleet-orchestrator, never a subagent's tool call. The
// load check never rescans the transcript: state keeps the offset scanned so far,
// so a later call reads only what was appended plus a 4 KB overlap. Fails open: any error
// returns null, so a tool call is never blocked and nothing is printed.
//
// Runs from post-tool-use.mjs.

import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatHandoffDir, chatHandoffFile, contextGuardConfig, defaultHome } from "../skills/fleet-orchestrator/scripts/fleet-home.mjs";
import { hookStatePath, readHookSkill } from "./hook-session-scope.mjs";
import { loadsSkill } from "./skill-transcript.mjs";

const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
// Longer than any skill load marker, so one split across two chunks is still seen whole.
const SCAN_OVERLAP_BYTES = 4096;
const USAGE_WINDOWS = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024];

const ContextLevel = Object.freeze({ Warn: "warn", Handoff: "handoff" });

/** The PostToolUse result for `event`: a notice when one is due, else null. Never throws. */
export function contextGuard(event, env = process.env, now = Date.now()) {
  try {
    return evaluate(event, env, now);
  } catch {
    return null;
  }
}

function evaluate(event, env, now) {
  if (event?.agent_id) return null;
  const transcript = event?.transcript_path;
  const userHome = env.HOME || os.homedir();
  const stateFile = hookStatePath(event?.session_id, "context-guard", userHome);
  if (typeof transcript !== "string" || transcript === "" || !stateFile) return null;
  const home = defaultHome(env);
  const config = contextGuardConfig(home);
  if (!config.enabled) return null;
  const state = readState(stateFile);
  const size = statSync(transcript).size;
  if (state.matched !== true) {
    const from = Number.isInteger(state.scannedBytes) && state.scannedBytes <= size ? state.scannedBytes : 0;
    state.matched = readHookSkill(event.session_id, userHome) === "fleet-orchestrator" || scanLoadsOrchestrator(transcript, from, size);
    state.scannedBytes = size;
    if (!state.matched) return writeState(stateFile, state, null);
  }
  const tokens = latestContextTokens(transcript, size);
  if (tokens === null) return writeState(stateFile, state, null);
  const level = levelFor(tokens, config);
  const due = level !== null && (state.lastLevel !== level
    || (level === ContextLevel.Handoff && now - (state.lastNotifiedAt ?? 0) >= config.remindEveryMinutes * 60_000));
  state.lastTokens = tokens;
  if (level === null) state.lastLevel = null;
  if (due) {
    state.lastLevel = level;
    state.lastNotifiedAt = now;
    if (typeof state.handoffDay !== "string") state.handoffDay = new Date(now).toISOString().slice(0, 10);
  }
  const handoffFile = due ? chatHandoffFile(chatHandoffDir(home), event.session_id, state.handoffDay) : null;
  return writeState(stateFile, state, due ? notice(level, tokens, config, handoffFile) : null);
}

/** The level `tokens` reaches under `config`, or null below the warn threshold. */
function levelFor(tokens, config) {
  if (tokens >= config.handoffContextTokens) return ContextLevel.Handoff;
  if (tokens >= config.warnContextTokens) return ContextLevel.Warn;
  return null;
}

/** Whether bytes [from, size) of `file` (with a small overlap before `from`) show a fleet-orchestrator load. */
function scanLoadsOrchestrator(file, from, size) {
  const fd = openSync(file, "r");
  try {
    for (let start = Math.max(0, from - SCAN_OVERLAP_BYTES); start < size; start += SCAN_CHUNK_BYTES - SCAN_OVERLAP_BYTES) {
      const length = Math.min(SCAN_CHUNK_BYTES, size - start);
      if (loadsSkill(readBytes(fd, start, length).toString("utf8"), "fleet-orchestrator")) return true;
      if (start + length >= size) break;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Input + cache read + cache write tokens of the latest main-thread assistant request in `file`, or null. */
export function latestContextTokens(file, size = statSync(file).size) {
  const fd = openSync(file, "r");
  try {
    for (const window of USAGE_WINDOWS) {
      const start = Math.max(0, size - window);
      const lines = readBytes(fd, start, size - start).toString("utf8").split("\n");
      for (let index = lines.length - 1; index >= (start > 0 ? 1 : 0); index -= 1) {
        const tokens = requestTokens(lines[index]);
        if (tokens !== null) return tokens;
      }
      if (start === 0) return null;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function requestTokens(line) {
  if (!line.includes('"usage"')) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const usage = entry?.type === "assistant" && entry.isSidechain !== true ? entry.message?.usage : null;
  if (!usage || typeof usage !== "object") return null;
  const total = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
    .reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  return total > 0 ? total : null;
}

function readBytes(fd, start, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, start + read);
    if (count === 0) break;
    read += count;
  }
  return buffer.subarray(0, read);
}

function readState(file) {
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

function writeState(file, state, result) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return result;
}

const kilo = (tokens) => `${Math.round(tokens / 1000)}k`;

/** The user line and the model context for a due notice at `level`, naming this chat's own `handoffFile`. */
export function notice(level, tokens, config, handoffFile) {
  if (level === ContextLevel.Warn) {
    return {
      systemMessage: `Context is ${kilo(tokens)} tokens per request (warn at ${kilo(config.warnContextTokens)}). Plan a handoff to a fresh chat soon to save tokens.`,
      context: `CONTEXT GUARD (warn): this chat now re-reads about ${kilo(tokens)} tokens on every request (warn threshold ${kilo(config.warnContextTokens)}, set in ${config.file}). Finish the current step, keep this chat's own handoff notes current in ${handoffFile}, and expect to recommend a handoff at ${kilo(config.handoffContextTokens)}.`,
    };
  }
  return {
    systemMessage: `Context is ${kilo(tokens)} tokens per request (handoff recommended at ${kilo(config.handoffContextTokens)}). A fresh orchestrator chat would cut the token burn; it is your call.`,
    context: `CONTEXT GUARD (handoff recommended): this chat re-reads about ${kilo(tokens)} tokens on every request, past the ${kilo(config.handoffContextTokens)} threshold in ${config.file}. Recommend a handoff to the operator and let them decide; do not stop or pause any work on your own. In your next reply, say in one line how large the context is and that a fresh chat would save tokens, and ask whether to hand off now. Meanwhile keep this chat's own handoff file ${handoffFile} current, never another chat's (live state, in-flight workers, queued work, rulings, pitfalls, and a "First steps" section that invokes vibe:fleet-orchestrator and vibe:codex-fleet-monitor) so a handoff costs nothing extra when they say yes. Only after the operator agrees: stop the work this chat owns that a new chat would orphan (its watcher and delivery loops, never independent workers) and give them a ready-to-paste prompt for the new orchestrator that points at the handoff file.`,
  };
}
