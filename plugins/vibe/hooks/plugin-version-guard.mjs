// The startup plugin version check, enforced in Claude Code (operator ruling,
// 2026-10-27): a vibe or fleet-orchestrator session runs
// skills/vibe/scripts/plugin-version.mjs first and, when a plugin is outdated,
// asks the person to update now or proceed knowing an outdated plugin could
// give worse results. Audited sessions on 1.0.72 and 1.0.85 ran whole programs
// on whatever was installed, and nobody was told.
//
// Starting either skill (the Skill tool, or a `/vibe:vibe` or
// `/vibe:fleet-orchestrator` prompt) marks the conversation pending unless it
// already has a record. Until the check has run, and while it found an
// outdated plugin with no recorded choice, every writer launch is refused: an
// Agent call that starts a vibe worker or a vibe writer (a prompt invoking
// vibe:vibe, as fleet-orchestrator's worker preamble does), `claude-worker.mjs`,
// and `fleet.sh ... session turn`. Other subagents, such as research, still run.
//
// Runs from pre-tool-use.mjs (Skill, Agent, Bash) and user-prompt-submit.mjs.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blockingProblem, conversationRuntime, markPending, readStartupRecord } from "../skills/vibe/scripts/plugin-version.mjs";
import { commandSegments } from "./command-segments.mjs";
import { deny } from "./hook-dispatch.mjs";
import { recordHookSkill } from "./hook-session-scope.mjs";
import { loadedSkillEvidenceProblem } from "../skills/vibe/scripts/loaded-skill.mjs";
import { pluginScriptProblems } from "../skills/fleet-orchestrator/scripts/skill-freshness.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "vibe", "scripts", "plugin-version.mjs");
export const CHECKED_SKILLS = Object.freeze(["vibe:vibe", "vibe:fleet-orchestrator"]);
const STARTS_SKILL = /^\s*\/(?:vibe:vibe|vibe:fleet-orchestrator)(?:\s|$)/;
const CODEX_VIBE_START = /^\s*\$vibe(?:\s|$)/;
const CONVERSATION = /^[A-Za-z0-9_.:-]{1,128}$/;
const INTERPRETERS = new Set(["node", "bash", "sh", "zsh"]);
const VIBE_WORKER = /^vibe:vibe-[a-z0-9-]+-worker$/;
const INVOKES_VIBE = /\bvibe:vibe\b/;

/** Whether an Agent call starts a vibe worker or a writer that runs the vibe skill. */
export function launchesWriterAgent(input) {
  return (typeof input?.subagent_type === "string" && VIBE_WORKER.test(input.subagent_type))
    || (typeof input?.prompt === "string" && INVOKES_VIBE.test(input.prompt));
}

/** Whether a Bash command starts a worker: a Claude worker launch or a Codex writer turn. */
export function launchesWorker(command) {
  return commandSegments(String(command ?? "")).some(({ words }) => {
    const program = INTERPRETERS.has(path.basename(words[0] ?? "")) ? words.slice(1) : words;
    const name = path.basename(program[0] ?? "");
    return name === "claude-worker.mjs" || (name === "fleet.sh" && program.slice(1).join(" ").includes("session turn"));
  });
}

/** The refusal for a worker launch in a conversation whose check blocks, or null. */
export function versionProblem(conversation, home = os.homedir()) {
  if (typeof conversation !== "string" || !CONVERSATION.test(conversation)) return null;
  const record = readStartupRecord(conversation, home);
  if (!record) return null;
  const problem = blockingProblem(record) ?? loadedSkillEvidenceProblem(record?.loadedSkill, { actorId: conversation, pluginRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") });
  if (!problem) return null;
  return [
    `Plugin version check first: ${problem}.`,
    `Run \`node ${SCRIPT} check\` (add \`--state <orchDir>/plugin-version.json\` for a fleet program).`,
    "When it says outdated, ask the person whether to update now or proceed, saying that proceeding on an outdated plugin could give worse results,",
    `and record the answer with \`node ${SCRIPT} choose --choice update|proceed\` before starting any worker (conversation ${conversation}).`,
  ].join(" ");
}

/** PreToolUse on Skill: starting vibe or fleet-orchestrator marks the conversation pending. Never decides. */
export function pluginVersionSkillStart(event, home = os.homedir()) {
  recordHookSkill(event?.session_id, event?.tool_input?.skill, home, new Date(), conversationRuntime() ?? "claude");
  if (CHECKED_SKILLS.includes(event?.tool_input?.skill) && CONVERSATION.test(event?.session_id ?? "")) markPending(event.session_id, home);
  return null;
}

/** UserPromptSubmit: a `/vibe:vibe` or `/vibe:fleet-orchestrator` prompt marks the conversation pending. Never decides. */
export function pluginVersionPromptStart(event, home = os.homedir()) {
  if (CONVERSATION.test(event?.session_id ?? "")) {
    const prompt = String(event?.prompt ?? "");
    const skill = CODEX_VIBE_START.test(prompt) ? "vibe:vibe"
      : /^\s*\/(vibe:vibe|vibe:fleet-orchestrator)(?:\s|$)/.exec(prompt)?.[1];
    if (skill) recordHookSkill(event.session_id, skill, home, new Date(), conversationRuntime() ?? "claude");
  }
  if ((STARTS_SKILL.test(String(event?.prompt ?? "")) || CODEX_VIBE_START.test(String(event?.prompt ?? "")))
    && CONVERSATION.test(event?.session_id ?? "")) markPending(event.session_id, home);
  return null;
}

/** PreToolUse on Agent and Bash: refuses a writer launch while the conversation's check blocks. */
export function pluginVersionGuard(event, home = os.homedir()) {
  const text = event?.tool_name === "Agent" ? event?.tool_input?.prompt
    : event?.tool_name === "SendMessage" ? event?.tool_input?.message
      : event?.tool_name === "Bash" ? event?.tool_input?.command : "";
  const launch = event?.tool_name === "Agent" || event?.tool_name === "SendMessage"
    || (event?.tool_name === "Bash" && (launchesWorker(event?.tool_input?.command) || /(?:^|\s)claude\s+-p\b/.test(String(text ?? ""))));
  if (!launch) return null;
  const problem = versionProblem(event?.session_id, home)
    ?? pluginScriptProblems(String(text ?? ""), path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), event?.cwd).at(0);
  return problem ? deny(problem) : null;
}
