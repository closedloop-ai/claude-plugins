#!/usr/bin/env node
// The precedent check before a product question (operator ruling,
// 2026-10-16; `references/quality-loop.md`, "Precedent before asking"): how
// Asana, or another established app with the same flow, handles the
// situation the question is about. The research brief and its safety rules
// live here once, for both harnesses.
//
// Usage:
//   precedent-check.mjs prompt --question <text> [--situation <text>] [--apps <list>]
//       Prints {"ok":true,"prompt":...}: the brief for the read-only requirements
//       worker's precedent mode when no signed-in `claude` CLI can run it. Codex
//       never follows it with computer use (`references/guardrails.md`,
//       "Processes and state").
//   precedent-check.mjs run --question <text> [--situation <text>] [--apps <list>]
//                          [--out <dir>] [--claude <CLI>] [--timeout-seconds <n>]
//       Both harnesses: the look runs as a separate headless `claude -p --chrome`
//       run with the brief on stdin (a Claude Code session's Chrome tools are
//       bound when it starts). Writes prompt.md and report.md to --out (by
//       default a new folder under ~/.codex/vibe/precedent/, which a reboot
//       keeps, never the system temp folder) and prints
//       {"ok":true,"report":...,"answer":...,"source":...}, or
//       {"ok":false,"error":...,"report":...} when the run failed or timed out.
//
// `--apps` names the apps to try after Asana, in order (default: Linear, then
// the service's own screens). Every command prints one JSON object.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const TEMP_PROJECT = "zz vibe precedent check (temp)";
export const TASK_PREFIX = "zz test";
export const CLAUDE_TOOLS = "mcp__claude-in-chrome__*,WebFetch,WebSearch,Read,Write";
const DEFAULT_APPS = "Linear, then the service's own screens (for example GitHub's own authorization screens)";
const DEFAULT_TIMEOUT_SECONDS = 900;
const MAX_TEXT = 2000;
const ANSWER_LINE = /^Answer:\s*(.+)$/m;
const SOURCE_LINE = /^Source:\s*(.+)$/m;

/** The research brief for one product question. */
export function precedentPrompt({ question, situation, apps = DEFAULT_APPS, today = new Date() }) {
  requireText("question", question);
  const date = today.toISOString().slice(0, 10);
  return `You are checking how established apps handle one situation, to answer a product question in a vibe session. Report what you see; never change anything that already exists.

Question: ${question}
Situation to reproduce: ${situation || question}

Order:
1. Asana, in Chrome, with the account already signed in there. Never sign in, create an account or type a credential.
2. When Asana does not have this situation, another established app with the same flow: ${apps}.
3. When Chrome is not available, or an app has no account signed in, that app's public help center and documentation (WebSearch, WebFetch), Asana's first.
Stop at the first app that settles it.

Safety, in every app:
- Never touch anything that already exists: no edits, moves, completions, comments, invitations or setting changes.
- When you need test data, create one new private project named "${TEMP_PROJECT}", with no members and notifications off, and put everything in it. Prefix every task you create with "${TASK_PREFIX}".
- A flow that would connect an app, invite or notify someone, share, pay or change a setting: go only as far as its confirmation step, then cancel it.
- At the end, delete every task you created and then the project, check that they are gone, and say so in the report.

Evidence:
- Verify every state before you record it: reload or reopen and look again. A hover can look like a completed task.
- For a narrow-layout judgment, first capture the app as found. Then close every navigation sidebar or drawer, dismiss banners and overlays, and capture the same viewport again. Judge support from the cleared state and report both captures.
- Keep what you observed directly separate from what a help center or forum says.
- Quote on-screen wording exactly, as evidence only.
- When nothing settles it, write "undocumented"; never guess.

Reply with only this report:
Answer: <the behavior, in one plain line, or "undocumented">
Source: <app>, observed ${date} | <help-center or documentation URL> | undocumented
Observed directly: <what you saw, with quoted wording>
Help center / forum: <what public material says, with URLs>
Apps without this situation: <each app checked that does not have it>
Cleanup: <what you created and deleted, confirmed gone, or "nothing created">
`;
}

/** The headless Claude Code arguments for the look. */
export function claudeArgs() {
  return ["-p", "--chrome", "--allowedTools", CLAUDE_TOOLS];
}

/** The answer and source lines of a report, or null for each line it lacks. */
export function summarize(report) {
  return {
    answer: ANSWER_LINE.exec(report)?.[1].trim() ?? null,
    source: SOURCE_LINE.exec(report)?.[1].trim() ?? null,
  };
}

/** Runs the headless look and resolves with its result; never rejects. */
export function runClaude({ prompt, out, claude = "claude", timeoutSeconds = DEFAULT_TIMEOUT_SECONDS }) {
  mkdirSync(out, { recursive: true });
  const promptFile = path.join(out, "prompt.md");
  const reportFile = path.join(out, "report.md");
  writeFileSync(promptFile, prompt);
  return new Promise((resolve) => {
    const report = createWriteStream(reportFile);
    let child;
    try {
      child = spawn(claude, claudeArgs(), { cwd: out, stdio: ["pipe", "pipe", "ignore"], detached: true });
    } catch (error) {
      resolve({ ok: false, error: `claude could not start: ${error.message}`, prompt: promptFile, report: reportFile });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutSeconds * 1000);
    child.stdout.pipe(report);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `claude could not start: ${error.message}`, prompt: promptFile, report: reportFile });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      report.end(() => {
        const text = readFileSync(reportFile, "utf8");
        const { answer, source } = summarize(text);
        if (timedOut) {
          resolve({ ok: false, error: `timed out after ${timeoutSeconds}s`, prompt: promptFile, report: reportFile });
        } else if (code !== 0 || !answer || !source) {
          resolve({
            ok: false,
            error: code === 0 ? "the report has no Answer or Source line" : `claude exited ${code}`,
            prompt: promptFile,
            report: reportFile,
          });
        } else {
          resolve({ ok: true, answer, source, prompt: promptFile, report: reportFile });
        }
      });
    });
    child.stdin.on("error", () => {
      // The child exited before reading its brief; the close handler reports it.
    });
    child.stdin.end(prompt);
  });
}

function requireText(name, value) {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT) {
    throw new Error(`--${name} must be 1 to ${MAX_TEXT} characters`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      question: { type: "string" },
      situation: { type: "string" },
      apps: { type: "string" },
      out: { type: "string" },
      claude: { type: "string" },
      "timeout-seconds": { type: "string" },
    },
  });
  const prompt = precedentPrompt({ question: values.question, situation: values.situation, apps: values.apps });
  if (command === "prompt") {
    return { ok: true, prompt };
  }
  if (command === "run") {
    const timeout = Number(values["timeout-seconds"]);
    return runClaude({
      prompt,
      out: values.out ?? newRunFolder(),
      claude: values.claude,
      timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_SECONDS,
    });
  }
  throw new Error("command must be prompt or run");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await main())}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

/** Where precedent reports live when no --out is given: under the vibe home a reboot keeps. */
export function precedentRoot(home = os.homedir()) {
  return path.join(home, ".codex", "vibe", "precedent");
}

function newRunFolder() {
  const root = precedentRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(path.join(root, "run-"));
}
