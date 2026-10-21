import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyUsage, highUsagePercent, UsageState, usageLine } from './ratelimit.mjs';

const reached = (extra = {}, credits = { hasCredits: false }) => ({
  rateLimits: { primary: { usedPercent: 100 }, rateLimitReachedType: 'rate_limit_reached', credits },
  ...extra,
});

test('classifyUsage maps every reached-limit combination to one state', () => {
  const table = [
    [{ rateLimits: { primary: { usedPercent: 40 }, rateLimitReachedType: null } }, UsageState.Ok],
    [{ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 99 } } }, UsageState.Ok],
    [reached({ ordinaryUsageAllowed: true }, { hasCredits: true }), UsageState.Limit],
    [reached({ ordinaryUsageAllowed: true }, { hasCredits: false }), UsageState.Limit],
    [reached({ ordinaryUsageAllowed: false }, { hasCredits: true }), UsageState.SpendingCredits],
    [reached({ ordinaryUsageAllowed: null }, { hasCredits: true }), UsageState.SpendingCredits],
    [reached({}, { hasCredits: true }), UsageState.SpendingCredits],
    [reached({ ordinaryUsageAllowed: false }, { hasCredits: false }), UsageState.Stopped],
    [reached({ ordinaryUsageAllowed: false }, null), UsageState.Stopped],
    [{ rateLimits: { rateLimitReachedType: 'workspace_owner_credits_depleted', primary: null } }, UsageState.Stopped],
    [{}, UsageState.Unknown],
    [{ rateLimits: null }, UsageState.Unknown],
    [undefined, UsageState.Unknown],
  ];
  for (const [response, state] of table) assert.equal(classifyUsage(response), state, JSON.stringify(response));
});

test('usageLine prints one band under 80 percent and the floored percent from 80 up', () => {
  const ok = (usedPercent, extra = {}) => ({ rateLimits: { primary: { usedPercent } }, ...extra });
  assert.equal(usageLine('local', ok(0)), 'codex-usage local under80% ok resets=0');
  assert.equal(usageLine('local', ok(59.9)), 'codex-usage local under80% ok resets=0');
  assert.equal(usageLine('local', ok(79.9)), 'codex-usage local under80% ok resets=0');
  assert.equal(usageLine('remote', ok(80, { rateLimitResetCredits: { availableCount: 2 } })), 'codex-usage remote HIGH(80%) ok resets=2');
  assert.equal(usageLine('local', ok(95)), 'codex-usage local HIGH(90%) ok resets=0');
  assert.equal(usageLine('local', reached({ ordinaryUsageAllowed: false }, { hasCredits: true })), 'codex-usage local HIGH(100%) LIMIT-SPENDING-CREDITS resets=0');
  assert.equal(usageLine('local', { rateLimits: {} }), 'codex-usage local ?% ok resets=0');
  assert.equal(usageLine('local', {}), 'codex-usage local ?% unknown resets=0');
});

test('usage moving within the low band is not a change, so it never wakes the watcher', () => {
  const line = (usedPercent) => usageLine('local', { rateLimits: { primary: { usedPercent } } });
  assert.equal(line(10), line(70));
  assert.notEqual(line(70), line(80));
  assert.notEqual(line(80), line(90));
});

test('the high band starts at USAGE_HIGH_PERCENT when it is set', () => {
  assert.equal(highUsagePercent({}), 80);
  assert.equal(highUsagePercent({ USAGE_HIGH_PERCENT: '' }), 80);
  assert.equal(highUsagePercent({ USAGE_HIGH_PERCENT: 'x' }), 80);
  assert.equal(highUsagePercent({ USAGE_HIGH_PERCENT: '60' }), 60);
  const response = { rateLimits: { primary: { usedPercent: 65 } } };
  assert.equal(usageLine('local', response, 60), 'codex-usage local HIGH(60%) ok resets=0');
  assert.equal(usageLine('local', response), 'codex-usage local under80% ok resets=0');
});
