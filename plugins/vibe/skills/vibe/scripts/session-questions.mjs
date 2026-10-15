#!/usr/bin/env node
// Remembers every question the vibe orchestrator asks the person, and the
// answer, so no question is asked twice: not in a later message, not after a
// worker relaunch, and not when the conversation resumes (operator ruling,
// 2026-10-15). In the session that prompted this, the page-wording question
// was repeated in three messages while it waited for one answer.
//
// Usage:
//   session-questions.mjs reset                                   (start of a new session)
//   session-questions.mjs ask    --key <key> --question <text> [--worktree <path>]
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
// Every command prints one JSON object; errors print {"ok":false,"error":...}.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readSessionRecord, writeSessionRecord } from "./session-record.mjs";

const KEY_PATTERN = /^[a-z0-9]+(?:[-:][a-z0-9]+)*$/;
const MAX_TEXT = 4000;

/** Where questions asked before the session exists are kept. */
export function startupFile(home = os.homedir()) {
  return path.join(home, ".codex", "vibe", "startup-questions.json");
}

/** Records a question once; a repeated key returns the existing entry instead. */
export function askQuestion(questions, { key, question, now = new Date().toISOString() }) {
  requireKey(key);
  requireText("--question", question);
  const existing = questions.find((entry) => entry.key === key);
  if (existing) {
    return { questions, result: { ask: false, ...existing } };
  }
  const entry = { key, question, askedAt: now, answer: null, answeredAt: null };
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
      const { questions, result } = askQuestion(load(worktree, home), { key: values.key, question: values.question });
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
