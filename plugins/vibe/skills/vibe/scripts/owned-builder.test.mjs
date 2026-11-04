import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ownedBuildEnvironment, prepareRunOwnedBuild } from './owned-builder.mjs';
import { reconcileGeneratedE2E, reserveGeneratedE2E } from './owned-docker.mjs';
import { sweepOwnedCleanups } from './owned-cleanup.mjs';

const STARTED = '2026-11-03T00:00:00Z';
const CREATED = '2026-11-03T00:00:01Z';
const CONTAINER = 'a'.repeat(64);
const VOLUME = 'state-volume';

function fixture(t) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vibe-owned-builder-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const token = 'c'.repeat(32);
  const project = 'vibe-e2e-' + token;
  const file = path.join(home, 'e2e-cleanup-' + token + '.json');
  const builder = 'vibe-build-' + token;
  const builderContainer = 'buildx_buildkit_' + builder + '0';
  const stateVolume = builderContainer + '_state';
  const calls = [];
  const docker = new Map();
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'buildx' && args[1] === 'version') return { status: 0, stdout: 'github.com/docker/buildx v0.14.1' };
    if (args[0] === 'compose' && args[1] === 'build' && args[2] === '--help') return { status: 0, stdout: '--builder Set builder to use' };
    if (args[0] === 'buildx' && args[1] === 'create') {
      docker.set('container:' + builderContainer, { Id: CONTAINER, Created: CREATED,
        Config: { Labels: { 'com.docker.buildx.builder': builder } } });
      docker.set('volume:' + stateVolume, { Name: stateVolume, CreatedAt: CREATED, Labels: {} });
      return { status: 0, stdout: builder };
    }
    if (args[0] === 'buildx' && args[1] === 'rm') {
      docker.delete('container:' + builderContainer);
      docker.delete('volume:' + stateVolume);
      return { status: 0, stdout: '' };
    }
    const [kind, action, ...rest] = args;
    if (action === 'ls') return { status: 0, stdout: '' };
    if (action === 'inspect') {
      const name = rest.at(-1);
      const value = docker.get(kind + ':' + name);
      if (value) return { status: 0, stdout: JSON.stringify([value]) };
      const error = kind === 'image' ? 'No such image: ' : kind === 'container' ? 'No such container: '
        : kind === 'volume' ? 'get ' : 'network ';
      return { status: 1, stderr: 'Error response from daemon: ' + error + name + (kind === 'volume' ? ': no such volume' : '') };
    }
    throw new Error('unexpected Docker: ' + args.join(' '));
  };
  const reserve = () => reserveGeneratedE2E({ token, project, owner: { token, identity: 'dead', pid: 99_999_999 },
    startedAt: STARTED, plannedTags: [], file }, { run });
  return { home, token, project, file, builder, builderContainer, stateVolume, calls, docker, run, reserve };
}

test('one generated build gets a private default-load builder, no global --use, and child-only Turbo root', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  const prepared = prepareRunOwnedBuild(record, { run: f.run, home: f.home });
  assert.ok(prepared?.builder, 'generated run must own a builder before the child starts');
  const create = f.calls.find((args) => args[0] === 'buildx' && args[1] === 'create');
  assert.ok(create.includes('default-load=true'));
  assert.ok(create.includes('--buildkitd-config'));
  assert.equal(create.includes('--use'), false);
  const config = create[create.indexOf('--buildkitd-config') + 1];
  assert.equal(config, path.join(record.runState.path, 'buildkitd.toml'));
  assert.match(readFileSync(config, 'utf8'), /\[worker\.oci\]\ngc = true\nmax-parallelism = 1\n/);
  const env = ownedBuildEnvironment(record, { HOME: f.home });
  assert.equal(env.BUILDX_BUILDER, f.builder);
  assert.ok(env.TURBO_CACHE_DIR?.startsWith(path.join(f.home, '.codex', 'vibe', 'cleanup')));
  assert.equal(existsSync(env.TURBO_CACHE_DIR), true);
});

