#!/usr/bin/env node
// Remembers every question the vibe orchestrator asks the person, and the
// answer, so no question is asked twice: not in a later message, not after a
// worker relaunch, and not when the conversation resumes (operator ruling,
// 2026-10-15). In the session that prompted this, the page-wording question
// was repeated in three messages while it waited for one answer.
//
// Usage:
//   session-questions.mjs reset                                   (start of a new session)
//   session-questions.mjs ask    --key <key> --question <text> --default <what you do without an answer> --deadline-minutes <n>
//                                [--product --code-evidence <file:line>] [--worktree <path>]
//   session-questions.mjs answer --key <key> --answer <text>   [--worktree <path>]
//   session-questions.mjs list   [--worktree <path>]
//
// With --worktree the questions live on that session's private record. Before
// the session exists they live in ~/.codex/vibe/startup-questions.json, which
// `reset` clears and `vibe-sessions.mjs new` moves onto the new session.
//
// `ask` answers whether to ask: {"ask":true} only for a key never asked. A key
// already asked returns {"ask":false} with its pending question or its answer,
// so the caller uses the answer or keeps waiting, and never repeats it.
// `ask` also refuses a request for permission to do in-scope engineering work
// (repair a test the change broke, merge main, push, rerun a check, fix a
// finding): that work never waits, so the writer does it and reports it. A
// writer once sat idle for an hour "pending authorization" to repair tests.
// Only a flag key, a product question, dropping or narrowing scope, a
// destructive action or a credential waits for the person.
// Every other question carries `--default` and `--deadline-minutes`, and `ask`
// returns `ifNoAnswer`, the line `If no answer by <ISO time>: <default>` that
// ends the message asking it; with no answer by then the writer proceeds on
// the default and says so, and codex-fleet-monitor's recovery pass resumes an
// idle Codex writer with it. Writers' questions once sat unanswered for seven
// hours overnight while their writers waited on stated defaults. The deadline
// is at most 30 minutes, and a question never holds a pull request: the
// writer ships what is done, arms auto-merge and puts the answer-dependent
// part in a follow-up (operator ruling, 2026-10-22), so `ask` refuses one
// that says it holds a merge, a push or the PR.
// Every command prints one JSON object; errors print {"ok":false,"error":...}.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readSessionRecord, writeSessionRecord } from "./session-record.mjs";

const KEY_PATTERN = /^[a-z0-9]+(?:[-:][a-z0-9]+)*$/;
const MAX_TEXT = 4000;
const ASKS_LEAVE = /\b(?:may|can|shall|should) i\b|\b(?:ok|okay|fine) (?:for me )?to\b|\bpermission\b|\bauthori[sz](?:e|ation)\b|\bapprov(?:e|al)\b|\bgo-?ahead\b/i;
const IN_SCOPE_WORK = /\b(?:tests?|fixtures?|specs?|snapshots?|merge (?:main|the base)|main merge|rebase|push|commit|rerun|re-run|lint|typecheck|fix(?:es)?|repair)\b/i;
const HUMAN_ONLY = /\b(?:flags?|feature flag|switch(?:es)?|toggles?|credentials?|password|token|sign(?:ed)?[ -]?in|log ?in|delete|discard|destroy|drop|force|wording|copy|say|says|label|product|skip|narrow|defer|exclude|descope|obsolete|out of scope)\b/i;
const WAITS_FOR_PERSON = /\b(?:flags?|feature flag|switch(?:es)?|toggles?|credentials?|password|token|sign(?:ed)?[ -]?in|log ?in|delete|discard|destroy|drop|force|wording|copy|say|says|label|skip|narrow|defer|exclude|descope|obsolete|out of scope)\b/i;
const MAX_DEADLINE_MINUTES = 30;
const HOLDS_PR = /\b(?:hold(?:s|ing)?|block(?:s|ing)?|paus(?:e|es|ing)|park(?:ed|ing)?)\b[^.?!\n]{0,40}\b(?:auto-?merge|merge|pr|pull request|push)\b|\b(?:auto-?merge|merge|pr|pull request|push)\b[^.?!\n]{0,20}\b(?:on hold|held|until you answer|pending your answer)\b/i;

/** In-scope engineering work asked as permission; it never waits for the person. */
export function asksLeaveForInScopeWork(question) {
  return ASKS_LEAVE.test(question) && IN_SCOPE_WORK.test(question) && !HUMAN_ONLY.test(question);
}

/** A flag, copy, destructive, credential or scope-narrowing question: no default is ever applied without the person. */
export function waitsForPerson(question) {
  return WAITS_FOR_PERSON.test(question);
}

/** The line that ends a question message: what happens, and when, if nobody answers. */
export function ifNoAnswerLine(deadlineAt, fallback) {
  return `If no answer by ${deadlineAt}: ${fallback}`;
}

/** Where questions asked before the session exists are kept. */
export function startupFile(home = os.homedir()) {
  return path.join(home, ".codex", "vibe", "startup-questions.json");
}

