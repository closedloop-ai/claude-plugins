import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { lintPlan, parseArgs } from './check-plan.mjs';

const script = resolve(import.meta.dirname, 'check-plan.mjs');

const template = `# Implementation Plan: {{feature_name}}

## Summary

{{brief_description}}

## Acceptance Criteria

| ID | Criterion | Source |
|----|-----------|--------|
| AC-001 | {{criterion}} | {{prd_reference}} |

## Architecture Fit

{{how_this_fits_existing_architecture}}

## Tasks

- [ ] **T-1.1**: {{task_description}}

## Test Plan

- [ ] Unit: {{unit_test_coverage}}

## Rollback

{{rollback_strategy}}
`;

const before = '```mermaid\nflowchart LR\n  A[Old path] --> B[Owner]\n```';
const after = '```mermaid\nflowchart LR\n  A[New path] --> C[Owner]\n```';

function plan({
  title = '# Implementation Plan: Retry uploads',
  diagrams = `${before}\n\n${after}`,
  acceptance = '| AC-001 | Uploads retry once | PRD-1 R2 |\n| AC-002 | Failures surface | PRD-1 R3 |',
  tasks = '- [ ] **T-1.1**: Add retry in `uploader.ts` (AC-001)',
  testPlan = '- [ ] Unit: `uploader.test.ts` covers AC-001 and AC-002',
  summary = 'Uploads retry once before failing.',
  extraTop = '',
  architecture = '',
} = {}) {
  return `${title}

## Summary

${summary}
${extraTop}
## Acceptance Criteria

| ID | Criterion | Source |
|----|-----------|--------|
${acceptance}

## Architecture Fit

The uploader owns retries.

${diagrams}
${architecture}
## Tasks

${tasks}

## Test Plan

${testPlan}

## Rollback

Revert the commit.
`;
}

const messages = (text, options) => lintPlan(text, template, options).map((p) => p.message);

test('a complete plan passes', () => {
  assert.deepEqual(lintPlan(plan(), template), []);
});

test('reports a missing template heading and a heading out of order', () => {
  const missing = plan().replace('## Rollback\n\nRevert the commit.\n', '');
  assert.ok(messages(missing).includes('missing template heading "## Rollback"'));

  const swapped = plan().replace('## Summary', '## Tmp').replace('## Rollback', '## Summary').replace('## Tmp', '## Rollback');
  assert.ok(messages(swapped).some((m) => /out of template order/.test(m)));
});

test('requires the template title prefix', () => {
  assert.ok(messages(plan({ title: '# Plan for uploads' })).some((m) => /title must start with/.test(m)));
});

test('flags left-over template placeholders outside code fences', () => {
  assert.ok(messages(plan({ summary: '{{brief_description}}' })).includes('template placeholder left in the plan'));
  assert.deepEqual(messages(plan({ summary: '```text\n{{ok_in_code}}\n```' })), []);
});

test('requires a Mermaid flowchart and paired before and after flowcharts unless --narrow', () => {
  assert.ok(messages(plan({ diagrams: '' })).some((m) => /no Mermaid flowchart fence/.test(m)));
  assert.ok(messages(plan({ diagrams: '```mermaid\nsequenceDiagram\n  A->>B: hi\n```' })).some((m) => /no Mermaid flowchart/.test(m)));
  assert.ok(messages(plan({ diagrams: before })).some((m) => /paired before and after/.test(m)));
  assert.deepEqual(messages(plan({ diagrams: before }), { narrow: true }), []);
  const oneFence = '```mermaid\nflowchart LR\n  subgraph Before\n    A --> B\n  end\n  subgraph After\n    A --> C\n  end\n```';
  assert.deepEqual(messages(plan({ diagrams: oneFence })), []);
});

test('every AC- id maps to a task or a test', () => {
  const problems = lintPlan(plan({ testPlan: '- [ ] Unit: `uploader.test.ts` covers AC-001' }), template);
  assert.deepEqual(problems.map((p) => p.message), ['AC-002 is not mapped to any task or test']);
  assert.equal(problems[0].line, 12);
  assert.ok(messages(plan({ acceptance: '| none | Uploads retry | PRD-1 |' })).includes('Acceptance Criteria lists no AC- ids'));
});

test('flags revision narration and sweep internals but not code', () => {
  for (const line of [
    'This version fixes the retry bug the reviewer found.',
    'Unlike the previous draft, uploads retry once.',
    'Updated per review feedback.',
    'Addressing the reviewer\'s findings, we now retry.',
    'Changes since the last upload: none.',
  ]) {
    assert.ok(messages(plan({ summary: line })).some((m) => /revision narration/.test(m)), line);
  }
  for (const line of ['Emit CL_SWEEP_EVENT v1 when done.', 'Covered by review_generation_2.', 'Run $cl-sweep first.']) {
    assert.ok(messages(plan({ summary: line })).some((m) => /internal sweep/.test(m)), line);
  }
  assert.deepEqual(messages(plan({ summary: 'The previous release kept one retry.' })), []);
  assert.deepEqual(messages(plan({ summary: '```text\nThis version fixes it\n```' })), []);
});

