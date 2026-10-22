import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ownership-lease.mjs', import.meta.url));

function invoke(args) {
  return JSON.parse(execFileSync('node', [script, ...args], { encoding: 'utf8' }));
}

function expireOnlyRecord(ledger) {
  const record = JSON.parse(readFileSync(ledger, 'utf8'));
  record.expiresAt = '2000-01-01T00:00:00.000Z';
  delete record.hash;
  record.hash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  writeFileSync(ledger, `${JSON.stringify(record)}\n`);
}

function failedInvoke(args, message) {
  const result = spawnSync('node', [script, ...args], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
}

test('scope exclusions refuse ownership changes while allowing inspection and cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'cl-scope-exclusions-test-'));
  const ledger = join(root, 'ownership.jsonl');
  const excludedSecret = join(root, 'excluded.secret.json');
  const unaffectedSecret = join(root, 'unaffected.secret.json');
  const rootSecret = join(root, 'root.secret.json');
  const exclusionsPath = join(root, 'scope-exclusions.json');
  const owner = ['--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-1'];
  invoke(['acquire', '--ledger', ledger, '--ticket', 'ISS-10793', ...owner, '--secret-output', excludedSecret]);
  writeFileSync(exclusionsPath, JSON.stringify({
    schema: 'CL_SWEEP_SCOPE_EXCLUSIONS v1',
    sweepId: 'PRO-69',
    projectId: 'PRO-69',
    excludedTickets: [
      { ticket: 'ISS-10793', reason: 'Removed from this sweep', reincludeWhen: 'Explicit operator instruction' },
      { ticket: 'ISS-10797', reason: 'Removed from this sweep', reincludeWhen: 'Explicit operator instruction' },
      { ticket: '@sweep-root', reason: 'Root exemption check', reincludeWhen: 'Never' },
    ],
  }));

  failedInvoke(['acquire', '--ledger', ledger, '--ticket', 'ISS-10797', ...owner, '--secret-output', join(root, 'new.secret.json')], /ISS-10797 is excluded/);
  failedInvoke(['renew', '--ledger', ledger, '--ticket', 'ISS-10793', '--secret-file', excludedSecret], /ISS-10793 is excluded/);
  for (const command of ['replace', 'transfer']) {
    failedInvoke([command, '--ledger', ledger, '--ticket', 'ISS-10793', '--secret-file', excludedSecret, ...owner, '--secret-output', join(root, `${command}.secret.json`)], /ISS-10793 is excluded/);
  }
  assert.equal(invoke(['status', '--ledger', ledger, '--ticket', 'ISS-10793']).active, true);
  assert.equal(invoke(['acquire', '--ledger', ledger, '--ticket', 'ISS-OTHER', ...owner, '--secret-output', unaffectedSecret]).event, 'ACQUIRE');
  assert.equal(invoke(['acquire', '--ledger', ledger, '--ticket', '@sweep-root', '--owner-surface', 'cli', '--owner-role', 'root', '--owner-id', 'root', '--secret-output', rootSecret, '--ttl-seconds', 'persistent']).event, 'ACQUIRE');
  assert.equal(invoke(['release', '--ledger', ledger, '--ticket', 'ISS-10793', '--secret-file', excludedSecret, '--reason', 'terminal_cleanup']).event, 'RELEASE');
  assert.equal(existsSync(excludedSecret), false);
});

