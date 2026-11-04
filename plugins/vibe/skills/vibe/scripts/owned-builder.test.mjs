import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BUILDER_CACHE_CAP, ownedBuildEnvironment, prepareRunOwnedBuild } from './owned-builder.mjs';
import { reconcileGeneratedE2E, reserveGeneratedE2E } from './owned-docker.mjs';
import { sweepOwnedCleanups } from './owned-cleanup.mjs';

const STARTED = '2026-11-03T00:00:00Z';
const CREATED = '2099-11-03T00:00:01Z';
const CONTAINER = 'a'.repeat(64);

function fixture(t) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vibe-owned-builder-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const token = 'c'.repeat(32);
  const project = 'vibe-e2e-' + token;
  const file = path.join(home, 'e2e-cleanup-' + token + '.json');
  const builder = 'vibe-build';
  const builderContainer = 'buildx_buildkit_vibe-build0';
  const stateVolume = builderContainer + '_state';
  const calls = [];
  const docker = new Map();
  let instance = false;
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'buildx' && args[1] === 'version') return { status: 0, stdout: 'github.com/docker/buildx v0.14.1' };
    if (args[0] === 'compose' && args[1] === 'build' && args[2] === '--help') return { status: 0, stdout: '--builder Set builder to use' };
    if (args[0] === 'buildx' && args[1] === 'create') {
      if (instance) return { status: 1, stderr: 'ERROR: existing instance for "vibe-build" but no append mode' };
      instance = true;
      docker.set('container:' + builderContainer, { Name: '/' + builderContainer, Id: CONTAINER, Created: CREATED,
        Config: { Labels: {} } });
      docker.set('volume:' + stateVolume, { Name: stateVolume, CreatedAt: CREATED, Labels: {} });
      return { status: 0, stdout: builder };
    }
    if (args[0] === 'buildx' && args[1] === 'rm') { instance = false; return { status: 0, stdout: '' }; }
    if (args[0] === 'buildx' && args[1] === 'prune') return { status: 0, stdout: 'reclaimed' };
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
  const reserve = (at = file) => reserveGeneratedE2E({ token, project,
    owner: { token, identity: 'dead', pid: 99_999_999 }, startedAt: STARTED, plannedTags: [], file: at }, { run, home });
  return { home, token, project, file, builder, builderContainer, stateVolume, calls, docker, run, reserve };
}

test('generated builds reuse one persistent vibe builder at default parallelism and prune only its capped cache', (t) => {
  const f = fixture(t);
  const first = f.reserve();
  prepareRunOwnedBuild(first, { run: f.run, home: f.home });
  const create = f.calls.find((args) => args[0] === 'buildx' && args[1] === 'create');
  assert.ok(create.includes('default-load=true'));
  assert.equal(create.includes('--use'), false);
  assert.equal(create.includes('--buildkitd-config'), false, 'BuildKit keeps default parallelism');
  const env = ownedBuildEnvironment(first, { HOME: f.home });
  assert.equal(env.BUILDX_BUILDER, 'vibe-build');
  assert.equal(env.TURBO_CACHE_DIR, undefined, 'no false host Turbo cache claim reaches Docker');
  reconcileGeneratedE2E(first, { run: f.run });
  assert.ok(f.docker.has('container:' + f.builderContainer), 'persistent builder remains');
  assert.deepEqual(f.calls.find((args) => args[0] === 'buildx' && args[1] === 'prune'),
    ['buildx', 'prune', '--builder', 'vibe-build', '--force', '--keep-storage', BUILDER_CACHE_CAP]);

  const second = f.reserve(path.join(f.home, 'second.json'));
  prepareRunOwnedBuild(second, { run: f.run, home: f.home });
  assert.equal(f.calls.filter((args) => args[0] === 'buildx' && args[1] === 'create').length, 1, 'second run reuses the builder');
});

test('unsupported Buildx or Compose refuses before persistent builder creation', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  const old = (args) => args[0] === 'buildx' && args[1] === 'version'
    ? { status: 0, stdout: 'github.com/docker/buildx v0.13.0' } : f.run(args);
  assert.throws(() => prepareRunOwnedBuild(record, { run: old, home: f.home }), /Buildx|0\.14/);
  const noBuilder = (args) => args[0] === 'compose' && args.includes('--help')
    ? { status: 0, stdout: 'build services' } : f.run(args);
  assert.throws(() => prepareRunOwnedBuild(record, { run: noBuilder, home: f.home }), /Compose|builder/);
  assert.equal(f.calls.some((args) => args[0] === 'buildx' && args[1] === 'create'), false);
});

test('a crash after the absent-builder reservation resumes creation without adopting foreign state', (t) => {
  const f = fixture(t);
  f.run(['buildx', 'create', '--name', 'vibe-build']);
  f.docker.delete('container:' + f.builderContainer);
  f.docker.delete('volume:' + f.stateVolume);
  const cleanup = path.join(f.home, '.codex', 'vibe', 'cleanup');
  mkdirSync(cleanup, { recursive: true });
  writeFileSync(path.join(cleanup, 'vibe-builder.json'), JSON.stringify({ version: 1, kind: 'vibe-builder',
    state: 'creating', name: 'vibe-build', containerName: f.builderContainer, volumeName: f.stateVolume,
    absentAtReservation: true, createdAt: new Date().toISOString() }));
  prepareRunOwnedBuild(f.reserve(), { run: f.run, home: f.home });
  assert.equal(f.calls.filter((args) => args[0] === 'buildx' && args[1] === 'create').length, 2);
  assert.ok(f.calls.some((args) => args[0] === 'buildx' && args[1] === 'rm'));
});

