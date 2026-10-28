#!/usr/bin/env node
// The precedent check before a product question (operator ruling,
// 2026-10-16; `references/quality-loop.md`, "Precedent before asking"): how
// Asana, or another established app with the same flow, handles the
// situation the question is about. The research brief and its safety rules
// live here once, for both harnesses.
//
// Usage:
//   precedent-check.mjs prompt --question <text> --code-evidence <file:line> [--situation <text>]
//       Prints {"ok":true,"prompt":...}: the brief for the read-only requirements
//       worker's precedent mode when no signed-in `claude` CLI can run it. Codex
//       never follows it with computer use (`references/guardrails.md`,
//       "Processes and state").
//   precedent-check.mjs run --question <text> --code-evidence <file:line> [--situation <text>]
//                          [--out <dir>] [--claude <CLI>] [--timeout-seconds <n>]
//       Both harnesses: the look runs as a separate headless `claude -p --chrome`
//       run with the brief on stdin (a Claude Code session's Chrome tools are
//       bound when it starts). Writes prompt.md and report.md to --out (by
//       default a new folder under ~/.codex/vibe/precedent/, which a reboot
//       keeps, never the system temp folder) and prints
//       {"ok":true,"report":...,"answer":...,"source":...}, or
//       {"ok":false,"error":...,"report":...} when the run failed or timed out.
//   Both take `--behavior <text>`, once per disputed behavior: the concrete
//       interaction the question turns on (for example "select a collapsed
//       parent, then run a bulk action: does it reach the hidden children?").
//       A check once answered the headline question and never tried the
//       sub-question in dispute. `run` saves them as checklist.json beside the
//       report.
//   precedent-check.mjs check --report <file> [--behavior <text>]...
//       Refuses (exit 1) a report not settled by a live look: an `undocumented`
//       answer or a public-material source. Precedent means live Asana in the
//       operator's signed-in browser; public help centers are never precedent.
//       When this actor has no browser, it returns NEEDS_PERSON to the actor that
//       does instead of accepting public material. It also refuses a report missing a line
//       for any disputed behavior (--behavior, or else checklist.json beside the
//       report): `B<n>: observed: <what happened>; screenshot: <capture>`, or
//       `B<n>: needs a write to test: <why>` for the operator.
//
// Every command prints one JSON object.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const TEMP_PROJECT = "zz vibe precedent check (temp)";
export const TASK_PREFIX = "zz test";
export const CLAUDE_TOOLS = "mcp__claude-in-chrome__*,Read,Write";
const DEFAULT_TIMEOUT_SECONDS = 900;
const MAX_TEXT = 2000;
const ANSWER_LINE = /^Answer:\s*(.+)$/m;
const SOURCE_LINE = /^Source:\s*(.+)$/m;
const PUBLIC_SOURCE = /https?:\/\/|help center|help-center|documentation|docs/i;
const UNDOCUMENTED = /^undocumented\b/i;
const CHECKLIST_FILE = "checklist.json";

/** The research brief for one product question. */
export function precedentPrompt({ question, situation, codeEvidence, behaviors = [], today = new Date() }) {
  requireText("question", question);
  if (!/^\S.*:\d+(?:-\d+)?$/.test(codeEvidence ?? "")) {
    throw new Error("--code-evidence <file:line> is required before precedent research");
  }
  const date = today.toISOString().slice(0, 10);
  const disputed = behaviors.length === 0 ? "" : `
Disputed behaviors, every one required. Perform each interaction in the app, verify the result, and capture a screenshot of it. One that only a change to existing data could show is not performed: mark it for the operator.
${behaviors.map((behavior, index) => `B${index + 1}. ${behavior}`).join("\n")}
`;
  return `You are checking how established apps handle one situation, to answer a product question in a vibe session. Report what you see; never change anything that already exists.

Question: ${question}
Situation to reproduce: ${situation || question}
Code/data-model check: ${codeEvidence}
${disputed}
Order:
1. Asana, in Chrome, with the account already signed in there. Never sign in, create an account or type a credential.
2. If this actor cannot use that signed-in browser, stop with NEEDS_PERSON so the orchestrator or browser-holder can run the live check. Never use a public help center or documentation page as precedent.

Safety, in every app:
- Never touch anything that already exists: no edits, moves, completions, comments, invitations or setting changes.
- When you need test data, create one new private project named "${TEMP_PROJECT}", with no members and notifications off, and put everything in it. Prefix every task you create with "${TASK_PREFIX}".
- A flow that would connect an app, invite or notify someone, share, pay or change a setting: go only as far as its confirmation step, then cancel it.
- At the end, delete every task you created and then the project, check that they are gone, and say so in the report.

Evidence:
- Verify every state before you record it: reload or reopen and look again. A hover can look like a completed task.
- For a narrow-layout judgment, first capture the app as found. Then close every navigation sidebar or drawer, dismiss banners and overlays, and capture the same viewport again. Judge support from the cleared state and report both captures.
- Quote on-screen wording exactly, as evidence only.
- When nothing settles it, write "undocumented"; never guess.

Reply with only this report:
Answer: <the behavior, in one plain line, or "undocumented">
Source: Asana, observed ${date} | undocumented
Observed directly: <what you saw, with quoted wording>
Asana lacks this situation: <what was checked, or none>
Cleanup: <what you created and deleted, confirmed gone, or "nothing created">
${behaviors.map((_, index) => `B${index + 1}: observed: <what happened>; screenshot: <capture file> | B${index + 1}: needs a write to test: <why>`).join("\n")}
`;
}