test('malformed scope exclusions fail closed for ownership changes without blocking cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'cl-scope-exclusions-invalid-test-'));
  const ledger = join(root, 'ownership.jsonl');
  const secret = join(root, 'owned.secret.json');
  const owner = ['--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-1'];
  invoke(['acquire', '--ledger', ledger, '--ticket', 'ISS-OWNED', ...owner, '--secret-output', secret]);
  const exclusionsPath = join(root, 'scope-exclusions.json');
  for (const malformed of [
    '{',
    JSON.stringify({ schema: 'CL_SWEEP_SCOPE_EXCLUSIONS v1', sweepId: 'PRO-69', projectId: 'PRO-69', excludedTickets: [{ ticket: 'ISS-OTHER', reason: 'Removed' }] }),
    JSON.stringify({ schema: 'CL_SWEEP_SCOPE_EXCLUSIONS v1', sweepId: 'PRO-69', projectId: 'PRO-69', excludedTickets: [], unexpected: true }),
  ]) {
    writeFileSync(exclusionsPath, malformed);
    failedInvoke(['acquire', '--ledger', ledger, '--ticket', 'ISS-OTHER', ...owner, '--secret-output', join(root, 'other.secret.json')], /Invalid scope exclusions file/);
    failedInvoke(['renew', '--ledger', ledger, '--ticket', 'ISS-OWNED', '--secret-file', secret], /Invalid scope exclusions file/);
  }
  assert.equal(invoke(['status', '--ledger', ledger, '--ticket', 'ISS-OWNED']).active, true);
  assert.equal(invoke(['release', '--ledger', ledger, '--ticket', 'ISS-OWNED', '--secret-file', secret, '--reason', 'terminal_cleanup']).event, 'RELEASE');
});

test('ownership remains available when the scope exclusions file is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'cl-scope-exclusions-absent-test-'));
  const ledger = join(root, 'ownership.jsonl');
  const secret = join(root, 'owner.secret.json');
  const acquired = invoke(['acquire', '--ledger', ledger, '--ticket', 'ISS-10793', '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-1', '--secret-output', secret]);
  assert.equal(acquired.event, 'ACQUIRE');
  assert.equal(invoke(['renew', '--ledger', ledger, '--ticket', 'ISS-10793', '--secret-file', secret]).event, 'RENEW');
});

test('stores only token hashes in the append-only ledger and rotates private secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'cl-lease-test-'));
  const ledger = join(root, 'ownership.jsonl');
  const firstSecret = join(root, 'first.secret.json');
  const secondSecret = join(root, 'second.secret.json');
  const thirdSecret = join(root, 'third.secret.json');
  const desktopFence = join(root, 'desktop-fence.json');
  const first = invoke(['acquire', '--ledger', ledger, '--ticket', 'FEA-1', '--owner-surface', 'desktop', '--owner-role', 'ticket_worker', '--owner-id', 'thread-1', '--secret-output', firstSecret, '--ttl-seconds', '60']);
  const firstPrivate = JSON.parse(readFileSync(firstSecret, 'utf8'));
  assert.equal(statSync(firstSecret).mode & 0o777, 0o600);
  assert.equal(first.leaseTokenHash, firstPrivate.leaseTokenHash);
  assert.equal(first.leaseId, firstPrivate.leaseId);
  assert.equal('leaseToken' in first, false);
  assert.equal('token' in first, false);

  const duplicate = spawnSync('node', [script, 'acquire', '--ledger', ledger, '--ticket', 'FEA-1', '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-2', '--secret-output', secondSecret], { encoding: 'utf8' });
  assert.notEqual(duplicate.status, 0);

  const unfenced = spawnSync('node', [script, 'transfer', '--ledger', ledger, '--ticket', 'FEA-1', '--secret-file', firstSecret, '--secret-output', secondSecret, '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-2', '--reason', 'desktop_cli_cutover'], { encoding: 'utf8' });
  assert.notEqual(unfenced.status, 0);
  assert.match(unfenced.stderr, /--desktop-fence-file is required/);
  const fence = { schema: 'CL_SWEEP_DESKTOP_FENCE v1', ticket: 'FEA-1', ownerId: 'thread-1', generation: 1, taskState: 'paused', activeTurn: false, activeToolCall: false, activeImplementationWorker: false, pendingMutation: false, acknowledgedAt: '2026-08-14T10:00:00.000Z', observedAt: '2026-08-14T10:00:01.000Z' };
  writeFileSync(desktopFence, `${JSON.stringify({ ...fence, activeTurn: true })}\n`);
  const activeTurn = spawnSync('node', [script, 'transfer', '--ledger', ledger, '--ticket', 'FEA-1', '--secret-file', firstSecret, '--secret-output', secondSecret, '--desktop-fence-file', desktopFence, '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-2', '--reason', 'desktop_cli_cutover'], { encoding: 'utf8' });
  assert.notEqual(activeTurn.status, 0);
  assert.match(activeTurn.stderr, /does not prove pause\/idle/);
  writeFileSync(desktopFence, `${JSON.stringify(fence)}\n`);
  const transferred = invoke(['transfer', '--ledger', ledger, '--ticket', 'FEA-1', '--secret-file', firstSecret, '--secret-output', secondSecret, '--desktop-fence-file', desktopFence, '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-2', '--reason', 'desktop_cli_cutover', '--ttl-seconds', '60']);
  assert.equal(transferred.generation, 2);
  assert.match(transferred.desktopFence.sha256, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(firstSecret), false);

  const stale = spawnSync('node', [script, 'renew', '--ledger', ledger, '--ticket', 'FEA-1', '--secret-file', firstSecret], { encoding: 'utf8' });
  assert.notEqual(stale.status, 0);

  const replacement = invoke(['replace', '--ledger', ledger, '--ticket', 'FEA-1', '--secret-file', secondSecret, '--secret-output', thirdSecret, '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-3', '--reason', 'worker_exit', '--ttl-seconds', '60']);
  assert.equal(replacement.generation, 3);
  assert.equal(existsSync(secondSecret), false);
  const renewed = invoke(['renew', '--ledger', ledger, '--ticket', 'FEA-1', '--secret-file', thirdSecret, '--ttl-seconds', '60']);
  assert.equal(renewed.generation, 3);
  const released = invoke(['release', '--ledger', ledger, '--ticket', 'FEA-1', '--secret-file', thirdSecret, '--reason', 'terminal_cleanup']);
  assert.equal(released.event, 'RELEASE');
  assert.equal(existsSync(thirdSecret), false);

  const ledgerText = readFileSync(ledger, 'utf8');
  assert.equal(ledgerText.includes(firstPrivate.token), false);
  for (const record of ledgerText.trim().split('\n').map(JSON.parse)) {
    assert.equal('leaseToken' in record, false);
    assert.equal('token' in record, false);
    assert.match(record.leaseTokenHash, /^[a-f0-9]{64}$/);
  }
  assert.equal(invoke(['status', '--ledger', ledger, '--ticket', 'FEA-1']).active, false);
});

