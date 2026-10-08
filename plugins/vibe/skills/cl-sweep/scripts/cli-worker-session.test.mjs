import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./cli-worker-session.mjs', import.meta.url));
const checkpointScript = fileURLToPath(new URL('./checkpoint-worktree.mjs', import.meta.url));
const ownershipScript = fileURLToPath(new URL('./ownership-lease.mjs', import.meta.url));
const HASH_1 = 'a'.repeat(64);
const HASH_2 = 'b'.repeat(64);

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', ...options }).trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cl-worker-session-test-'));
  const repo = join(root, 'repo');
  run('git', ['init', repo]);
  run('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  run('git', ['-C', repo, 'config', 'user.name', 'Test User']);
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  run('git', ['-C', repo, 'add', 'tracked.txt']);
  run('git', ['-C', repo, 'commit', '-m', 'base']);
  const state = join(root, 'private');
  mkdirSync(state, { mode: 0o700 });
  const invocationLog = join(root, 'invocations.jsonl');
  const fakeCodex = join(root, 'codex');
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('codex-cli 0.test\\n'); process.exit(0); }
if (args.includes('--help')) {
  process.stdout.write(args.includes('resume') ? 'Usage: codex exec resume [SESSION_ID] [PROMPT]\\n-m, --model <MODEL>\\n' : '-C, --cd <DIR>\\n-m, --model <MODEL>\\n');
  process.exit(0);
}
const input = fs.readFileSync(0, 'utf8');
const outputIndex = args.indexOf('-o');
const callback = input.split('\\n').filter((line) => line.startsWith('CL_SWEEP_EVENT v1 ')).at(-1);
fs.writeFileSync(args[outputIndex + 1], callback ? callback + '\\n' : input);
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ cwd: process.cwd(), args, input }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'session-123' }) + '\\n');
`);
  chmodSync(fakeCodex, 0o755);
  return { root, repo, state, fakeCodex, invocationLog };
}

function event({ id, worktree, generation = 1, rootGeneration = 1, parentThreadId = 'parent-1', ownerId = 'worker-1', leaseId = 'lease-1', hash = HASH_1, kind = 'ANALYSIS_COMPLETE', payload = {} }) {
  return `CL_SWEEP_EVENT v1 ${JSON.stringify({
    event_id: id,
    parent_thread_id: parentThreadId,
    root_generation: rootGeneration,
    ticket: 'FEA-1',
    worker_id: ownerId,
    owner_surface: 'cli',
    owner_generation: generation,
    lease_id: leaseId,
    lease_token_hash: hash,
    kind,
    phase: 'analysis',
    status: 'READY',
    parent_action: 'continue',
    worktree,
    payload,
  })}\n`;
}

test('launches and resumes the same cwd-bound Codex exec session', () => {
  const { repo, state, fakeCodex, invocationLog } = setup();
  const session = join(state, 'session.json');
  const events = join(state, 'events.jsonl');
  JSON.parse(run('node', [script, 'probe', '--codex', fakeCodex]));
  JSON.parse(run('node', [script, 'init', '--session-file', session, '--worktree', repo, '--ticket', 'FEA-1', '--parent-thread-id', 'parent-1', '--parent-cwd', repo, '--owner-id', 'worker-1', '--generation', '1', '--lease-id', 'lease-1', '--lease-token-hash', HASH_1]));
  assert.equal(statSync(session).mode & 0o777, 0o600);
  const ready = JSON.parse(run('node', [script, 'status', '--session-file', session]));
  assert.equal(ready.state, 'READY');
  assert.equal(ready.bindingValid, true);
  assert.equal(ready.requestedModel, 'gpt-6-sol');
  assert.equal(ready.activeProcess, false);

  const firstPrompt = join(state, 'first.txt');
  writeFileSync(firstPrompt, event({ id: randomUUID(), worktree: repo }));
  const launched = JSON.parse(run('node', [script, 'run', '--session-file', session, '--prompt-file', firstPrompt, '--events-file', events, '--codex', fakeCodex]));
  assert.equal(launched.launch, true);
  assert.equal(launched.codexSessionId, 'session-123');

  const secondPrompt = join(state, 'second.txt');
  writeFileSync(secondPrompt, event({ id: randomUUID(), worktree: repo, kind: 'EXECUTION_CHECKPOINT' }));
  const resumed = JSON.parse(run('node', [script, 'run', '--session-file', session, '--prompt-file', secondPrompt, '--events-file', events, '--codex', fakeCodex]));
  assert.equal(resumed.launch, false);
  assert.equal(resumed.codexSessionId, 'session-123');

  const invocations = readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(invocations.length, 2);
  const canonicalRepo = realpathSync(repo);
  assert.equal(invocations[0].cwd, canonicalRepo);
  assert.deepEqual(invocations[0].args.slice(0, 3), ['exec', '-C', canonicalRepo]);
  assert.deepEqual(invocations[0].args.slice(3, 5), ['-m', 'gpt-6-sol']);
  assert.match(invocations[0].input, /validate-callback --session-file/);
  assert.match(invocations[0].input, /"parent_thread_id":"parent-1"/);
  assert.match(invocations[0].input, /parent_action at or below 512 characters/);
  assert.equal(invocations[1].cwd, canonicalRepo);
  assert.deepEqual(invocations[1].args.slice(0, 4), ['exec', 'resume', '-m', 'gpt-6-sol']);
  assert.ok(invocations[1].args.includes('session-123'));
  assert.equal(readFileSync(events, 'utf8').trim().split('\n').length, 2);
});

test('compatibility fallback replaces a persisted legacy binding before another turn', () => {
  const { repo, state, fakeCodex, invocationLog } = setup();
  const sessionFile = join(state, 'legacy-session.json');
  JSON.parse(run('node', [script, 'init', '--session-file', sessionFile, '--worktree', repo, '--ticket', 'FEA-1', '--parent-thread-id', 'parent-1', '--parent-cwd', repo, '--owner-id', 'worker-1', '--generation', '1', '--lease-id', 'lease-1', '--lease-token-hash', HASH_1]));
  const stored = JSON.parse(readFileSync(sessionFile, 'utf8'));
  stored.requestedModel = 'gpt-5.5';
  stored.codexSessionId = 'session-123';
  stored.state = 'WAITING';
  writeFileSync(sessionFile, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  const status = JSON.parse(run('node', [script, 'status', '--session-file', sessionFile]));
  assert.equal(status.bindingValid, true);
  assert.equal(status.modelReplacement.requiredBeforeNextTurn, true);
  assert.equal(status.modelReplacement.idleCandidate, true);

  const prompt = join(state, 'prompt.txt');
  writeFileSync(prompt, event({ id: randomUUID(), worktree: repo }));
  const rejected = spawnSync('node', [script, 'run', '--session-file', sessionFile, '--prompt-file', prompt, '--events-file', join(state, 'events.jsonl'), '--codex', fakeCodex], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /requires idle-boundary replacement with a new gpt-6-sol session/);
  assert.equal(existsSync(invocationLog), false);
  assert.equal(JSON.parse(readFileSync(sessionFile, 'utf8')).requestedModel, 'gpt-5.5');
});

test('compatibility fallback refuses a CLI without model-bound resume', () => {
  const { root, fakeCodex } = setup();
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('codex-cli 0.test\\n'); process.exit(0); }
if (args.includes('--help')) {
  process.stdout.write(args.includes('resume') ? 'Usage: codex exec resume [SESSION_ID] [PROMPT]\\n' : '-C, --cd <DIR>\\n-m, --model <MODEL>\\n');
  process.exit(0);
}
`);
  chmodSync(fakeCodex, 0o755);
  const result = spawnSync('node', [script, 'probe', '--codex', fakeCodex], { encoding: 'utf8', cwd: root });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /model-bound launch\/resume/);
});

