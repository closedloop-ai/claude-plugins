import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** Values that belong in a user's config.env, never in the skill that every machine installs. */
const MACHINE_SPECIFIC = [
  ['absolute home path', /(?:\/Users|\/home)\/[A-Za-z0-9._-]+/],
  ['IPv4 address', /\b\d{1,3}(?:\.\d{1,3}){3}\b/],
  ['email address', /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/],
  ['ticket id', /\b[A-Z]{2,}-\d{2,}\b/],
  ['owner/repo#number reference', /\b[\w.-]+\/[\w.-]+#\d+/],
  // The plugin family's own tools (closedloop-graph, closedloop-core, vibe) may be named; the org and its repos may not.
  ['organization or repo name', /closed-?loop(?!-(?:graph|core)\b)|symphony|claude-plugins/i],
];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test('the skill carries no machine, account, repo or ticket specific values', () => {
  const found = [];
  for (const file of files(SKILL_DIR).filter((path) => path !== SELF)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      for (const [kind, pattern] of MACHINE_SPECIFIC) {
        const match = pattern.exec(line);
        if (match) found.push(`${relative(SKILL_DIR, file)}:${index + 1} ${kind}: ${match[0]}`);
      }
    });
  }
  assert.deepEqual(found, []);
});

test('each pattern catches the kind of value it names', () => {
  const samples = ['/Users/someone/x', '10.0.0.12', 'me@example.com', 'ABC-123', 'acme/app#42', 'ClosedLoop'];
  MACHINE_SPECIFIC.forEach(([kind, pattern], index) => assert.match(samples[index], pattern, kind));
  for (const allowed of ['closedloop-graph', 'closedloop-core', 'vibe:vibe']) {
    for (const [kind, pattern] of MACHINE_SPECIFIC) assert.doesNotMatch(allowed, pattern, `${kind} on ${allowed}`);
  }
  assert.match('closedloop-ai', MACHINE_SPECIFIC.at(-1)[1]);
});