/**
 * The headless Claude Code arguments for the look. It is never resumed and its report goes to a file, so it
 * saves no session: a saved one is imported into the Codex app's sidebar as a stray chat (ISS-13279).
 */
export function claudeArgs() {
  return ["-p", "--no-session-persistence", "--chrome", "--allowedTools", CLAUDE_TOOLS];
}

/**
 * The answer and source lines of a report, or null for each line it lacks, and
 * the kind of source: `observed` (a look at the live app), `public` (help
 * center or documentation only) or `none`.
 */
export function summarize(report) {
  const answer = ANSWER_LINE.exec(report)?.[1].trim() ?? null;
  const source = SOURCE_LINE.exec(report)?.[1].trim() ?? null;
  return { answer, source, sourceKind: sourceKind(source) };
}

/** Disputed behaviors the report leaves without an observed result and screenshot, or an operator note. */
export function missingBehaviors(report, behaviors) {
  return behaviors.map((behavior, index) => ({ id: `B${index + 1}`, behavior })).filter(({ id }) => {
    const line = new RegExp(`^${id}:\\s*(?:observed:\\s*\\S.*;\\s*screenshot:\\s*\\S+|needs a write to test:\\s*\\S.*)$`, "m");
    return !line.test(report);
  });
}

/** Whether a report is settled by a live look. */
export function checkReport(report, behaviors = []) {
  const { answer, source, sourceKind: kind } = summarize(report);
  if (!answer || !source) {
    return { ok: false, error: "the report has no Answer or Source line" };
  }
  const missing = missingBehaviors(report, behaviors);
  if (missing.length > 0) {
    return {
      ok: false,
      answer,
      source,
      sourceKind: kind,
      missing,
      error: `the report does not settle ${missing.map(({ id }) => id).join(", ")}: each disputed behavior needs "observed: <what happened>; screenshot: <capture>", or "needs a write to test: <why>" for the operator`,
    };
  }
  const settledLive = kind === "observed" && !UNDOCUMENTED.test(answer);
  if (settledLive) {
    return { ok: true, answer, source, sourceKind: kind };
  }
  return {
    ok: false,
    answer,
    source,
    sourceKind: kind,
    error: `the answer is ${UNDOCUMENTED.test(answer) ? "undocumented" : `from ${kind === "public" ? "public material" : "no source"}`}, not a live look; return NEEDS_PERSON to the browser-holder and run precedent-check.mjs run in the signed-in browser`,
  };
}

function sourceKind(source) {
  if (!source) {
    return "none";
  }
  if (/\bobserved\b/i.test(source)) {
    return "observed";
  }
  return PUBLIC_SOURCE.test(source) && !UNDOCUMENTED.test(source) ? "public" : "none";
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
        // kill(-1) would signal every process the user owns.
        if (child.pid > 1) process.kill(-child.pid, "SIGKILL");
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
        const { answer, source, sourceKind: kind } = summarize(text);
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
          resolve({ ok: true, answer, source, sourceKind: kind, prompt: promptFile, report: reportFile });
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
      "code-evidence": { type: "string" },
      out: { type: "string" },
      claude: { type: "string" },
      "timeout-seconds": { type: "string" },
      report: { type: "string" },
      behavior: { type: "string", multiple: true },
    },
  });
  if (command === "check") {
    if (!values.report) {
      throw new Error("check needs --report <file>");
    }
    const result = checkReport(readFileSync(values.report, "utf8"), values.behavior?.length ? values.behavior : savedBehaviors(values.report));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return result;
  }
  const behaviors = values.behavior ?? [];
  const prompt = precedentPrompt({ question: values.question, situation: values.situation, codeEvidence: values["code-evidence"], behaviors });
  if (command === "prompt") {
    return { ok: true, liveLook: false, prompt };
  }
  if (command === "run") {
    const timeout = Number(values["timeout-seconds"]);
    const out = values.out ?? newRunFolder();
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, CHECKLIST_FILE), `${JSON.stringify({ behaviors }, null, 2)}\n`);
    return runClaude({
      prompt,
      out,
      claude: values.claude,
      timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_SECONDS,
    });
  }
  throw new Error("command must be prompt, run or check");
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

/** The disputed behaviors `run` saved beside a report, or none. */
function savedBehaviors(reportFile) {
  try {
    const saved = JSON.parse(readFileSync(path.join(path.dirname(reportFile), CHECKLIST_FILE), "utf8"));
    return Array.isArray(saved.behaviors) ? saved.behaviors.filter((behavior) => typeof behavior === "string") : [];
  } catch {
    return [];
  }
}
