import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classify, CLASSES } from '../../vibe/scripts/vibe-triage.mjs';
import { chooseDispatch, claudeHigh, codexHigh, QaGuide, routeClass, Runtime } from './dispatch-route.mjs';

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

test('the QA guide is skipped only for the small-ticket classes', () => {
  const guide = (cls) => routeClass({ manifestClass: cls }).qaGuide;
  assert.deepEqual([CLASSES.TrivialUi, CLASSES.DocsConfig].map(guide), [QaGuide.Skip, QaGuide.Skip]);
  assert.deepEqual([CLASSES.UiFeature, CLASSES.Backend, CLASSES.DataMetric, CLASSES.Mockup].map(guide), Array(4).fill(QaGuide.Launch));
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
  const on = chooseDispatch({ enabled: true, manifest: valid, codexUsage: CODEX_HIGH, claudeUsage: CLAUDE_OK });
  assert.deepEqual([on.routed, on.class, on.runtime, on.qaGuide], [true, CLASSES.TrivialUi, Runtime.Claude, QaGuide.Skip]);
});

test('the CLI honours the environment switch and reads the manifest file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-'));
  const file = join(dir, 'triage.json');
  writeFileSync(file, JSON.stringify(manifestFor('fix the copy on the pricing page', ['apps/app/pricing.tsx'])));
  const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, FLEET_CLASS_ROUTING: '', ...env } });
  const off = JSON.parse(run(['--manifest', file]).stdout);
  assert.deepEqual([off.routed, off.runtime], [false, null]);
  const on = JSON.parse(run(['--manifest', file, '--codex-usage', CODEX_OK], { FLEET_CLASS_ROUTING: '1' }).stdout);
  assert.deepEqual([on.schema, on.routed, on.runtime, on.qaGuide], ['vibe.fleet-dispatch-route/1', true, Runtime.Codex, QaGuide.Skip]);
  const missing = JSON.parse(run(['--manifest', join(dir, 'none.json'), '--enable']).stdout);
  assert.equal(missing.routed, false);
  assert.equal(run([]).status, 2);
});
