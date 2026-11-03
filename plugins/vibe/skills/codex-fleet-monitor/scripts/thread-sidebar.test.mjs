import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// ISS-13279: every session a plugin script starts becomes a chat in the person's desktop app sidebar. A Codex
// thread/start gets a name, the Fleet workers section and the hidden marker; a headless Claude run gets a name,
// or saves no session.
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const SOURCE = /\.(?:mjs|cjs|js|ts)$/;
const SKIPPED = /(?:\.test\.|\.black-box\.|test-fixtures|test-support|\/dist\/|\/node_modules\/|\/evals\/)/;
const THREAD_START = /['"]thread\/start['"]/;
const CLAUDE_PRINT = /['"](?:-p|--print)['"]/;
const CLAUDE_BINARY = /['"]claude['"]|CLAUDE_BIN|\bclaude\s*=/;
const WORKER_SOURCE_SENT = /threadSource:\s*WORKER_THREAD_SOURCE\b/;
const SESSION_TITLE = /['"]--(?:name|no-session-persistence)['"]/;

function sources(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !SKIPPED.test(file));
}

/** Every runtime source in a plugin, plus the TypeScript sources that build a plugin's dist bundles. */
function runtimeSources() {
  const tools = join(ROOT, 'tools');
  const toolSources = existsSync(tools)
    ? readdirSync(tools).flatMap((name) => sources(join(tools, name, 'src')))
    : [];
  return [...sources(join(ROOT, 'plugins')), ...toolSources];
}

function unlabeledSpawns(files) {
  const found = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (THREAD_START.test(text) && !text.includes('labelWorkerThread')) {
      found.push(`${relative(ROOT, file)}: thread/start without labelWorkerThread (thread-sidebar.mjs)`);
    }
    if (THREAD_START.test(text) && !WORKER_SOURCE_SENT.test(text)) {
      found.push(`${relative(ROOT, file)}: thread/start without threadSource WORKER_THREAD_SOURCE (thread-sidebar.mjs)`);
    }
    if (CLAUDE_PRINT.test(text) && CLAUDE_BINARY.test(text) && !SESSION_TITLE.test(text)) {
      found.push(`${relative(ROOT, file)}: headless claude run without --name or --no-session-persistence`);
    }
  }
  return found;
}

test('every plugin script that starts a Codex thread or a headless Claude run titles it or saves nothing', () => {
  const files = runtimeSources();
  assert.ok(files.some((file) => file.endsWith('codex-session.mjs')), 'the scan reaches the plugin scripts');
  assert.deepEqual(unlabeledSpawns(files), []);
});
