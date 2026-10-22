import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('head-change evidence retains stable patch-id and per-scenario reach checks', () => {
  const methodology = readFileSync(new URL('../references/plan-methodology.md', import.meta.url), 'utf8');
  const rule = methodology.slice(methodology.indexOf('## Rebind results after a head change'));
  assert.match(rule, /git patch-id --stable/);
  assert.match(rule, /Patch-id unchanged:[\s\S]{0,400}git diff --name-only <old-merge-base> <new-merge-base>/);
  assert.match(rule, /`code_importers` and `code_callers` on each file/);
  assert.match(rule, /Patch-id changed: reset each checkpoint the delta reaches/);
  assert.match(rule, /it was not exercised there/);
});
