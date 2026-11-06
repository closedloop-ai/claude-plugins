import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classify, CLASSES } from '../../vibe/scripts/vibe-triage.mjs';
import { chooseDispatch, claudeHigh, codexHigh, freshReading, QaGuide, routeClass, Runtime } from './dispatch-route.mjs';

const SCRIPT = fileURLToPath(new URL('./dispatch-route.mjs', import.meta.url));
const CODEX_OK = 'codex-usage local under80% ok resets=0';
const CODEX_HIGH = 'codex-usage local HIGH(90%) ok resets=0';
const CLAUDE_OK = 'claude-usage local session=under80% week=under80%';
const CLAUDE_HIGH = 'claude-usage local session=under80% week=HIGH(90%) resets=Oct_27';

const manifestFor = (request, paths = []) => classify({ request, paths, pathSources: paths.map((path) => ({ path, source: 'brief' })) });

test('usage lines are read as the watcher prints them, and an unreadable one is neither high nor ok', () => {
  assert.equal(codexHigh(CODEX_OK), false);
  assert.equal(codexHigh(CODEX_HIGH), true);
  assert.equal(codexHigh('codex-usage local under80% LIMIT resets=0'), true, 'a limit is high whatever the band');
  assert.equal(codexHigh('codex-usage local unreadable READFAIL'), null);
  assert.equal(codexHigh(undefined), null);
  assert.equal(claudeHigh(CLAUDE_OK), false);
  assert.equal(claudeHigh(CLAUDE_HIGH), true);
  assert.equal(claudeHigh('claude-usage local unreadable READFAIL'), null);
  assert.equal(codexHigh('codex-usage local ?% unknown resets=0'), null, 'a reading with no percentage says nothing');
  assert.equal(claudeHigh('claude-usage local session=unknown week=unknown'), null);
  assert.equal(claudeHigh('claude-usage local session=under80% week=unknown'), null, 'an unknown band beside a low one is not proof of room');
  assert.equal(claudeHigh('claude-usage local session=HIGH(90%) week=unknown'), true, 'a known high band stands');
});

test('a reading counts only with a valid read time no older than the staleness bound', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const at = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();
  assert.equal(freshReading(CODEX_HIGH, at(60), { now }), CODEX_HIGH);
  assert.equal(freshReading(CODEX_HIGH, now - 60_000, { now }), CODEX_HIGH, 'epoch milliseconds read as well');
  assert.equal(freshReading(CODEX_HIGH, undefined, { now }), null, 'no read time');
  assert.equal(freshReading(CODEX_HIGH, 'not a time', { now }), null);
  assert.equal(freshReading(CODEX_HIGH, at(31 * 60), { now }), null, 'past the 30 minute bound');
  assert.equal(freshReading(CODEX_HIGH, at(31 * 60), { now, staleSeconds: 3600 }), CODEX_HIGH);
  assert.equal(freshReading(CODEX_HIGH, new Date(now + 60_000).toISOString(), { now }), null, 'a read time in the future');
  assert.equal(freshReading(undefined, at(1), { now }), null);
});

test('a class chooses its runtime and a high band moves it only when the other runtime is not high', () => {
  assert.equal(routeClass({ manifestClass: CLASSES.TrivialUi }).runtime, Runtime.Codex);
  assert.equal(routeClass({ manifestClass: CLASSES.UiFeature }).runtime, Runtime.Claude);
  assert.equal(routeClass({ manifestClass: CLASSES.TrivialUi, codexIsHigh: true, claudeIsHigh: false }).runtime, Runtime.Claude);
  assert.equal(routeClass({ manifestClass: CLASSES.UiFeature, codexIsHigh: false, claudeIsHigh: true }).runtime, Runtime.Codex);
  assert.equal(routeClass({ manifestClass: CLASSES.TrivialUi, codexIsHigh: true, claudeIsHigh: true }).runtime, Runtime.Codex, 'both high keeps the class choice');
  assert.equal(routeClass({ manifestClass: CLASSES.TrivialUi, codexIsHigh: true, claudeIsHigh: null }).runtime, Runtime.Codex, 'an unreadable other side is not proof it has room');
  assert.doesNotMatch(JSON.stringify(routeClass({ manifestClass: CLASSES.Backend })), /gpt|opus|sonnet|haiku|model/i);
});

