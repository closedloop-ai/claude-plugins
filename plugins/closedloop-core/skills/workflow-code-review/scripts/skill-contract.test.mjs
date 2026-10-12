import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

const skillDir = resolve(import.meta.dirname, '..');
const skillsRoot = resolve(skillDir, '..');

// Every non-test file under a directory, so new references are covered without editing this list.
const filesUnder = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && !/\.test\.[cm]?js$/.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name));

// Reviewers are the same model family as the worker. These phrases only appear when text
// asks for a reviewer from the other family.
const OTHER_FAMILY_REVIEWER = /\b(?:cross|other|opposite)[- ]family\b|\b(?:second|different|other|another) model famil(?:y|ies)\b/i;
// A Claude Code reviewer launched from Codex, or a Codex reviewer launched from Claude Code.
const OTHER_HARNESS_CLI = /\bcodex\s+(?:exec|e)\b|\bclaude\s+(?:-p|--print)\b/;

const hits = (files, pattern) => files
  .filter((file) => pattern.test(readFileSync(file, 'utf8')))
  .map((file) => relative(skillsRoot, file));

test('no closedloop-core skill asks for a reviewer from the other model family', () => {
  const markdown = filesUnder(skillsRoot).filter((file) => file.endsWith('.md'));
  assert.ok(markdown.length > 10, 'skill markdown discovery found too few files');
  assert.deepEqual(hits(markdown, OTHER_FAMILY_REVIEWER), []);
});

test('workflow-code-review reviewers never run through the other harness CLI', () => {
  assert.deepEqual(hits(filesUnder(skillDir), OTHER_HARNESS_CLI), []);
});

test('workflow-code-review states the same-family reviewer rule', () => {
  const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(skill, /Reviewer workers are always the same model family as the caller/);
  assert.match(skill, /Never shell\s+out to another harness's CLI for a review lane/);
});
