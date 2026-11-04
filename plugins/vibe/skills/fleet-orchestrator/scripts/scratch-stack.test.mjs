import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runScratchStack, scratchOverlay } from './helpers.mjs';

test('scratch overlay labels services, named volumes and networks and refuses local image builds', () => {
  const config = { services: { postgres: { image: 'postgres:16' }, seed: { image: 'seed:1' } },
    volumes: { data: {} }, networks: { private: {} } };
  const overlay = scratchOverlay(config, 'token-one');
  assert.equal(overlay.services.postgres.labels['vibe.owner-token'], 'token-one');
  assert.equal(overlay.services.seed.labels['vibe.owner-token'], 'token-one');
  assert.equal(overlay.volumes.data.labels['vibe.owner-token'], 'token-one');
  assert.equal(overlay.networks.private.labels['vibe.owner-token'], 'token-one');
  assert.throws(() => scratchOverlay({ services: { app: { build: '.' } } }, 'token'), /locally built/);
  assert.throws(() => scratchOverlay({ services: { postgres: { volumes: [{ type: 'volume', target: '/data' }] } } }, 'token'),
    /named volumes/);
  assert.throws(() => scratchOverlay({ services: { postgres: {} }, volumes: { shared: { external: true } } }, 'token'),
    /shared/);
  for (const volumes of [{ data: { name: 'production_data' } }, { data: { driver_opts: { type: 'none', device: '/host', o: 'bind' } } }]) {
    assert.throws(() => scratchOverlay({ services: { postgres: {} }, volumes }, 'token'), /explicit|host-backed/);
  }
  assert.throws(() => scratchOverlay({ services: { postgres: {} }, networks: { default: { name: 'foreign-net' } } }, 'token'),
    /explicit/);
  for (const service of [{ privileged: true }, { network_mode: 'host' }, { volumes: [{ type: 'bind', source: '/host', target: '/data' }] }]) {
    assert.throws(() => scratchOverlay({ services: { postgres: service } }, 'token'), /host|privileged/);
  }
});

test('scratch wrapper registers before Docker up and captures exact resources after launch', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-scratch-wrapper-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const composeFile = path.join(dir, 'compose.yml');
  writeFileSync(composeFile, 'services:\n  postgres:\n    image: postgres:16\n');
  const calls = [];
  const run = (bin, args) => {
    calls.push([bin, args]);
    if (args.includes('start')) {
      const name = args[3];
      const project = args[args.indexOf('--project') + 1];
      writeFileSync(path.join(dir, 'helpers.json'), JSON.stringify({ [name]: { project, ownerToken: 'owner-token', expiresAt: '2026-11-04T00:00:00Z' } }));
      return '';
    }
    if (args.includes('config')) return JSON.stringify({ services: { postgres: { image: 'postgres:16' } }, volumes: { data: {} } });
    return '';
  };
  const result = runScratchStack({ orchDir: dir, name: 'pg', owner: 'writer', ticket: 'ticket-one',
    worktree: dir, ttlSeconds: 600, composeFile }, { run, docker: 'docker' });
  assert.equal(result.ownerToken, 'owner-token');
  assert.equal(calls[0][1].includes('start'), true, 'ledger reservation precedes Docker');
  const up = calls.findIndex(([, args]) => args.includes('up'));
  const captured = calls.findIndex(([, args]) => args.includes('resources'));
  assert.ok(up > 0 && captured > up, 'Docker starts after reservation and before exact capture');
  assert.equal(calls[up][1][1], '--project-name', 'scratch Compose uses the long project option');
  assert.equal(readFileSync(composeFile, 'utf8').includes('postgres:16'), true);
});

test('scratch wrapper launches the private checked Compose snapshot after original replacement', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-scratch-drift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const composeFile = path.join(dir, 'compose.yml');
  writeFileSync(composeFile, 'services:\n  postgres:\n    image: postgres:16\n');
  const calls = [];
  const run = (_bin, args) => {
    calls.push(args);
    if (args.includes('start')) {
      const name = args[3];
      writeFileSync(path.join(dir, 'helpers.json'), JSON.stringify({ [name]: {
        project: args[args.indexOf('--project') + 1], ownerToken: 'owner-token', expiresAt: '2026-11-04T00:00:00Z' } }));
      return '';
    }
    if (args.includes('config')) {
      writeFileSync(composeFile, 'services:\n  postgres:\n    privileged: true\n');
      return JSON.stringify({ services: { postgres: { image: 'postgres:16' } } });
    }
    if (args.includes('up')) {
      const snapshot = args[args.indexOf('-f') + 1];
      assert.notEqual(snapshot, composeFile);
      assert.deepEqual(JSON.parse(readFileSync(snapshot, 'utf8')), { services: { postgres: { image: 'postgres:16' } } });
    }
    return '';
  };
  runScratchStack({ orchDir: dir, name: 'pg', owner: 'writer', ticket: 'ticket-one',
    worktree: dir, ttlSeconds: 600, composeFile }, { run, docker: 'docker' });
  assert.equal(calls.some((args) => args.includes('up')), true);
});

test('scratch launch keeps its owner record when post-start resource capture fails', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-scratch-capture-fail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const composeFile = path.join(dir, 'compose.yml');
  writeFileSync(composeFile, 'services:\n  postgres:\n    image: postgres:16\n');
  let started = false;
  const run = (_bin, args) => {
    if (args.includes('start')) {
      const name = args[3];
      writeFileSync(path.join(dir, 'helpers.json'), JSON.stringify({ [name]: { owner: 'writer', ticket: 'ticket-one',
        project: args[args.indexOf('--project') + 1], ownerToken: 'owner-token', expiresAt: '2026-11-04T00:00:00Z' } }));
      return '';
    }
    if (args.includes('config')) return JSON.stringify({ services: { postgres: { image: 'postgres:16' } } });
    if (args.includes('up')) { started = true; return ''; }
    if (args.includes('resources')) throw new Error('capture unavailable');
    return '';
  };
  assert.throws(() => runScratchStack({ orchDir: dir, name: 'pg', owner: 'writer', ticket: 'ticket-one',
    worktree: dir, ttlSeconds: 600, composeFile }, { run, docker: 'docker' }), /capture unavailable/);
  assert.equal(started, true);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'helpers.json'), 'utf8')).pg.ownerToken, 'owner-token');
});
