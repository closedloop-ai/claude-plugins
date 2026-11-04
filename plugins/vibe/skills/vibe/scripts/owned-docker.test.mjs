import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { reconcileGeneratedE2E, reserveGeneratedE2E } from './owned-docker.mjs';
import { sweepOwnedCleanups } from './owned-cleanup.mjs';

const CONTAINER = 'a'.repeat(64);
const NETWORK = 'b'.repeat(64);
const CREATED = '2026-11-03T00:00:01Z';
const STARTED = '2026-11-03T00:00:00Z';

function fixture(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vibe-owned-docker-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const token = 'c'.repeat(32);
  const project = `vibe-e2e-${token}`;
  const tag = `${project}-api`;
  const imageId = `sha256:${'d'.repeat(64)}`;
  const resources = new Map();
  const images = new Map();
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const [kind, action, ...rest] = args;
    const id = rest.at(-1);
    if (action === 'ls') {
      const prefix = `${kind}:`;
      const filterAt = rest.indexOf('--filter');
      const filter = filterAt >= 0 ? rest[filterAt + 1] : null;
      const wanted = filter?.replace('label=com.docker.compose.project=', '');
      const ancestor = filter?.replace('ancestor=', '');
      return { status: 0, stdout: [...resources.entries()].filter(([key, value]) => key.startsWith(prefix)
        && (!filter || (filter.startsWith('ancestor=') ? value.Image === ancestor
          : (kind === 'container' ? value.Config?.Labels : value.Labels)?.['com.docker.compose.project'] === wanted)))
        .map(([key]) => key.slice(prefix.length)).join('\n') };
    }
    if (action === 'inspect') {
      const value = kind === 'image' ? images.get(id) : resources.get(`${kind}:${id}`);
      if (value) return { status: 0, stdout: JSON.stringify([value]) };
      const stderr = kind === 'container' ? `Error response from daemon: No such container: ${id}`
        : kind === 'volume' ? `Error response from daemon: get ${id}: no such volume`
          : kind === 'network' ? `Error response from daemon: network ${id} not found`
            : `Error response from daemon: No such image: ${id}`;
      return { status: 1, stderr };
    }
    if (action === 'rm') {
      if (kind === 'image') images.delete(id);
      else resources.delete(`${kind}:${id}`);
      return { status: 0, stdout: '' };
    }
    if (kind === 'compose' && action === 'config') return { status: 0, stdout: '{}' };
    throw new Error(`unhandled fake Docker command ${args.join(' ')}`);
  };
  const addResources = () => {
    resources.set(`container:${CONTAINER}`, { Id: CONTAINER, Image: imageId, Created: CREATED,
      State: { Running: false }, Config: { Labels: { 'com.docker.compose.project': project } } });
    resources.set('volume:project-data', { Name: 'project-data', CreatedAt: CREATED,
      Labels: { 'com.docker.compose.project': project } });
    resources.set(`network:${NETWORK}`, { Id: NETWORK, Created: CREATED,
      Labels: { 'com.docker.compose.project': project } });
    images.set(tag, { Id: imageId, Created: CREATED, RepoTags: [tag + ':latest'] });
  };
  const reserve = (options = {}) => {
    const record = reserveGeneratedE2E({ token, project, owner: { pid: 99_999_999, identity: 'dead', token },
      startedAt: STARTED, plannedTags: [tag], file: path.join(dir, `e2e-cleanup-${token}.json`), ...options }, { run });
    record.potentialBuiltTags = record.plannedTags.slice(); // Simulated selected build-wave intent.
    return record;
  };
  const reconcile = (record, options = {}) => reconcileGeneratedE2E(record, { run, ownerAlive: () => false, lockHeld: () => false, ...options });
  return { dir, token, project, tag, imageId, resources, images, calls, run, addResources, reserve, reconcile };
}

test('successful generated E2E removes exact local tag and stopped project resources', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  assert.ok(record, 'pre-launch reservation persists a full random project capability');
  f.addResources();
  f.reconcile(record);
  assert.deepEqual([...f.resources.keys()], []);
  assert.deepEqual([...f.images.keys()], [], 'locally built tag is removed');
  assert.equal(f.calls.some((args) => args[0] === 'image' && args[1] === 'rm' && args.includes('--force')), false);
});

test('crash before exit recovers stopped containers, volumes, networks and built tags', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  assert.ok(record, 'pre-launch reservation is required');
  f.addResources();
  assert.equal(record.resources, undefined, 'crash happened before the exit checkpoint');
  f.reconcile(record);
  assert.equal(f.resources.size + f.images.size, 0, 'post-reservation exact project is recovered');
});

