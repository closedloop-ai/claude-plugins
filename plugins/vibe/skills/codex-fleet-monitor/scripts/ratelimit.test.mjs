import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readUsage, usageLine, usageState } from './ratelimit.mjs';

const reached = (extra = {}, credits = { hasCredits: false }) => ({
  rateLimits: { primary: { usedPercent: 100 }, rateLimitReachedType: 'primary', credits },
  ...extra,
});

test('usageState maps a reached limit by ordinary usage and paid credits', () => {
  assert.equal(usageState({ rateLimits: { primary: { usedPercent: 40 }, rateLimitReachedType: null } }), 'ok');
  assert.equal(usageState(reached({ ordinaryUsageAllowed: true }, { hasCredits: true })), 'LIMIT');
  assert.equal(usageState(reached({ ordinaryUsageAllowed: false }, { hasCredits: true })), 'LIMIT-SPENDING-CREDITS');
  assert.equal(usageState(reached({ ordinaryUsageAllowed: null }, { hasCredits: true })), 'LIMIT-SPENDING-CREDITS');
  assert.equal(usageState(reached({ ordinaryUsageAllowed: false }, { hasCredits: false })), 'LIMIT-STOPPED');
  assert.equal(usageState(reached({ ordinaryUsageAllowed: false }, null)), 'LIMIT-STOPPED');
});

test('usageLine floors the used percent to a band of 10 and reports resets', () => {
  const ok = (usedPercent, extra = {}) => ({ rateLimits: { primary: { usedPercent } }, ...extra });
  assert.equal(usageLine('local', ok(0)), 'codex-usage local 0% ok resets=0');
  assert.equal(usageLine('local', ok(59.9)), 'codex-usage local 50% ok resets=0');
  assert.equal(usageLine('remote', ok(60, { rateLimitResetCredits: { availableCount: 2 } })), 'codex-usage remote 60% ok resets=2');
  assert.equal(usageLine('local', reached({ ordinaryUsageAllowed: false }, { hasCredits: true })), 'codex-usage local 100% LIMIT-SPENDING-CREDITS resets=0');
  assert.equal(usageLine('local', { rateLimits: {} }), 'codex-usage local ?% ok resets=0');
});

test('readUsage calls account/rateLimits/read and reports READFAIL when it fails', async () => {
  const calls = [];
  const client = (result) => ({
    request: async (method, params) => {
      calls.push({ method, params });
      if (result instanceof Error) throw result;
      return result;
    },
  });
  assert.equal(await readUsage(client({ rateLimits: { primary: { usedPercent: 73 } } }), 'local'), 'codex-usage local 70% ok resets=0');
  assert.deepEqual(calls[0], { method: 'account/rateLimits/read', params: {} });
  assert.equal(await readUsage(client(new Error('timed out')), 'remote'), 'codex-usage remote unreadable READFAIL');
});
