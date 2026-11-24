import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertVibeSession, requireResumeSession } from './codex-session.mjs';

test('fleet writer requires a matching active vibe session record in its worktree', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-session-record-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q', '-b', 'vibe/example', dir]);
  const gitDir = execFileSync('git', ['-C', dir, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  const record = join(gitDir, 'vibe-session.json');
  assert.throws(() => assertVibeSession(dir), /no vibe session record/);
  const valid = { status: 'active', branch: 'vibe/example', slug: 'example', summary: 'Example', operator: { id: 'operator' },
    baseCommit: 'a'.repeat(40), createdAt: '2026-10-30T12:00:00Z' };
  writeFileSync(record, JSON.stringify({ ...valid, branch: 'vibe/other' }));
  assert.throws(() => assertVibeSession(dir), /does not match/);
  writeFileSync(record, JSON.stringify({ ...valid, status: 'stopped' }));
  assert.throws(() => assertVibeSession(dir), /no active vibe session/);
  writeFileSync(record, JSON.stringify({ status: 'active', branch: 'vibe/example' }));
  assert.throws(() => assertVibeSession(dir), /no active vibe session/, 'a hand-written stub is not a session');
  writeFileSync(record, JSON.stringify(valid));
  assert.equal(assertVibeSession(dir).branch, 'vibe/example');
  assert.equal(requireResumeSession(null, dir), null, 'the first $vibe turn creates its own record');
  assert.equal(requireResumeSession({ cwd: dir }, dir).branch, 'vibe/example');
  const pullRequest = { repo: 'org/example', number: 42 };
  writeFileSync(record, JSON.stringify({ ...valid, status: 'handed-off', pullRequest }));
  assert.throws(() => requireResumeSession({ cwd: dir }, dir, `section-10 changes for ${pullRequest.repo}-other#${pullRequest.number}`), /section-10/);
  assert.equal(requireResumeSession({ cwd: dir }, dir, `section-10 changes for ${pullRequest.repo}#${pullRequest.number}`).status, 'active');
});
