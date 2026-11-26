import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { completeHandoff, handoffProblems, OPERATOR, recordTold, startHandoff, stopWatcher, Via } from './fleet-handoff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_HOME = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fleet-handoff-user-')));
process.on('exit', () => rmSync(TEST_HOME, { recursive: true, force: true }));

// Runs outside any chat with a private HOME, as fleet-home.test.mjs does, so no chat binding reaches the real home.
const run = (args, env = {}) => {
  const base = { ...process.env, HOME: TEST_HOME };
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'FLEET_HOME']) Reflect.deleteProperty(base, name);
  return spawnSync(process.execPath, [path.join(HERE, 'fleet-home.mjs'), ...args], { encoding: 'utf8', env: { ...base, ...env } });
};

function program(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fleet-handoff-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'fleet');
  assert.equal(run(['start', 'iss-1', '--shape', 'fleet', '--home', home]).status, 0);
  const dir = path.join(home, 'programs', 'iss-1');
  writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ writers: {
    'prevent-claude': { runtime: 'claude', status: 'PR #438 open', pr: '#438' },
    cx: { runtime: 'codex', status: 'building' },
    old: { runtime: 'claude', status: 'MERGED #9810; writer stopped', retiredAt: '2026-11-17T00:00:00Z', retiredReason: 'merged' },
    ended: { runtime: 'claude', status: 'MERGED #9811; writer stopped' },
  } }));
  writeFileSync(path.join(dir, 'sessions', 'cx.json'), JSON.stringify({ threadId: 'thread-cx' }));
  return { home, dir };
}

