import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeBudget, createBudget } from '../../vibe/scripts/heavy-budget.mjs';
import { chooseConcurrency, slotCap, Source } from './dispatch-budget.mjs';

const SCRIPT = fileURLToPath(new URL('./dispatch-budget.mjs', import.meta.url));
const snapshotOf = (over) => ({ ...computeBudget({ cores: 10, targetUtilisation: 0.8, minWorkers: 2, leases: [], unleasedCores: 0, ...over }), leases: 0 });

test('off, the guidance is the fixed slot count and the budget is not read', () => {
  const off = chooseConcurrency({ enabled: false, snapshot: snapshotOf({}), minWorkers: 2, env: { HEAVY_SLOTS: '3' } });
  assert.deepEqual([off.source, off.concurrentRuns], [Source.Slots, 3]);
  assert.equal(slotCap({}), 1);
  assert.equal(slotCap({ HEAVY_SLOTS: '0' }), 1);
});

test('on, the guidance is how many minimum-worker runs fit in what the budget has left, outside load included', () => {
  const free = chooseConcurrency({ enabled: true, snapshot: snapshotOf({}), minWorkers: 2, env: { HEAVY_SLOTS: '1' } });
  assert.deepEqual([free.source, free.available, free.concurrentRuns, free.slotCap], [Source.Budget, 8, 4, 1]);
  const leased = chooseConcurrency({ enabled: true, snapshot: snapshotOf({ leases: [{ workers: 4 }] }), minWorkers: 2 });
  assert.equal(leased.concurrentRuns, 2);
  const outside = chooseConcurrency({ enabled: true, snapshot: snapshotOf({ unleasedCores: 6.4 }), minWorkers: 2 });
  assert.deepEqual([outside.available, outside.concurrentRuns, outside.belowMinimum], [1, 0, true], 'a run started by another tool leaves less for this fleet');
  assert.equal(chooseConcurrency({ enabled: true, snapshot: null, minWorkers: 2, env: { HEAVY_SLOTS: '2' } }).concurrentRuns, 2);
});

test('the guidance follows the real budget: a lease held by a live process lowers it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budget-'));
  const budget = createBudget({ env: {}, cores: 10, leaseDir: dir, processes: () => [] });
  const before = chooseConcurrency({ enabled: true, snapshot: budget.snapshot(), minWorkers: 2 }).concurrentRuns;
  const lease = budget.acquire({ command: 'vitest', budget: { workers: 6 } });
  const during = chooseConcurrency({ enabled: true, snapshot: budget.snapshot(), minWorkers: 2 }).concurrentRuns;
  assert.ok(readFileSync(join(dir, `${lease.id}.json`), 'utf8').includes('"workers":6'));
  assert.ok(during < before);
  lease.release();
});

test('the CLI is off by default and honours the environment switch', () => {
  const run = (env) => JSON.parse(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, FLEET_BUDGET_GUIDANCE: '', HEAVY_SLOTS: '2', ...env } }).stdout);
  const off = run({});
  assert.deepEqual([off.schema, off.source, off.concurrentRuns], ['vibe.fleet-dispatch-budget/1', Source.Slots, 2]);
  const dir = mkdtempSync(join(tmpdir(), 'budget-cli-'));
  writeFileSync(join(dir, 'x.json'), '');
  const on = run({ FLEET_BUDGET_GUIDANCE: '1', VIBE_HEAVY_BUDGET: 'on', VIBE_HEAVY_LEASE_DIR: dir, VIBE_HEAVY_CORES: '10' });
  assert.equal(on.source, Source.Budget);
  // The shared worker budget is opt-in (#383), so guidance alone keeps the slot count.
  const budgetUnset = run({ FLEET_BUDGET_GUIDANCE: '1', VIBE_HEAVY_LEASE_DIR: dir, VIBE_HEAVY_CORES: '10' });
  assert.equal(budgetUnset.source, Source.Slots);
  const disabled = run({ FLEET_BUDGET_GUIDANCE: '1', VIBE_HEAVY_BUDGET: 'off' });
  assert.equal(disabled.source, Source.Slots);
});