test('lease expiry alone cannot fence a prior Desktop owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'cl-lease-test-'));
  const ledger = join(root, 'ownership.jsonl');
  const secret = join(root, 'desktop.secret.json');
  invoke(['acquire', '--ledger', ledger, '--ticket', 'FEA-3', '--owner-surface', 'desktop', '--owner-role', 'ticket_worker', '--owner-id', 'thread-3', '--secret-output', secret]);
  expireOnlyRecord(ledger);
  const replacementSecret = join(root, 'replacement.secret.json');
  const result = spawnSync('node', [script, 'acquire', '--ledger', ledger, '--ticket', 'FEA-3', '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-3', '--secret-output', replacementSecret], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expired ownership requires authenticated replace/);
  assert.equal(existsSync(replacementSecret), false);
});

test('expired ownership permits only authenticated terminal release or generation replace', () => {
  const root = mkdtempSync(join(tmpdir(), 'cl-expired-release-test-'));
  const ledger = join(root, 'ownership.jsonl');
  const secret = join(root, 'owner.secret.json');
  const wrongLedger = join(root, 'wrong-ownership.jsonl');
  const wrongSecret = join(root, 'wrong.secret.json');
  const transferSecret = join(root, 'transfer.secret.json');

  invoke([
    'acquire', '--ledger', ledger, '--ticket', 'ISS-EXPIRED',
    '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-1',
    '--secret-output', secret, '--ttl-seconds', '60',
  ]);
  invoke([
    'acquire', '--ledger', wrongLedger, '--ticket', 'ISS-WRONG',
    '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-2',
    '--secret-output', wrongSecret, '--ttl-seconds', '60',
  ]);
  expireOnlyRecord(ledger);

  const wrong = spawnSync('node', [
    script, 'release', '--ledger', ledger, '--ticket', 'ISS-EXPIRED',
    '--secret-file', wrongSecret, '--reason', 'terminal_cleanup',
  ], { encoding: 'utf8' });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /Lease secret does not match current generation/);
  assert.equal(existsSync(secret), true);

  for (const command of ['renew', 'transfer']) {
    const args = [script, command, '--ledger', ledger, '--ticket', 'ISS-EXPIRED', '--secret-file', secret];
    if (command === 'transfer') {
      args.push(
        '--secret-output', transferSecret,
        '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-3',
        '--reason', 'must_not_rotate',
      );
    }
    const result = spawnSync('node', args, { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Current lease is expired/);
  }
  assert.equal(existsSync(transferSecret), false);

  const released = invoke([
    'release', '--ledger', ledger, '--ticket', 'ISS-EXPIRED',
    '--secret-file', secret, '--reason', 'terminal_cleanup',
  ]);
  assert.equal(released.event, 'RELEASE');
  assert.equal(released.generation, 1);
  assert.equal(existsSync(secret), false);
  assert.equal(invoke(['status', '--ledger', ledger, '--ticket', 'ISS-EXPIRED']).active, false);

  const repeated = spawnSync('node', [
    script, 'release', '--ledger', ledger, '--ticket', 'ISS-EXPIRED',
    '--secret-file', secret, '--reason', 'terminal_cleanup',
  ], { encoding: 'utf8' });
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /is already released/);
});