test('scheduled sweep recovers a crashed pre-reserved E2E project without taking the machine lock', async (t) => {
  const f = fixture(t);
  const ownerToken = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const file = path.join(f.dir, '.codex', 'vibe', 'locks', `e2e-cleanup-${ownerToken}.json`);
  const record = reserveGeneratedE2E({ token: f.token, project: f.project,
    owner: { pid: 99_999_999, identity: 'dead', token: ownerToken },
    startedAt: STARTED, plannedTags: [f.tag], file }, { run: f.run, home: f.dir });
  record.potentialBuiltTags = [f.tag];
  writeFileSync(file, JSON.stringify(record));
  const liveLock = path.join(f.dir, '.codex', 'vibe', 'locks', 'e2e-stack');
  mkdirSync(liveLock);
  writeFileSync(path.join(liveLock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'other-live-run' }));
  f.addResources();
  assert.equal(record.resources, undefined);
  const result = await sweepOwnedCleanups({ home: f.dir, docker: f.run });
  assert.equal(f.resources.size + f.images.size, 0);
  assert.ok(result.removed.includes(f.tag));
  assert.equal(existsSync(file), false, 'completed records do not consume future sweep visits');
  assert.equal(existsSync(liveLock), true, 'unique-project sweep does not take or release the machine lock');
});

test('partial cleanup retries remaining exact witnesses without broadening ownership', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  f.addResources();
  f.resources.delete(`container:${CONTAINER}`);
  f.reconcile(record);
  assert.equal(f.resources.size + f.images.size, 0);
  assert.doesNotThrow(() => f.reconcile(record));
});

test('reservation rejects a preexisting project or planned local tag', (t) => {
  const f = fixture(t);
  f.addResources();
  assert.throws(() => f.reserve(), /preexisting|not empty|already exists|owned/i);
  f.resources.clear();
  assert.throws(() => f.reserve(), /tag|image|already exists/i);
});

test('reservation accepts only the exact normalized Docker missing-image reply', (t) => {
  const f = fixture(t);
  const details = { token: f.token, project: f.project,
    owner: { pid: 99_999_999, identity: 'dead', token: f.token }, startedAt: STARTED,
    plannedTags: [f.tag], file: path.join(f.dir, 'normalized-reservation.json') };
  const normalized = (args) => args[0] === 'image' && args[1] === 'inspect'
    ? { status: 1, stderr: `Error response from daemon: No such image: ${f.tag}:latest` }
    : f.run(args);
  assert.doesNotThrow(() => reserveGeneratedE2E(details, { run: normalized }));
  const unrelated = (args) => args[0] === 'image' && args[1] === 'inspect'
    ? { status: 1, stderr: `Error response from daemon: No such image: ${f.tag}:other` }
    : f.run(args);
  assert.throws(() => reserveGeneratedE2E(details, { run: unrelated }), /Docker image inspect failed/);
});

test('changed ID, creation, project or tag witnesses and extra project members refuse deletion', (t) => {
  for (const change of ['id', 'created', 'project', 'tag', 'extra']) {
    const f = fixture(t);
    const record = f.reserve();
    assert.ok(record, `${change} needs the reserved run`);
    f.addResources();
    if (change === 'id') {
      record.resources = { project: f.project, containers: [{ id: CONTAINER, created: CREATED, project: f.project }],
        volumes: [], networks: [] };
      f.resources.delete(`container:${CONTAINER}`);
      f.resources.set(`container:${'e'.repeat(64)}`, { Id: 'e'.repeat(64), Image: f.imageId, Created: CREATED,
        State: { Running: false }, Config: { Labels: { 'com.docker.compose.project': f.project } } });
    }
    if (change === 'created') f.resources.get(`container:${CONTAINER}`).Created = '2026-10-01T00:00:00Z';
    if (change === 'project') f.resources.get(`container:${CONTAINER}`).Config.Labels['com.docker.compose.project'] = 'foreign';
    if (change === 'tag') {
      record.images = [{ tag: f.tag, id: f.imageId, created: CREATED }];
      f.images.get(f.tag).Id = `sha256:${'e'.repeat(64)}`;
    }
    if (change === 'extra') record.resources = { project: f.project, containers: [], volumes: [], networks: [] };
    assert.throws(() => f.reconcile(record), /witness|owned|project|recorded|changed|foreign/i, change);
    assert.ok(f.resources.size + f.images.size > 0, `${change} leaves resources for review`);
  }
});

test('foreign, shared, upstream and no-build images remain outside the exact tag set', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  assert.ok(record, 'image test has a reservation');
  f.addResources();
  const shared = 'postgres:16';
  f.images.set(shared, { Id: `sha256:${'f'.repeat(64)}`, Created: CREATED, RepoTags: [shared] });
  f.reconcile(record);
  assert.equal(f.images.has(shared), true, 'upstream image stays');
  const noBuild = fixture(t);
  const blank = noBuild.reserve({ plannedTags: [] });
  noBuild.images.set(noBuild.tag, { Id: noBuild.imageId, Created: CREATED, RepoTags: [noBuild.tag] });
  noBuild.reconcile(blank);
  assert.equal(noBuild.images.has(noBuild.tag), true, '--no-build creates no image entitlement');
});

