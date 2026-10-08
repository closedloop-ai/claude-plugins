import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Capture a PID's immutable process-start token and command digest. */
export function captureProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  let output;
  try {
    output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  const match = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+)$/.exec(output);
  if (!match) return null;
  return {
    pid,
    startToken: match[1],
    commandSha256: sha256(match[2]),
  };
}

/** Compare a live PID to a previously captured process instance. */
export function verifyProcessIdentity(expected, capture = captureProcessIdentity) {
  if (!expected || !Number.isSafeInteger(expected.pid) || !expected.startToken || !expected.commandSha256) {
    return { alive: Boolean(expected?.pid && capture(expected.pid)), matches: false, reason: 'missing_process_identity' };
  }
  const actual = capture(expected.pid);
  if (!actual) return { alive: false, matches: false, reason: 'process_absent', actual: null };
  const matches = actual.startToken === expected.startToken && actual.commandSha256 === expected.commandSha256;
  return { alive: true, matches, reason: matches ? 'exact_process' : 'pid_reused_or_command_changed', actual };
}
