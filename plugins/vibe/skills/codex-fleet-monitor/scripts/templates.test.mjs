import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PLIST = readFileSync(fileURLToPath(new URL('../templates/codex-fleet-supervisor.plist', import.meta.url)), 'utf8');

test('launchd respawns the supervisor within a minute', () => {
  const throttle = /<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(PLIST);
  assert.ok(throttle, 'the template sets ThrottleInterval');
  assert.ok(Number(throttle[1]) <= 60, `ThrottleInterval ${throttle[1]} leaves the host without a supervisor for too long`);
});

test('the template restarts with bootout then bootstrap and never recommends kickstart', () => {
  assert.match(PLIST, /launchctl bootout gui\/\$\(id -u\)\/codex-fleet-supervisor/);
  assert.match(PLIST, /launchctl bootstrap gui\/\$\(id -u\)/);
  const lines = PLIST.split('\n');
  const kickstart = lines.map((line, index) => [line, index]).filter(([line]) => /kickstart/.test(line));
  assert.ok(kickstart.length > 0, 'the template warns against kickstart');
  for (const [line, index] of kickstart) {
    assert.match(line, /never/i, `line ${index + 1} names kickstart without saying never: ${line.trim()}`);
  }
});
