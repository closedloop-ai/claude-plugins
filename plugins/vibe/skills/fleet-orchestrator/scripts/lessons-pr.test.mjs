import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./lessons-pr.mjs', import.meta.url));

function fakeGh(t, body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-lessons-pr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gh = path.join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh\n${body}\n`);
  chmodSync(gh, 0o755);
  return (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LESSONS_GH: gh } });
}

test('an open lessons PR is reported so the next batch goes onto its branch, not a stacked PR', (t) => {
  const prs = [
    { number: 31, title: 'fix(vibe): encode the open fleet lessons', headRefName: 'fix/vibe-lessons-a', url: 'https://example.test/pull/31' },
    { number: 32, title: 'feat: unrelated', headRefName: 'feat/other', url: 'https://example.test/pull/32' },
  ];
  const run = fakeGh(t, `echo '${JSON.stringify(prs)}'`);
  const found = run(['--repo', 'acme/plugins']);
  assert.equal(found.status, 1);
  assert.equal(found.stdout, 'OPEN https://example.test/pull/31 fix/vibe-lessons-a: push this batch onto that branch\n');
  assert.equal(run(['--repo', 'acme/plugins', '--match', 'release']).stdout, 'no open lessons PR\n');
});

test('no open lessons PR passes; gh failing is an error, never a pass', (t) => {
  assert.equal(fakeGh(t, "echo '[]'")(['--repo', 'acme/plugins']).status, 0);
  const broken = fakeGh(t, 'exit 1')(['--repo', 'acme/plugins']);
  assert.equal(broken.status, 2);
  assert.equal(fakeGh(t, "echo '[]'")([]).status, 2);
});
