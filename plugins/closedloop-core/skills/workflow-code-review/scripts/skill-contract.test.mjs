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

test('plan-structure gives detail-level plan-review suggestions an Implementation Notes section', () => {
  const resources = join(skillsRoot, 'plan-structure', 'resources');
  const h2 = readFileSync(join(resources, 'plan_template.md'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('## '));
  const at = (heading) => h2.indexOf(heading);
  assert.ok(at('## Implementation Notes') > at('## Tasks'), 'Implementation Notes follows Tasks');
  assert.ok(at('## Tasks') > at('## Acceptance Criteria'));
  assert.ok(at('## Implementation Notes') < at('## API & Data Impacts'), 'Implementation Notes precedes API & Data Impacts');
  const template = readFileSync(join(resources, 'plan_template.md'), 'utf8');
  assert.match(template, /## Implementation Notes\n\n\{\{detail_level_plan_review_suggestions_or_none\}\}/);
  const playbook = readFileSync(join(resources, 'playbook.md'), 'utf8');
  assert.match(playbook, /Task Table → Implementation Notes → API\/Data Impacts/);
});

// workflow-code-review is self-contained: it reads instructions only from its own folder.
const OUTSIDE_SKILL_READS = [
  /\bWORKFLOW_PROMPT_PACK_ROOT\b/,
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:PROMPT|PACK|LENS|SOUL|TEMPLATE)[A-Z0-9_]*\b/,
  /\bprompt[- ]pack\b/i,
  /\bSOUL\.md\b/,
  /\borchestrator\.md\b/,
  /(?:^|[\s`'"(])~\//m,
  /\/(?:Users|home)\/[A-Za-z]/,
  /\bCODEX_HOME\b|\.codex\/|\.claude\//,
  /\.\.\//,
];

test('workflow-code-review never reads prompt files from an env var or outside its folder', () => {
  const files = filesUnder(skillDir);
  assert.ok(files.some((file) => file.endsWith('review-lens-map.md')));
  const found = files.flatMap((file) => OUTSIDE_SKILL_READS
    .filter((pattern) => pattern.test(readFileSync(file, 'utf8')))
    .map((pattern) => `${relative(skillsRoot, file)}: ${pattern}`));
  assert.deepEqual(found, []);
});

test('workflow-code-review bundles every lens the lens map names and nothing else', () => {
  const references = join(skillDir, 'references');
  const mapped = new Set(
    [...readFileSync(join(references, 'review-lens-map.md'), 'utf8').matchAll(/`(lenses\/[A-Za-z0-9_./-]+\.md)`/g)]
      .map((match) => match[1]),
  );
  const bundled = filesUnder(join(references, 'lenses')).map((file) => relative(references, file));
  assert.ok(bundled.length > 0);
  assert.deepEqual(bundled.sort(), [...mapped].sort());
});
