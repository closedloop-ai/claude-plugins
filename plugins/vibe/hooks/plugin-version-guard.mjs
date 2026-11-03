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
// outdated plugin with no recorded choice or a stale loaded skill, every writer
// launch is refused: an Agent call that starts a vibe worker or a vibe writer
// (a prompt invoking vibe:vibe, as fleet-orchestrator's worker preamble does),
// `claude-worker.mjs`, and `fleet.sh ... session turn`. Inside a vibe or fleet
// conversation every Agent and SendMessage dispatch is held the same way, and
// a dispatch naming a vibe plugin script the installed release lacks is
// refused. Conversations that never started either skill are not touched (PR
// #371 review: a repository's own skills/<x>/scripts path was refused in every
// conversation).
//
// Codex `$vibe` and `$fleet-orchestrator` prompts record hook scope but do not
// mark the conversation pending: the check keys its record by the shell's
// conversation id, which Codex's hook documentation does not tie to the hook's
// session_id, so a pending mark could never be cleared there.
//
// Runs from pre-tool-use.mjs (Skill, Agent, Bash, SendMessage) and user-prompt-submit.mjs.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blockingProblem, markPending, readStartupRecord } from "../skills/vibe/scripts/plugin-version.mjs";
import { commandSegments } from "./command-segments.mjs";
import { deny } from "./hook-dispatch.mjs";
import { conversationSkill, hookRuntime, recordHookSkill } from "./hook-session-scope.mjs";
import { loadedSkillEvidenceProblem, loadedSkillRequired } from "../skills/vibe/scripts/loaded-skill.mjs";
import { pluginScriptProblems } from "../skills/vibe/scripts/plugin-script-references.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(PLUGIN_ROOT, "skills", "vibe", "scripts", "plugin-version.mjs");
export const CHECKED_SKILLS = Object.freeze(["vibe:vibe", "vibe:fleet-orchestrator"]);
const STARTS_SKILL = /^\s*\/(vibe:vibe|vibe:fleet-orchestrator)(?:\s|$)/;
const CODEX_SKILL_START = /^\s*\$(?:vibe:)?(vibe|fleet-orchestrator)(?:\s|$)/;
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
  const problem = blockingProblem(record)
    ?? (loadedSkillRequired(record) ? loadedSkillEvidenceProblem(record.loadedSkill, { actorId: conversation, pluginRoot: PLUGIN_ROOT }) : null);
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
  recordHookSkill(event?.session_id, event?.tool_input?.skill, home, new Date(), hookRuntime(event));
  if (CHECKED_SKILLS.includes(event?.tool_input?.skill) && CONVERSATION.test(event?.session_id ?? "")) markPending(event.session_id, home);
  return null;
}

/** UserPromptSubmit: a skill-start prompt records hook scope; a `/vibe:...` one also marks the conversation pending. Never decides. */
export function pluginVersionPromptStart(event, home = os.homedir()) {
  if (!CONVERSATION.test(event?.session_id ?? "")) return null;
  const prompt = String(event?.prompt ?? "");
  const codex = CODEX_SKILL_START.exec(prompt)?.[1];
  const skill = codex ? `vibe:${codex}` : STARTS_SKILL.exec(prompt)?.[1];
  if (skill) recordHookSkill(event.session_id, skill, home, new Date(), hookRuntime(event));
  if (STARTS_SKILL.test(prompt)) markPending(event.session_id, home);
  return null;
}

/** Whether the event's conversation started vibe or fleet-orchestrator: its transcript, hook record or startup record. */
export function inVibeConversation(event, home = os.homedir()) {
  if (conversationSkill(event, home)) return true;
  return CONVERSATION.test(event?.session_id ?? "") && readStartupRecord(event.session_id, home) !== null;
}

/**
 * PreToolUse on Agent, SendMessage and Bash: refuses a writer launch while the conversation's check
 * blocks, and inside a vibe or fleet conversation any dispatch while it blocks or that names a
 * vibe plugin script the installed release lacks.
 */
export function pluginVersionGuard(event, home = os.homedir()) {
  const tool = event?.tool_name;
  const text = tool === "Agent" ? event?.tool_input?.prompt
    : tool === "SendMessage" ? event?.tool_input?.message
      : tool === "Bash" ? event?.tool_input?.command : "";
  const writerLaunch = (tool === "Agent" && launchesWriterAgent(event?.tool_input))
    || (tool === "Bash" && (launchesWorker(event?.tool_input?.command) || /(?:^|\s)claude\s+-p\b/.test(String(text ?? ""))));
  if (!writerLaunch && tool !== "Agent" && tool !== "SendMessage") return null;
  if (!writerLaunch && !inVibeConversation(event, home)) return null;
  const problem = versionProblem(event?.session_id, home) ?? pluginScriptProblems(String(text ?? ""), PLUGIN_ROOT, event?.cwd).at(0);
  return problem ? deny(problem) : null;
}
