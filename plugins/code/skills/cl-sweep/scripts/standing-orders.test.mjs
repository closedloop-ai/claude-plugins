import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { FILE_NAME, SCHEMA, addOrder, load, removeOrder, render } from './standing-orders.mjs';

const script = resolve(import.meta.dirname, 'standing-orders.mjs');
const root = () => mkdtempSync(join(tmpdir(), 'standing-orders-'));

test('an absent register renders as none', () => {
  assert.equal(load(root()), null);
  assert.equal(render(null), 'Operator standing orders for this sweep: none.');
});

test('adds numbered orders with the user words, mode 0600, and renders them verbatim', () => {
  const dir = root();
  addOrder(dir, { sweepId: 's1', projectId: 'p1', order: 'Daniel approves every implementation plan.', userWords: 'I want to approve every plan', now: new Date('2026-09-29T10:00:00Z') });
  addOrder(dir, { sweepId: 's1', projectId: 'p1', order: 'Do not touch apps/desktop.', userWords: 'leave desktop alone', now: new Date('2026-09-29T11:00:00Z') });
  assert.equal(statSync(join(dir, FILE_NAME)).mode & 0o777, 0o600);
  const text = render(load(dir));
  assert.match(text, /^Operator standing orders for this sweep\. They bind this worker/);
  assert.match(text, /\n1\. Daniel approves every implementation plan\. \(user, 2026-09-29: "I want to approve every plan"\)/);
  assert.match(text, /\n2\. Do not touch apps\/desktop\./);
});

test('removal needs the newer user instruction and keeps ids unique', () => {
  const dir = root();
  addOrder(dir, { sweepId: 's1', projectId: 'p1', order: 'A', userWords: 'a' });
  addOrder(dir, { sweepId: 's1', projectId: 'p1', order: 'B', userWords: 'b' });
  assert.throws(() => removeOrder(dir, { id: 1, userWords: '' }), /newer user instruction/);
  removeOrder(dir, { id: 1, userWords: 'you can drop A now' });
  const register = load(dir);
  assert.deepEqual(register.orders.map((o) => o.id), [2]);
  assert.equal(register.removed[0].removedBecause, 'you can drop A now');
  addOrder(dir, { sweepId: 's1', projectId: 'p1', order: 'C', userWords: 'c' });
  assert.deepEqual(load(dir).orders.map((o) => o.id), [2, 3]);
  assert.throws(() => removeOrder(dir, { id: 1, userWords: 'again' }), /No active standing order 1/);
});

test('fails closed on a wrong mode, a malformed file, or another sweep', () => {
  const dir = root();
  addOrder(dir, { sweepId: 's1', projectId: 'p1', order: 'A', userWords: 'a' });
  assert.throws(() => addOrder(dir, { sweepId: 's2', projectId: 'p1', order: 'B', userWords: 'b' }), /different sweep/);
  chmodSync(join(dir, FILE_NAME), 0o644);
  assert.throws(() => load(dir), /must be mode 0600/);
  writeFileSync(join(dir, FILE_NAME), JSON.stringify({ schema: SCHEMA, sweepId: 's1', projectId: 'p1', orders: [{ id: 1, order: 'A' }], removed: [] }), { mode: 0o600 });
  chmodSync(join(dir, FILE_NAME), 0o600);
  assert.throws(() => load(dir), /Invalid standing orders register/);
  writeFileSync(join(dir, FILE_NAME), '{not json');
  assert.throws(() => load(dir), /Invalid standing orders register/);
});

test('CLI add, render, and remove', () => {
  const dir = root();
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(run('render', '--root', dir).stdout, 'Operator standing orders for this sweep: none.\n');
  assert.equal(run('add', '--root', dir, '--sweep-id', 's1', '--project-id', 'p1', '--order', 'Owner limit is five.', '--user-words', 'run five at a time').status, 0);
  assert.match(run('render', '--root', dir).stdout, /1\. Owner limit is five\./);
  assert.equal(run('remove', '--root', dir, '--id', '1', '--user-words', 'back to three').status, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, FILE_NAME), 'utf8')).orders.length, 0);
  const bad = run('frobnicate', '--root', dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown command/);
});