test('feature member lease loss blocks fallback dispatch before Codex starts', () => {
  const { repo, state, fakeCodex, invocationLog } = setup();
  const session = join(state, 'feature-session.json');
  const ledger = join(state, 'ownership.jsonl');
  const secrets = join(state, 'secrets');
  mkdirSync(secrets, { mode: 0o700 });
  const acquire = (ticket) => JSON.parse(run(process.execPath, [
    ownershipScript, 'acquire', '--ledger', ledger, '--ticket', ticket,
    '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'feature-worker',
    '--secret-output', join(secrets, `${ticket}.json`), '--ttl-seconds', '600',
  ]));
  const anchor = acquire('FEA-1');
  const member = acquire('FEA-2');
  const manifest = join(state, 'feature.json');
  writeFileSync(manifest, `${JSON.stringify({
    schema: 'CL_SWEEP_FEATURE_OWNERSHIP v1',
    feature_id: 'feature-1',
    anchor_ticket: 'FEA-1',
    owner_id: 'feature-worker',
    owner_surface: 'cli',
    worktree: realpathSync(repo),
    members: [anchor, member].map((record) => ({
      ticket: record.ticket,
      generation: record.generation,
      lease_id: record.leaseId,
      lease_token_hash: record.leaseTokenHash,
    })),
  }, null, 2)}\n`, { mode: 0o600 });
  JSON.parse(run(process.execPath, [
    script, 'init', '--session-file', session, '--worktree', repo, '--ticket', 'FEA-1',
    '--parent-thread-id', 'parent-1', '--parent-cwd', repo, '--owner-id', 'feature-worker',
    '--generation', String(anchor.generation), '--lease-id', anchor.leaseId,
    '--lease-token-hash', anchor.leaseTokenHash, '--feature-manifest', realpathSync(manifest),
    '--ownership-ledger', realpathSync(ledger),
  ]));
  run(process.execPath, [
    ownershipScript, 'release', '--ledger', ledger, '--ticket', 'FEA-2',
    '--secret-file', join(secrets, 'FEA-2.json'), '--reason', 'test_member_loss',
  ]);
  const prompt = join(state, 'prompt.txt');
  writeFileSync(prompt, 'do not start\n');
  const blocked = spawnSync(process.execPath, [
    script, 'run', '--session-file', session, '--prompt-file', prompt,
    '--events-file', join(state, 'events.jsonl'), '--codex', fakeCodex,
  ], { encoding: 'utf8' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /FEA-2.*active current lease/);
  assert.equal(existsSync(invocationLog), false);
});

test('feature replacement rotates the full member scope before the next session can launch', () => {
  const { repo, state, fakeCodex } = setup();
  const priorSession = join(state, 'feature-prior.json');
  const nextSession = join(state, 'feature-next.json');
  const ledger = join(state, 'ownership.jsonl');
  const secrets = join(state, 'replace-secrets');
  mkdirSync(secrets, { mode: 0o700 });
  const acquire = (ticket) => JSON.parse(run(process.execPath, [
    ownershipScript, 'acquire', '--ledger', ledger, '--ticket', ticket,
    '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'feature-worker-1',
    '--secret-output', join(secrets, `${ticket}-1.json`), '--ttl-seconds', '600',
  ]));
  const firstAnchor = acquire('FEA-1');
  const firstMember = acquire('FEA-2');
  const writeManifest = (path, ownerId, records) => writeFileSync(path, `${JSON.stringify({
    schema: 'CL_SWEEP_FEATURE_OWNERSHIP v1',
    feature_id: 'feature-1',
    anchor_ticket: 'FEA-1',
    owner_id: ownerId,
    owner_surface: 'cli',
    worktree: realpathSync(repo),
    members: records.map((record) => ({
      ticket: record.ticket,
      generation: record.generation,
      lease_id: record.leaseId,
      lease_token_hash: record.leaseTokenHash,
    })),
  }, null, 2)}\n`, { mode: 0o600 });
  const firstManifest = join(state, 'feature-1.json');
  writeManifest(firstManifest, 'feature-worker-1', [firstAnchor, firstMember]);
  JSON.parse(run(process.execPath, [
    script, 'init', '--session-file', priorSession, '--worktree', repo, '--ticket', 'FEA-1',
    '--parent-thread-id', 'parent-1', '--parent-cwd', repo, '--owner-id', 'feature-worker-1',
    '--generation', '1', '--lease-id', firstAnchor.leaseId,
    '--lease-token-hash', firstAnchor.leaseTokenHash, '--feature-manifest', realpathSync(firstManifest),
    '--ownership-ledger', realpathSync(ledger),
  ]));
  const rotate = (ticket) => JSON.parse(run(process.execPath, [
    ownershipScript, 'replace', '--ledger', ledger, '--ticket', ticket,
    '--secret-file', join(secrets, `${ticket}-1.json`),
    '--secret-output', join(secrets, `${ticket}-2.json`),
    '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'feature-worker-2',
    '--reason', 'feature_worker_replacement', '--ttl-seconds', '600',
  ]));
  const nextAnchor = rotate('FEA-1');
  const nextMember = rotate('FEA-2');
  const nextManifest = join(state, 'feature-2.json');
  writeManifest(nextManifest, 'feature-worker-2', [nextAnchor, nextMember]);
  const replaced = JSON.parse(run(process.execPath, [
    script, 'replace', '--session-file', priorSession, '--output', nextSession,
    '--owner-id', 'feature-worker-2', '--generation', '2', '--lease-id', nextAnchor.leaseId,
    '--lease-token-hash', nextAnchor.leaseTokenHash, '--reason', 'feature_worker_replacement',
    '--feature-manifest', realpathSync(nextManifest), '--ownership-ledger', realpathSync(ledger),
  ]));
  assert.equal(replaced.featureOwnership.members.length, 2);
  assert.equal(JSON.parse(readFileSync(priorSession, 'utf8')).state, 'REPLACED');

  const metadata = {
    manifest_sha256: replaced.featureOwnership.manifestSha256,
    feature_id: 'feature-1',
    members: ['FEA-1', 'FEA-2'],
  };
  const prompt = join(state, 'replacement-prompt.txt');
  writeFileSync(prompt, event({
    id: randomUUID(), worktree: repo, generation: 2, ownerId: 'feature-worker-2',
    leaseId: nextAnchor.leaseId, hash: nextAnchor.leaseTokenHash,
    payload: { feature_ownership: metadata },
  }));
  const launched = JSON.parse(run(process.execPath, [
    script, 'run', '--session-file', nextSession, '--prompt-file', prompt,
    '--events-file', join(state, 'replacement-events.jsonl'), '--codex', fakeCodex,
  ]));
  assert.equal(launched.event.owner_generation, 2);
});

test('preflights fallback callbacks with exact field diagnostics', () => {
  const { repo, state } = setup();
  const session = join(state, 'session.json');
  JSON.parse(run('node', [
    script, 'init', '--session-file', session, '--worktree', repo,
    '--ticket', 'FEA-1', '--parent-thread-id', 'parent-1', '--parent-cwd', repo,
    '--owner-id', 'worker-1', '--generation', '1', '--lease-id', 'lease-1',
    '--lease-token-hash', HASH_1,
  ]));
  const callbackFile = join(state, 'candidate.json');
  const candidate = JSON.parse(event({ id: randomUUID(), worktree: repo })
    .trim().slice('CL_SWEEP_EVENT v1 '.length));
  writeFileSync(callbackFile, `${JSON.stringify(candidate)}\n`);
  const valid = JSON.parse(run('node', [
    script, 'validate-callback', '--session-file', session,
    '--callback-file', callbackFile,
  ]));
  assert.equal(valid.valid, true);

  writeFileSync(callbackFile, `${JSON.stringify({ ...candidate, root_generation: 2 })}\n`);
  const stale = spawnSync('node', [
    script, 'validate-callback', '--session-file', session,
    '--callback-file', callbackFile,
  ], { encoding: 'utf8' });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /root_generation does not match the current parent generation/);

  writeFileSync(callbackFile, `${JSON.stringify({
    ...candidate,
    event_id: randomUUID(),
    parent_action: 'x'.repeat(513),
  })}\n`);
  const overlong = spawnSync('node', [
    script, 'validate-callback', '--session-file', session,
    '--callback-file', callbackFile,
  ], { encoding: 'utf8' });
  assert.notEqual(overlong.status, 0);
  assert.match(overlong.stderr, /parent_action exceeds 512 characters \(observed 513\)/);
});

