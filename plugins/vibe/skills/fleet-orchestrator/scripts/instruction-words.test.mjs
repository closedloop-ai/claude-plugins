import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { changelogProblems, countWords } from './instruction-words.mjs';
import { git, makeHome, mutationPreload } from '../../vibe/scripts/test-fixtures.mjs';

const SCRIPT = fileURLToPath(new URL('./instruction-words.mjs', import.meta.url));

test('v1.1.21 records a validated non-growing Markdown measurement', () => {
  const repo = path.resolve(path.dirname(SCRIPT), '../../../../..');
  const run = spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--base', 'b8df21893c6322a0176b16df9fe123cc6f9296c2',
    '--changelog', path.join(repo, 'CHANGELOG.md'), '--version', '1.1.21'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /net (?:-\d+|0)/);
});

test('word count rejects source mutation after reading the diff', t => {
  const { root, home, cleanup } = makeHome('word-count-race-');
  t.after(cleanup);
  const repo = path.join(root, 'repo');
  const file = path.join(repo, 'plugins/vibe/skills/SKILL.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'base words\n');
  git(repo, ['init', '--quiet'], home);
  git(repo, ['add', '.'], home);
  git(repo, ['commit', '--quiet', '-m', 'base'], home);
  writeFileSync(file, 'candidate words\n');
  const preload = mutationPreload(root, { file, gitDiff: true, text: 'changed after diff was read\n' });
  const run = spawnSync(process.execPath, ['--import', preload, SCRIPT, '--repo', repo, '--base', 'HEAD'], { encoding: 'utf8' });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /SOURCE-MOVED/);
  assert.doesNotMatch(run.stdout, /added \d+ removed/);
});

test('the current release names the full Markdown scope of its word count', () => {
  const changelog = readFileSync(path.resolve(path.dirname(SCRIPT), '../../../../../CHANGELOG.md'), 'utf8');
  const entry = changelog.split('### vibe v1.1.20\n', 2)[1]?.split('\n### ', 1)[0] ?? '';
  assert.match(entry, /all plugin Markdown, including eval prompts and graders/);
});

test('counts words on added and removed lines only', () => {
  assert.deepEqual(countWords('--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-one two three\n+one two\n'), { added: 2, removed: 3, net: -1 });
});

test('a changelog number taken before the last commits fails at the final head (1.0.77 said 930 for 832)', () => {
  const entry = (n) => `### vibe v1.0.77\n\n- Markdown is about ${n} words shorter than in 1.0.75.\n\n### vibe v1.0.76\n`;
  assert.match(changelogProblems(entry('930'), '1.0.77', -832).join(), /says about 930 words shorter; the measured net is -832/);
  assert.deepEqual(changelogProblems(entry('830'), '1.0.77', -832), []);
  assert.match(changelogProblems(entry('830').replace('shorter', 'longer'), '1.0.77', -832).join(), /measured net is -832/);
  assert.match(changelogProblems('### vibe v1.0.77\n\n- Fixed.\n', '1.0.77', -5).join(), /states no/);
});

test('the command measures the Markdown between two refs and checks the changelog', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'instruction-words-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  mkdirSync(path.join(dir, 'plugins/vibe/skills'), { recursive: true });
  writeFileSync(path.join(dir, 'plugins/vibe/skills/SKILL.md'), 'one two three four five\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'plugins/vibe/skills/SKILL.md'), 'one two\n');
  writeFileSync(path.join(dir, 'CHANGELOG.md'), '### vibe v1.0.78\n\n- Markdown is about 3 words shorter.\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'trim');
  const ok = spawnSync(process.execPath, [SCRIPT, '--repo', dir, '--base', base, '--changelog', path.join(dir, 'CHANGELOG.md'), '--version', '1.0.78'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^added 2 removed 5 net -3$/m);
  writeFileSync(path.join(dir, 'plugins/vibe/skills/SKILL.md'), 'one\n');
  writeFileSync(path.join(dir, 'plugins/vibe/skills/new.md'), 'new guard\n');
  const dirty = spawnSync(process.execPath, [SCRIPT, '--repo', dir, '--base', base], { encoding: 'utf8' });
  assert.equal(dirty.status, 0, dirty.stderr);
  assert.match(dirty.stdout, /^added 3 removed 5 net -2$/m, 'the final word count includes unstaged and new Markdown without a commit');
  assert.match(dirty.stdout, /diffSha256.*[a-f0-9]{64}/);
  const pinned = spawnSync(process.execPath, [SCRIPT, '--repo', dir, '--base', base, '--head', 'HEAD'], { encoding: 'utf8' });
  assert.match(pinned.stdout, /^added 2 removed 5 net -3$/m, 'explicit ref comparisons stay pinned');
});