test('--safety-fact and --bug require a named, backticked proof in the Test Plan', () => {
  assert.ok(messages(plan(), { safetyFact: true }).includes('--safety-fact: Test Plan has no entry'));
  const vague = plan({ testPlan: '- [ ] Unit: covers AC-001 and AC-002\n- [ ] Safety fact: retries reuse the same token' });
  assert.ok(messages(vague, { safetyFact: true }).some((m) => /--safety-fact: name the test/.test(m)));
  const proven = plan({
    testPlan: '- [ ] Unit: covers AC-001 and AC-002\n- [ ] Safety fact: retries reuse the same token,\n  proven by `pnpm vitest run uploader.token.test.ts`',
  });
  assert.deepEqual(messages(proven, { safetyFact: true }), []);

  assert.ok(messages(plan(), { bug: true }).includes('--bug: Test Plan has no entry'));
  const red = plan({ testPlan: '- [ ] Unit: covers AC-001 and AC-002\n- [ ] Red-first: `uploader.retry.test.ts` fails on main' });
  assert.deepEqual(messages(red, { bug: true }), []);
});

const costHeader = '| Option | Cost scales with | Per-device idle cost | At 10x / 100x | Existing mechanism reused |\n| --- | --- | --- | --- | --- |';
const pollRow = '| Poll the list every 60 s | connected clients | one wakeup and one request per minute | linear in installs | none |';
const relayRow = '| Hint over the relay socket | renames | none | linear in renames | relay socket |';
const costTable = (...rows) => `\n### Cost Scaling\n\n${[costHeader, ...rows].join('\n')}\n`;
const polling = 'Desktop polls the rename feed every 60 s.';

test('periodic or cross-surface work needs a Cost Scaling table', () => {
  assert.deepEqual(messages(plan({ summary: polling, architecture: costTable(pollRow, relayRow) })), []);

  const missing = lintPlan(plan({ summary: polling }), template);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].line, 5);
  assert.match(missing[0].message, /^"polls" names periodic or cross-surface work; add a ### Cost Scaling table/);

  assert.deepEqual(messages(plan({ summary: polling, architecture: costTable(relayRow) })), [
    '### Cost Scaling table needs at least two option rows',
  ]);
  const nothingReused = relayRow.replace(/relay socket \|$/, 'none |');
  assert.deepEqual(messages(plan({ summary: polling, architecture: costTable(pollRow, nothingReused) })), [
    '### Cost Scaling table needs a row that names an existing mechanism under "Existing mechanism reused"',
  ]);
  const noIdleColumn = costTable(pollRow, relayRow).replace(' Per-device idle cost |', '');
  assert.deepEqual(messages(plan({ summary: polling, architecture: noIdleColumn })), [
    '### Cost Scaling table is missing column(s): Per-device idle cost',
  ]);
});

test('plans without periodic work, or waived with --no-periodic, need no Cost Scaling table', () => {
  assert.deepEqual(messages(plan()), []);
  assert.deepEqual(messages(plan({ summary: '```text\nsetInterval(poll, 5000)\n```' })), []);
  for (const line of ['A watcher re-reads the file.', 'Open a websocket per tab.', 'Run it from cron.', 'A heartbeat every 30s.']) {
    assert.ok(messages(plan({ summary: line })).some((m) => /Cost Scaling/.test(m)), line);
  }
  assert.deepEqual(messages(plan({ summary: polling }), { noPeriodic: true }), []);
});

test('parses flags and rejects bad arguments', () => {
  assert.deepEqual(parseArgs(['p.md', '--bug', '--narrow', '--template', 't.md']), {
    file: 'p.md',
    options: { bug: true, safetyFact: false, narrow: true, noPeriodic: false, template: 't.md' },
  });
  assert.equal(parseArgs(['p.md', '--no-periodic', '--template', 't.md']).options.noPeriodic, true);
  assert.throws(() => parseArgs([]), /exactly one plan file/);
  assert.throws(() => parseArgs(['p.md', '--nope']), /unknown flag/);
  assert.throws(() => parseArgs(['p.md']), /pass --template/);
  assert.throws(() => parseArgs(['p.md', '--template']), /needs a path/);
});

test('CLI prints file:line problems and exits 0, 1, or 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-plan-'));
  const templatePath = join(dir, 'template.md');
  writeFileSync(templatePath, template);
  const good = join(dir, 'good.md');
  writeFileSync(good, plan());
  const bad = join(dir, 'bad.md');
  writeFileSync(bad, plan({ diagrams: '' }));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  const ok = run(good, '--template', templatePath);
  assert.equal(ok.status, 0, ok.stderr);
  const failing = run(bad, '--template', templatePath);
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, new RegExp(`${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:1: no Mermaid flowchart fence`));
  assert.equal(run(good, '--template', join(dir, 'absent.md')).status, 2);
  assert.equal(run().status, 2);
  assert.equal(run(good).status, 2);
});