test('unsupported Buildx or Compose refuses before builder/cache creation', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  const old = (args) => args[0] === 'buildx' && args[1] === 'version'
    ? { status: 0, stdout: 'github.com/docker/buildx v0.13.0' } : f.run(args);
  assert.throws(() => prepareRunOwnedBuild(record, { run: old, home: f.home }), /Buildx|0\.14/);
  assert.equal(f.calls.some((args) => args[0] === 'buildx' && args[1] === 'create'), false);
  const noBuilder = (args) => args[0] === 'compose' && args.includes('--help')
    ? { status: 0, stdout: 'build services' } : f.run(args);
  assert.throws(() => prepareRunOwnedBuild(record, { run: noBuilder, home: f.home }), /Compose|builder/);
});

test('exact builder and owned cache retire after Docker cleanup; foreign/default state stays', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  assert.ok(prepareRunOwnedBuild(record, { run: f.run, home: f.home }), 'builder registration precedes cleanup');
  const cache = record.cache.path;
  writeFileSync(path.join(cache, 'entry'), 'owned');
  f.docker.set('container:foreign', { Id: 'b'.repeat(64), Created: CREATED });
  f.docker.set('container:buildx_buildkit_default0', { Id: 'f'.repeat(64), Created: CREATED });
  reconcileGeneratedE2E(record, { run: f.run, ownerAlive: () => false, lockHeld: () => false });
  assert.equal(f.docker.has('container:' + f.builderContainer), false, 'exact builder is removed');
  assert.equal(f.docker.has('container:foreign'), true, 'foreign builder remains');
  assert.equal(f.docker.has('container:buildx_buildkit_default0'), true, 'default builder remains');
  assert.equal(existsSync(cache), false, 'owned cache root is removed');
});

test('changed builder identity or cache path keeps both resources for review', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  assert.ok(prepareRunOwnedBuild(record, { run: f.run, home: f.home }), 'builder registration precedes identity checks');
  f.docker.get('container:' + f.builderContainer).Created = '2026-11-04T00:00:00Z';
  assert.throws(() => reconcileGeneratedE2E(record, { run: f.run }), /builder|identity|witness/i);
  assert.equal(f.docker.has('container:' + f.builderContainer), true);
  const cache = record.cache.path;
  rmSync(cache, { recursive: true });
  symlinkSync(f.home, cache);
  assert.throws(() => reconcileGeneratedE2E(record, { run: f.run }), /builder|cache|symlink|identity/i);
  assert.equal(lstatSync(cache).isSymbolicLink(), true);
});

test('a live run keeps its exact builder and cache root', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  assert.ok(prepareRunOwnedBuild(record, { run: f.run, home: f.home }));
  const cache = record.cache.path;
  assert.throws(() => reconcileGeneratedE2E(record, { run: f.run, ownerAlive: () => true }), /live.*owner/i);
  assert.equal(f.docker.has('container:' + f.builderContainer), true);
  assert.equal(existsSync(cache), true);
});

test('symlinked or replaced local cache root is retained with the owned builder', (t) => {
  for (const change of ['symlink', 'replaced inode']) {
    const f = fixture(t);
    const record = f.reserve();
    assert.ok(prepareRunOwnedBuild(record, { run: f.run, home: f.home }));
    const cache = record.cache.path;
    rmSync(cache, { recursive: true });
    if (change === 'symlink') symlinkSync(f.home, cache);
    else mkdirSync(cache);
    assert.throws(() => reconcileGeneratedE2E(record, { run: f.run }), /cache|symlink|identity/i, change);
    assert.equal(f.docker.has('container:' + f.builderContainer), true, change);
    assert.equal(existsSync(f.home), true);
  }
});

test('no-build and caller-owned projects never create a builder', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  assert.throws(() => prepareRunOwnedBuild(record, { run: f.run, home: f.home, buildIntent: false }), /build intent/);
  assert.throws(() => prepareRunOwnedBuild({ ...record, project: 'callers-own' }, { run: f.run, home: f.home }),
    /Generated E2E build intent/);
  assert.equal(f.calls.some((args) => args[0] === 'buildx' && args[1] === 'create'), false);
});

