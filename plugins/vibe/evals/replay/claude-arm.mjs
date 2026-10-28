// One arm run in Claude Code (M2): `claude -p` in the run's workspace with the
// ticket text as the whole request, no MCP servers (no ticket or PR lookup),
// `gh` and `git push` denied, and a spend and time cap. Runs the vibe change
// worker alone (writer-only replay): the session record, ticket, environment
// and decision table steps of a full vibe session are not exercised here.
// Wall time and cost come from the final `result` event of the stream.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseTranscript, tokenTotals } from "../../skills/vibe/scripts/transcript-tokens.mjs";

export const WRITER_AGENT = "vibe:vibe-change-worker";
export const DEFAULT_BUDGET_USD = 15;
export const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

/** The request an arm is given: the human-written brief when the ticket has one, else the ticket's own text. Never the slug, pull request or tests. */
export function renderBrief(brief) {
  if (typeof brief.briefText === "string" && brief.briefText.trim()) return brief.briefText.trim();
  const criteria = (brief.acceptanceCriteria ?? []).map((item) => `- ${item}`).join("\n");
  return [brief.title, brief.description, criteria ? `Acceptance criteria:\n${criteria}` : null].filter(Boolean).join("\n\n");
}

/** The `claude` arguments for one run. `arm.pluginDir` loads a candidate plugin build; the baseline arm leaves it out. */
export function claudeArgs({ arm, brief, budgetUsd = DEFAULT_BUDGET_USD }) {
  return [
    "-p", `Mode: request. Your worktree and branch are the current directory; do not create another. There is no session record, live ticket, environment, decision table or reference image in this run.\n\nThe person's request, in their words:\n${renderBrief(brief)}`,
    "--agent", arm.agent ?? WRITER_AGENT,
    "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "Skill", "Agent",
    "--disallowedTools", "Bash(gh:*)", "Bash(git push:*)",
    "--max-budget-usd", String(budgetUsd),
    ...(arm.pluginDir ? ["--plugin-dir", arm.pluginDir] : []),
  ];
}

/**
 * Runs one arm and writes `<outDir>/stream.jsonl`. `run` is injectable for tests
 * (default `spawnSync`). Returns the telemetry measured from the stream; a run that
 * produced no result event has null wall time and cost.
 */
export function runClaudeArm({ arm, brief, workspace, outDir, run = spawnSync, timeoutMs = DEFAULT_TIMEOUT_MS, budgetUsd }) {
  mkdirSync(outDir, { recursive: true });
  const outcome = run("claude", claudeArgs({ arm, brief, budgetUsd }), { cwd: workspace, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: timeoutMs });
  if (outcome.error) throw outcome.error;
  writeFileSync(path.join(outDir, "stream.jsonl"), outcome.stdout ?? "");
  if (outcome.stderr) writeFileSync(path.join(outDir, "stderr.txt"), outcome.stderr);
  return { outputText: outcome.stdout ?? "", telemetry: telemetryFromStream(outcome.stdout ?? ""), exitStatus: outcome.status ?? null };
}

/** Telemetry fields for the baseline report from stream-json text; unmeasured fields are null. */
export function telemetryFromStream(text) {
  const events = parseTranscript(text);
  const { tokens, result } = tokenTotals([events]);
  const launches = events.filter((event) => event?.type === "assistant").flatMap((event) => event.message?.content ?? [])
    .filter((block) => block?.type === "tool_use" && (block.name === "Agent" || block.name === "Task")).length;
  return {
    workerLaunches: tokens === null ? null : launches,
    inputTokens: tokens?.input ?? null, outputTokens: tokens?.output ?? null,
    cacheReadTokens: tokens?.cacheRead ?? null, cacheWriteTokens: tokens?.cacheWrite ?? null,
    wallTimeMs: result?.durationMs ?? null, costUsd: result?.costUsd ?? null, isError: result?.isError ?? null,
    environmentMinutes: null, slotWaitMs: null,
  };
}

/** Counts of the identifiers of the human change (slug, pull request, merge commit) that appear in a stream; a nonzero count means the arm may have seen the answer. */
export function contaminationMentions(text, { slug, prNumber, mergeSha }) {
  const needles = [slug, prNumber === undefined || prNumber === null ? null : `#${prNumber}`, mergeSha ? mergeSha.slice(0, 10) : null].filter(Boolean);
  return needles.reduce((sum, needle) => sum + text.split(needle).length - 1, 0);
}
