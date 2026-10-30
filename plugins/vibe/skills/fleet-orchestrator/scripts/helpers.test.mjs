import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { historyOrigin } from './history-origin.mjs';
import { removeOwnedDockerResources } from '../../vibe/scripts/e2e-lock.mjs';
import { sourceIdentity } from '../../vibe/scripts/tested-head.mjs';
import { evidenceFingerprint } from '../../handoff/scripts/handoff-evidence.mjs';
import { loadedSkillEvidence } from '../../vibe/scripts/loaded-skill.mjs';
import { endProcesses, finalMarker, isAlive, orphans, parsePids, pendingE2eCleanups, readIdentity, reconcileTerminalHelpers, stopCandidates } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..');
const actorLoad = (actor = 'test') => loadedSkillEvidence(actor, 'claude', PLUGIN_ROOT, 'fleet-orchestrator');
const run = (args) => {
  const [dir, action] = args;
  const isolated = action === 'status' && !args.includes('--e2e-lock-dir')
    ? [...args, '--e2e-lock-dir', path.join(dir, 'test-e2e-stack')] : args;
  return spawnSync(process.execPath, [path.join(HERE, 'helpers.mjs'), ...isolated], { encoding: 'utf8' });
};
const tempDir = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-helpers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'plugin-version.json'), JSON.stringify({ status: 'current', runtime: 'claude', checkedAt: 'now', loadedSkill: actorLoad(), harnesses: [] }));
  return dir;
};
/** A pid this test started; anything else (empty output parses as 0) fails the test before any signal. */
const ownedPid = (text) => {
  const pid = Number(String(text).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid, `not a pid this test started: ${text}`);
  return pid;
};
/** Signals one owned pid, never its group. */
const killOwned = (pid) => {
  if (!(pid > 1) || pid === process.pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
};
/**
 * A background process the test owns, started through a shell that exits at
 * once, so its parent is not this test (a dead direct child would stay a
 * zombie while spawnSync blocks the loop). Killed in t.after if left running.
 */
const child = (t, command, args) => {
  const quoted = [command, ...args].map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(' ');
  const pid = ownedPid(spawnSync('sh', ['-c', `${quoted} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).stdout);
  t.after(() => killOwned(pid));
  return pid;
};
/**
 * A detached shell that leads its own process group and waits on a `sleep`
 * in that group, started through a node process that exits at once.
 */
const groupLeader = async (t, dir) => {
  const memberFile = path.join(dir, 'member.pid');
  const script = `const c = require('node:child_process').spawn('sh', ['-c', 'sleep 60 & echo $! > "$0"; wait', ${JSON.stringify(memberFile)}], { detached: true, stdio: 'ignore' }); c.unref(); process.stdout.write(String(c.pid));`;
  const leader = ownedPid(spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' }).stdout);
  t.after(() => killOwned(leader));
  for (let i = 0; i < 100 && !existsSync(memberFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const member = ownedPid(readFileSync(memberFile, 'utf8'));
  t.after(() => killOwned(member));
  return { leader, member };
};
/**
 * A fake process table for endProcesses, so its decisions are checked without
 * one real signal. Pids sit above every real pid_max, in case one leaks.
 */
const fakeTable = (processes) => {
  const table = new Map(processes.map((entry) => [entry.pid, { identity: `id-${entry.pid}`, ...entry }]));
  const calls = [];
  const fail = (code) => Object.assign(new Error(code), { code });
  const kill = (target, signal) => {
    calls.push([target, signal]);
    if (target < 0) {
      const members = [...table.values()].filter((entry) => entry.pgid === -target && entry.state === 'alive');
      if (members.length === 0) throw fail('ESRCH');
      for (const entry of members) entry.state = 'gone';
      return;
    }
    const entry = table.get(target);
    if (!entry || entry.state === 'gone') throw fail('ESRCH');
    if (entry.state === 'foreign') throw fail('EPERM');
    if (signal === 'SIGTERM' && entry.reusedOnTerm) {
      // The process exits on SIGTERM and the system hands its pid to another of the user's apps.
      entry.identity = entry.reusedOnTerm;
      return;
    }
    if (signal !== 0) entry.state = 'gone';
  };
  const groupOf = (pid) => table.get(pid)?.pgid ?? null;
  const identityOf = (pid) => {
    const entry = table.get(pid);
    return entry && entry.state !== 'gone' ? entry.identity : null;
  };
  const sent = () => calls.filter(([, signal]) => signal !== 0);
  const state = (pid) => table.get(pid)?.state;
  return { kill, groupOf, identityOf, calls, sent, state };
};
/** A target as `stopped` builds it from the ledger, with the identity recorded at `pid` time. */
const recorded = (pid, group, identity = `id-${pid}`) => ({ pid, group, identity });
const FAKE = 2_147_480_000;

test('idle notice cannot accept or stop a reviewer without its source-bound FINAL deliverable', (t) => {
  const dir = tempDir(t);
  const help = run([dir]);
  assert.equal(help.status, 2);
  assert.match(help.stderr, /--kind reviewer\|verifier\|critic.*--agent-definition.*--capabilities/);
  const worktree = path.join(dir, 'source');
  mkdirSync(worktree);
  execFileSync('git', ['init', '-q', '-b', 'review', worktree]);
  writeFileSync(path.join(worktree, 'app.txt'), 'source\n');
  execFileSync('git', ['-C', worktree, 'add', '.']);
  execFileSync('git', ['-C', worktree, '-c', 'user.email=fixture.invalid', '-c', 'user.name=Test', 'commit', '-qm', 'base']);
  const capabilities = path.join(dir, 'capabilities.json');
  writeFileSync(capabilities, '[]\n');
  const definition = path.join(dir, 'reviewer.md');
  writeFileSync(definition, '---\nname: reviewer\n---\n');
  const brief = path.join(dir, 'review.md');
  writeFileSync(brief, 'Review the current diff.\n');
  assert.notEqual(run([dir, 'start', 'missing', '--kind', 'reviewer', '--worktree', worktree]).status, 0, 'reviewer needs a brief');
  writeFileSync(brief, 'Run handoff/scripts/qa-merge-order.mjs.\n');
  assert.notEqual(run([dir, 'start', 'missing-script', '--kind', 'reviewer', '--brief', brief, '--worktree', worktree,
    '--worker-id', 'native-reviewer-missing', '--role', 'reviewer', '--agent-definition', definition, '--capabilities', capabilities]).status, 0,
  'Claude helper launch refuses a deleted installed plugin script');
  writeFileSync(brief, 'Review the current diff.\n');
  assert.equal(run([dir, 'start', 'reviewer', '--kind', 'reviewer', '--brief', brief, '--worktree', worktree,
    '--worker-id', 'native-reviewer-1', '--role', 'reviewer', '--agent-definition', definition, '--capabilities', capabilities]).status, 0);
  assert.notEqual(run([dir, 'accepted', 'reviewer']).status, 0, 'idle is not a final report');
  assert.notEqual(run([dir, 'stopped', 'reviewer']).status, 0, 'a working reviewer cannot be stopped');
  const helper = JSON.parse(readFileSync(path.join(dir, 'helpers.json'), 'utf8')).reviewer;
  const token = helper.finalToken;
  const deliverable = path.join(dir, 'review-final.md');
  writeFileSync(deliverable, 'verified findings\n');
  const report = path.join(dir, 'review-report.json');
  const final = { helper: 'reviewer', token, status: 'FINAL', workerId: 'native-reviewer-1', source: sourceIdentity(worktree),
    completion: { sessionId: 'session-1', turnId: 'turn-1' }, deliverable: evidenceFingerprint(deliverable) };
  writeFileSync(report, JSON.stringify(final));
  assert.notEqual(run([dir, 'accepted', 'reviewer', '--report', report]).status, 0, 'hand-written FINAL wrapper around partial work is refused');
  writeFileSync(report, JSON.stringify({ ...final, status: 'IDLE' }));
  assert.notEqual(run([dir, 'accepted', 'reviewer', '--report', report]).status, 0, 'turn end is not final');
  const finalReport = path.join(dir, 'helper-produced-final.json');
  assert.notEqual(run([dir, 'final', 'reviewer', '--deliverable', deliverable, '--session-id', 'session-1', '--turn-id', 'turn-1', '--out', finalReport]).status, 0, 'partial deliverable has no FINAL marker');
  writeFileSync(deliverable, `verified findings\n${finalMarker(helper, final.completion)}\n`);
  final.deliverable = evidenceFingerprint(deliverable);
  assert.notEqual(run([dir, 'final', 'reviewer', '--deliverable', deliverable, '--session-id', 'invented', '--turn-id', 'turn-1', '--out', finalReport]).status, 0, 'invented completion identity cannot match helper marker');
  writeFileSync(path.join(worktree, 'app.txt'), 'changed source\n');
  assert.notEqual(run([dir, 'final', 'reviewer', '--deliverable', deliverable, '--session-id', 'session-1', '--turn-id', 'turn-1', '--out', finalReport]).status, 0, 'changed start source blocks completion');
  writeFileSync(path.join(worktree, 'app.txt'), 'source\n');
  const completionEvent = path.join(dir, 'thread-read.json');
  const event = (status) => ({ thread: { id: 'session-1', turns: [{ id: 'turn-1', status }] } });
  writeFileSync(completionEvent, JSON.stringify(event('inProgress')));
  assert.notEqual(run([dir, 'final', 'reviewer', '--deliverable', deliverable, '--session-id', 'session-1', '--turn-id', 'turn-1', '--completion-event', completionEvent, '--out', finalReport]).status, 0, 'runtime still working cannot finalize');
  writeFileSync(completionEvent, JSON.stringify(event('completed')));
  final.completionEvidence = evidenceFingerprint(completionEvent);
  assert.equal(run([dir, 'final', 'reviewer', '--deliverable', deliverable, '--session-id', 'session-1', '--turn-id', 'turn-1', '--completion-event', completionEvent, '--out', finalReport]).status, 0);
  assert.notEqual(run([dir, 'final', 'reviewer', '--deliverable', deliverable, '--session-id', 'session-1', '--turn-id', 'turn-1', '--out', path.join(dir, 'second-final.json')]).status, 0, 'the FINAL token is consumed once');
  assert.deepEqual(JSON.parse(readFileSync(finalReport, 'utf8')), final);
  assert.equal(run([dir, 'accepted', 'reviewer', '--report', finalReport]).status, 0);
  writeFileSync(definition, '---\nname: reviewer\n---\nchanged definition\n');
  assert.notEqual(run([dir, 'stopped', 'reviewer']).status, 0, 'changed canonical role definition invalidates final proof');
  writeFileSync(definition, '---\nname: reviewer\n---\n');
  writeFileSync(deliverable, 'changed after acceptance\n');
  assert.notEqual(run([dir, 'stopped', 'reviewer']).status, 0, 'stale final report cannot justify stop');
  writeFileSync(deliverable, `verified findings\n${finalMarker(helper, final.completion)}\n`);
  writeFileSync(completionEvent, JSON.stringify(event('inProgress')));
  assert.notEqual(run([dir, 'stopped', 'reviewer']).status, 0, 'runtime completion evidence is rechecked');
  writeFileSync(completionEvent, JSON.stringify(event('completed')));
  assert.equal(run([dir, 'stopped', 'reviewer']).status, 0);
});

test('a terminal PR reconciles only its recorded helper and reports a refused cleanup with owner and ticket', async () => {
  const record = { owner: 'writer-a', ticket: 'ticket-one', repo: 'acme/repo', pr: '42', ending: 'pr-terminal',
    startedAt: '2026-10-29T00:00:00Z', pids: [FAKE + 101], identities: { [FAKE + 101]: 'started-a' },
    dockerResources: { project: 'qa-owned', containers: [], volumes: [], networks: [] } };
  const other = { owner: 'writer-b', ticket: 'ISS-OTHER', repo: 'acme/repo', pr: '43', ending: 'pr-terminal',
    startedAt: '2026-10-29T00:00:00Z', pids: [FAKE + 102], identities: { [FAKE + 102]: 'started-b' } };
  const ledger = { 'qa-a': record, 'qa-b': other };
  const ended = [];
  const cleaned = [];
  const result = await reconcileTerminalHelpers(ledger, {
    prState: async (_repo, pr) => pr === '42' ? 'terminal' : 'open',
    end: async (targets) => { ended.push(targets); return []; },
    cleanup: (resources) => { cleaned.push(resources.project); },
    alive: () => false,
  });
  assert.equal(result.findings.length, 0);
  assert.equal(result.changed, true);
  assert.match(record.stoppedAt, /^\d{4}-/);
  assert.equal(other.stoppedAt, undefined);
  assert.deepEqual(ended.map((targets) => targets[0].pid), [FAKE + 101]);
  assert.deepEqual(cleaned, ['qa-owned']);
  record.stoppedAt = undefined;
  const refused = await reconcileTerminalHelpers(ledger, {
    prState: async () => 'terminal', end: async () => [], alive: () => false,
    cleanup: () => { throw new Error('Docker witness changed'); },
  });
  assert.match(refused.findings[0], /LEFTOVER qa-a owner writer-a ticket ticket-one: Docker witness changed/);
  assert.equal(record.stoppedAt, undefined);
});

test('an unverified or still live process is never marked stopped after PR closure', async () => {
  const ledger = { qa: { owner: 'writer-a', ticket: 'ticket-one', repo: 'acme/repo', pr: '42', ending: 'pr-terminal',
    pids: [FAKE + 103], identities: {} } };
  let signals = 0;
  const result = await reconcileTerminalHelpers(ledger, { prState: async () => 'terminal',
    end: async () => { signals += 1; return []; }, alive: () => true });
  assert.equal(signals, 1);
  assert.match(result.findings[0], /LEFTOVER qa owner writer-a ticket ticket-one/);
  assert.equal(ledger.qa.stoppedAt, undefined);
});

test('a reused live PID is foreign and does not block owned Docker reconciliation', async () => {
  const pid = FAKE + 104;
  const ledger = { qa: { owner: 'writer-a', ticket: 'ticket-one', repo: 'acme/repo', pr: '42', ending: 'pr-terminal',
    pids: [pid], identities: { [pid]: 'old process birth' },
    dockerResources: { project: 'qa-owned', containers: [], volumes: [], networks: [] } } };
  let cleaned = 0;
  const result = await reconcileTerminalHelpers(ledger, { prState: async () => 'terminal',
    end: async () => [], alive: () => true, identityOf: () => 'new foreign process birth',
    cleanup: () => { cleaned += 1; } });
  assert.deepEqual(result.findings, []);
  assert.equal(cleaned, 1);
  assert.ok(ledger.qa.stoppedAt);
  assert.deepEqual(orphans({ qa: { stoppedAt: 'now', pids: [pid], identities: { [pid]: 'old process birth' } } },
    () => true, () => 'new foreign process birth'), []);
});

test('a Docker inspect read error reports a leftover and keeps the terminal helper active', async () => {
  const id = 'a'.repeat(64);
  const ledger = { qa: { owner: 'writer-a', ticket: 'ticket-one', repo: 'acme/repo', pr: '42', ending: 'pr-terminal',
    dockerResources: { project: null, containers: [{ id, created: '2026-10-29T00:00:00Z', project: 'qa-owned' }],
      volumes: [], networks: [] } } };
  const result = await reconcileTerminalHelpers(ledger, { prState: async () => 'terminal', end: async () => [], alive: () => false,
    cleanup: (resources) => removeOwnedDockerResources(resources, { run: ([, action]) => action === 'inspect'
      ? { status: 1, stderr: 'daemon read failed' } : { status: 0, stdout: '' } }) });
  assert.match(result.findings[0], /LEFTOVER qa owner writer-a ticket ticket-one: Docker container inspect failed/);
  assert.equal(ledger.qa.stoppedAt, undefined);
  assert.ok(ledger.qa.dockerResources);
});

test('unknown endings and an uncaptured Compose project cannot reach stopped', (t) => {
  const dir = tempDir(t);
  const unknown = run([dir, 'start', 'qa', '--ending', 'whenever']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /ending/);
  writeFileSync(path.join(dir, 'helpers.json'), JSON.stringify({ qa: { startedAt: '2026-10-29T00:00:00Z',
    owner: 'writer-a', ticket: 'ticket-one', project: 'qa-owned', ending: 'pr-terminal' } }));
  const stopped = run([dir, 'stopped', 'qa']);
  assert.equal(stopped.status, 2);
  assert.match(stopped.stderr, /resources|witness/i);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'helpers.json'), 'utf8')).qa.stoppedAt, undefined);
});

test('terminal reconciliation refuses a Compose project without captured resources', async () => {
  const ledger = { qa: { startedAt: '2026-10-29T00:00:00Z', owner: 'writer-a', ticket: 'ticket-one',
    repo: 'acme/repo', pr: '42', project: 'qa-owned', ending: 'pr-terminal' } };
  const result = await reconcileTerminalHelpers(ledger, { prState: async () => 'terminal', end: async () => [], alive: () => false });
  assert.match(result.findings[0], /LEFTOVER qa owner writer-a ticket ticket-one:.*resources|witness/i);
  assert.equal(ledger.qa.stoppedAt, undefined);
});

test('fleet status lists private pending e2e cleanup with owner and ticket', (t) => {
  const dir = tempDir(t);
  const lockDir = path.join(dir, 'locks', 'e2e-stack');
  const pending = path.join(path.dirname(lockDir), 'e2e-cleanup-token.json');
  mkdirSync(path.dirname(lockDir), { recursive: true });
  writeFileSync(pending, JSON.stringify({ project: 'qa-owned', owner: { worktree: 'writer-a', ticket: 'ticket-one' },
    resources: { project: 'qa-owned', containers: [], volumes: [], networks: [] } }));
  const status = run([dir, 'status', '--e2e-lock-dir', lockDir]);
  assert.equal(status.status, 1);
  assert.match(status.stdout, /LEFTOVER .*owner writer-a ticket ticket-one.*pending e2e cleanup/i);
  rmSync(pending);
  assert.equal(run([dir, 'status', '--e2e-lock-dir', lockDir]).status, 0);
});

test('fleet status hides only the cleanup record for the same live lock owner birth', (t) => {
  const dir = tempDir(t);
  const lockDir = path.join(dir, 'locks', 'e2e-stack');
  const pending = path.join(path.dirname(lockDir), 'e2e-cleanup-current-token.json');
  const owner = { pid: 4242, token: 'current-token', identity: 'birth-a', worktree: 'writer-a', ticket: 'ticket-one' };
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner));
  writeFileSync(pending, JSON.stringify({ project: 'qa-owned', owner }));
  const current = { alive: () => true, identityOf: () => 'birth-a' };
  assert.deepEqual(pendingE2eCleanups(lockDir, current), [], 'the current run is not a leftover');
  assert.equal(pendingE2eCleanups(lockDir, { alive: () => true, identityOf: () => 'birth-b' }).length, 1, 'pid reuse fails closed');
  assert.equal(pendingE2eCleanups(lockDir, { alive: () => false, identityOf: () => null }).length, 1, 'dead owner stays visible');
  writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ ...owner, pid: 4343, token: 'other-token' }));
  assert.equal(pendingE2eCleanups(lockDir, current).length, 1, 'a different live lock stays visible');
  writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner));
  writeFileSync(pending, JSON.stringify({ project: 'qa-owned', owner: { ...owner, identity: undefined } }));
  assert.equal(pendingE2eCleanups(lockDir, current).length, 1, 'missing birth identity fails closed');
  writeFileSync(pending, JSON.stringify({ project: 'qa-owned', owner }));
  rmSync(lockDir, { recursive: true, force: true });
  assert.equal(pendingE2eCleanups(lockDir, current).length, 1, 'missing lock stays visible');
});

test('fleet lifecycle status names the owner and ticket when cleanup proof is incomplete', (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'helpers.json'), JSON.stringify({ qa: {
    startedAt: '2026-10-29T00:00:00Z', owner: 'writer-a', ticket: 'ticket-one',
    ending: 'pr-terminal', pr: '42',
  } }));
  const result = run([dir, 'status']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /LEFTOVER qa owner writer-a ticket ticket-one: missing ending or ownership record/);
});
const waitUntil = async (predicate) => {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return predicate();
};

test('a helper whose result was accepted and that still runs is a stop candidate', (t) => {
  const dir = tempDir(t);
  const source = path.join(dir, 'source');
  mkdirSync(source);
  execFileSync('git', ['init', '-q', '-b', 'review', source]);
  writeFileSync(path.join(source, 'app.txt'), 'source\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, '-c', 'user.email=fixture.invalid', '-c', 'user.name=Test', 'commit', '-qm', 'base']);
  const capabilities = path.join(dir, 'capabilities.json');
  writeFileSync(capabilities, '[]\n');
  const definition = path.join(dir, 'review-a.md');
  writeFileSync(definition, '---\nname: review-a\n---\n');
  const brief = path.join(dir, 'prompts', 'review-a-01.md');
  mkdirSync(path.dirname(brief));
  writeFileSync(brief, 'Review.\n');
  assert.equal(run([dir, 'start', 'review-a', '--kind', 'reviewer', '--brief', 'prompts/review-a-01.md', '--worktree', source,
    '--worker-id', 'native-reviewer-a', '--role', 'review-a', '--agent-definition', definition,
    '--capabilities', capabilities, '--now', '2026-10-21T10:00:00Z']).status, 0);
  assert.equal(run([dir, 'start', 'review-b', '--now', '2026-10-21T10:00:00Z']).status, 0);
  const helper = JSON.parse(readFileSync(path.join(dir, 'helpers.json'), 'utf8'))['review-a'];
  const deliverable = path.join(dir, 'final.md');
  writeFileSync(deliverable, `final review\n${finalMarker(helper, { sessionId: 's-1', turnId: 't-1' })}\n`);
  const report = path.join(dir, 'final.json');
  assert.equal(run([dir, 'final', 'review-a', '--deliverable', deliverable, '--session-id', 's-1', '--turn-id', 't-1', '--out', report]).status, 0);
  assert.equal(run([dir, 'accepted', 'review-a', '--report', report, '--now', '2026-10-21T10:10:00Z']).status, 0);
  const busy = run([dir, 'status', '--now', '2026-10-21T10:20:00Z']);
  assert.equal(busy.status, 1);
  assert.match(busy.stdout, /^STOP review-a accepted 10m ago; relaunch from prompts\/review-a-01\.md$/m);
  assert.match(busy.stdout, /helpers: 2 active, 1 to stop/);
  assert.equal(run([dir, 'status', '--now', '2026-10-21T10:12:00Z']).status, 0, 'inside the idle window');
  assert.equal(run([dir, 'stopped', 'review-a', '--now', '2026-10-21T10:21:00Z']).status, 0);
  assert.equal(run([dir, 'status', '--now', '2026-10-21T10:30:00Z']).status, 0);
  assert.deepEqual(stopCandidates({ x: { startedAt: 'a' } }, Date.now()), [], 'a running helper with no accepted result is not idle');
});

test('history attribution refuses a shallow clone', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).stdout.trim();
  git('init', '--quiet');
  writeFileSync(path.join(dir, 'route.ts'), '1\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'create route');
  const created = git('rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'route.ts'), '2\n');
  git('commit', '--quiet', '-am', 'change route');
  assert.deepEqual(historyOrigin(dir, 'route.ts'), { commit: created, subject: 'create route' });
  writeFileSync(path.join(dir, '.git', 'shallow'), `${git('rev-parse', 'HEAD')}\n`);
  assert.match(historyOrigin(dir, 'route.ts').reason, /shallow/);
});

test('stopping a helper ends the processes it recorded, and a stopped helper with live processes is an orphan', async (t) => {
  const dir = tempDir(t);
  const server = child(t, 'sleep', ['60']);
  assert.equal(run([dir, 'start', 'qa-a']).status, 0);
  assert.equal(run([dir, 'pid', 'qa-a', String(server), String(server)]).status, 0);
  assert.equal(run([dir, 'stopped', 'qa-a', '--grace-seconds', '5']).status, 0);
  assert.ok(await waitUntil(() => !isAlive(server)), 'the recorded dev server is gone');
  assert.equal(run([dir, 'status']).status, 0);

  const left = child(t, 'sleep', ['60']);
  assert.deepEqual(orphans({ 'qa-b': { stoppedAt: 'x', pids: [left], identities: { [left]: 'owned' } }, 'qa-c': { pids: [left] } },
    () => true, () => 'owned'), [{ name: 'qa-b', pids: [left] }]);
  assert.deepEqual(orphans({ '#stacks': { s: { guide: 'g' } } }), []);
});

test('a process that ignores SIGTERM is killed after the grace; a survivor keeps the helper unstopped', async (t) => {
  const dir = tempDir(t);
  const stubborn = child(t, process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(run([dir, 'start', 'qa-d']).status, 0);
  assert.equal(run([dir, 'pid', 'qa-d', String(stubborn)]).status, 0);
  const stopped = run([dir, 'stopped', 'qa-d', '--grace-seconds', '1']);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.ok(await waitUntil(() => !isAlive(stubborn)));

  const ledger = path.join(dir, 'helpers.json');
  const left = child(t, 'sleep', ['60']);
  writeFileSync(ledger, JSON.stringify({ 'qa-e': { startedAt: 'x', pids: [left] },
    'qa-f': { stoppedAt: 'x', pids: [left], identities: { [left]: readIdentity(left) } } }));
  const status = run([dir, 'status']);
  assert.equal(status.status, 1);
  assert.match(status.stdout, new RegExp(`^ORPHAN qa-f ${left} still running$`, 'm'));
  assert.match(status.stdout, /helpers: 1 active, 0 to stop, 1 orphaned/);
  assert.equal(run([dir, 'pid', 'qa-e', 'abc']).status, 2);
});

test('a pid of 1 or lower is never recorded: signalling group 1 reaches every process the user owns', () => {
  for (const unsafe of [['1'], ['0'], ['-1'], ['-42'], ['1.5'], ['abc'], []]) {
    assert.throws(() => parsePids(unsafe), /above 1/, unsafe.join(' '));
  }
  assert.deepEqual(parsePids(['2', String(FAKE)]), [2, FAKE]);
});

test('endProcesses never signals a pid of 1 or lower, this process or its parent, even when one is recorded', async () => {
  const fake = fakeTable([]);
  const unsafe = [0, 1, -1, -42, Number.NaN, 1.5, process.pid, process.ppid].map((pid) => ({ pid, group: true }));
  assert.deepEqual(await endProcesses(unsafe, 0, { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }), []);
  assert.deepEqual(fake.calls, [], 'not even a liveness probe');
});

test('endProcesses signals a pid alone unless it was recorded as a group the helper spawned and still leads', async () => {
  const fake = fakeTable([
    { pid: FAKE + 1, pgid: FAKE + 1, state: 'alive' },
    { pid: FAKE + 2, pgid: FAKE + 1, state: 'alive' },
    { pid: FAKE + 3, pgid: FAKE + 3, state: 'alive' },
    { pid: FAKE + 4, pgid: FAKE + 3, state: 'alive' },
    { pid: FAKE + 5, pgid: FAKE + 9, state: 'alive' },
    { pid: FAKE + 6, pgid: FAKE + 9, state: 'alive' },
  ]);
  const survivors = await endProcesses(
    [recorded(FAKE + 1, false), recorded(FAKE + 3, true), recorded(FAKE + 5, true)],
    0,
    { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }
  );
  assert.deepEqual(survivors, []);
  assert.deepEqual(fake.sent(), [
    [FAKE + 1, 'SIGTERM'],
    [-(FAKE + 3), 'SIGTERM'],
    [FAKE + 5, 'SIGTERM'],
  ]);
  assert.equal(fake.state(FAKE + 2), 'alive', 'a group leader recorded without --group is signalled alone');
  assert.equal(fake.state(FAKE + 4), 'gone', 'a recorded group that the pid still leads is ended whole');
  assert.equal(fake.state(FAKE + 6), 'alive', 'a recorded group pid that no longer leads its group is signalled alone');
});

test('endProcesses never signals a pid the system says is not ours (EPERM), and does not count it as a survivor', async () => {
  const fake = fakeTable([{ pid: FAKE + 7, pgid: FAKE + 7, state: 'foreign' }]);
  assert.deepEqual(await endProcesses([recorded(FAKE + 7, true)], 0, { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }), []);
  assert.deepEqual(fake.sent(), []);
  assert.equal(isAlive(FAKE + 7), false, 'a fake pid above pid_max does not exist');
});

test('a reused pid whose start time or command differs from the record is never signalled', async () => {
  const fake = fakeTable([{ pid: FAKE + 10, pgid: FAKE + 30, state: 'alive', identity: 'Wed Oct 21 16:00:01 2026 /Applications/Slack.app/Contents/MacOS/Slack' }]);
  const targets = [recorded(FAKE + 10, false, 'Wed Oct 21 15:00:00 2026 node dev-server.js')];
  assert.deepEqual(await endProcesses(targets, 0, { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }), []);
  assert.deepEqual(fake.sent(), []);
  assert.equal(fake.state(FAKE + 10), 'alive');
});

test('a reused pid that now leads its own group, as a launchd app does, is never group-killed', async () => {
  const fake = fakeTable([
    { pid: FAKE + 11, pgid: FAKE + 11, state: 'alive', identity: 'Wed Oct 21 16:05:00 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { pid: FAKE + 12, pgid: FAKE + 11, state: 'alive', identity: 'Wed Oct 21 16:05:01 2026 Google Chrome Helper' },
  ]);
  const targets = [recorded(FAKE + 11, true, 'Wed Oct 21 15:00:00 2026 sh -c next dev')];
  assert.deepEqual(await endProcesses(targets, 0, { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }), []);
  assert.deepEqual(fake.sent(), []);
  assert.equal(fake.state(FAKE + 12), 'alive', 'the app and its group are untouched');
});

test('a record with no identity, as an older ledger has, is never signalled', async () => {
  const fake = fakeTable([{ pid: FAKE + 13, pgid: FAKE + 13, state: 'alive' }]);
  for (const identity of [undefined, '', null]) {
    assert.deepEqual(await endProcesses([{ pid: FAKE + 13, group: true, identity }], 0, { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }), []);
  }
  assert.deepEqual(fake.sent(), []);
  assert.equal(fake.state(FAKE + 13), 'alive');
});

test('identity is read again before every signal: a pid reused during the grace gets no SIGKILL', async () => {
  const fake = fakeTable([{ pid: FAKE + 14, pgid: FAKE + 40, state: 'alive', reusedOnTerm: 'Wed Oct 21 16:10:00 2026 /Applications/iTerm.app/Contents/MacOS/iTerm2' }]);
  assert.deepEqual(await endProcesses([recorded(FAKE + 14, false)], 0, { kill: fake.kill, groupOf: fake.groupOf, identityOf: fake.identityOf }), []);
  assert.deepEqual(fake.sent(), [[FAKE + 14, 'SIGTERM']]);
  assert.equal(fake.state(FAKE + 14), 'alive', 'the app now holding the pid is not killed');
});

test('pid preserves the raw start time and command identity format and refuses one it cannot read', (t) => {
  const dir = tempDir(t);
  const server = child(t, 'sleep', ['60']);
  assert.equal(run([dir, 'pid', 'qa-i', String(server)]).status, 0);
  const identity = JSON.parse(readFileSync(path.join(dir, 'helpers.json'), 'utf8'))['qa-i'].identities[server];
  assert.match(identity, /sleep 60/);
  assert.equal(identity, readIdentity(server));
  const refused = run([dir, 'pid', 'qa-j', String(FAKE + 15)]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /cannot read the start time and command/);
});

test('a pre-upgrade raw process identity still matches through the default stopped path', (t) => {
  const dir = tempDir(t);
  const server = child(t, 'sleep', ['60']);
  const identity = readIdentity(server);
  assert.match(identity, /sleep 60/);
  writeFileSync(path.join(dir, 'helpers.json'), JSON.stringify({ qa: {
    startedAt: '2026-10-29T00:00:00Z', pids: [server], identities: { [server]: identity },
  } }));
  const stopped = run([dir, 'stopped', 'qa', '--grace-seconds', '2']);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.ok(JSON.parse(readFileSync(path.join(dir, 'helpers.json'), 'utf8')).qa.stoppedAt);
});

test('stopping a helper recorded with --group ends its whole process group', { timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const { leader, member } = await groupLeader(t, dir);
  assert.equal(run([dir, 'start', 'qa-h']).status, 0);
  assert.equal(run([dir, 'pid', 'qa-h', String(leader), '--group']).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'helpers.json'), 'utf8'))['qa-h'].groups, [leader]);
  const stopped = run([dir, 'stopped', 'qa-h', '--grace-seconds', '5']);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.ok(await waitUntil(() => !isAlive(leader)), 'the leader is gone');
  assert.ok(await waitUntil(() => !isAlive(member)), 'the process it started in its group is gone');
});

test('a stack handed to a human cannot be used by another helper until it is released', (t) => {
  const dir = tempDir(t);
  assert.equal(run([dir, 'hand', 'preview-3000', '--to', 'qa-guide-12']).status, 0);
  const refused = run([dir, 'start', 'qa-rerun', '--stack', 'preview-3000']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /handed to qa-guide-12; launch this helper on its own stack/);
  assert.equal(run([dir, 'start', 'qa-rerun', '--stack', 'qa-rerun-own']).status, 0);
  assert.equal(run([dir, 'hand', 'x']).status, 2, 'hand needs a guide');
  assert.equal(run([dir, 'unhand', 'preview-3000']).status, 0);
  assert.equal(run([dir, 'start', 'qa-rerun-2', '--stack', 'preview-3000']).status, 0);
  const status = run([dir, 'status']);
  assert.match(status.stdout, /helpers: 2 active, 0 to stop, 0 orphaned/);
});
