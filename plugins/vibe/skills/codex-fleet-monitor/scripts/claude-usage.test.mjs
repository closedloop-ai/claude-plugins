import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { claudeUsageLine, DEFAULT_TIMEOUT_SECONDS, parseUsage, recordClaudeUsageProbe, usageTimeoutMilliseconds } from './claude-usage.mjs';
import { readUsageReadings, usageStatuses, usageWatchLines } from './usage-state.mjs';

// The real `claude -p "/usage"` lines, as the operator's session printed them.
const REAL = [
  'Current session: 51% used · resets Oct 22 at 12:39pm (America/Chicago)',
  'Current week (all models): 69% used · resets Oct 27 at 9am (America/Chicago)',
].join('\n');

const CURRENT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current week (all models): 64% used · resets Nov 9 at 2pm (America/Chicago)',
  'Current week (Fable): 54% used · resets Nov 9 at 2pm (America/Chicago)',
  '',
  "What's contributing to your usage?",
].join('\n');

const SCRIPT = fileURLToPath(new URL('./claude-usage.mjs', import.meta.url));

function runReader(dir, fake, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, dir, 'local'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_BIN: fake, ...extraEnv },
  });
}

test('parses the session and all-models weekly usage from the real /usage output', () => {
  assert.deepEqual(parseUsage(REAL), {
    session: { used: 51, resets: 'Oct 22 at 12:39pm (America/Chicago)' },
    week: { used: 69, resets: 'Oct 27 at 9am (America/Chicago)' },
  });
  assert.equal(parseUsage('Usage is not available in this mode.'), null);
});

test('current output without a session line reports an unknown session and the weekly band', () => {
  assert.equal(claudeUsageLine('local', parseUsage(CURRENT), 80), 'claude-usage local session=unknown week=under80%');
});

test('invalid timeout values use 90 seconds and an exact fractional millisecond value is accepted', () => {
  assert.equal(usageTimeoutMilliseconds('1.0001'), 90_000);
  assert.equal(usageTimeoutMilliseconds('Infinity'), 90_000);
  assert.equal(usageTimeoutMilliseconds('0.05'), 50);
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-timeout-value-'));
  const fake = join(dir, 'claude');
  writeFileSync(fake, `#!/bin/sh\ncat <<'USAGE'\n${CURRENT}\nUSAGE\n`);
  chmodSync(fake, 0o755);
  for (const value of ['1.0001', 'Infinity']) {
    const result = runReader(mkdtempSync(join(tmpdir(), 'claude-usage-timeout-run-')), fake, { CLAUDE_USAGE_TIMEOUT_SECONDS: value });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /session=unknown week=under80%/, `a malformed ${value} override must not discard a working probe`);
  }
});

for (const [name, ending] of [['times out', 'exec sleep 5'], ['exits nonzero', 'exit 1']]) {
  test(`parses output already printed when the probe ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-usage-thrown-'));
    const fake = join(dir, 'claude');
    writeFileSync(fake, `#!/bin/sh\ncat <<'USAGE'\n${CURRENT}\nUSAGE\n${ending}\n`);
    chmodSync(fake, 0o755);
    const started = Date.now();
    const result = runReader(dir, fake, name === 'times out' ? { CLAUDE_USAGE_TIMEOUT_SECONDS: '1' } : {});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^claude-usage local session=unknown week=under80% read=\S+ source=claude-usage$/);
    if (name === 'times out') assert.ok(Date.now() - started < 4_000, 'the configured timeout ends the 5-second probe early');
  });
}

test('one failed read reuses a recent good line, while a repeated failure reports READFAIL', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-retry-'));
  const fake = join(dir, 'claude');
  writeFileSync(fake, `#!/bin/sh\ncat <<'USAGE'\n${CURRENT}\nUSAGE\n`);
  chmodSync(fake, 0o755);
  const good = runReader(dir, fake, { CLAUDE_USAGE_SECONDS: '2' });
  assert.equal(good.status, 0, good.stderr);
  assert.doesNotMatch(good.stdout, /READFAIL/);

  writeFileSync(fake, '#!/bin/sh\nexit 1\n');
  await sleep(2200);
  const first = runReader(dir, fake, { CLAUDE_USAGE_SECONDS: '2' });
  assert.equal(first.stdout, good.stdout, 'the recent good line and its read time remain visible');
  assert.equal(readUsageReadings(dir).at(-1).status, 'readfail');
  assert.deepEqual(usageWatchLines(usageStatuses(readUsageReadings(dir)), { claudeIntervalSeconds: 2 }), []);

  await sleep(2200);
  const second = runReader(dir, fake, { CLAUDE_USAGE_SECONDS: '2' });
  assert.match(second.stdout, /^claude-usage local unreadable READFAIL read=\S+ source=claude-usage$/m);
  assert.match(usageWatchLines(usageStatuses(readUsageReadings(dir)), { claudeIntervalSeconds: 2 }).join('\n'), /READFAIL/);
});

