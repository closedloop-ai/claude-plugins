#!/usr/bin/env node
// Prints "claude-usage <label> session=<band> week=<band>" (plus `resets=<when>` for a HIGH band) from `claude -p "/usage"`,
// or "claude-usage <label> unreadable READFAIL". Claude usage is readable: the command prints lines such as
//   Current session: 51% used · resets Oct 22 at 12:39pm (America/Chicago)
//   Current week (all models): 69% used · resets Oct 27 at 9am (America/Chicago)
// Bands follow the Codex usage line (usageBand from ratelimit.mjs, USAGE_HIGH_PERCENT), so ordinary use is
// not a watcher event. The command runs at most once per CLAUDE_USAGE_SECONDS (default 600); between runs
// the last line is reused from <workDir>/claude-usage.txt.
//
// Usage: claude-usage.mjs <workDir> [label]   (CLAUDE_BIN overrides the claude binary)

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEntryPoint } from './liveness.mjs';
import { resolveWorkDir } from './work-dir.mjs';
import { highUsagePercent, usageBand } from './ratelimit.mjs';

const LINE = /^\s*Current (session|week \(all models\)):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/gim;
export const DEFAULT_INTERVAL_SECONDS = 600;

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
export function claudeUsageLine(label, usage, high = highUsagePercent()) {
  if (!usage) return `claude-usage ${label} unreadable READFAIL`;
  const band = (part) => (part ? usageBand(part.used, high) : 'unknown');
  const high_ = (part) => part && part.used >= high;
  const when = high_(usage.session) ? usage.session.resets : high_(usage.week) ? usage.week.resets : null;
  const resets = when ? ` resets=${when.replace(/\s+/g, '_')}` : '';
  return `claude-usage ${label} session=${band(usage.session)} week=${band(usage.week)}${resets}`;
}

function cachedLine(file, maxAgeSeconds, now = Date.now()) {
  try {
    if ((now - statSync(file).mtimeMs) / 1000 < maxAgeSeconds) return readFileSync(file, 'utf8').trim();
  } catch {}
  return null;
}

function main() {
  const [workDir, label = 'local'] = process.argv.slice(2);
  if (!workDir) {
    process.stderr.write('Usage: claude-usage.mjs <workDir> [label]\n');
    process.exit(2);
  }
  const file = join(resolveWorkDir(workDir).dir, 'claude-usage.txt');
  const interval = Number(process.env.CLAUDE_USAGE_SECONDS) > 0 ? Number(process.env.CLAUDE_USAGE_SECONDS) : DEFAULT_INTERVAL_SECONDS;
  let line = cachedLine(file, interval);
  if (!line) {
    let output = '';
    try {
      output = execFileSync(process.env.CLAUDE_BIN || 'claude', ['-p', '/usage'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
    } catch {}
    line = claudeUsageLine(label, parseUsage(output));
    writeFileSync(file, `${line}\n`);
  }
  console.log(line);
}

if (isEntryPoint(import.meta.url)) main();
