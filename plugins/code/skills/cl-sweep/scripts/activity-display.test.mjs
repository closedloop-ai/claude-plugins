import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRunActivity } from './app-server-worker-session.mjs';
import { callbackDisplayDetail, normalizeDisplayEvent } from './display-event.mjs';

test('new worker turns require a specific activity', () => {
  assert.throws(() => normalizeRunActivity({}), /activity-phase/);
  assert.deepEqual(normalizeRunActivity({ 'activity-phase': 'planning' }), { phase: 'planning' });
  assert.throws(
    () => normalizeRunActivity({ 'activity-phase': 'reviewing' }),
    /review-kind/,
  );
  assert.deepEqual(
    normalizeRunActivity({ 'activity-phase': 'reviewing', 'review-kind': 'code' }),
    { phase: 'reviewing', reviewKind: 'code' },
  );
});

test('display events retain review and wait specificity', () => {
  const base = { sweepId: 'sweep-1', workerId: 'worker-1', ownerGeneration: 1, kind: 'phase' };
  assert.equal(normalizeDisplayEvent({ ...base, phase: 'reviewing', reviewKind: 'plan' }).reviewKind, 'plan');
  assert.throws(() => normalizeDisplayEvent({ ...base, phase: 'reviewing' }), /reviewKind/);
  assert.equal(normalizeDisplayEvent({ ...base, phase: 'waiting', waitKind: 'dependency' }).waitKind, 'dependency');
  assert.equal(
    normalizeDisplayEvent({ ...base, phase: 'waiting_for_human', waitKind: 'ui_plan_approval' }).waitKind,
    'plan_review',
  );
  assert.equal(
    normalizeDisplayEvent({ ...base, phase: 'waiting_for_human', waitKind: 'manual_qa' }).waitKind,
    'manual_qa',
  );
});

test('structured callbacks preserve plan and automatic wait reasons', () => {
  assert.deepEqual(
    callbackDisplayDetail({ kind: 'WAITING_HUMAN', status: 'WAITING_UI_PLAN_APPROVAL', payload: { summary: { wait_kind: 'combined_atomic_shape_and_ui_plan_approval' } } }),
    { kind: 'phase', phase: 'waiting_for_human', waitKind: 'plan_review' },
  );
  assert.deepEqual(
    callbackDisplayDetail({ kind: 'PR_MONITORING_HANDOFF' }),
    { kind: 'phase', phase: 'waiting', waitKind: 'monitoring' },
  );
  assert.deepEqual(
    callbackDisplayDetail({ kind: 'WAITING_HUMAN', status: 'WAITING_MANUAL_QA', payload: { summary: { wait_kind: 'manual_qa' } } }),
    { kind: 'phase', phase: 'waiting_for_human', waitKind: 'manual_qa' },
  );
});
