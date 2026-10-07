import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve(import.meta.dirname, 'decision-log.sh');
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });

test('writes a private TSV with a header and one sanitized row per call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-log-'));
  const log = join(dir, 'nested', 'decisions.tsv');

  assert.equal(run(log, 'plan', 'chose a retry queue', 'one owner', 'commit abc123', 'VERIFIED').status, 0);
  assert.equal(run(log, 'start', 'resumed ticket', 'new worker\tafter\ncompaction', '=HYPERLINK("x")', '-1').status, 0);

  const rows = readFileSync(log, 'utf8').trimEnd().split('\n');
  assert.equal(rows[0], 'ts\tphase\tdecision\twhy\tevidence\tresult');
  assert.equal(rows.length, 3);
  const cells = rows[2].split('\t');
  assert.equal(cells.length, 6);
  assert.match(cells[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(cells[3], 'new worker after compaction');
  assert.equal(cells[4], `'=HYPERLINK("x")`);
  assert.equal(cells[5], "'-1");
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700);
});

test('rejects a call without exactly six arguments', () => {
  const result = run('only', 'two');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: decision-log\.sh/);
});

test('carries the MIT notice for the copied pstack script', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /show-me-your-work\/scripts\/log\.sh/);
  assert.match(source, /MIT License/);
  assert.match(source, /Copyright \(c\) 2026 Lauren Tan/);
});
