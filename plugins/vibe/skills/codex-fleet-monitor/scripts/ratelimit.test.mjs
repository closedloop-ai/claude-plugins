import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyUsage, UsageState, usageLine } from './ratelimit.mjs';

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

test('usageLine floors the used percent to a band of 10 and reports resets', () => {
  const ok = (usedPercent, extra = {}) => ({ rateLimits: { primary: { usedPercent } }, ...extra });
  assert.equal(usageLine('local', ok(0)), 'codex-usage local 0% ok resets=0');
  assert.equal(usageLine('local', ok(59.9)), 'codex-usage local 50% ok resets=0');
  assert.equal(usageLine('remote', ok(60, { rateLimitResetCredits: { availableCount: 2 } })), 'codex-usage remote 60% ok resets=2');
  assert.equal(usageLine('local', reached({ ordinaryUsageAllowed: false }, { hasCredits: true })), 'codex-usage local 100% LIMIT-SPENDING-CREDITS resets=0');
  assert.equal(usageLine('local', { rateLimits: {} }), 'codex-usage local ?% ok resets=0');
  assert.equal(usageLine('local', {}), 'codex-usage local ?% unknown resets=0');
});