test('root ownership remains active until explicit generation transfer or release', () => {
  const root = mkdtempSync(join(tmpdir(), 'cl-root-lease-test-'));
  const ledger = join(root, 'ownership.jsonl');
  const firstSecret = join(root, 'root-1.secret.json');
  const secondSecret = join(root, 'root-2.secret.json');
  const acquired = invoke([
    'acquire', '--ledger', ledger, '--ticket', '@sweep-root',
    '--owner-surface', 'cli', '--owner-role', 'root', '--owner-id', 'root-1',
    '--secret-output', firstSecret, '--ttl-seconds', 'persistent',
  ]);
  assert.equal(acquired.expiresAt, null);
  assert.equal(invoke(['status', '--ledger', ledger, '--ticket', '@sweep-root']).active, true);
  const transferred = invoke([
    'replace', '--ledger', ledger, '--ticket', '@sweep-root',
    '--secret-file', firstSecret, '--secret-output', secondSecret,
    '--owner-surface', 'cli', '--owner-role', 'root', '--owner-id', 'root-2',
    '--ttl-seconds', 'persistent', '--reason', 'root_adoption',
  ]);
  assert.equal(transferred.generation, 2);
  assert.equal(transferred.expiresAt, null);
  assert.equal(existsSync(firstSecret), false);
  invoke([
    'release', '--ledger', ledger, '--ticket', '@sweep-root',
    '--secret-file', secondSecret, '--reason', 'terminal',
  ]);
  assert.equal(invoke(['status', '--ledger', ledger, '--ticket', '@sweep-root']).active, false);

  const invalid = spawnSync('node', [
    script, 'acquire', '--ledger', join(root, 'ticket.jsonl'), '--ticket', 'ISS-1',
    '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-1',
    '--secret-output', join(root, 'ticket.secret.json'), '--ttl-seconds', 'persistent',
  ], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Only root ownership may use a persistent lifetime/);
});

test('rejects permissive secret storage and a modified ledger hash chain', () => {
  const root = mkdtempSync(join(tmpdir(), 'cl-lease-test-'));
  const ledger = join(root, 'ownership.jsonl');
  const secret = join(root, 'secret.json');
  invoke(['acquire', '--ledger', ledger, '--ticket', 'FEA-2', '--owner-surface', 'cli', '--owner-role', 'ticket_worker', '--owner-id', 'worker-1', '--secret-output', secret]);
  chmodSync(secret, 0o644);
  const permissive = spawnSync('node', [script, 'renew', '--ledger', ledger, '--ticket', 'FEA-2', '--secret-file', secret], { encoding: 'utf8' });
  assert.notEqual(permissive.status, 0);
  assert.match(permissive.stderr, /mode 0600/);
  chmodSync(secret, 0o600);
  const record = JSON.parse(readFileSync(ledger, 'utf8'));
  record.ownerId = 'tampered';
  writeFileSync(ledger, `${JSON.stringify(record)}\n`);
  const result = spawnSync('node', [script, 'status', '--ledger', ledger, '--ticket', 'FEA-2'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid append-only ownership ledger/);
});