test('the QA guide is skipped only for docs-config; trivial-ui still changes UI and keeps its guide', () => {
  const guide = (cls) => routeClass({ manifestClass: cls }).qaGuide;
  assert.equal(guide(CLASSES.DocsConfig), QaGuide.Skip);
  assert.deepEqual([CLASSES.TrivialUi, CLASSES.UiFeature, CLASSES.Backend, CLASSES.DataMetric, CLASSES.Mockup].map(guide), Array(5).fill(QaGuide.Launch));
});

test('off, an invalid manifest and class unknown are today: no runtime named and the QA guide launches', () => {
  const valid = manifestFor('fix the copy on the pricing page', ['apps/app/pricing.tsx']);
  assert.equal(valid.class, CLASSES.TrivialUi);
  const off = chooseDispatch({ enabled: false, manifest: valid, codexUsage: CODEX_OK, claudeUsage: CLAUDE_OK });
  assert.deepEqual([off.routed, off.runtime, off.qaGuide], [false, null, QaGuide.Launch]);
  const broken = chooseDispatch({ enabled: true, manifest: { class: 'backend' } });
  assert.deepEqual([broken.routed, broken.runtime, broken.qaGuide], [false, null, QaGuide.Launch]);
  assert.equal(chooseDispatch({ enabled: true, manifest: null }).routed, false);
  const unknown = chooseDispatch({ enabled: true, manifest: manifestFor('make it better') });
  assert.deepEqual([unknown.routed, unknown.class, unknown.qaGuide], [false, null, QaGuide.Launch]);
  const now = Date.parse('2026-11-05T12:00:00Z');
  const fresh = new Date(now - 60_000).toISOString();
  const on = chooseDispatch({ enabled: true, manifest: valid, codexUsage: CODEX_HIGH, claudeUsage: CLAUDE_OK, codexReadAt: fresh, claudeReadAt: fresh, now });
  assert.deepEqual([on.routed, on.class, on.runtime, on.qaGuide], [true, CLASSES.TrivialUi, Runtime.Claude, QaGuide.Launch]);
  const noReadTime = chooseDispatch({ enabled: true, manifest: valid, codexUsage: CODEX_HIGH, claudeUsage: CLAUDE_OK, now });
  assert.equal(noReadTime.runtime, Runtime.Codex, 'a line with no read time never moves a writer');
  const stale = new Date(now - 3 * 3600 * 1000).toISOString();
  assert.equal(chooseDispatch({ enabled: true, manifest: valid, codexUsage: CODEX_HIGH, claudeUsage: CLAUDE_OK, codexReadAt: stale, claudeReadAt: fresh, now }).runtime, Runtime.Codex, 'a stale line never moves a writer');
  const unknownReading = chooseDispatch({ enabled: true, manifest: valid, codexUsage: 'codex-usage local ?% unknown resets=0', claudeUsage: CLAUDE_OK, codexReadAt: fresh, claudeReadAt: fresh, now });
  assert.equal(unknownReading.runtime, Runtime.Codex, 'an unknown reading never moves a writer');
});

test('the CLI honours the environment switch and reads the manifest file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-'));
  const file = join(dir, 'triage.json');
  writeFileSync(file, JSON.stringify(manifestFor('fix the copy on the pricing page', ['apps/app/pricing.tsx'])));
  const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, FLEET_CLASS_ROUTING: '', ...env } });
  const off = JSON.parse(run(['--manifest', file]).stdout);
  assert.deepEqual([off.routed, off.runtime], [false, null]);
  const on = JSON.parse(run(['--manifest', file, '--codex-usage', CODEX_OK], { FLEET_CLASS_ROUTING: '1' }).stdout);
  assert.deepEqual([on.schema, on.routed, on.runtime, on.qaGuide], ['vibe.fleet-dispatch-route/1', true, Runtime.Codex, QaGuide.Launch]);
  const missing = JSON.parse(run(['--manifest', join(dir, 'none.json'), '--enable']).stdout);
  assert.equal(missing.routed, false);
  assert.equal(run([]).status, 2);
});
