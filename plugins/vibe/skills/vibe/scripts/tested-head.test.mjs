import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as identity from './tested-head.mjs';
import { sourceIdentity, treeIdentity, snapshotPlugins } from './tested-head.mjs';
import { git, makeHome } from './test-fixtures.mjs';

function snapshotFixture(t) {
  const fixture = makeHome('snapshot-boundary-');
  t.after(fixture.cleanup);
  const source = path.join(fixture.root, 'source');
  const plugins = path.join(source, 'plugins');
  for (const name of ['vibe', 'closedloop-core']) {
    mkdirSync(path.join(plugins, name), { recursive: true });
    writeFileSync(path.join(plugins, name, 'input.md'), 'selected input');
  }
  writeFileSync(path.join(source, '.gitignore'), '.env\n');
  git(source, ['init', '--quiet'], fixture.home);
  git(source, ['add', '.'], fixture.home);
  git(source, ['commit', '--quiet', '-m', 'base'], fixture.home);
  return { ...fixture, source, plugins };
}

test('source CLI normalizes nested plugin directories to the repository root', t => {
  const { source, plugins } = snapshotFixture(t);
  writeFileSync(path.join(plugins, 'vibe/input.md'), 'dirty nested input');
  const run = spawnSync(process.execPath, [new URL('./tested-head.mjs', import.meta.url).pathname, 'source', path.join(plugins, 'vibe')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), sourceIdentity(source));
});

test('stable source rejects sync and async mutations during the operation', async t => {
  const { source, plugins } = snapshotFixture(t);
  const file = path.join(plugins, 'vibe/input.md');
  assert.throws(() => identity.withStableSource(source, () => {
    const bytes = readFileSync(file, 'utf8');
    writeFileSync(file, 'changed after read');
    return { bytes };
  }), /SOURCE-MOVED/);
  await assert.rejects(async () => identity.withStableSource(source, async () => {
    const bytes = readFileSync(file, 'utf8');
    await Promise.resolve();
    writeFileSync(file, 'changed again');
    return { bytes };
  }), /SOURCE-MOVED/);
  const accepted = identity.withStableSource(source, () => ({ bytes: readFileSync(file, 'utf8') }));
  assert.deepEqual(accepted.source, sourceIdentity(source));
});

for (const escape of ['absolute', 'parent']) test(`snapshot refuses ${escape} symlink escape to ignored private input`, t => {
  const { root, home, source, plugins } = snapshotFixture(t);
  const secret = path.join(plugins, '.env');
  writeFileSync(secret, 'PRIVATE=never-copy');
  symlinkSync(escape === 'absolute' ? secret : '../.env', path.join(plugins, 'vibe/leak.md'));
  git(source, ['add', 'plugins/vibe/leak.md'], home);
  assert.throws(() => snapshotPlugins(plugins, path.join(root, 'out')), /SYMLINK|outside.*root/i);
  assert.equal(existsSync(path.join(root, 'out/plugins/vibe/leak.md')), false);
});

test('snapshot excludes ignored regular files and links to ignored in-root files', t => {
  const { root, plugins } = snapshotFixture(t);
  writeFileSync(path.join(plugins, 'vibe/.env'), 'PRIVATE=never-copy');
  writeFileSync(path.join(plugins, 'vibe/new.md'), 'nonignored untracked input');
  snapshotPlugins(plugins, path.join(root, 'out'));
  assert.equal(existsSync(path.join(root, 'out/plugins/vibe/.env')), false);
  assert.equal(readFileSync(path.join(root, 'out/plugins/vibe/new.md'), 'utf8'), 'nonignored untracked input');
  symlinkSync('.env', path.join(plugins, 'vibe/alias.md'));
  assert.throws(() => snapshotPlugins(plugins, path.join(root, 'out-link')), /ignored|unselected|SYMLINK/i);
});