/** Records a question once; a repeated key returns the existing entry instead. */
export function askQuestion(questions, { key, question, product = false, codeEvidence, fallback, deadlineMinutes, now = new Date().toISOString() }) {
  requireKey(key);
  requireText("--question", question);
  if (asksLeaveForInScopeWork(question)) {
    throw new Error("in-scope work never waits for authorization: repairing tests the change broke, a main merge, a push, a rerun or an in-scope fix goes ahead now and is reported afterwards; only a flag key, a product question, dropping or narrowing scope, a destructive action or a credential waits");
  }
  if (HOLDS_PR.test(question)) {
    throw new Error("a question never holds a pull request: ship what is done, arm auto-merge, put the part that depends on the answer in a follow-up, and ask without holding anything");
  }
  if (product && !/^\S.*:\d+(?:-\d+)?$/.test(codeEvidence ?? "")) {
    throw new Error("a product question needs --code-evidence <file:line> proving the code and data model were checked first");
  }
  const existing = questions.find((entry) => entry.key === key);
  if (existing) {
    return { questions, result: { ask: false, ...existing } };
  }
  const waits = waitsForPerson(question);
  const minutes = Number(deadlineMinutes);
  if (!waits && (!fallback?.trim() || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_DEADLINE_MINUTES)) {
    throw new Error(`a question carries --default <what you do without an answer> and --deadline-minutes <1 to ${MAX_DEADLINE_MINUTES}>; only a flag, copy, destructive, credential or scope-narrowing question waits for the person with no deadline`);
  }
  const deadlineAt = waits ? null : new Date(Date.parse(now) + minutes * 60_000).toISOString();
  const entry = {
    key, question, ...(product ? { product: true, codeEvidence } : {}),
    ...(waits ? { waitsForPerson: true } : { default: fallback.trim(), deadlineAt, ifNoAnswer: ifNoAnswerLine(deadlineAt, fallback.trim()) }),
    askedAt: now, answer: null, answeredAt: null,
  };
  return { questions: [...questions, entry], result: { ask: true, ...entry } };
}

/** Saves the person's answer to a question that was asked. */
export function answerQuestion(questions, { key, answer, now = new Date().toISOString() }) {
  requireKey(key);
  requireText("--answer", answer);
  const existing = questions.find((entry) => entry.key === key);
  if (!existing) {
    throw new Error(`No question was recorded under ${key}; record it with ask first.`);
  }
  const updated = { ...existing, answer, answeredAt: now };
  return { questions: questions.map((entry) => (entry.key === key ? updated : entry)), result: updated };
}

/** Moves startup questions onto a new session record and clears the startup file. */
export function adoptStartupQuestions(worktree, home = os.homedir()) {
  const startup = readStartup(home);
  if (!startup.length) {
    return [];
  }
  const record = readSessionRecord(worktree);
  if (!record) {
    throw new Error(`No vibe session record in ${worktree}.`);
  }
  const merged = [...(record.questions ?? [])];
  for (const entry of startup) {
    if (!merged.some((item) => item.key === entry.key)) {
      merged.push(entry);
    }
  }
  writeSessionRecord(worktree, { ...record, questions: merged });
  rmSync(startupFile(home), { force: true });
  return merged;
}

function readStartup(home) {
  const file = startupFile(home);
  if (!existsSync(file)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(parsed?.questions) ? parsed.questions : [];
}

function writeStartup(home, questions) {
  const file = startupFile(home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ questions }, null, 2)}\n`, { mode: 0o600 });
}

function load(worktree, home) {
  if (!worktree) {
    return readStartup(home);
  }
  const record = readSessionRecord(worktree);
  if (!record) {
    throw new Error(`No vibe session record in ${worktree}.`);
  }
  return record.questions ?? [];
}

function store(worktree, home, questions) {
  if (!worktree) {
    writeStartup(home, questions);
    return;
  }
  writeSessionRecord(worktree, { ...readSessionRecord(worktree), questions });
}

function requireKey(key) {
  if (!key || !KEY_PATTERN.test(key) || key.length > 80) {
    throw new Error("--key must be lowercase words joined by hyphens or colons, such as page-wording or sample-data.");
  }
}

function requireText(name, text) {
  if (!text || !text.trim() || text.length > MAX_TEXT) {
    throw new Error(`${name} is required and must be at most ${MAX_TEXT} characters.`);
  }
}

function run(argv, home = os.homedir()) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      worktree: { type: "string" },
      key: { type: "string" },
      question: { type: "string" },
      answer: { type: "string" },
      product: { type: "boolean" },
      "code-evidence": { type: "string" },
      default: { type: "string" },
      "deadline-minutes": { type: "string" },
    },
  });
  const worktree = values.worktree;
  switch (positionals[0]) {
    case "reset":
      if (worktree) {
        throw new Error("reset clears only the questions kept before a session exists; it takes no --worktree.");
      }
      rmSync(startupFile(home), { force: true });
      return { questions: [] };
    case "ask": {
      const { questions, result } = askQuestion(load(worktree, home), {
        key: values.key, question: values.question, product: values.product, codeEvidence: values["code-evidence"],
        fallback: values.default, deadlineMinutes: values["deadline-minutes"],
      });
      if (result.ask) {
        store(worktree, home, questions);
      }
      return result;
    }
    case "answer": {
      const { questions, result } = answerQuestion(load(worktree, home), { key: values.key, answer: values.answer });
      store(worktree, home, questions);
      return result;
    }
    case "list":
      return { questions: load(worktree, home) };
    default:
      throw new Error("Unknown command. Use one of: reset, ask, answer, list.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...run(process.argv.slice(2)) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  }
}