test('recovers a malformed final event in the same fallback session and worktree', () => {
  const { repo, state, fakeCodex, invocationLog } = setup();
  const session = join(state, 'session.json');
  const events = join(state, 'events.jsonl');
  JSON.parse(run('node', [
    script, 'init', '--session-file', session, '--worktree', repo,
    '--ticket', 'FEA-1', '--parent-thread-id', 'parent-1', '--owner-id', 'worker-1',
    '--parent-cwd', repo,
    '--generation', '1', '--lease-id', 'lease-1', '--lease-token-hash', HASH_1,
  ]));
  const malformedPrompt = join(state, 'malformed.txt');
  writeFileSync(malformedPrompt, `${event({ id: randomUUID(), worktree: repo }).trim()}}\n`);
  const rejected = spawnSync('node', [
    script, 'run', '--session-file', session, '--prompt-file', malformedPrompt,
    '--events-file', events, '--codex', fakeCodex,
  ], { encoding: 'utf8' });
  assert.equal(rejected.status, 0);
  const rejectionEvent = JSON.parse(rejected.stdout).event;
  assert.equal(rejectionEvent.status, 'CALLBACK_CORRECTION_REQUIRED');
  assert.equal(rejectionEvent.payload.runtime_generated, true);
  const failedSession = JSON.parse(readFileSync(session, 'utf8'));
  assert.equal(failedSession.state, 'INTERRUPTED');
  assert.equal(failedSession.codexSessionId, 'session-123');
  assert.equal(failedSession.generation, 1);
  assert.equal(failedSession.callbackCorrection.status, 'required');

  const recoveryPrompt = join(state, 'recovery.txt');
  writeFileSync(recoveryPrompt, event({ id: randomUUID(), worktree: repo }));
  const recovered = JSON.parse(run('node', [
    script, 'run', '--session-file', session, '--prompt-file', recoveryPrompt,
    '--events-file', events, '--codex', fakeCodex,
  ]));
  assert.equal(recovered.launch, false);
  assert.equal(recovered.codexSessionId, 'session-123');
  assert.equal(recovered.worktree, realpathSync(repo));
  const invocations = readFileSync(invocationLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[1].args.slice(0, 4), ['exec', 'resume', '-m', 'gpt-6-sol']);
  assert.equal(invocations[1].cwd, realpathSync(repo));
  assert.equal(readFileSync(events, 'utf8').trim().split('\n').length, 2);
  assert.equal(JSON.parse(readFileSync(session, 'utf8')).callbackCorrection.status, 'corrected');
});

