// Which harness conversation a vibe script runs in. Claude Code exports
// CLAUDECODE=1 and CLAUDE_CODE_SESSION_ID to its commands and Codex exports
// CODEX_THREAD_ID, and each harness's children inherit the other's variables:
// a Codex App Server started from a Claude Code chat hands that chat's
// CLAUDE_CODE_SESSION_ID to every Codex thread it runs. When both
// ids are set, the nearest harness process above this one owns the command.

import { execFileSync } from "node:child_process";
import path from "node:path";

export const Harness = Object.freeze({ Claude: "claude", Codex: "codex" });

const CONVERSATION = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_ANCESTORS = 32;
const PS_TIMEOUT_MS = 2000;
const PS_MAX_BUFFER = 64 * 1024;

function valid(value) {
  return typeof value === "string" && CONVERSATION.test(value) ? value : null;
}

/** The harness one process command line belongs to, or null. */
export function harnessOfCommand(command) {
  const executable = String(command ?? "").trim().split(/\s+/)[0] ?? "";
  const name = path.basename(executable);
  if (name === Harness.Codex || name.startsWith(`${Harness.Codex}-`) || /\/@openai\/codex\//.test(command)) return Harness.Codex;
  if (name === Harness.Claude || /\/claude\/versions\/[^/\s]+$/.test(executable) || /\/@anthropic-ai\/claude-code\//.test(command)) return Harness.Claude;
  return null;
}

/** Command lines of this process's ancestors, nearest first; empty when `ps` cannot be read. */
export function processAncestry(pid = process.ppid, { ps = "ps" } = {}) {
  const commands = [];
  let current = pid;
  try {
    for (let depth = 0; depth < MAX_ANCESTORS && current > 1; depth += 1) {
      const line = execFileSync(ps, ["-o", "ppid=,args=", `-p${current}`], {
        encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const match = /^(\d+)\s+(.*)$/.exec(line);
      if (!match) break;
      commands.push(match[2]);
      current = Number(match[1]);
    }
  } catch {
    // A sandbox that refuses `ps` leaves the ancestry it read so far.
  }
  return commands;
}

/**
 * The conversation this process acts for: `{ runtime, id }`, or null outside a harness.
 * With both ids set, the nearest harness ancestor decides; when none can be read, the
 * Codex thread wins, because Codex threads inherit a stale Claude id from the shell that
 * started the App Server while CODEX_THREAD_ID is set for each command.
 */
export function harnessActor(env = process.env, { ancestry = processAncestry } = {}) {
  const claudeId = valid(env.CLAUDE_CODE_SESSION_ID);
  const codexId = valid(env.CODEX_THREAD_ID);
  if (!claudeId && !codexId) return null;
  if (!claudeId) return { runtime: Harness.Codex, id: codexId };
  if (!codexId) return { runtime: Harness.Claude, id: claudeId };
  const nearest = ancestry().map(harnessOfCommand).find(Boolean);
  return nearest === Harness.Claude ? { runtime: Harness.Claude, id: claudeId } : { runtime: Harness.Codex, id: codexId };
}
