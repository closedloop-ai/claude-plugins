import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeUsageLine, parseUsage } from './claude-usage.mjs';

// The real `claude -p "/usage"` lines, as the operator's session printed them.
const REAL = [
  'Current session: 51% used · resets Oct 22 at 12:39pm (America/Chicago)',
  'Current week (all models): 69% used · resets Oct 27 at 9am (America/Chicago)',
].join('\n');

test('parses the session and all-models weekly usage from the real /usage output', () => {
  assert.deepEqual(parseUsage(REAL), {
    session: { used: 51, resets: 'Oct 22 at 12:39pm (America/Chicago)' },
    week: { used: 69, resets: 'Oct 27 at 9am (America/Chicago)' },
  });
  assert.equal(parseUsage('Usage is not available in this mode.'), null);
});

test('the line uses the Codex bands: one band below the threshold, HIGH with the reset time from it', () => {
  assert.equal(claudeUsageLine('local', parseUsage(REAL), 80), 'claude-usage local session=under80% week=under80%');
  const high = parseUsage(REAL.replace('51%', '86%'));
  assert.equal(claudeUsageLine('local', high, 80), 'claude-usage local session=HIGH(80%) week=under80% resets=Oct_22_at_12:39pm_(America/Chicago)');
  assert.equal(claudeUsageLine('local', parseUsage(REAL.replace('69%', '95%')), 80), 'claude-usage local session=under80% week=HIGH(90%) resets=Oct_27_at_9am_(America/Chicago)');
  assert.equal(claudeUsageLine('local', null), 'claude-usage local unreadable READFAIL');
});

// A saved `/usage` transcript is imported into the Codex app's sidebar as an "Imported session" chat (ISS-13279).
test('the usage probe runs claude without saving a session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-'));
  const fake = join(dir, 'claude');
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dir, 'args.txt'))}\nprintf '%s\\n' ${JSON.stringify(REAL)}\n`);
  chmodSync(fake, 0o755);
  const script = fileURLToPath(new URL('./claude-usage.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, dir, 'local'], { encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: fake } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^claude-usage local session=/);
  assert.deepEqual(readFileSync(join(dir, 'args.txt'), 'utf8').trim().split('\n'), ['-p', '--no-session-persistence', '/usage']);
});