test('allows exactly one malformed-callback correction turn', () => {
  const { repo, state, fakeCodex, invocationLog } = setup();
  const session = join(state, 'session.json');
  const events = join(state, 'events.jsonl');
  JSON.parse(run('node', [
    script, 'init', '--session-file', session, '--worktree', repo,
    '--ticket', 'FEA-1', '--parent-thread-id', 'parent-1', '--parent-cwd', repo,
    '--owner-id', 'worker-1', '--generation', '1', '--lease-id', 'lease-1',
    '--lease-token-hash', HASH_1,
  ]));
  const malformed = join(state, 'malformed.txt');
  writeFileSync(malformed, `${event({ id: randomUUID(), worktree: repo }).trim()}}\n`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync('node', [
      script, 'run', '--session-file', session, '--prompt-file', malformed,
      '--events-file', events, '--codex', fakeCodex,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    const runtimeEvent = JSON.parse(result.stdout).event;
    assert.equal(runtimeEvent.status, attempt === 0
      ? 'CALLBACK_CORRECTION_REQUIRED'
      : 'REPLACEMENT_REQUIRED');
  }
  const exhausted = JSON.parse(readFileSync(session, 'utf8'));
  assert.equal(exhausted.state, 'FAILED');
  assert.equal(exhausted.callbackCorrection.status, 'exhausted');
  assert.equal(exhausted.replacementRequired.reason, 'CALLBACK_CORRECTION_EXHAUSTED');
  assert.equal(exhausted.lastEvent.status, 'REPLACEMENT_REQUIRED');
  assert.equal(readFileSync(events, 'utf8').trim().split('\n').length, 2);
  const visible = JSON.parse(run('node', [script, 'status', '--session-file', session]));
  assert.equal(visible.callbackCorrection.status, 'exhausted');
  assert.equal(visible.replacementRequired.reason, 'CALLBACK_CORRECTION_EXHAUSTED');
  const before = readFileSync(invocationLog, 'utf8').trim().split('\n').length;
  const third = spawnSync('node', [
    script, 'run', '--session-file', session, '--prompt-file', malformed,
    '--events-file', events, '--codex', fakeCodex,
  ], { encoding: 'utf8' });
  assert.notEqual(third.status, 0);
  assert.match(third.stderr, /correction budget is exhausted/);
  assert.equal(readFileSync(invocationLog, 'utf8').trim().split('\n').length, before);
});

test('rejects stale callbacks and replaces only a non-running generation', () => {
  const { repo, state, fakeCodex } = setup();
  const session = join(state, 'session.json');
  const events = join(state, 'events.jsonl');
  JSON.parse(run('node', [script, 'init', '--session-file', session, '--worktree', repo, '--ticket', 'FEA-1', '--parent-thread-id', 'parent-1', '--parent-cwd', repo, '--owner-id', 'worker-1', '--generation', '1', '--lease-id', 'lease-1', '--lease-token-hash', HASH_1]));
  const stalePrompt = join(state, 'stale.txt');
  writeFileSync(stalePrompt, event({ id: randomUUID(), worktree: repo, generation: 0 }));
  const stale = spawnSync('node', [script, 'run', '--session-file', session, '--prompt-file', stalePrompt, '--events-file', events, '--codex', fakeCodex], { encoding: 'utf8' });
  assert.equal(stale.status, 0);
  const staleEvent = JSON.parse(stale.stdout).event;
  assert.equal(staleEvent.status, 'CALLBACK_CORRECTION_REQUIRED');
  assert.match(staleEvent.payload.failure, /owner_generation does not match the current ticket generation/);

  const replacement = join(state, 'replacement.json');
  const replaced = JSON.parse(run('node', [script, 'replace', '--session-file', session, '--output', replacement, '--owner-id', 'worker-2', '--generation', '2', '--lease-id', 'lease-2', '--lease-token-hash', HASH_2, '--reason', 'callback_failed']));
  assert.equal(replaced.generation, 2);
  assert.equal(replaced.replacementOf, 'worker-1:1');
  assert.equal(JSON.parse(readFileSync(session, 'utf8')).state, 'REPLACED');
});

test('requires cutover sessions to use a fresh worktree with the exact checkpoint state', () => {
  const { root, repo, state } = setup();
  writeFileSync(join(repo, 'tracked.txt'), 'desktop change\n');
  writeFileSync(join(repo, 'untracked.txt'), 'preserved\n');
  const checkpoint = join(root, 'checkpoint');
  JSON.parse(run('node', [checkpointScript, 'create', '--worktree', repo, '--output', checkpoint, '--owner-surface', 'desktop', '--generation', '1']));

  const legacySession = join(state, 'legacy-session.json');
  const legacy = spawnSync('node', [script, 'init', '--session-file', legacySession, '--worktree', repo, '--ticket', 'FEA-1', '--parent-thread-id', 'parent-1', '--parent-cwd', repo, '--owner-id', 'worker-1', '--generation', '1', '--lease-id', 'lease-1', '--lease-token-hash', HASH_1, '--cutover-checkpoint', checkpoint], { encoding: 'utf8' });
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /must differ from the legacy checkpoint source/);

  const cutover = join(root, 'cutover');
  run('git', ['-C', repo, 'worktree', 'add', '-b', 'codex/cutover', cutover, 'HEAD']);
  JSON.parse(run('node', [checkpointScript, 'rehydrate', '--checkpoint', checkpoint, '--worktree', cutover]));
  const session = join(state, 'cutover-session.json');
  const initialized = JSON.parse(run('node', [script, 'init', '--session-file', session, '--worktree', cutover, '--ticket', 'FEA-1', '--parent-thread-id', 'parent-1', '--parent-cwd', repo, '--owner-id', 'worker-1', '--generation', '1', '--lease-id', 'lease-1', '--lease-token-hash', HASH_1, '--cutover-checkpoint', checkpoint]));
  assert.equal(initialized.cutoverCheckpoint.manifestSha256.length, 64);
  assert.equal(initialized.worktree, realpathSync(cutover));
});

test('surfaces a terminated Codex process instead of only a null exit status', () => {
  const { repo, state, fakeCodex } = setup();
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('codex-cli 0.test\\n'); process.exit(0); }
if (args.includes('--help')) {
  process.stdout.write(args.includes('resume') ? 'Usage: codex exec resume [SESSION_ID] [PROMPT]\\n-m, --model <MODEL>\\n' : '-C, --cd <DIR>\\n-m, --model <MODEL>\\n');
  process.exit(0);
}
process.kill(process.pid, 'SIGKILL');
`);
  chmodSync(fakeCodex, 0o755);
  const session = join(state, 'session.json');
  JSON.parse(run('node', [script, 'init', '--session-file', session, '--worktree', repo, '--ticket', 'FEA-1', '--parent-thread-id', 'parent-1', '--parent-cwd', repo, '--owner-id', 'worker-1', '--generation', '1', '--lease-id', 'lease-1', '--lease-token-hash', HASH_1]));
  const prompt = join(state, 'prompt.txt');
  writeFileSync(prompt, event({ id: randomUUID(), worktree: repo }));
  const failed = spawnSync('node', [script, 'run', '--session-file', session, '--prompt-file', prompt, '--events-file', join(state, 'events.jsonl'), '--codex', fakeCodex], { encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(failed.stderr, /Codex exited null/);
  assert.match(JSON.parse(readFileSync(session, 'utf8')).lastFailure, /SIGKILL/);

  const healthy = setup().fakeCodex;
  const retryPrompt = join(state, 'retry.txt');
  writeFileSync(retryPrompt, event({ id: randomUUID(), worktree: repo }));
  JSON.parse(run('node', [script, 'run', '--session-file', session, '--prompt-file', retryPrompt, '--events-file', join(state, 'events.jsonl'), '--codex', healthy]));
  const retried = JSON.parse(readFileSync(session, 'utf8'));
  assert.equal(retried.state, 'WAITING');
  assert.equal(retried.lastFailure, undefined);
});

test('rebinds an inactive fallback session to the next root without rotating its ticket lease', () => {
  const { repo, state, fakeCodex } = setup();
  const session = join(state, 'session.json');
  JSON.parse(run('node', [
    script, 'init', '--session-file', session, '--worktree', repo,
    '--ticket', 'FEA-1', '--parent-thread-id', 'parent-1', '--parent-cwd', repo,
    '--root-generation', '1', '--owner-id', 'worker-1', '--generation', '1',
    '--lease-id', 'lease-1', '--lease-token-hash', HASH_1,
  ]));
  const rebound = JSON.parse(run('node', [
    script, 'rebind-parent', '--session-file', session,
    '--expected-parent-thread-id', 'parent-1', '--expected-parent-cwd', repo,
    '--expected-root-generation', '1', '--parent-thread-id', 'parent-2',
    '--parent-cwd', repo,
  ]));
  assert.equal(rebound.ticketOwnerGeneration, 1);
  assert.equal(rebound.parentGeneration, 2);

  const prompt = join(state, 'rebound.txt');
  writeFileSync(prompt, event({
    id: randomUUID(),
    worktree: repo,
    rootGeneration: 2,
    parentThreadId: 'parent-2',
  }));
  const result = JSON.parse(run('node', [
    script, 'run', '--session-file', session, '--prompt-file', prompt,
    '--events-file', join(state, 'events.jsonl'), '--codex', fakeCodex,
  ]));
  assert.equal(result.event.root_generation, 2);
});
