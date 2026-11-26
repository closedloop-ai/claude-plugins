import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LoadBasis, loadedSkillEvidence } from '../../vibe/scripts/loaded-skill.mjs';
import { finalMarker } from './helpers.mjs';
import { reviewBrief } from '../../handoff/scripts/review-context-test-support.mjs';
import { vibeRoot } from '../../../shared/vibe-install.mjs';

// ISS-14552 receipt hardening moved to ISS-14476 (AC-88): direct helper transitions through the real helper CLI.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = (args) => spawnSync(process.execPath, [path.join(HERE, 'helpers.mjs'), ...args], { encoding: 'utf8' });
const ledger = (dir) => JSON.parse(readFileSync(path.join(dir, 'helpers.json'), 'utf8'));

/** A registered review helper in a fresh program, with its brief, worktree, definition and capabilities. */
function registered(t, { name = 'reviewer', kind = 'reviewer', role = kind, runtime = 'claude', workerId = 'native-reviewer-1' } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-receipts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const load = loadedSkillEvidence('test', 'claude', vibeRoot(), 'fleet-orchestrator', LoadBasis.HookObserved);
  writeFileSync(path.join(dir, 'plugin-version.json'), JSON.stringify({ status: 'current', runtime: 'claude', checkedAt: 'now', loadedSkill: load, harnesses: [] }));
  const worktree = path.join(dir, 'source');
  mkdirSync(worktree);
  execFileSync('git', ['init', '-q', '-b', 'review', worktree]);
  writeFileSync(path.join(worktree, 'app.txt'), 'source\n');
  execFileSync('git', ['-C', worktree, 'add', '.']);
  execFileSync('git', ['-C', worktree, '-c', 'user.email=fixture.invalid', '-c', 'user.name=Test', 'commit', '-qm', 'base']);
  const file = (base, text) => { const target = path.join(dir, base); writeFileSync(target, text); return target; };
  const started = run([dir, 'start', name, '--kind', kind, '--runtime', runtime, '--brief', file('brief.md', reviewBrief(dir, 'Review the current diff.')), '--worktree', worktree,
    '--worker-id', workerId, '--role', role, '--agent-definition', file('definition.md', `---\nname: ${role}\n---\n`), '--capabilities', file('capabilities.json', '[]\n')]);
  assert.equal(started.status, 0, started.stderr);
  const helper = ledger(dir)[name];
  const completionEvent = (sessionId, turnId = 'turn-1') => file(`thread-${sessionId}.json`,
    JSON.stringify({ thread: { id: sessionId, turns: [] } }) + '\n' + JSON.stringify({ thread: { id: sessionId, turns: [{ id: turnId, status: 'completed' }] } }));
  const final = (body, { sessionId = 'session-1', turnId = 'turn-1', event = null, out = 'final.json' } = {}) => {
    const deliverable = file('deliverable.md', body);
    return { out: path.join(dir, out), result: run([dir, 'final', name, '--deliverable', deliverable, '--session-id', sessionId, '--turn-id', turnId,
      ...(event ? ['--completion-event', event] : []), '--out', path.join(dir, out)]) };
  };
  return { dir, name, helper, final, completionEvent, file, marker: (completion = { sessionId: 'session-1', turnId: 'turn-1' }) => finalMarker(helper, completion) };
}

test('AC-88 R33 a direct helper finalizes only on an exact last FINAL marker line', (t) => {
  for (const body of [(m) => `findings\n${m} extra\n`, (m) => `findings\nnote ${m}\n`, (m) => `findings\n${m}  \n`, (m) => `findings\n${m}\nmore\n`]) {
    const h = registered(t);
    const { result } = h.final(body(h.marker()));
    assert.notEqual(result.status, 0, 'an inexact marker line never finalizes');
    assert.match(result.stderr, /exact FINAL marker/);
  }
  const crlf = registered(t);
  assert.equal(crlf.final(`findings\r\n${crlf.marker()}\r\n`).result.status, 0, 'a CRLF marker line is the same exact line');
});

