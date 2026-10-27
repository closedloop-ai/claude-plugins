// PreToolUse guard for the question tools (Claude's AskUserQuestion, Codex's
// request_user_input): a question reaches a person only on the path its skill
// requires. In a vibe session that is scripts/session-questions.mjs, which
// keeps a question from being asked twice and gives it a default; in a
// fleet-orchestrator session it is a question naming where the code was
// checked (`checked in code: <file>:<line>`). Both rules were written and a
// session skipped both in one question about the person's own files
// (2026-10-26). Questions written as plain chat text are not tool calls, so
// this guard cannot see them.
//
// Which skill drives the session is read from its transcript. The startup
// plugin version question runs once per conversation outside
// session-questions.mjs (vibe SKILL.md, "Plugin version"; fleet-orchestrator
// SKILL.md, Setup) and is about the install, not the code, so it passes both.
//
// Runs from pre-tool-use.mjs.

import { deny } from "./hook-dispatch.mjs";
import { latestSkill, readTranscript } from "./skill-transcript.mjs";

export const QUESTION_TOOLS = Object.freeze(["AskUserQuestion", "request_user_input", "request_user_input_async"]);
const VERSION_QUESTION = /\bnewer version of (?:vibe|the plugins) is available\b/i;
const CODE_CITATION = /checked in code:\s*\S+:\d+/i;
const RECORD_MARKER = "sessionquestionsmjsask";
const RECORD_WINDOW = 400;

/** The question texts a question tool call carries. */
export function questionTexts(input) {
  const listed = Array.isArray(input?.questions) ? input.questions.map((entry) => entry?.question) : [input?.question];
  return listed.filter((text) => typeof text === "string" && text.trim() !== "");
}

/** The PreToolUse result for a question tool call: a deny for a question off its skill's path, or null. */
export function questionGuard(event) {
  const questions = questionTexts(event?.tool_input);
  const text = readTranscript(event?.transcript_path);
  if (questions.length === 0 || text === null) return null;
  // The skill loaded last decides, so an orchestrator that read vibe's files, or a vibe
  // session started after a fleet chat, gets its own rule (PR #350 review).
  const skill = latestSkill(text, ["vibe", "fleet-orchestrator"]);
  if (skill === "vibe") {
    const missing = questions.filter((question) => !VERSION_QUESTION.test(question) && !recorded(text, question));
    return missing.length === 0 ? null : deny(`record each question with \`node <plugin root>/skills/vibe/scripts/session-questions.mjs ask --key <topic> --question "<exact words>" --default "<what you do without an answer>" --deadline-minutes <n>\` first and ask only when it returns "ask": true (vibe SKILL.md, "Questions are asked once"); not recorded: ${missing.join(" | ")}`);
  }
  if (skill === "fleet-orchestrator") {
    const missing = questions.filter((question) => !VERSION_QUESTION.test(question) && !CODE_CITATION.test(question));
    return missing.length === 0 ? null : deny(`a question to the operator names where you checked the code first, as \`checked in code: <file>:<line>\` (fleet-orchestrator SKILL.md, principle 1); drop it if the code already answers it. Missing in: ${missing.join(" | ")}`);
  }
  return null;
}

function recorded(text, question) {
  const wanted = normalize(question);
  return normalize(text).split(RECORD_MARKER).slice(1).some((chunk) => chunk.slice(0, wanted.length + RECORD_WINDOW).includes(wanted));
}

function normalize(text) {
  return text.toLowerCase().replace(/\\[nrt]/g, " ").replace(/[^a-z0-9]+/g, "");
}
