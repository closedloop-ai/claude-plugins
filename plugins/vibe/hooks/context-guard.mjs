// vibe's compaction control for a long-running fleet-orchestrator chat in Claude
// Code (ISS-13859; the operator ruled on 2026-11-09 to "rescope to compaction").
// Every request re-reads the whole conversation from the prompt cache, so the
// cost of a request follows where compaction happens and what its summary keeps.
//
// PostToolUse (contextGuard): when the chat was launched without
// CLAUDE_CODE_AUTO_COMPACT_WINDOW (Claude Code reads it at launch, 100k to 1M
// tokens, over every other window setting), the operator is told once how to
// relaunch with the window in <fleetHome>/context-guard.json. Nothing writes the
// variable or the autoCompactWindow setting, which would change every chat. At
// flushAtPercent of the window the model is told, once per compaction cycle, to
// bring the program's state files current (with no window, at each step of growth).
// PreCompact (compactionInstructions): Claude Code uses the hook's stdout as the
// summary's instructions, so the summary leaves out what those files hold.
//
// Context = input + cache read + cache write tokens of the latest assistant
// request. Only sessions that loaded fleet-orchestrator, never a subagent's tool
// call. A load is a parsed Claude Code entry (the Skill tool call or the
// injected isMeta base line), never marker text a prompt or command quotes, and
// never the hook skill record, which a Codex-form "$fleet-orchestrator" prompt
// writes in any runtime. The load check never rescans the transcript: state
// keeps the offset of the last whole line scanned. Fails open: any error
// returns null, so nothing is printed and no tool call or compaction is blocked.

import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkDir } from "../skills/codex-fleet-monitor/scripts/work-dir.mjs";
import { COMPACT_WINDOW_RANGE, contextGuardConfig, defaultHome, PROGRAM_READING } from "../skills/fleet-orchestrator/scripts/fleet-home.mjs";
import { hookStatePath } from "./hook-session-scope.mjs";

const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
const ORCHESTRATOR_SKILL = "vibe:fleet-orchestrator";
const ORCHESTRATOR_BASE_LINE = /^Base directory for this skill: [^\n]*\/skills\/fleet-orchestrator$/;
const USAGE_WINDOWS = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024];
const WINDOW_VARIABLE = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
// Claude Code's reading of the variable: tokens, or a k/M suffix; outside COMPACT_WINDOW_RANGE it clamps.
const WINDOW_VALUE = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/;

/** The PostToolUse result for `event`: the window notice and the flush prompt when due, else null. Never throws. */
export function contextGuard(event, env = process.env) {
  try {
    return evaluate(event, env);
  } catch {
    return null;
  }
}

/** The PreCompact stdout for `event`: instructions for the compaction summary in a fleet-orchestrator chat, else null. Never throws. */
export function compactionInstructions(event, env = process.env) {
  try {
    const chat = fleetChat(event, env);
    const dirs = chat && stateDirs(chat.home);
    if (!dirs) return null;
    const { programDir, home } = dirs;
    return [
      "This chat is a vibe fleet-orchestrator chat. Its program state lives in files that vibe's SessionStart hook has the chat reread right after this compaction:",
      ...PROGRAM_READING.map((name) => `- ${path.join(programDir, name)}`),
      `- ${path.join(home, "lessons.md")} and ${path.join(home, "standing-rulings.md")}`,
      "Do not restate what those files hold (program history, the board, recorded rulings, lessons). Keep the summary short, and keep only:",
      "- every question to the operator that is still open, word for word;",
      "- every operator ruling not yet written to rulings.md, quoted with who said it and when;",
      "- the name of every live worker, session, watcher and background job, with what it is doing and where its output goes;",
      "- every promise made to the operator that is not yet kept.",
    ].join("\n");
  } catch {
    return null;
  }
}