test('a ready ownership record recreates its builder only when both exact parts are absent', (t) => {
  const f = fixture(t);
  prepareRunOwnedBuild(f.reserve(), { run: f.run, home: f.home });
  f.docker.delete('container:' + f.builderContainer);
  f.docker.delete('volume:' + f.stateVolume);
  const next = f.reserve(path.join(f.home, 'next.json'));
  prepareRunOwnedBuild(next, { run: f.run, home: f.home });
  assert.equal(f.calls.filter((args) => args[0] === 'buildx' && args[1] === 'create').length, 2);
  const recreateAt = f.calls.findLastIndex((args) => args[0] === 'buildx' && args[1] === 'create');
  const staleRmAt = f.calls.findLastIndex((args) => args[0] === 'buildx' && args[1] === 'rm');
  assert.ok(staleRmAt >= 0 && staleRmAt < recreateAt, 'stale buildx instance is removed before exact recreation');
  assert.ok(f.docker.has('container:' + f.builderContainer));
  assert.ok(f.docker.has('volume:' + f.stateVolume));
});

test('a same-named foreign builder without the vibe ownership record is never adopted', (t) => {
  const f = fixture(t);
  f.docker.set('container:' + f.builderContainer, { Name: '/' + f.builderContainer, Id: CONTAINER, Created: CREATED,
    Config: { Labels: {} } });
  f.docker.set('volume:' + f.stateVolume, { Name: f.stateVolume, CreatedAt: CREATED, Labels: {} });
  assert.throws(() => prepareRunOwnedBuild(f.reserve(), { run: f.run, home: f.home }), /without a vibe ownership record/);
  assert.equal(f.calls.some((args) => args[0] === 'buildx' && args[1] === 'prune'), false);
});

test('changed persistent builder identity refuses prune while foreign and default builders remain', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  prepareRunOwnedBuild(record, { run: f.run, home: f.home });
  f.docker.set('container:foreign', { Id: 'b'.repeat(64), Created: CREATED });
  f.docker.set('container:buildx_buildkit_default0', { Id: 'f'.repeat(64), Created: CREATED });
  f.docker.get('container:' + f.builderContainer).Created = '2099-11-04T00:00:00Z';
  assert.throws(() => reconcileGeneratedE2E(record, { run: f.run }), /builder|identity|witness/i);
  assert.equal(f.calls.some((args) => args[0] === 'buildx' && args[1] === 'prune'), false);
  assert.ok(f.docker.has('container:foreign'));
  assert.ok(f.docker.has('container:buildx_buildkit_default0'));
});

test('crash sweep removes run state but neither prunes nor removes the persistent builder', async (t) => {
  const f = fixture(t);
  const file = path.join(f.home, '.codex', 'vibe', 'locks', 'e2e-cleanup-' + f.token + '.json');
  const record = f.reserve(file);
  prepareRunOwnedBuild(record, { run: f.run, home: f.home });
  const runState = record.runState.path;
  const result = await sweepOwnedCleanups({ home: f.home, docker: f.run });
  assert.ok(f.docker.has('container:' + f.builderContainer));
  assert.equal(existsSync(runState), false, JSON.stringify(result));
  assert.equal(f.calls.some((args) => args[0] === 'buildx' && args[1] === 'prune'), false);
});

test('a missing witnessed service tag is already clean and cannot strand the persistent builder record', (t) => {
  const f = fixture(t);
  const tag = f.project + '-api';
  const record = reserveGeneratedE2E({ token: f.token, project: f.project,
    owner: { token: f.token, identity: 'dead', pid: 99_999_999 }, startedAt: STARTED,
    plannedTags: [tag], file: f.file }, { run: f.run });
  prepareRunOwnedBuild(record, { run: f.run, home: f.home });
  record.requiredBuiltTags = [tag];
  assert.doesNotThrow(() => reconcileGeneratedE2E(record, { run: f.run }));
  assert.ok(f.docker.has('container:' + f.builderContainer));
  assert.equal(existsSync(path.join(f.home, '.codex', 'vibe', 'cleanup', 'vibe-builder.json')), true);
});

test('no-build and caller-owned projects never create a builder', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  assert.throws(() => prepareRunOwnedBuild(record, { run: f.run, home: f.home, buildIntent: false }), /build intent/);
  assert.throws(() => prepareRunOwnedBuild({ ...record, project: 'callers-own' }, { run: f.run, home: f.home }), /Generated E2E/);
});

test('failed capped prune leaves an exact retryable builder and run record', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  prepareRunOwnedBuild(record, { run: f.run, home: f.home });
  let failed = false;
  const flaky = (args) => {
    if (!failed && args[0] === 'buildx' && args[1] === 'prune') { failed = true; return { status: 1, stderr: 'busy' }; }
    return f.run(args);
  };
  assert.throws(() => reconcileGeneratedE2E(record, { run: flaky }), /prune|busy/i);
  assert.ok(f.docker.has('container:' + f.builderContainer));
  assert.doesNotThrow(() => reconcileGeneratedE2E(record, { run: f.run }));
});