test('ISS-14116 item 42: the handover lists live writers with their addresses, and the check fails until every recipient is recorded', (t) => {
  const { dir } = program(t);
  startHandoff(dir, { successor: 'flamingo-2', mesh: 'claude:abc', peers: ['ox-13467'], notes: '- Ask the operator to merge #438\n' });
  const handover = readFileSync(path.join(dir, 'handover.md'), 'utf8');
  assert.match(handover, /Successor: flamingo-2 \(Mesh claude:abc\)/);
  assert.match(handover, /- prevent-claude \(claude\), address prevent-claude, PR #438/);
  assert.match(handover, /- cx \(codex\), address codex thread thread-cx/);
  assert.doesNotMatch(handover, /- old \(/, 'a retired writer has no session left to tell');
  assert.match(handover, /Ask the operator to merge #438/);
  const missing = (problems) => problems.filter((line) => line.startsWith('NOT-TOLD')).map((line) => line.split(' ')[1].replace(/:$/, ''));
  assert.deepEqual(missing(handoffProblems(dir)), ['prevent-claude', 'cx', 'ended', 'ox-13467', OPERATOR], 'status text alone never retires a writer');
  assert.match(handoffProblems(dir).join('\n'), /NOT-TOLD ended: .*board\.mjs <orchDir> retire ended --reason <why>/);
  const board = JSON.parse(readFileSync(path.join(dir, 'board.json'), 'utf8'));
  board.writers.ended.retiredAt = '2026-11-18T00:00:00Z';
  writeFileSync(path.join(dir, 'board.json'), JSON.stringify(board));
  for (const name of ['prevent-claude', 'cx', 'ox-13467']) recordTold(dir, name, Via.SendMessage);
  assert.deepEqual(missing(handoffProblems(dir)), [OPERATOR], 'one missing recipient still fails');
  recordTold(dir, OPERATOR, Via.Mesh);
  assert.deepEqual(handoffProblems(dir), []);
  assert.throws(() => recordTold(dir, 'cx', 'email'), /--via is sendmessage or mesh/);
});

test('ISS-14116 item 42: a writer added to the board after the handover was written is still a recipient', (t) => {
  const { dir } = program(t);
  startHandoff(dir, { successor: 'flamingo-2', mesh: 'claude:abc' });
  for (const name of ['prevent-claude', 'cx', 'ended', OPERATOR]) recordTold(dir, name, Via.SendMessage);
  assert.deepEqual(handoffProblems(dir), []);
  const board = JSON.parse(readFileSync(path.join(dir, 'board.json'), 'utf8'));
  board.writers['late-writer'] = { runtime: 'claude', status: 'starting' };
  writeFileSync(path.join(dir, 'board.json'), JSON.stringify(board));
  assert.match(handoffProblems(dir).join('\n'), /^NOT-TOLD late-writer:/m);
});

test('ISS-14116 item 42: the watcher is stopped only by the pid both watcher.json and watch.lock record, and a deleted cron is recorded', (t) => {
  const { dir } = program(t);
  writeFileSync(path.join(dir, 'watcher.json'), JSON.stringify({ pid: 4242, identity: 'fixture-birth', startedAt: '2026-11-18T10:00:00Z' }));
  mkdirSync(path.join(dir, 'watch.lock'), { recursive: true });
  writeFileSync(path.join(dir, 'watch.lock', 'pid'), '999\n');
  startHandoff(dir, { successor: 'flamingo-2', mesh: 'claude:abc', crons: ['cron-7'] });
  for (const name of ['prevent-claude', 'cx', 'ended', OPERATOR]) recordTold(dir, name, Via.SendMessage);
  // The lock names another watcher, so this pid holds nothing to stop, and stop-watcher refuses to guess.
  assert.deepEqual(handoffProblems(dir).map((line) => line.split(' ')[0]), ['CRON-LIVE']);
  const killed = [];
  assert.throws(() => stopWatcher(dir, { kill: (pid) => killed.push(pid) }), /WATCHER-MISMATCH/);
  assert.deepEqual(killed, [], 'nothing is stopped by guess');
  writeFileSync(path.join(dir, 'watch.lock', 'pid'), '4242\n');
  assert.deepEqual(handoffProblems(dir).map((line) => line.split(' ')[0]), ['WATCHER-RUNNING', 'CRON-LIVE']);
  assert.throws(() => stopWatcher(dir, { identityOf: () => 'different-birth', kill: (pid) => killed.push(pid) }), /WATCHER-IDENTITY/);
  assert.deepEqual(killed, []);
  assert.equal(stopWatcher(dir, { identityOf: () => 'fixture-birth', kill: (pid) => killed.push(pid) }).line, 'WATCHER-STOPPED 4242');
  assert.deepEqual(killed, [4242]);
  assert.equal(run(['handoff', '--cron-deleted', 'cron-7', '--check'], { FLEET_HOME: path.dirname(path.dirname(dir)) }).status, 0);
  writeFileSync(path.join(dir, 'watcher.json'), JSON.stringify({ pid: 5151, startedAt: new Date(Date.now() + 60_000).toISOString() }));
  assert.deepEqual(handoffProblems(dir), [], "the successor's own watcher is not the outgoing chat's to stop");
});

test('ISS-14116 item 42: resume reads the program handover and says HANDOFF-INCOMPLETE until the check passes; the CLI check exits 1 until then', (t) => {
  const { home, dir } = program(t);
  writeFileSync(path.join(home, 'handover.md'), 'shared, from before per-program handovers\n');
  assert.match(run(['resume'], { FLEET_HOME: home }).stdout, new RegExp(`^READ ${path.join(home, 'handover.md')}$`, 'm'), 'the legacy shared file is read while the program has none');
  const started = run(['handoff', '--successor', 'flamingo-2', '--mesh', 'claude:abc'], { FLEET_HOME: home });
  assert.equal(started.status, 0, started.stderr);
  const resumed = run(['resume'], { FLEET_HOME: home }).stdout;
  assert.match(resumed, new RegExp(`^READ ${path.join(dir, 'handover.md')}$`, 'm'));
  assert.doesNotMatch(resumed, new RegExp(`^READ ${path.join(home, 'handover.md')}$`, 'm'));
  assert.match(resumed, /^HANDOFF-INCOMPLETE: /m);
  assert.equal(run(['handoff', '--check'], { FLEET_HOME: home }).status, 1);
  for (const name of ['prevent-claude', 'cx', 'ended', OPERATOR]) assert.equal(run(['handoff', '--told', name, '--via', 'sendmessage'], { FLEET_HOME: home }).status, 0);
  const done = run(['handoff', '--check'], { FLEET_HOME: home });
  assert.equal(done.status, 0, done.stdout);
  assert.match(done.stdout, /^HANDOFF-COMPLETE$/m);
  assert.doesNotMatch(run(['resume'], { FLEET_HOME: home }).stdout, /HANDOFF-INCOMPLETE/);
});

test('ISS-14116 item 42 (round 13b F1): a new successor starts a fresh handoff, and a completed one stays complete when the successor adds writers', (t) => {
  const { dir } = program(t);
  const all = ['prevent-claude', 'cx', 'ended', OPERATOR];
  startHandoff(dir, { successor: 'chat-b', mesh: 'claude:b' });
  for (const name of all) recordTold(dir, name, Via.SendMessage);
  startHandoff(dir, { successor: 'chat-b', mesh: 'claude:b', notes: 'rewritten' });
  assert.deepEqual(handoffProblems(dir), [], 'a rerun for the same successor keeps its records');
  assert.equal(completeHandoff(dir), true);
  const board = JSON.parse(readFileSync(path.join(dir, 'board.json'), 'utf8'));
  board.writers['chat-b-writer'] = { runtime: 'claude', status: 'starting' };
  writeFileSync(path.join(dir, 'board.json'), JSON.stringify(board));
  assert.deepEqual(handoffProblems(dir), [], "a writer the successor starts after completion is its own");
  startHandoff(dir, { successor: 'chat-c', mesh: 'claude:c' });
  const missing = handoffProblems(dir).filter((line) => line.startsWith('NOT-TOLD')).map((line) => line.split(' ')[1].replace(/:$/, ''));
  assert.deepEqual(missing, [...all.slice(0, 3), 'chat-b-writer', OPERATOR], 'the next handoff tells everyone about the new successor');
});

test('ISS-14116 item 42 (round 14 F1, F3): a watcher that already exited needs no stop, and a completed handoff rerun for the same successor stays complete', (t) => {
  const { dir } = program(t);
  writeFileSync(path.join(dir, 'watcher.json'), JSON.stringify({ pid: 4242, identity: 'fixture-birth', startedAt: '2026-11-18T10:00:00Z', exitedAt: '2026-11-18T11:00:00Z' }));
  startHandoff(dir, { successor: 'chat-b', mesh: 'claude:b' });
  for (const name of ['prevent-claude', 'cx', 'ended', OPERATOR]) recordTold(dir, name, Via.SendMessage);
  assert.deepEqual(handoffProblems(dir), [], 'an exited watcher released its lock and is not WATCHER-RUNNING');
  writeFileSync(path.join(dir, 'watcher.json'), JSON.stringify({ pid: 4242, identity: 'fixture-birth', startedAt: '2026-11-18T10:00:00Z' }));
  assert.deepEqual(handoffProblems(dir), [], 'a recorded pid with no lock is not a running watcher');
  mkdirSync(path.join(dir, 'watch.lock'), { recursive: true });
  writeFileSync(path.join(dir, 'watch.lock', 'pid'), '4242\n');
  assert.match(handoffProblems(dir).join('\n'), /^WATCHER-RUNNING 4242/m, 'a watcher still holding the lock must be stopped');
  rmSync(path.join(dir, 'watch.lock'), { recursive: true, force: true });
  assert.equal(completeHandoff(dir), true);
  const board = JSON.parse(readFileSync(path.join(dir, 'board.json'), 'utf8'));
  board.writers['chat-b-writer'] = { runtime: 'claude', status: 'starting' };
  writeFileSync(path.join(dir, 'board.json'), JSON.stringify(board));
  startHandoff(dir, { successor: 'chat-b', mesh: 'claude:b', notes: '- one more promise' });
  assert.deepEqual(handoffProblems(dir), [], 'a rerun after completion for the same successor does not reopen it');
  assert.match(readFileSync(path.join(dir, 'handover.md'), 'utf8'), /one more promise/);
});

test('ISS-14116 item 42 (round 15 F5): a same-successor rerun keeps the first writtenAt, so the successor\'s watcher is neither reported nor stopped', (t) => {
  const { dir } = program(t);
  startHandoff(dir, { successor: 'chat-b', mesh: 'claude:b', now: new Date('2026-11-18T10:00:00Z') });
  writeFileSync(path.join(dir, 'watcher.json'), JSON.stringify({ pid: 6161, startedAt: '2026-11-18T10:05:00Z' }));
  mkdirSync(path.join(dir, 'watch.lock'), { recursive: true });
  writeFileSync(path.join(dir, 'watch.lock', 'pid'), '6161\n');
  startHandoff(dir, { successor: 'chat-b', mesh: 'claude:b', now: new Date('2026-11-18T10:10:00Z') });
  assert.doesNotMatch(handoffProblems(dir).join('\n'), /WATCHER-RUNNING/);
  const killed = [];
  assert.throws(() => stopWatcher(dir, { kill: (pid) => killed.push(pid) }), /WATCHER-SUCCESSOR/);
  assert.deepEqual(killed, [], "the successor's watcher is never signalled");
});

test("a legacy watcher requires its exact script, program and recorded birth", t => {
  const {dir} = program(t), pid = 4242, startedAt = new Date(2026,10,18,10).toISOString();
  writeFileSync(path.join(dir, "watcher.json"), JSON.stringify({pid,startedAt}));
  mkdirSync(path.join(dir, "watch.lock"), {recursive:true});
  writeFileSync(path.join(dir, "watch.lock","pid"), String(pid));
  startHandoff(dir, {successor:"next",mesh:"codex:next",crons:[]});
  const script = fileURLToPath(new URL("../../../skills/codex-fleet-monitor/scripts/watch.sh", import.meta.url));
  const identity = `Wed Nov 18 10:00:00 2026 zsh ${script} ${dir} 120`;
  const killed=[];
  for (const wrong of [identity.replace("10:00","10:10"), identity.replace("watch.sh","other.sh"), identity+"-other", identity.replace(dir, dir+"-other")]) {
    assert.throws(() => stopWatcher(dir, {kill:id=>killed.push(id), identityOf:()=>wrong}), /WATCHER-IDENTITY/);
  }
  assert.deepEqual(killed,[]);
  assert.ok(stopWatcher(dir, {kill:id=>killed.push(id),identityOf:()=>identity}).stopped);
  assert.deepEqual(killed,[pid]);
});

test("an initializing watcher lock blocks closure before its matching heartbeat", t => {
  const {dir}=program(t);
  startHandoff(dir,{successor:"next",mesh:"codex:next",crons:[]});
  mkdirSync(path.join(dir,"watch.lock"));
  writeFileSync(path.join(dir,"watch.lock","pid"),String(process.pid));
  for (const previous of [null,{pid:4242,exitedAt:new Date().toISOString()}]) {
    if (previous) writeFileSync(path.join(dir,"watcher.json"),JSON.stringify(previous));
    assert.throws(()=>stopWatcher(dir,{kill:()=>assert.fail("initializing watcher signalled")}),/WATCHER-/);
  }
});