test('witnessed private GHCR fallback tag is removed while GHCR and fixed tags remain', (t) => {
  const f = fixture(t);
  const fallback = f.tag;
  const fixed = 'cl-e2e-api-local';
  const ghcr = 'ghcr.io/shared/api:sha';
  const record = f.reserve({ plannedTags: [fallback] });
  f.addResources();
  f.images.set(fixed, { Id: 'sha256:' + 'e'.repeat(64), Created: CREATED, RepoTags: [fixed] });
  f.images.set(ghcr, { Id: 'sha256:' + 'f'.repeat(64), Created: CREATED, RepoTags: [ghcr] });
  record.observedImages = [{ tag: fallback, id: f.imageId, created: CREATED }];
  f.reconcile(record);
  assert.equal(f.images.has(fallback), false);
  assert.equal(f.images.has(ghcr), true);
  assert.equal(f.images.has(fixed), true, 'fixed fallback belongs to no generated run');

  const preexisting = fixture(t);
  preexisting.images.set(fallback, { Id: preexisting.imageId, Created: CREATED, RepoTags: [fallback] });
  assert.throws(() => preexisting.reserve({ plannedTags: [fallback] }), /already exists/);
});

test('paired reserved tags on one image retire only when both share the wave witness', (t) => {
  const f = fixture(t);
  const pair = f.project + '-api-local';
  const record = f.reserve({ plannedTags: [f.tag, pair] });
  record.potentialBuiltTags = [f.tag, pair];
  record.observedImages = [f.tag, pair].map((tag) => ({ tag, id: f.imageId, created: CREATED }));
  f.images.set(f.tag, { Id: f.imageId, Created: CREATED, RepoTags: [f.tag, pair] });
  f.images.set(pair, { Id: f.imageId, Created: CREATED, RepoTags: [f.tag, pair] });
  assert.deepEqual(f.reconcile(record).removed.filter((row) => row.kind === 'image-tag').map((row) => row.id), [f.tag, pair]);
  assert.equal(f.images.size, 0);
});

test('concurrent retag and foreign profile image preserve exact images', (t) => {
  const f = fixture(t);
  const inactive = f.project + '-storybook';
  const record = f.reserve({ plannedTags: [f.tag, inactive] });
  record.potentialBuiltTags = [f.tag];
  record.observedImages = [{ tag: f.tag, id: f.imageId, created: CREATED }];
  f.images.set(f.tag, { Id: 'sha256:' + 'e'.repeat(64), Created: CREATED, RepoTags: [f.tag] });
  assert.throws(() => f.reconcile(record), /wave witness/);
  assert.equal(f.images.has(f.tag), true);
  f.images.set(f.tag, { Id: f.imageId, Created: CREATED, RepoTags: [f.tag] });
  f.images.set(inactive, { Id: f.imageId, Created: CREATED, RepoTags: [inactive, 'foreign:latest'] });
  assert.throws(() => f.reconcile(record), /retagged or shared/);
  assert.equal(f.images.has(inactive), true);
});

test('implicit Compose up can retire only a reserved private project tag', (t) => {
  const f = fixture(t);
  const realtime = f.project + '-realtime';
  const record = f.reserve({ plannedTags: [realtime] });
  record.potentialBuiltTags = [];
  f.images.set(realtime, { Id: f.imageId, Created: CREATED, RepoTags: [realtime + ':latest'] });
  const result = f.reconcile(record);
  assert.ok(result.removed.some((entry) => entry.kind === 'image-tag' && entry.id === realtime));
  assert.equal(f.images.has(realtime), false);

  const other = fixture(t);
  const fixed = 'cl-e2e-realtime-local';
  const unsafe = other.reserve({ plannedTags: [] });
  unsafe.plannedTags.push(fixed); // A changed record cannot promote a fixed shared tag.
  other.images.set(fixed, { Id: other.imageId, Created: CREATED, RepoTags: [fixed] });
  assert.throws(() => other.reconcile(unsafe), /outside the reserved private project/);
  assert.equal(other.images.has(fixed), true);
});

test('partial failed wave can retire its selected private tag after reservation', (t) => {
  const f = fixture(t);
  const pair = f.project + '-api-local';
  const record = f.reserve({ plannedTags: [f.tag, pair] });
  record.potentialBuiltTags = [f.tag, pair];
  f.images.set(f.tag, { Id: f.imageId, Created: CREATED, RepoTags: [f.tag] });
  f.reconcile(record);
  assert.equal(f.images.has(f.tag), false);
});

