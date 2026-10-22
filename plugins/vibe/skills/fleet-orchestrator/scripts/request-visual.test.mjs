import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkHeads, parseDraft, requestName } from './request-visual.mjs';

const SCRIPT = fileURLToPath(new URL('./request-visual.mjs', import.meta.url));
const TIMEOUT = { timeout: 30_000 };
const GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
// Built from parts so the skill's generic check does not read a fixture as a real repo reference.
const PR = `${['acme', 'app'].join('/')}#42`;

function draft(head, extra = {}) {
  const fields = {
    title: 'Row menu at narrow width', Session: 'w1', PR, 'Pushed head': head,
    Where: 'story list-row--narrow', Flags: 'new-rows=on', Expected: 'the <Menu> opens inside the row', Requirement: 'criterion 3',
    ...extra,
  };
  return [
    `# Visual request: ${fields.title}`,
    ...['Session', 'PR', 'Pushed head', 'Where', 'Flags'].map((k) => `${k}: ${fields[k]}`),
    'Steps:', '1. Open the story at 400px.',
    `Expected: ${fields.Expected}`, `Requirement: ${fields.Requirement}`, '',
  ].join('\n');
}

/** A git worktree with two commits, a requests dir, and a bin dir whose `gh` prints FAKE_PR_HEAD. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'request-visual-'));
  const repo = join(root, 'wt');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  for (const n of [1, 2]) {
    writeFileSync(join(repo, 'f.txt'), `${n}\n`);
    git('add', 'f.txt');
    git('-c', 'user.name=t', '-c', 'user.email=t', 'commit', '-q', '-m', `c${n}`);
  }
  const [second, first] = git('log', '--format=%H').split('\n');
  const requests = join(root, 'requests');
  mkdirSync(requests);
  const withGh = join(root, 'bin');
  const noGh = join(root, 'bin-no-gh');
  mkdirSync(withGh);
  mkdirSync(noGh);
  for (const bin of [withGh, noGh]) symlinkSync(GIT, join(bin, 'git'));
  writeFileSync(join(withGh, 'gh'), '#!/bin/sh\n[ -n "$FAKE_PR_HEAD" ] || exit 1\necho "$FAKE_PR_HEAD"\n');
  chmodSync(join(withGh, 'gh'), 0o755);
  const run = (head, prHead, { bin = withGh } = {}) => {
    const file = join(root, 'draft.md');
    writeFileSync(file, draft(head));
    return spawnSync(process.execPath, [SCRIPT, requests, file, '--worktree', repo], {
      encoding: 'utf8', env: { PATH: `${bin}:${dirname(process.execPath)}`, FAKE_PR_HEAD: prHead ?? '' },
    });
  };
  return { first, second, requests, run, noGh };
}

test('files the request when the named head is the pushed PR head and the worktree HEAD', TIMEOUT, () => {
  const f = fixture();
  const result = f.run(f.second, f.second);
  assert.equal(result.status, 0, result.stderr);
  const files = readdirSync(f.requests);
  assert.equal(files.length, 1);
  assert.match(files[0], /^w1-\d{8}-\d{4}-row-menu-at-narrow-width\.md$/);
  assert.equal(result.stdout.trim(), join(f.requests, files[0]));
  assert.equal(readFileSync(join(f.requests, files[0]), 'utf8'), draft(f.second));
});

test('refuses a head the worktree has unpushed commits beyond, naming both shas', TIMEOUT, () => {
  const f = fixture();
  const result = f.run(f.second, f.first);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`Pushed head ${f.second} is not the PR's current head ${f.first}`));
  const unpushed = f.run(f.first, f.first);
  assert.equal(unpushed.status, 1);
  assert.match(unpushed.stderr, new RegExp(`worktree HEAD ${f.second} differs from the PR's pushed head ${f.first}`));
  assert.deepEqual(readdirSync(f.requests), []);
});

test('refuses when gh is missing or fails rather than guessing', TIMEOUT, () => {
  const f = fixture();
  for (const result of [f.run(f.second, f.second, { bin: f.noGh }), f.run(f.second, undefined)]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refused: cannot read the head of acme\/app#42 with gh, so nothing was filed/);
  }
  assert.deepEqual(readdirSync(f.requests), []);
});

test('parseDraft requires every field filled and well formed', () => {
  const head = 'a'.repeat(40);
  assert.equal(parseDraft(draft(head)).repo, 'acme/app');
  assert.equal(parseDraft(draft(head)).number, '42');
  const rejects = (text, pattern) => assert.throws(() => parseDraft(text), pattern);
  rejects(draft(head).replace(/^# .*\n/, ''), /no "# Visual request/);
  rejects(draft(head).replace(/^Flags: .*\n/m, ''), /no Flags line/);
  rejects(draft(head).replace('1. Open', 'Open'), /no numbered step/);
  rejects(draft(head, { Where: '<URLs or component story ids>' }), /placeholder: <URLs or component story ids>/);
  rejects(draft(head).replace('1. Open the story at 400px.', '1. <step>'), /placeholder: <step>/);
  rejects(draft(head, { PR: 'acme/app 42' }), /PR must be/);
  rejects(draft('abc1234'), /full 40-character sha/);
  rejects(draft(head, { Session: '../w1' }), /Session must be/);
});

test('checkHeads passes only when all three heads agree', () => {
  const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
  assert.doesNotThrow(() => checkHeads({ head: a, prHead: a, worktreeHead: a }));
  assert.throws(() => checkHeads({ head: a, prHead: b, worktreeHead: b }), /is not the PR's current head/);
  assert.throws(() => checkHeads({ head: a, prHead: a, worktreeHead: b }), /worktree HEAD/);
});

test('requestName stamps the local time and slugs the title', () => {
  assert.equal(requestName('w1', 'Row menu: narrow!', new Date(2026, 0, 5, 9, 7)), 'w1-20260105-0907-row-menu-narrow.md');
  assert.equal(requestName('w1', '!!!', new Date(2026, 0, 5, 9, 7)), 'w1-20260105-0907-request.md');
});