test('crash sweep removes the exact inactive builder and local cache after project cleanup', async (t) => {
  const f = fixture(t);
  const file = path.join(f.home, '.codex', 'vibe', 'locks', 'e2e-cleanup-' + f.token + '.json');
  const record = reserveGeneratedE2E({ token: f.token, project: f.project,
    owner: { token: f.token, identity: 'dead', pid: 99_999_999 }, startedAt: STARTED,
    plannedTags: [], file }, { run: f.run, home: f.home });
  assert.ok(prepareRunOwnedBuild(record, { run: f.run, home: f.home }));
  const cache = record.cache.path;
  await sweepOwnedCleanups({ home: f.home, docker: f.run });
  assert.equal(f.docker.has('container:' + f.builderContainer), false);
  assert.equal(existsSync(cache), false);
});

test('failed builder removal leaves a retryable exact record; later pass succeeds', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  assert.ok(prepareRunOwnedBuild(record, { run: f.run, home: f.home }));
  let failed = false;
  const flaky = (args) => {
    if (!failed && args[0] === 'buildx' && args[1] === 'rm') { failed = true; return { status: 1, stderr: 'busy' }; }
    return f.run(args);
  };
  assert.throws(() => reconcileGeneratedE2E(record, { run: flaky }), /builder|busy/i);
  assert.equal(f.docker.has('container:' + f.builderContainer), true);
  assert.doesNotThrow(() => reconcileGeneratedE2E(record, { run: f.run }));
  assert.equal(f.docker.has('container:' + f.builderContainer), false);
});

test('retry accepts its already-deleted shim or complete run-state absence', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  assert.ok(prepareRunOwnedBuild(record, { run: f.run, home: f.home }));
  const shimDir = path.join(record.runState.path, 'bin');
  mkdirSync(shimDir);
  const shim = path.join(shimDir, 'docker');
  writeFileSync(shim, 'owned');
  const stat = lstatSync(shim);
  record.runState.shim = { dev: stat.dev, ino: stat.ino };
  rmSync(shim);
  assert.doesNotThrow(() => reconcileGeneratedE2E(record, { run: f.run }));
  assert.equal(record.state, 'complete');

  const g = fixture(t);
  const pending = g.reserve();
  assert.ok(prepareRunOwnedBuild(pending, { run: g.run, home: g.home }));
  g.docker.delete('container:' + g.builderContainer);
  g.docker.delete('volume:' + g.stateVolume);
  rmSync(pending.runState.path, { recursive: true });
  pending.state = 'cleaning';
  assert.doesNotThrow(() => reconcileGeneratedE2E(pending, { run: g.run }));
  assert.equal(pending.state, 'complete');
});

test('built service image missing from local store blocks builder teardown; GHCR image is never a target', (t) => {
  const f = fixture(t);
  const tag = f.project + '-api';
  const record = reserveGeneratedE2E({ token: f.token, project: f.project,
    owner: { token: f.token, identity: 'dead', pid: 99_999_999 }, startedAt: STARTED,
    plannedTags: [tag], file: f.file }, { run: f.run });
  assert.ok(prepareRunOwnedBuild(record, { run: f.run, home: f.home }));
  record.buildFinished = true;
  record.requiredBuiltTags = [tag];
  f.docker.set('image:ghcr.io/shared:tag', { Id: 'sha256:' + 'f'.repeat(64), Created: CREATED,
    RepoTags: ['ghcr.io/shared:tag'] });
  assert.throws(() => reconcileGeneratedE2E(record, { run: f.run }), /local image|built tag/i);
  assert.equal(f.docker.has('container:' + f.builderContainer), true);
  assert.equal(f.docker.has('image:ghcr.io/shared:tag'), true);
  assert.equal(f.calls.some((args) => args[0] === 'image' && args[1] === 'rm' && args.at(-1) === 'ghcr.io/shared:tag'), false);
});
