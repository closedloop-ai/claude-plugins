import assert from 'node:assert/strict';
import { test } from 'node:test';
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
