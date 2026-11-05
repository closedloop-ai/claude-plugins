import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chooseReviewChain, ReviewChain } from './review-chain.mjs';

const SCRIPT = fileURLToPath(new URL('./review-chain.mjs', import.meta.url));
const HEAD = 'a'.repeat(40);

test('the default keeps the orchestrator chain whatever the handoff reported', () => {
  const decision = chooseReviewChain({ enabled: false, prHead: HEAD, handoffReviewedHead: HEAD });
  assert.equal(decision.mode, ReviewChain.Full);
});

test('enabled, only a handoff review of this exact head replaces the chain', () => {
  const run = (prHead, handoffReviewedHead) => chooseReviewChain({ enabled: true, prHead, handoffReviewedHead }).mode;
  assert.equal(run(HEAD, HEAD), ReviewChain.VerifyFixesOnly);
  assert.equal(run(HEAD, HEAD.slice(0, 12).toUpperCase()), ReviewChain.VerifyFixesOnly, 'an abbreviated SHA of the same commit');
  assert.equal(run(HEAD, 'b'.repeat(40)), ReviewChain.Full, 'the head moved after the handoff review');
  assert.equal(run(HEAD, undefined), ReviewChain.Full);
  assert.equal(run(HEAD, 'not-a-sha'), ReviewChain.Full);
  assert.equal(run('main', HEAD), ReviewChain.Full);
  assert.equal(run(undefined, HEAD), ReviewChain.Full);
});

test('the CLI honours the environment switch and refuses a missing head', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, FLEET_REVIEW_HANDOFF_ONLY: '', ...env } });
  const off = run(['--pr-head', HEAD, '--handoff-reviewed-head', HEAD]);
  assert.equal(JSON.parse(off.stdout).mode, ReviewChain.Full);
  const on = run(['--pr-head', HEAD, '--handoff-reviewed-head', HEAD], { FLEET_REVIEW_HANDOFF_ONLY: '1' });
  assert.equal(JSON.parse(on.stdout).mode, ReviewChain.VerifyFixesOnly);
  assert.equal(JSON.parse(on.stdout).schema, 'vibe.fleet-review-chain/1');
  assert.equal(run([]).status, 2);
});