test('concurrent failed probes reuse the good line at most once and leave READFAIL cached', { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-concurrent-'));
  const fake = join(dir, 'claude');
  writeFileSync(fake, `#!/bin/sh\ncat <<'USAGE'\n${CURRENT}\nUSAGE\n`);
  chmodSync(fake, 0o755);
  const good = runReader(dir, fake, { CLAUDE_USAGE_SECONDS: '4' });
  assert.equal(good.status, 0, good.stderr);
  writeFileSync(fake, '#!/bin/sh\nexit 1\n');
  await sleep(4200);

  const lock = join(dir, '.usage-readings.lock');
  writeFileSync(lock, `${process.pid}\n`);
  const fixture = join(dir, 'probe.mjs');
  writeFileSync(fixture, `import { recordClaudeUsageProbe } from ${JSON.stringify(new URL('./claude-usage.mjs', import.meta.url).href)};
const [dir, readAt] = process.argv.slice(2);
process.send({ type: 'before-record' });
console.log(recordClaudeUsageProbe(dir, 'local', null, { readAt, source: 'claude-usage', interval: 4 }));
`);
  const probes = [];
  t.after(() => {
    rmSync(lock, { force: true });
    for (const { child } of probes) if (child.exitCode === null) child.kill('SIGKILL');
  });
  const startProbe = (readAt) => {
    const child = fork(fixture, [dir, readAt], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const atRecord = new Promise((resolve, reject) => {
      child.on('message', (message) => { if (message?.type === 'before-record') resolve(); });
      child.once('exit', (code) => reject(new Error(`probe exited before record: ${code} ${stderr}`)));
    });
    const completed = new Promise((resolve) => child.once('close', (code) => resolve({ code, stdout, stderr })));
    const probe = { child, atRecord, completed };
    probes.push(probe);
    return probe;
  };
  const failedAt = Date.now();
  const first = startProbe(new Date(failedAt).toISOString());
  const second = startProbe(new Date(failedAt + 1).toISOString());
  await Promise.all([first.atRecord, second.atRecord]);
  rmSync(lock);

  const results = await Promise.all([first.completed, second.completed]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(results.filter((result) => result.stdout === good.stdout).length, 1, 'only the first committed failure may reuse the good line');
  assert.equal(results.filter((result) => /unreadable READFAIL/.test(result.stdout)).length, 1);
  assert.match(readFileSync(join(dir, 'claude-usage.txt'), 'utf8'), /unreadable READFAIL/);
  assert.equal(readUsageReadings(dir).filter((reading) => reading.status === 'readfail').length, 2);
});

test('an older failure completing after a newer success keeps the success cached', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-order-'));
  const newer = recordClaudeUsageProbe(dir, 'local', parseUsage(CURRENT), {
    readAt: '2026-11-03T18:00:00.000Z', source: 'test', interval: 600,
  });
  const older = recordClaudeUsageProbe(dir, 'local', null, {
    readAt: '2026-11-03T17:59:00.000Z', source: 'test', interval: 600,
  });
  assert.equal(older, newer);
  assert.equal(readFileSync(join(dir, 'claude-usage.txt'), 'utf8'), `${newer}\n`);
  assert.equal(usageStatuses(readUsageReadings(dir), { now: Date.parse('2026-11-03T18:00:00.000Z') })[0].status, 'ok');
});

test('an older success completing after a newer failure reuses only that recent good line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-reverse-order-'));
  const failed = recordClaudeUsageProbe(dir, 'local', null, {
    readAt: '2026-11-03T18:00:00.000Z', source: 'test', interval: 600,
  });
  assert.match(failed, /unreadable READFAIL/);
  const displayed = recordClaudeUsageProbe(dir, 'local', parseUsage(CURRENT), {
    readAt: '2026-11-03T17:59:00.000Z', source: 'test', interval: 600,
  });
  assert.match(displayed, /session=unknown week=under80%/);
  assert.equal(readFileSync(join(dir, 'claude-usage.txt'), 'utf8'), `${displayed}\n`);
  const rows = usageStatuses(readUsageReadings(dir), { now: Date.parse('2026-11-03T18:00:00.000Z') });
  assert.equal(rows[0].status, 'readfail');
  assert.deepEqual(usageWatchLines(rows), []);
});

test('the line uses the Codex bands: one band below the threshold, HIGH with the reset time from it', () => {
  assert.equal(claudeUsageLine('local', parseUsage(REAL), 80), 'claude-usage local session=under80% week=under80%');
  const high = parseUsage(REAL.replace('51%', '86%'));
  assert.equal(claudeUsageLine('local', high, 80), 'claude-usage local session=HIGH(80%) week=under80% resets=Oct_22_at_12:39pm_(America/Chicago)');
  assert.equal(claudeUsageLine('local', parseUsage(REAL.replace('69%', '95%')), 80), 'claude-usage local session=under80% week=HIGH(90%) resets=Oct_27_at_9am_(America/Chicago)');
  assert.equal(claudeUsageLine('local', null), 'claude-usage local unreadable READFAIL');
});

// A saved `/usage` transcript is imported into the Codex app's sidebar as an "Imported session" chat (ISS-13279).
test('the usage probe runs claude without saving a session', () => {
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 90);
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-'));
  const fake = join(dir, 'claude');
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dir, 'args.txt'))}\nprintf '%s\\n' ${JSON.stringify(REAL)}\n`);
  chmodSync(fake, 0o755);
  const result = runReader(dir, fake);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^claude-usage local session=.* read=\S+ source=claude-usage$/);
  assert.deepEqual(readFileSync(join(dir, 'args.txt'), 'utf8').trim().split('\n'), ['-p', '--no-session-persistence', '/usage']);
  const persisted = readUsageReadings(dir).find((reading) => reading.runtime === 'claude');
  assert.equal(persisted.runtime, 'claude');
  assert.equal(persisted.source, 'claude-usage');
  assert.ok(Number.isFinite(Date.parse(persisted.readAt)));
});