test('identity covers staged, unstaged, untracked, binary, executable, deleted and symlink inputs without commits', t => {
  const { root, home, cleanup } = makeHome('source-identity-');
  t.after(cleanup);
  const wt = path.join(root, 'wt');
  git(root, ['init', '--quiet', wt], home);
  writeFileSync(path.join(wt, 'tracked'), 'base');
  git(wt, ['add', '.'], home);
  git(wt, ['commit', '--quiet', '-m', 'base'], home);
  const base = sourceIdentity(wt);
  writeFileSync(path.join(wt, 'tracked'), Buffer.from([0, 1, 2]));
  writeFileSync(path.join(wt, 'new'), 'new');
  symlinkSync('tracked', path.join(wt, 'link'));
  const dirty = sourceIdentity(wt);
  assert.equal(dirty.head, base.head);
  assert.notEqual(dirty.diffSha256, base.diffSha256);
  assert.notEqual(dirty.treeSha256, base.treeSha256);
  git(wt, ['add', '.'], home);
  assert.deepEqual(sourceIdentity(wt), dirty, 'staging preserves identity');
  chmodSync(path.join(wt, 'new'), 0o755);
  assert.notEqual(sourceIdentity(wt).treeSha256, dirty.treeSha256);
  unlinkSync(path.join(wt, 'tracked'));
  const deleted = sourceIdentity(wt);
  git(wt, ['add', '-A'], home);
  assert.deepEqual(sourceIdentity(wt), deleted, 'staging a deletion preserves identity');
  git(wt, ['commit', '--quiet', '-m', 'ready'], home);
  assert.equal(sourceIdentity(wt).treeSha256, deleted.treeSha256, 'the one final commit preserves tested content');
});

test('copied tree identity names the bytes copied even after the source changes', t => {
  const { root, cleanup } = makeHome('copied-identity-');
  t.after(cleanup);
  const source = path.join(root, 'source');
  const copied = path.join(root, 'copy');
  mkdirSync(source);
  writeFileSync(path.join(source, 'a'), 'grader revision 19');
  cpSync(source, copied, { recursive: true });
  const snapshot = treeIdentity(copied);
  writeFileSync(path.join(source, 'a'), 'concurrent revision 20');
  assert.notDeepEqual(treeIdentity(source), snapshot);
  assert.deepEqual(treeIdentity(copied), snapshot);
  assert.equal(readFileSync(path.join(copied, 'a'), 'utf8'), 'grader revision 19');
});

test('Claude eval executes the copied inputs, retains their receipt and rejects mutation', t => {
  const { root, home, cleanup } = makeHome('claude-eval-identity-');
  t.after(cleanup);
  const source = path.join(root, 'source');
  const plugins = path.join(source, 'plugins');
  for (const name of ['vibe', 'closedloop-core']) {
    mkdirSync(path.join(plugins, name), { recursive: true });
    writeFileSync(path.join(plugins, name, 'input.md'), 'base');
  }
  symlinkSync('input.md', path.join(plugins, 'vibe/alias.md'));
  git(source, ['init', '--quiet'], home);
  git(source, ['add', '.'], home);
  git(source, ['commit', '--quiet', '-m', 'base'], home);
  writeFileSync(path.join(plugins, 'vibe/input.md'), 'uncommitted revision');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(path.join(plugins, 'vibe/input.md'))}, 'later source edit');
const outputIndex = process.argv.indexOf('--output-dir');
fs.mkdirSync(process.argv[outputIndex + 1], { recursive: true });
fs.writeFileSync(require('path').join(process.argv[outputIndex + 1], 'report.html'), 'owned result');
fs.writeFileSync('../called.json', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), input: fs.readFileSync('vibe/input.md', 'utf8'), alias: fs.readFileSync('vibe/alias.md', 'utf8') }));
if (process.argv.includes('--mutate')) fs.writeFileSync('vibe/input.md', 'invalid snapshot mutation');
`, { mode: 0o755 });
  const run = (out, ...flags) => spawnSync(process.execPath, [new URL('./tested-head.mjs', import.meta.url).pathname,
    'claude-eval', plugins, out, ...flags], { encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  const out = path.join(root, 'out');
  const valid = run(out, '--no-publish');
  assert.equal(valid.status, 0, valid.stderr);
  const call = JSON.parse(readFileSync(path.join(out, 'called.json'), 'utf8'));
  assert.equal(call.cwd, path.join(out, 'plugins'));
  assert.deepEqual(call.args, ['plugin', 'eval', '.', '--eval-dir', 'vibe/evals', '--no-publish', '--output-dir', path.join(out, 'results')]);
  assert.equal(readFileSync(path.join(out, 'results/report.html'), 'utf8'), 'owned result');
  assert.equal(call.input, 'uncommitted revision');
  assert.equal(call.alias, 'uncommitted revision', 'copied links must not read later live source bytes');
  const result = JSON.parse(readFileSync(path.join(out, 'result.json'), 'utf8'));
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.payloads.vibe, treeIdentity(path.join(out, 'plugins/vibe')));
  const invalidOut = path.join(root, 'invalid');
  const invalid = run(invalidOut, '--mutate');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /SOURCE-MOVED/);
  assert.equal(JSON.parse(readFileSync(path.join(invalidOut, 'result.json'), 'utf8')).unchanged, false);
});
