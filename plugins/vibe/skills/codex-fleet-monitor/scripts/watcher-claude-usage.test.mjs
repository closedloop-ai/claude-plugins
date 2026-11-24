import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordUsageReading } from './usage-state.mjs';

const WATCH = fileURLToPath(new URL('./watch.sh', import.meta.url));
const pr = 'pr acme/app#12 OPEN';
const at = (n) => `2026-11-20T04:00:${String(n).padStart(2, '0')}.000Z`;
const good = (time, { week = 'HIGH(90%)', source = 'snapshot', resets = '18:00' } = {}) =>
  `claude-usage local session=under80% week=${week} resets=${resets} read=${at(time)} source=${source}`;
const failed = (time, lastGood = at(0)) =>
  `claude-usage local unreadable READFAIL read=${at(time)} source=snapshot\nusage claude local READFAIL last-good=${lastGood}`;
const snapshot = (usage, ordinary = pr) => [usage, ordinary].filter(Boolean).join('\n');
const timeout = { timeout: 30_000 };

function sequence(t, initial = snapshot(good(0))) {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-claude-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const baseline = join(dir, 'last-snapshot.txt');
  const nextSnapshot = join(dir, 'fixture.sh');
  const ticks = join(dir, 'ticks');
  writeFileSync(baseline, initial + '\n');
  writeFileSync(nextSnapshot, `
read -r index < "$1/ticks"
(( index += 1 ))
print -r -- "$index" > "$1/ticks"
cat "$1/fixture-$index.txt"
`);
  return {
    dir,
    baseline,
    run(samples, heartbeat = samples.length) {
      writeFileSync(ticks, '0\n');
      samples.forEach((value, index) => writeFileSync(join(dir, `fixture-${index + 1}.txt`), value + '\n'));
      const result = spawnSync('zsh', [WATCH, dir, '1'], {
        encoding: 'utf8', timeout: 12_000,
        env: { ...process.env, WATCH_SNAPSHOT: nextSnapshot, HEARTBEAT_SECONDS: String(heartbeat) },
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return { stdout: result.stdout, ticks: Number(readFileSync(ticks, 'utf8')) };
    },
  };
}

function quiet(result, ticks) {
  assert.match(result.stdout, /^HEARTBEAT/m);
  assert.doesNotMatch(result.stdout, /^EVENT$/m);
  assert.equal(result.ticks, ticks);
}

function event(result, ticks) {
  assert.equal(result.ticks, ticks);
  assert.deepEqual(result.stdout.match(/^EVENT$/gm), ['EVENT']);
  assert.doesNotMatch(result.stdout, /^HEARTBEAT/m);
}

test('ISS-14476 suppresses READFAIL/same-band recovery/READFAIL even with both snapshot lines', timeout, (t) => {
  const fixture = sequence(t);
  const newest = snapshot(failed(3, at(2)));
  quiet(fixture.run([snapshot(failed(1)), snapshot(good(2, { source: 'status', resets: '23:00' })), newest]), 3);
  assert.equal(readFileSync(fixture.baseline, 'utf8'), newest + '\n');
});

test('ISS-14476 counts two distinct failed probes and rearms after silent same-band recovery', timeout, (t) => {
  const fixture = sequence(t);
  const cached = failed(1, at(8)).replace('source=snapshot', 'source=status');
  const first = fixture.run([snapshot(failed(1)), snapshot(cached), snapshot(failed(2))]);
  event(first, 3);
  assert.equal(first.stdout.match(/^> claude-usage local .*READFAIL/gm)?.length, 1);
  quiet(fixture.run([snapshot(failed(2)), snapshot(failed(3))]), 2);
  quiet(fixture.run([snapshot(good(4, { source: 'status' }))]), 1);
  const later = fixture.run([snapshot(failed(5, at(4))), snapshot(failed(6, at(4)))]);
  event(later, 2);
  assert.equal(later.stdout.match(/^> claude-usage local .*READFAIL/gm)?.length, 1);
});

test('ISS-14476 wakes immediately on a real band change and filters a coincident transient failure from an ordinary event', timeout, (t) => {
  const fixture = sequence(t);
  const next = 'pr acme/app#12 MERGED';
  const other = fixture.run([snapshot(failed(1), next)]);
  event(other, 1);
  assert.match(other.stdout, /^> pr acme\/app#12 MERGED$/m);
  assert.doesNotMatch(other.stdout, /claude-usage|usage claude/);
  const changed = fixture.run([snapshot(good(2, { week: 'HIGH(80%)' }), next)]);
  event(changed, 1);
  assert.match(changed.stdout, /^< claude-usage local .*week=HIGH\(90%\)/m);
  assert.match(changed.stdout, /^> claude-usage local .*week=HIGH\(80%\)/m);
});

test('ISS-14476 keeps Claude read, source, and reset metadata out of same-band wakes', timeout, (t) => {
  const fixture = sequence(t);
  quiet(fixture.run([snapshot(good(1, { source: 'status', resets: '22:00' })), snapshot(good(2, { source: 'board', resets: '23:00' }))]), 2);
});

test('ISS-14476 keeps known stale onset material and clears it silently on same-band recovery', timeout, (t) => {
  const fixture = sequence(t);
  const stale = snapshot(`${good(0)}\nusage claude local STALE last-good=${at(0)}`);
  const onset = fixture.run([stale]);
  event(onset, 1);
  assert.match(onset.stdout, /^> usage claude local STALE/m);
  quiet(fixture.run([stale, snapshot(good(1))]), 2);
  const nextStale = fixture.run([snapshot(`${good(1)}\nusage claude local STALE last-good=${at(1)}`)]);
  event(nextStale, 1);
});

test('ISS-14476 ignores missing, disabled, malformed and old Claude usage rows', timeout, (t) => {
  const fixture = sequence(t, snapshot(good(3)));
  const derivedOnly = `usage claude local READFAIL,STALE last-good=${at(3)}`;
  const malformed = 'claude-usage local unreadable READFAIL read=bad-date source=snapshot';
  const wrongShape = `claude-usage local unreadable READFAIL read=${at(4)} other=snapshot`;
  const invalidCalendar = 'claude-usage local unreadable READFAIL read=2026-11-31T04:00:09.000Z source=snapshot';
  quiet(fixture.run([snapshot(failed(1)), snapshot(''), snapshot(derivedOnly), snapshot(malformed),
    snapshot(wrongShape), snapshot(invalidCalendar), snapshot(failed(4, at(3)))]), 7);
  event(fixture.run([snapshot(failed(5, at(3)))]), 1);
  const recovered = fixture.run([snapshot(good(6))]);
  quiet(recovered, 1);
});

test('ISS-14476 treats deleting the baseline as a fresh start and counts only distinct cold failures', timeout, (t) => {
  const fixture = sequence(t);
  event(fixture.run([snapshot(failed(1)), snapshot(failed(2))]), 2);
  rmSync(fixture.baseline);
  const cold = fixture.run([snapshot(failed(2, 'none')), snapshot(failed(2, 'none')), snapshot(failed(3, 'none'))], 2);
  event(cold, 3);
});

test('ISS-14476 restores the earlier good band from telemetry on legacy re-arm with an unsupported checkpoint', timeout, (t) => {
  const fixture = sequence(t, snapshot(failed(2)));
  const current = good(3, { week: 'HIGH(80%)' });
  for (const [readAt, line] of [[at(0), good(0)], [at(3), current]]) {
    recordUsageReading(fixture.dir, { runtime: 'claude', machine: 'local', source: 'snapshot', status: 'ok', readAt, line });
  }
  writeFileSync(join(fixture.dir, 'watch-usage-state.json'), '{"version":99,"machines":{}}');
  const result = fixture.run([snapshot(current)]);
  event(result, 1);
  assert.match(result.stdout, /^< claude-usage local .*week=HIGH\(90%\)/m);
  assert.match(result.stdout, /^> claude-usage local .*week=HIGH\(80%\)/m);
});