test('an unacknowledged gate cannot run Docker; a surviving command tree blocks cleanup', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  record.launchPending = true;
  assert.doesNotThrow(() => f.reconcile(record));
  const g = fixture(t);
  const pending = g.reserve();
  pending.child = { pid: 98765, pgid: 98765, identity: 'original leader birth' };
  assert.throws(() => g.reconcile(pending, { childAlive: () => true }), /command tree/);
});

test('a surviving descendant in the isolated command group blocks cleanup after its leader exits', async (t) => {
  const f = fixture(t);
  const record = f.reserve();
  const leader = spawn('/bin/sh', ['-c', 'sleep 20 &'], { detached: true, stdio: 'ignore' });
  t.after(() => { if (leader.pid > 1) { try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* Group already exited. */ } } });
  await new Promise((resolve) => leader.once('close', resolve));
  record.child = { pid: leader.pid, pgid: leader.pid, identity: 'leader birth before exit' };
  assert.throws(() => f.reconcile(record), /command tree/);
});

test('retagged image and foreign container references preserve the owned tag', (t) => {
  const shared = fixture(t);
  const reserved = shared.reserve();
  shared.addResources();
  shared.images.get(shared.tag).RepoTags.push('foreign:latest');
  assert.throws(() => shared.reconcile(reserved), /retagged or shared/);
  assert.equal(shared.images.has(shared.tag), true);

  const foreign = fixture(t);
  const other = foreign.reserve();
  foreign.addResources();
  foreign.resources.set(`container:${'f'.repeat(64)}`, { Id: 'f'.repeat(64), Image: foreign.imageId, Created: CREATED,
    State: { Running: true }, Config: { Labels: { 'com.docker.compose.project': 'other-tool' } } });
  assert.throws(() => foreign.reconcile(other), /foreign or live container/);
  assert.equal(foreign.images.has(foreign.tag), true);
  assert.equal(foreign.resources.has(`container:${'f'.repeat(64)}`), true);
});

test('image reference checks use an ancestor filter and every Docker call is capped by the shared deadline', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  f.addResources();
  const timeouts = [];
  const bounded = (args, options = {}) => { timeouts.push(options.timeoutMs); return f.run(args); };
  f.reconcile(record, { run: bounded, deadline: 750, clock: () => 0 });
  assert.ok(f.calls.some((args) => args[0] === 'container' && args[1] === 'ls'
    && args.includes('--filter') && args.includes('ancestor=' + f.imageId)));
  assert.ok(timeouts.length > 0 && timeouts.every((value) => value <= 750));
});

test('live owner or lock and legacy reservation without proof stay pending', (t) => {
  const f = fixture(t);
  const record = f.reserve();
  assert.ok(record, 'live run has a reservation');
  f.addResources();
  assert.throws(() => f.reconcile(record, { ownerAlive: () => true }), /live|active|owner/i);
  assert.throws(() => f.reconcile(record, { lockHeld: () => true }), /live|active|lock/i);
  assert.equal(f.resources.size + f.images.size, 4);
  assert.throws(() => f.reconcile({ project: f.project, owner: record.owner }), /reservation|proof|legacy/i);
  const old = { ...record };
  delete old.launchPending;
  assert.throws(() => f.reconcile(old), /reservation|proof|legacy/i,
    'an old record without the durable launch handshake cannot authorize cleanup');
  assert.equal(f.resources.size + f.images.size, 4);
});

test('dead parent with a surviving child or running upstream-image container cannot be swept', (t) => {
  const f = fixture(t);
  const record = f.reserve({ plannedTags: [] });
  record.child = { pid: 12345, identity: 'birth' };
  f.addResources();
  f.images.clear();
  assert.throws(() => f.reconcile(record, { childAlive: () => true }), /Live E2E command tree/);
  assert.equal(f.resources.size, 3);
  record.child = null;
  f.resources.get('container:' + CONTAINER).State.Running = true;
  assert.throws(() => f.reconcile(record), /container is running/);
  assert.equal(f.resources.size, 3);
});

test('scheduled sweep reports an old reservation without proof and leaves its resources intact', async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, '.codex', 'vibe', 'locks', `e2e-cleanup-${f.token}.json`);
  reserveGeneratedE2E({ token: f.token, project: f.project,
    owner: { pid: 99_999_999, identity: 'dead', token: f.token },
    startedAt: STARTED, plannedTags: [f.tag], file }, { run: f.run, home: f.dir });
  f.addResources();
  writeFileSync(file, JSON.stringify({ project: f.project, owner: { token: f.token } }));
  const result = await sweepOwnedCleanups({ home: f.dir, docker: f.run });
  assert.ok(result.leftover.some((line) => line.includes('ownership proof')), 'legacy record remains visible');
  assert.equal(f.resources.size + f.images.size, 4);
});
