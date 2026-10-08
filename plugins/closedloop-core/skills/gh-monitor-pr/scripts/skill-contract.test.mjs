import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('monitor wakes on review decisions, review bodies, refused rollups, and stalls, and offers a snapshot', () => {
  const monitor = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.match(monitor, /review summary body that has no inline comments/);
  assert.match(monitor, /`changes_requested` when the review decision is\s+`CHANGES_REQUESTED`/);
  assert.match(monitor, /`ci_rollup_refused`/);
  assert.match(monitor, /`--stall-after`, wake once with `stalled`/);
  assert.match(monitor, /monitor-pr\.mjs" snapshot '<pr-url>'/);
  assert.match(monitor, /`7` query failure\. It never starts, stops, or wakes\s+anything/);
});
