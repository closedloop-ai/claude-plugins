// PreToolUse guard for the question tools (Claude's AskUserQuestion, Codex's
// request_user_input): a question reaches a person only on the path its skill
// requires. In a vibe session that is scripts/session-questions.mjs, which
// keeps a question from being asked twice and gives it a default; in a
// fleet-orchestrator session the same question record carries the private
// code citation. Both rules were written and a
// session skipped both in one question about the person's own files
// (2026-10-26). Questions written as plain chat text are not tool calls, so
// this guard cannot see them.
//
// The transcript and hook-owned scope identify the session. The startup
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
import { readStartupRecord } from "../lib/vibe/scripts/startup-record.mjs";
import { readTranscript } from "./skill-transcript.mjs";
import { conversationSkill } from "./hook-session-scope.mjs";
import { pointerProblems } from "../skills/vibe/scripts/publishable-text.mjs";
import { absoluteGitDir, readSessionRecord } from "../lib/vibe/scripts/session-record.mjs";
import { CARD_FILE } from "../skills/vibe/scripts/spec-card.mjs";
import { asksLeaveForInScopeWork, checkQuestionRulings, startupFile } from "../skills/vibe/scripts/session-questions.mjs";

export const QUESTION_TOOLS = Object.freeze(["AskUserQuestion", "request_user_input", "request_user_input_async"]);
const VERSION_SUBJECT = /\b(?:vibe|plugin(?:s)?)\b/i;
const VERSION_CHANGE = /\b(?:version|update|upgrade|outdated)\b/i;
const VERSION_CHOICE = /\b(?:proceed|continue|keep going|update now|upgrade now|install now)\b/i;
const CODE_CITATION = /checked in code:\s*(\S+):(\d+)/i;
const RECORD_MARKER = "sessionquestionsmjsask";
const RECORD_WINDOW = 400;
const FOLD_LABEL = /\b(?:fold|absorb|join|combine with|merge into|add to|include in|keep in)\b/i;
const SEPARATE_LABEL = /\b(?:separate|new|follow[- ]up)\b[^.]*\b(?:ticket|issue|pull request|PR)\b|^\s*(?:file|open|create)\b[^.]*\b(?:ticket|issue|pull request|PR)\b/i;
const FOLD_COST = /\bbloat\w*\b|\bscope growth\b|\b(?:grow|expand|increase|widen)(?:s|ing|ed)?\b[^.!?;]*\bscope\b/i;
const SEPARATE_COSTS = [/\b(?:test|validation) lanes?\b/i, /\bCI\b/i, /\breviews?\b/i, /\bmerge[- ]queue\b/i];