test('AC-88 R34 abandonment is terminal: an abandoned helper never finalizes or accepts, and a real acceptance keeps its time', (t) => {
  const early = registered(t);
  assert.equal(run([early.dir, 'abandoned', early.name, '--reason', 'operator changed the review model']).status, 0);
  assert.notEqual(early.final(`findings\n${early.marker()}\n`).result.status, 0, 'an abandoned helper cannot finalize');

  const late = registered(t);
  const finalized = late.final(`findings\n${late.marker()}\n`);
  assert.equal(finalized.result.status, 0, finalized.result.stderr);
  assert.equal(run([late.dir, 'abandoned', late.name, '--reason', 'superseded']).status, 0);
  assert.notEqual(run([late.dir, 'accepted', late.name, '--report', finalized.out]).status, 0, 'a finalized but abandoned helper cannot be accepted');

  const kept = registered(t);
  const report = kept.final(`findings\n${kept.marker()}\n`).out;
  assert.equal(run([kept.dir, 'accepted', kept.name, '--report', report]).status, 0);
  const acceptedAt = ledger(kept.dir)[kept.name].acceptedAt;
  assert.equal(run([kept.dir, 'stopped', kept.name]).status, 0);
  assert.equal(run([kept.dir, 'accepted', kept.name, '--report', report]).status, 0, 'an unchanged accepted report can be retried after stop');
  assert.equal(ledger(kept.dir)[kept.name].acceptedAt, acceptedAt, 'the retry keeps the original acceptance time');
});

test('AC-88 R27 a Codex helper finalizes only with a completed turn from its own registered thread', (t) => {
  const foreign = registered(t, { name: 'codex-reviewer', runtime: 'codex', workerId: 'codex-thread-1' });
  const other = { sessionId: 'codex-thread-2', turnId: 'turn-1' };
  const refused = foreign.final(`findings\n${foreign.marker(other)}\n`, { sessionId: other.sessionId, event: foreign.completionEvent(other.sessionId) });
  assert.notEqual(refused.result.status, 0, 'a completed turn of another thread is refused');

  const own = registered(t, { name: 'codex-reviewer', runtime: 'codex', workerId: 'codex-thread-1' });
  const mine = { sessionId: 'codex-thread-1', turnId: 'turn-1' };
  const accepted = own.final(`findings\n${own.marker(mine)}\n`, { sessionId: mine.sessionId, event: own.completionEvent(mine.sessionId) });
  assert.equal(accepted.result.status, 0, accepted.result.stderr);
  assert.equal(run([own.dir, 'accepted', own.name, '--report', accepted.out]).status, 0, 'the registered thread finalizes and is accepted');
});

test('AC-88 a visual critic report whose findings file is replaced after finalization is never accepted', (t) => {
  const critic = registered(t, { name: 'critic', kind: 'critic', role: 'visual-qa-critic' });
  const findings = critic.file('findings.json', JSON.stringify({ head: 'a'.repeat(40), findings: [] }));
  const finalized = critic.final(`${findings}\n${critic.marker()}\n`);
  assert.equal(finalized.result.status, 0, finalized.result.stderr);
  writeFileSync(findings, JSON.stringify({ head: 'a'.repeat(40), findings: [{ id: 'F1' }] }));
  const refused = run([critic.dir, 'accepted', critic.name, '--report', finalized.out]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /visual critic findings changed since finalization/);
});

test('AC-88 a completion page changed after finalization is never accepted, so the page read is the page fingerprinted', (t) => {
  const reviewer = registered(t);
  const event = reviewer.completionEvent('session-1');
  const finalized = reviewer.final(`findings\n${reviewer.marker()}\n`, { event });
  assert.equal(finalized.result.status, 0, finalized.result.stderr);
  writeFileSync(event, JSON.stringify({ thread: { id: 'session-1', turns: [{ id: 'turn-1', status: 'completed' }] } }) + '\n');
  assert.notEqual(run([reviewer.dir, 'accepted', reviewer.name, '--report', finalized.out]).status, 0);
});
