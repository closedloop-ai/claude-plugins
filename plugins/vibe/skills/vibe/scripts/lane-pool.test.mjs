import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULTS, ENV, resolveSettings } from "./heavy-budget.mjs";
import { classifyLane, LaneKind, POOLABLE_SCRIPTS, poolSizeFor, runScheduled } from "./lane-pool.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("only a known pure pnpm script lane is poolable; unknown, filtered, desktop, dagger and stack lanes default to serial", () => {
  for (const lane of ["pnpm test:lint", "pnpm test:ci", "AFFECTED_SCRIPT_SUITES='a b' pnpm test:lint", "pnpm test:deploy-guards"]) {
    assert.equal(classifyLane(lane, {}).kind, LaneKind.Pool, lane);
  }
  for (const lane of ["pnpm test:affected", "pnpm --filter app test", "pnpm --dir apps/desktop test:node", "pnpm test:deploy-harness", "pnpm test:something-new", "dagger call test", "pnpm db:migrate-test", "node scripts/x.mjs"]) {
    assert.equal(classifyLane(lane, {}).kind, LaneKind.Serial, lane);
  }
});

test("e2e lanes are serial and marked for the e2e lock, web and desktop alike", () => {
  for (const lane of ["pnpm test:e2e", "pnpm test:web-smoke", "pnpm --dir apps/desktop test:e2e", "FOO='1' pnpm playwright test"]) {
    const verdict = classifyLane(lane, {});
    assert.equal(verdict.kind, LaneKind.Serial, lane);
    assert.equal(verdict.e2e, true, lane);
  }
  assert.equal(classifyLane("pnpm test:lint", {}).e2e, false);
});

test("the poolable list is extendable by the environment, and the shipped list names no e2e, desktop or stack script", () => {
  assert.equal(classifyLane("pnpm test:mine", { [ENV.poolable]: "test:mine, test:other" }).kind, LaneKind.Pool);
  assert.ok(Object.isFrozen(POOLABLE_SCRIPTS));
  for (const name of POOLABLE_SCRIPTS) assert.equal(classifyLane(`pnpm ${name}`, {}).kind, LaneKind.Pool, name);
});

test("pool size comes from the budget, capped by the default of 2, and 1 when strictly serial or the budget is off", () => {
  const settings = resolveSettings({});
  assert.equal(DEFAULTS.poolSize, 2);
  assert.equal(poolSizeFor({ env: {}, settings, snapshot: { available: 8 } }), 2);
  assert.equal(poolSizeFor({ env: {}, settings, snapshot: { available: 3 } }), 1);
  assert.equal(poolSizeFor({ env: {}, settings, snapshot: { available: 0 } }), 1);
  assert.equal(poolSizeFor({ env: { [ENV.poolSize]: "4" }, settings: resolveSettings({ [ENV.poolSize]: "4" }), snapshot: { available: 20 } }), 4);
  assert.equal(poolSizeFor({ env: { [ENV.pool]: "serial" }, settings, snapshot: { available: 8 } }), 1);
  assert.equal(poolSizeFor({ env: { [ENV.off]: "off" }, settings, snapshot: { available: 8 } }), 1);
});

test("the scheduler never exceeds the pool size, never overlaps two serial items, and returns results in item order", async () => {
  const delays = [60, 10, 40, 5, 30, 20, 50, 15];
  const items = delays.map((delay, index) => ({ delay, serial: index % 3 === 0 }));
  let active = 0;
  let maxActive = 0;
  let serialActive = 0;
  let maxSerial = 0;
  const finished = [];
  const results = await runScheduled(items, { size: 3, run: async (item, index) => {
    active += 1; maxActive = Math.max(maxActive, active);
    if (item.serial) { serialActive += 1; maxSerial = Math.max(maxSerial, serialActive); }
    await sleep(item.delay);
    active -= 1;
    if (item.serial) serialActive -= 1;
    finished.push(index);
    return `result-${index}`;
  } });
  assert.deepEqual(results, delays.map((_, index) => `result-${index}`));
  assert.ok(maxActive <= 3 && maxActive > 1, `max active ${maxActive}`);
  assert.equal(maxSerial, 1);
  assert.notDeepEqual(finished, delays.map((_, index) => index), "completion order really differed from item order");
});

test("size 1 is strictly serial and in order; a rejection becomes an error record without stopping the others", async () => {
  const order = [];
  const results = await runScheduled([{}, {}, {}], { size: 1, run: async (_item, index) => { order.push(index); if (index === 1) throw new Error("spawn failed"); return index; } });
  assert.deepEqual(order, [0, 1, 2]);
  assert.equal(results[0], 0);
  assert.match(results[1].error.message, /spawn failed/);
  assert.equal(results[2], 2);
  assert.deepEqual(await runScheduled([], { size: 2, run: async () => 1 }), []);
});
