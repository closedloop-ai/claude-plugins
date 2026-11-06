#!/usr/bin/env node
// Prints "claude-usage <label> session=<band> week=<band>" (plus `resets=<when>` for a HIGH band) from `claude -p "/usage"`,
// or "claude-usage <label> unreadable READFAIL". Claude usage is readable: the command prints lines such as
//   Current session: 51% used · resets Oct 22 at 12:39pm (America/Chicago)
//   Current week (all models): 69% used · resets Oct 27 at 9am (America/Chicago)
// Bands follow the Codex usage line (usageBand from ratelimit.mjs, USAGE_HIGH_PERCENT), so ordinary use is
// not a watcher event. The command runs at most once per CLAUDE_USAGE_SECONDS (default 600); between runs
// the last line is reused from <workDir>/claude-usage.txt.
//
// Usage: claude-usage.mjs <workDir> [label] [--source <name>]   (CLAUDE_BIN overrides the claude binary)
// The probe runs with --no-session-persistence: nobody resumes or analyzes it, and a saved transcript is
// imported into the Codex app's sidebar as an "Imported session" chat (ISS-13279).

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isEntryPoint } from './liveness.mjs';
import { resolveWorkDir } from './work-dir.mjs';
import { highUsagePercent, usageBand } from './ratelimit.mjs';
import { DEFAULT_CLAUDE_USAGE_INTERVAL_SECONDS, isRecentClaudeGood, recordUsageReading } from './usage-state.mjs';

const LINE = /^\s*Current (session|week \(all models\)):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/gim;
export const DEFAULT_INTERVAL_SECONDS = DEFAULT_CLAUDE_USAGE_INTERVAL_SECONDS;
export const DEFAULT_TIMEOUT_SECONDS = 90;
export const USAGE_ARGS = Object.freeze(['-p', '--no-session-persistence', '/usage']);

/** Convert a configured duration to Node's supported timer milliseconds, or use the 90-second default. */
export function usageTimeoutMilliseconds(value) {
  const milliseconds = Number(value) * 1000;
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 2_147_483_647
    ? milliseconds : DEFAULT_TIMEOUT_SECONDS * 1000;
}

/** The session and all-models weekly percentages and reset times in `/usage` output, or null when absent. */
export function parseUsage(text) {
  const found = {};
  for (const match of String(text ?? '').matchAll(LINE)) {
    const key = match[1].toLowerCase().startsWith('session') ? 'session' : 'week';
    found[key] = { used: Number(match[2]), resets: match[3]?.trim() ?? null };
  }
  return found.session || found.week ? found : null;
}

/** The monitor line for parsed usage. */
export function claudeUsageLine(label, usage, high = highUsagePercent(), metadata = null) {
  const suffix = metadata ? ` read=${metadata.readAt} source=${metadata.source}` : '';
  if (!usage) return `claude-usage ${label} unreadable READFAIL${suffix}`;
  const band = (part) => (part ? usageBand(part.used, high) : 'unknown');
  const high_ = (part) => part && part.used >= high;
  const when = high_(usage.session) ? usage.session.resets : high_(usage.week) ? usage.week.resets : null;
  const resets = when ? ` resets=${when.replace(/\s+/g, '_')}` : '';
  return `claude-usage ${label} session=${band(usage.session)} week=${band(usage.week)}${resets}${suffix}`;
}

function cachedLine(file, maxAgeSeconds, now = Date.now()) {
  try {
    if ((now - statSync(file).mtimeMs) / 1000 < maxAgeSeconds) return readFileSync(file, 'utf8').trim();
  } catch {}
  return null;
}

/** Persist a Claude probe and cache the line selected from its committed state under the same lock. */
export function recordClaudeUsageProbe(workDir, label, usage, { readAt, source, interval }) {
  const resolved = resolveWorkDir(workDir).dir;
  const file = join(resolved, 'claude-usage.txt');
  const readingLine = claudeUsageLine(label, usage, highUsagePercent(), { readAt, source });
  return recordUsageReading(resolved, { runtime: 'claude', machine: label, source, status: usage ? 'ok' : 'readfail', readAt, line: readingLine },
    ({ latest, lastGood, consecutiveFailures }) => {
      const recentGood = latest.status === 'readfail' && consecutiveFailures === 1
        && isRecentClaudeGood(lastGood?.readAt, latest.readAt, interval);
      const displayed = recentGood ? lastGood.line : latest.line;
      writeFileSync(file, `${displayed}\n`);
      return displayed;
    });
}

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true,
    options: { source: { type: 'string' } },
  });
  const [workDir, label = 'local'] = positionals;
  if (!workDir) {
    process.stderr.write('Usage: claude-usage.mjs <workDir> [label] [--source <name>]\n');
    process.exit(2);
  }
  const resolved = resolveWorkDir(workDir).dir;
  const file = join(resolved, 'claude-usage.txt');
  const interval = Number(process.env.CLAUDE_USAGE_SECONDS) > 0 ? Number(process.env.CLAUDE_USAGE_SECONDS) : DEFAULT_INTERVAL_SECONDS;
  const timeout = usageTimeoutMilliseconds(process.env.CLAUDE_USAGE_TIMEOUT_SECONDS);
  let line = cachedLine(file, interval);
  if (!line) {
    let output = '';
    try {
      output = execFileSync(process.env.CLAUDE_BIN || 'claude', USAGE_ARGS, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout,
      });
    } catch (error) {
      output = error?.stdout?.toString?.() ?? '';
    }
    const usage = parseUsage(output);
    const readAt = new Date().toISOString();
    const source = values.source ?? 'claude-usage';
    line = recordClaudeUsageProbe(resolved, label, usage, { readAt, source, interval });
  }
  console.log(line);
}

if (isEntryPoint(import.meta.url)) main();
