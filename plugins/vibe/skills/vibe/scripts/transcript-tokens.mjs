// Token totals from Claude Code transcripts (WS0 M4): a session `.jsonl` or the
// stream-json output of `claude -p --verbose`. Both carry assistant messages with
// `message.usage`; one API message is written once per content block, so usage is
// counted once per message id. The final `result` event's duration and cost are
// returned when present (durationMs is the run's wall time).
//
// Codex rollouts use a different format that this does not read; a Codex session's
// tokens stay null.

import { readFileSync } from "node:fs";

/** Parses jsonl text, skipping blank and truncated lines. */
export function parseTranscript(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* a truncated last line */ }
  }
  return events;
}

/** Token totals across `transcripts` (arrays of events); null when no assistant message carried usage. */
export function tokenTotals(transcripts) {
  const seen = new Set();
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let counted = 0;
  let result = null;
  for (const events of transcripts) {
    for (const event of events) {
      if (event?.type === "result") result = { durationMs: number(event.duration_ms), costUsd: number(event.total_cost_usd), isError: typeof event.is_error === "boolean" ? event.is_error : null };
      const usage = event?.type === "assistant" ? event.message?.usage : null;
      if (!usage || typeof usage !== "object") continue;
      const id = event.message.id ?? event.uuid;
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      totals.input += number(usage.input_tokens) ?? 0;
      totals.output += number(usage.output_tokens) ?? 0;
      totals.cacheRead += number(usage.cache_read_input_tokens) ?? 0;
      totals.cacheWrite += number(usage.cache_creation_input_tokens) ?? 0;
      counted += 1;
    }
  }
  return { tokens: counted === 0 ? null : totals, messages: counted, result };
}

/** Totals for transcript files, for example a session's main transcript and its subagents' files. */
export function tokenTotalsFromFiles(files) {
  return tokenTotals(files.map((file) => parseTranscript(readFileSync(file, "utf8"))));
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