// A technical decision can be phrased as a choice rather than a permission request.
const ENGINEERING = /\b(?:technical(?:-fork| decision| question)|test[- ]evidence|(?:test|qa|validation) (?:results?|coverage|evidence|fixtures?|snapshots?|strategy)|(?:unit|integration|regression|end.to.end|automated) tests?|e2e|typecheck|lint(?:ing)?|rebase|schema migration|database index|service credentials?|api keys?|stack trace|mock(?:ing)?|polling interval)\b/i;
const EVIDENCE_DECISION = /\b(?:evidence|proof|screenshots?|test results?|coverage)\b[^?!.]{0,60}\b(?:enough|sufficient|acceptable|prove|confirm|rerun|re-run|qualif\w*)\b|\b(?:accept|evaluate|attach|collect|validate|rerun|re-run)\b[^?!.]{0,45}\b(?:evidence|proof|tests?|suite|snapshots?)\b/i;
const LOCAL_REFERENCE = /(?:^|[\s("'=:,[{<\x60])(?:[.~]{1,2}[/\\]|\/[^\s/]|[A-Z]:[/\\]|\\\\[\w.-]+\\|[\w.-]+[/\\][\w.-]+\.[a-z0-9]{1,10}\b)|\bchecked in code:\s*\S+:\d+/i;

/** User-visible fields only. A safe prompt cannot excuse a path or test decision in another option. */
function operatorQuestionProblem(input, technicalQuestions) {
  const questions = Array.isArray(input?.questions) ? input.questions : [input];
  for (const item of questions) {
    const fields = [item?.question, item?.header, ...(Array.isArray(item?.options)
      ? item.options.flatMap(option => [option?.label, option?.description, option?.preview]) : [])].filter(value => typeof value === "string");
    for (const field of fields) {
      // An ordinary shareable web URL can contain a path. File URLs remain local references.
      const words = field.replace(/https?:\/\/[^\s)<>\]]+/gi, "");
      if (pointerProblems(words).length || LOCAL_REFERENCE.test(words) || /(?:[\w.-]+[/\\]){2,}[\w.-]+\.[\w]+\b/.test(words)) return "Keep local filesystem paths in the private evidence, including paths in options.";
    }
    const decision = item.question ?? "";
    const wording = /\b(?:label|wording|caption|button text|copy|call(?:ed)?|say)\b/i.test(decision)
      ? decision.replace(/"[^"]*"|“[^”]*”|'[^']*'/g, "") : decision;
    if (technicalQuestions.has(normalize(decision)) || ENGINEERING.test(wording) || EVIDENCE_DECISION.test(decision) ||
        /\b(?:mutex|semaphore)\b/i.test(decision) || asksLeaveForInScopeWork(decision)) return "Resolve this technical or test-evidence question from evidence and precedent. Record the decision as (orchestrator). Put any engineer-only item in the PR body's Engineering review section and continue.";
  }
  return null;
}

/** Use the existing person/session question record. Fleet startup can precede creation of a vibe worktree. */
function privateQuestions(cwd, home, transcript) {
  let sessionEntries = [];
  try {
    const session = cwd && readSessionRecord(cwd);
    if (session?.operator?.id) sessionEntries = session.questions ?? [];
  } catch { /* Fleet can run outside a repository. */ }
  if (!transcript || !normalize(transcript).includes(RECORD_MARKER)) return sessionEntries;
  try {
    const entries = JSON.parse(readFileSync(startupFile(home), "utf8")).questions;
    return [...sessionEntries, ...entries.filter(entry => typeof entry.question === "string" && recorded(transcript, entry.question)
      && !sessionEntries.some(current => current.key === entry.key || current.question === entry.question))];
  }
  catch { return sessionEntries; }
}

/** Verify the full question and option text before offering a separate delivery. */
function deliveryFramingProblem(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [input];
  for (const question of questions) {
    const options = Array.isArray(question?.options) ? question.options : [];
    const fold = options.find((option) => FOLD_LABEL.test(option?.label ?? ""));
    const separate = options.find((option) => option !== fold && SEPARATE_LABEL.test(option?.label ?? ""));
    if (!fold || !separate) continue;
    const text = (option) => `${option.label ?? ""} ${option.description ?? ""}`;
    if (SEPARATE_COSTS.some((cost) => !cost.test(text(separate)))) return "the separate ticket or PR needs its own test lanes, CI, reviews and merge-queue time in its option";
    if (FOLD_COST.test(text(fold)) || options.some((option) => option !== fold && FOLD_LABEL.test(text(option)) && FOLD_COST.test(text(option)))) {
      return "describe the delivery options without calling folding bloat or scope growth";
    }
    const unrelated = /\bunrelated to\b[^.!?;]*\bbecause\b\s+\S/i.test(`${question?.question ?? ""} ${text(separate)}`);
    const recommended = (option) => /\b(?:recommended|default)\b/i.test(option.label ?? "") || option.recommended === true;
    if (!unrelated && (!recommended(fold) || recommended(separate))) return "recommend folding into the open unit unless the work is unrelated and the question gives the reason";
  }
  return null;
}

/** The question texts a question tool call carries. */
export function questionTexts(input) {
  const listed = Array.isArray(input?.questions) ? input.questions.map((entry) => entry?.question) : [input?.question];
  return listed.filter((text) => typeof text === "string" && text.trim() !== "");
}

/** Startup plugin-version choices vary in wording but must name the subject, change and decision. */
export function isVersionQuestion(question) {
  return VERSION_SUBJECT.test(question) && VERSION_CHANGE.test(question) && VERSION_CHOICE.test(question);
}

/**
 * A cited code line must exist in a regular file inside a git repository, including through
 * symlinks. An absolute path is checked against its own repository or worktree, so an
 * orchestrator outside any repository can cite a writer's worktree (PR #371 review); a relative
 * path resolves against the hook cwd's repository, or the cwd itself outside one.
 */
export function codeCitationProblem(question, cwd) {
  const match = CODE_CITATION.exec(question);
  if (!match) return "checked in code: <file>:<line> is missing";
  const [, raw, number] = match;
  if (raw.split(/[\\/]/).includes("..")) return "checked in code path may not traverse out of the repository";
  let file;
  try {
    file = realpathSync(path.isAbsolute(raw) ? raw : path.join(repositoryRoot(cwd) ?? cwd, raw));
  } catch { return "checked in code file cannot be read; cite an absolute path or one relative to the repository"; }
  const repo = repositoryRoot(path.dirname(file));
  try {
    if (!repo || !file.startsWith(`${repo}${path.sep}`) || !statSync(file).isFile()) return "checked in code path is not a regular file inside a git repository";
    const content = readFileSync(file, "utf8");
    const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    if (Number(number) < 1 || Number(number) > lines) return "checked in code line is outside the file";
    return null;
  } catch { return "checked in code file cannot be read inside its repository"; }
}

function repositoryRoot(dir) {
  try {
    return realpathSync(execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { return null; }
}

/** The PreToolUse result for a question tool call: a deny for a question off its skill's path, or null. */
export function questionGuard(event, home = os.homedir()) {
  const input = event?.tool_input ?? {};
  const source = Array.isArray(input.questions) ? input.questions : [input];
  const questionsInput = { questions: source.map(item => ({ ...item, question: item?.question ?? item?.title,
    options: Array.isArray(item?.options) ? item.options.map(option => typeof option === "string" ? { label: option } : option) : [] })) };
  const questions = questionTexts(questionsInput);
  const text = readTranscript(event?.transcript_path);
  if (questions.length === 0) return null;
  // The skill loaded last decides, so an orchestrator that read vibe's files, or a vibe
  // session started after a fleet chat, gets its own rule (PR #350 review).
  const skill = conversationSkill(event, home, text);
  if (!skill) return null;
  const cwd = eventCwd(event);
  const entries = privateQuestions(cwd, home, text);
  for (const question of questions) {
    const entry = entries.find(item => item.question === question && !item.answeredAt);
    try {
      const { allowed, rulings } = checkQuestionRulings(question, { chat: event.session_id, cwd, home,
        newFact: entry?.newFact, ticketRecord: entry?.ticketRecord });
      if (!allowed) return deny("Apply these recorded rulings. Ask only about a named, uncovered new fact:\n" + rulings.join("\n"));
    } catch (error) { return deny("Read the applicable operator rulings before asking. " + error.message); }
  }
  // A session's operator records a person (id/email/name), not an engineering qualification.
  // Vibe already reserves technical questions for internal resolution, including when the person's role is unknown.
  const technicalQuestions = new Set();
  let cardPath;
  try { cardPath = path.join(absoluteGitDir(eventCwd(event)), CARD_FILE); } catch { /* No checkout before startup. */ }
  if (cardPath) {
    try {
      const card = JSON.parse(readFileSync(cardPath, "utf8"));
      for (const item of card.openQuestions ?? []) if (item.kind === "technical-fork") technicalQuestions.add(normalize(item.question));
    } catch (error) { if (error.code !== "ENOENT") return deny("The private Spec Card decision classification could not be read."); }
  }
  const problem = operatorQuestionProblem(questionsInput, technicalQuestions) ?? deliveryFramingProblem(questionsInput);
  if (problem) return deny(problem);
  let startup = null;
  try { if (typeof event?.session_id === "string") startup = readStartupRecord(event.session_id, home); }
  catch { /* An invalid session id never grants the startup exception. */ }
  const startupChoice = startup?.conversation === event?.session_id && startup?.status === "outdated" && !startup?.choice;
  const versionChoice = (question) => startupChoice && isVersionQuestion(question);
  const pending = questions.filter(question => !versionChoice(question));
  if (!pending.length) return null;
  if (skill === "vibe") {
    const missing = pending.filter(question => !entries.some(entry => entry.question === question && !entry.answeredAt)
      && !recorded(text ?? "", question));
    return missing.length === 0 ? null : deny(`record each question with \`node <plugin root>/skills/vibe/scripts/session-questions.mjs ask --key <topic> --question "<exact words>" --default "<what you do without an answer>" --deadline-minutes <n>\` first and ask only when it returns "ask": true (vibe SKILL.md, "Questions are asked once"); not recorded: ${missing.join(" | ")}`);
  }
  if (skill === "fleet-orchestrator") {
    const missing = pending.some(question => !entries.some(entry => entry.question === question && !entry.answeredAt
      && entry.product === true && typeof entry.codeEvidence === "string"
      && !codeCitationProblem("checked in code: " + entry.codeEvidence, cwd)));
    return missing ? deny("Record where you checked in code privately with session-questions.mjs ask --product --code-evidence <file>:<line> for the exact question first.") : null;
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
