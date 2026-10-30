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
import os from "node:os";
import { execFileSync } from "node:child_process";
import { realpathSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eventCwd } from "./hook-dispatch.mjs";
import { readStartupRecord } from "../skills/vibe/scripts/plugin-version.mjs";
import { latestSkill, readTranscript } from "./skill-transcript.mjs";

export const QUESTION_TOOLS = Object.freeze(["AskUserQuestion", "request_user_input", "request_user_input_async"]);
const VERSION_SUBJECT = /\b(?:vibe|plugin(?:s)?)\b/i;
const VERSION_CHANGE = /\b(?:version|update|upgrade|outdated)\b/i;
const VERSION_CHOICE = /\b(?:proceed|continue|keep going|update now|upgrade now|install now)\b/i;
const CODE_CITATION = /checked in code:\s*(\S+):(\d+)/i;
const RECORD_MARKER = "sessionquestionsmjsask";
const RECORD_WINDOW = 400;

/** The question texts a question tool call carries. */
export function questionTexts(input) {
  const listed = Array.isArray(input?.questions) ? input.questions.map((entry) => entry?.question) : [input?.question];
  return listed.filter((text) => typeof text === "string" && text.trim() !== "");
}

/** Startup plugin-version choices vary in wording but must name the subject, change and decision. */
export function isVersionQuestion(question) {
  return VERSION_SUBJECT.test(question) && VERSION_CHANGE.test(question) && VERSION_CHOICE.test(question);
}

/** A cited code line must exist inside the current repository, including through symlinks. */
export function codeCitationProblem(question, cwd) {
  const match = CODE_CITATION.exec(question);
  if (!match) return "checked in code: <file>:<line> is missing";
  const [, raw, number] = match;
  if (raw.split(/[\\/]/).includes("..")) return "checked in code path may not traverse out of the repository";
  try {
    const repo = realpathSync(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    const file = realpathSync(path.isAbsolute(raw) ? raw : path.join(repo, raw));
    if (!file.startsWith(`${repo}${path.sep}`) || !statSync(file).isFile()) return "checked in code path is not a regular repository file";
    const content = readFileSync(file, "utf8");
    const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    if (Number(number) < 1 || Number(number) > lines) return "checked in code line is outside the file";
    return null;
  } catch { return "checked in code file cannot be read inside the repository"; }
}

/** The PreToolUse result for a question tool call: a deny for a question off its skill's path, or null. */
export function questionGuard(event, home = os.homedir()) {
  const questions = questionTexts(event?.tool_input);
  const text = readTranscript(event?.transcript_path);
  if (questions.length === 0 || text === null) return null;
  // The skill loaded last decides, so an orchestrator that read vibe's files, or a vibe
  // session started after a fleet chat, gets its own rule (PR #350 review).
  const skill = latestSkill(text, ["vibe", "fleet-orchestrator"]);
  let startup = null;
  try { if (typeof event?.session_id === "string") startup = readStartupRecord(event.session_id, home); }
  catch { /* An invalid session id never grants the startup exception. */ }
  const startupChoice = startup?.conversation === event?.session_id && startup?.status === "outdated" && !startup?.choice;
  const versionChoice = (question) => startupChoice && isVersionQuestion(question);
  if (skill === "vibe") {
    const missing = questions.filter((question) => !versionChoice(question) && !recorded(text, question));
    return missing.length === 0 ? null : deny(`record each question with \`node <plugin root>/skills/vibe/scripts/session-questions.mjs ask --key <topic> --question "<exact words>" --default "<what you do without an answer>" --deadline-minutes <n>\` first and ask only when it returns "ask": true (vibe SKILL.md, "Questions are asked once"); not recorded: ${missing.join(" | ")}`);
  }
  if (skill === "fleet-orchestrator") {
    const missing = questions.filter((question) => !versionChoice(question)).map(question => ({ question, problem: codeCitationProblem(question, eventCwd(event)) })).filter(item => item.problem);
    return missing.length === 0 ? null : deny(`a question to the operator needs a real code citation before asking (fleet-orchestrator SKILL.md, principle 1); ${missing.map(item => `${item.problem}: ${item.question}`).join(" | ")}`);
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