function evaluate(event, env) {
  const chat = fleetChat(event, env);
  if (!chat) return null;
  const { state, config, stateFile, size } = chat;
  const result = {};
  const window = windowTokens(env[WINDOW_VARIABLE]);
  if (window === null && state.windowNoticeShown !== true) {
    state.windowNoticeShown = true;
    result.systemMessage = `This fleet-orchestrator chat has no usable ${WINDOW_VARIABLE}, so it compacts where Claude Code's own settings put it. To compact at ${kilo(config.compactWindowTokens)} (set in ${config.file}), relaunch it with: ${WINDOW_VARIABLE}=${config.compactWindowTokens} claude --resume ${event.session_id}`;
  }
  const tokens = latestContextTokens(event.transcript_path, size);
  const dirs = stateDirs(chat.home);
  const flushAt = (window ?? config.compactWindowTokens) * config.flushAtPercent / 100;
  if (tokens !== null && tokens < flushAt) state.flushedAt = null;
  // With no window the chat compacts where Claude Code's own settings put it, so instead of once
  // per cycle the prompt repeats each time the context grows by the headroom a window would leave.
  const step = window === null ? config.compactWindowTokens * (100 - config.flushAtPercent) / 100 : Number.POSITIVE_INFINITY;
  const flushedAt = Number.isFinite(state.flushedAt) ? state.flushedAt : null;
  if (dirs && tokens !== null && tokens >= flushAt && (flushedAt === null || tokens - flushedAt >= step)) {
    state.flushedAt = tokens;
    const point = window === null
      ? `has no usable ${WINDOW_VARIABLE}, so it compacts where Claude Code's own settings put it; this repeats every ${kilo(step)} of growth`
      : `compacts at about ${kilo(window)}`;
    result.context = `CONTEXT GUARD (flush): this chat re-reads about ${kilo(tokens)} tokens per request and ${point}. Before that, bring the program state files in ${dirs.programDir} current (${PROGRAM_READING.join(", ")}): open operator questions, rulings not yet in rulings.md, live workers and sessions, and promises to the operator. After compaction vibe's SessionStart reading list reloads them.`;
  }
  return writeState(stateFile, state, Object.keys(result).length > 0 ? result : null);
}

/** The state of a main-thread fleet-orchestrator chat for `event`, or null (after saving its scan) for any other. */
function fleetChat(event, env) {
  if (event?.agent_id) return null;
  const transcript = event?.transcript_path;
  const stateFile = hookStatePath(event?.session_id, "context-guard", env.HOME || os.homedir());
  if (typeof transcript !== "string" || transcript === "" || !stateFile) return null;
  const home = defaultHome(env);
  const config = contextGuardConfig(home);
  if (!config.enabled) return null;
  const state = readState(stateFile);
  const size = statSync(transcript).size;
  if (state.matched !== true) {
    const from = Number.isInteger(state.scannedBytes) && state.scannedBytes <= size ? state.scannedBytes : 0;
    const scan = scanLoadsOrchestrator(transcript, from, size);
    state.matched = scan.matched;
    state.scannedBytes = scan.scannedBytes;
    if (!state.matched) return writeState(stateFile, state, null);
  }
  return { state, config, stateFile, size, home };
}

/** The window Claude Code compacts at for a CLAUDE_CODE_AUTO_COMPACT_WINDOW value, or null when unset or unusable. */
function windowTokens(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const match = WINDOW_VALUE.exec(value);
  if (!match) return null;
  const scale = { "": 1, k: 1_000, m: 1_000_000 }[match[2].toLowerCase()];
  const tokens = Number(match[1]) * scale;
  return Number.isFinite(tokens) && tokens > 0 ? Math.min(Math.max(tokens, COMPACT_WINDOW_RANGE[0]), COMPACT_WINDOW_RANGE[1]) : null;
}

/** The active program's dir and the home, or null with no active program (no state files to flush or reread). */
function stateDirs(home) {
  try {
    const resolved = resolveWorkDir(home);
    return resolved.program ? { programDir: resolved.dir, home: path.resolve(home) } : null;
  } catch {
    return null;
  }
}

/**
 * Whether the whole lines in bytes [from, size) of `file` hold a fleet-orchestrator load, and the
 * offset to resume from: past the last whole line, so a line still being written is read next time.
 */
function scanLoadsOrchestrator(file, from, size) {
  const fd = openSync(file, "r");
  try {
    let offset = from;
    let insideLongLine = false;
    while (offset < size) {
      const chunk = readBytes(fd, offset, Math.min(SCAN_CHUNK_BYTES, size - offset));
      const end = chunk.lastIndexOf(0x0a);
      if (end < 0) {
        if (offset + chunk.length >= size) break;
        // One line longer than a chunk is a tool result or similar, never a load entry: skip to its end.
        offset += chunk.length;
        insideLongLine = true;
        continue;
      }
      const lines = chunk.subarray(0, end).toString("utf8").split("\n");
      if (lines.slice(insideLongLine ? 1 : 0).some(isOrchestratorLoad)) return { matched: true, scannedBytes: size };
      offset += end + 1;
      insideLongLine = false;
    }
    return { matched: false, scannedBytes: offset };
  } finally {
    closeSync(fd);
  }
}

/** Whether transcript `line` is a main-thread Claude Code load of fleet-orchestrator. */
function isOrchestratorLoad(line) {
  if (!line.includes("fleet-orchestrator")) return false;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return false;
  }
  if (entry?.isSidechain === true) return false;
  const content = entry?.message?.content;
  if (entry?.type === "assistant") {
    return Array.isArray(content) && content.some((block) => block?.type === "tool_use" && block.name === "Skill" && block.input?.skill === ORCHESTRATOR_SKILL);
  }
  if (entry?.type !== "user" || entry.isMeta !== true) return false;
  return entryTexts(content).some((text) => ORCHESTRATOR_BASE_LINE.test(text.split("\n", 1)[0]));
}

function entryTexts(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text);
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
