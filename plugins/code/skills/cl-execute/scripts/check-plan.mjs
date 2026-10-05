#!/usr/bin/env node
// Mechanical linter for cl-execute implementation plans. It checks only rules
// a script can decide; the plan reviewer still judges substance.
//
// Usage: check-plan.mjs <plan.md> [--template <path>] [--bug] [--safety-fact] [--narrow]
// Exit 0 when clean, 1 when it printed problems, 2 on a usage or input error.
//
// The approach (a plan linter run before hand-back) follows pstack's
// poteto-mode/scripts/check-plan.mjs (MIT, copyright 2026 Lauren Tan); the
// rules here are cl-execute's own.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_TEMPLATE = join(
  homedir(),
  'Source/claude-plugins/plugins/code/skills/plan-structure/resources/plan_template.md',
);

const REVISION_NARRATION = [
  /\b(?:previous|prior|earlier|last|original) (?:version|draft|revision|iteration) of (?:this|the) plan\b/i,
  /\b(?:previous|prior|earlier) (?:plan|draft|revision)\b/i,
  /\bthis (?:version|revision|draft|iteration|update) (?:now )?(?:fixes|addresses|adds|removes|changes|corrects|resolves)\b/i,
  /\b(?:revised|updated|changed) (?:per|after|based on|in response to) (?:the )?(?:plan )?(?:review|reviewer|feedback)\b/i,
  /\baddress(?:es|ed|ing)? (?:the )?(?:plan )?reviewer(?:'s)? (?:feedback|findings|comments)\b/i,
  /\baddress(?:es|ed|ing)? (?:the )?(?:plan )?review (?:feedback|findings|comments)\b/i,
  /\b(?:changelog|change log|revision history|changes since)\b/i,
];

const SWEEP_INTERNALS = [
  /\bCL_SWEEP_(?:EVENT|RESULT)\b/,
  /\breview_generation_[12]\b/,
  /\$cl-(?:sweep|execute|analyze)\b/,
  /\bsupport lanes?\b/i,
];

const FENCE = /^\s*(```|~~~)/;

function scan(text) {
  const lines = text.split('\n');
  const info = [];
  let inFence = false;
  let fenceLang = '';
  for (const line of lines) {
    const fence = FENCE.test(line);
    if (fence && !inFence) {
      inFence = true;
      fenceLang = line.trim().replace(/^(```|~~~)/, '').trim().toLowerCase();
      info.push({ line, inFence: true, fenceStart: true, lang: fenceLang });
      continue;
    }
    if (fence && inFence) {
      info.push({ line, inFence: true, fenceEnd: true, lang: fenceLang });
      inFence = false;
      fenceLang = '';
      continue;
    }
    info.push({ line, inFence, lang: inFence ? fenceLang : '' });
  }
  return info;
}

function headings(info, level) {
  const prefix = `${'#'.repeat(level)} `;
  const out = [];
  info.forEach((entry, index) => {
    if (!entry.inFence && entry.line.startsWith(prefix)) {
      out.push({ title: entry.line.slice(prefix.length).trim(), line: index + 1 });
    }
  });
  return out;
}

function sections(info) {
  const h2 = headings(info, 2);
  const map = new Map();
  h2.forEach((heading, i) => {
    const end = i + 1 < h2.length ? h2[i + 1].line - 1 : info.length;
    map.set(heading.title, { start: heading.line, end });
  });
  return map;
}

function sectionLines(info, bounds) {
  if (!bounds) return [];
  const out = [];
  for (let n = bounds.start; n <= bounds.end; n += 1) out.push({ n, ...info[n - 1] });
  return out;
}

// A bullet or paragraph block: from the matching line to the next blank line
// or the next bullet at any depth.
function blockFrom(lines, index) {
  const block = [lines[index]];
  for (let i = index + 1; i < lines.length; i += 1) {
    const text = lines[i].line;
    if (!text.trim() || /^\s*(?:[-*+]|\d+\.)\s/.test(text) || /^#/.test(text)) break;
    block.push(lines[i]);
  }
  return block.map((entry) => entry.line).join('\n');
}

function mermaidFlowcharts(info) {
  const fences = [];
  let current = null;
  info.forEach((entry, index) => {
    if (entry.fenceStart && entry.lang === 'mermaid') {
      current = { line: index + 1, body: [] };
    } else if (entry.fenceEnd && current) {
      fences.push(current);
      current = null;
    } else if (current) {
      current.body.push(entry.line);
    }
  });
  return fences
    .map((fence) => {
      const first = fence.body.find((l) => l.trim() && !l.trim().startsWith('%%')) ?? '';
      return { ...fence, isFlowchart: /^\s*(?:flowchart|graph)\b/i.test(first) };
    })
    .filter((fence) => fence.isFlowchart);
}

export function lintPlan(planText, templateText, options = {}) {
  const problems = [];
  const add = (line, message) => problems.push({ line, message });
  const plan = scan(planText);
  const template = scan(templateText);

  // 1. Title and template H2 headings, in the template's order.
  const templateH1 = headings(template, 1)[0];
  if (templateH1) {
    const titlePrefix = templateH1.title.split('{{')[0].trim();
    const planH1 = headings(plan, 1)[0];
    if (!planH1 || !planH1.title.startsWith(titlePrefix)) {
      add(planH1?.line ?? 1, `title must start with "# ${titlePrefix}"`);
    }
  }
  const wanted = headings(template, 2).map((h) => h.title);
  const present = headings(plan, 2);
  let cursor = 0;
  for (const title of wanted) {
    const found = present.find((h) => h.title === title);
    if (!found) {
      add(1, `missing template heading "## ${title}"`);
      continue;
    }
    if (found.line < cursor) add(found.line, `heading "## ${title}" is out of template order`);
    cursor = Math.max(cursor, found.line);
  }

  // 2. Left-over template placeholders.
  plan.forEach((entry, index) => {
    if (!entry.inFence && /\{\{[^}]*\}\}/.test(entry.line)) {
      add(index + 1, 'template placeholder left in the plan');
    }
  });

  // 3. Mermaid scope flowcharts.
  const flowcharts = mermaidFlowcharts(plan);
  if (flowcharts.length === 0) {
    add(1, 'no Mermaid flowchart fence (```mermaid with flowchart or graph)');
  } else if (!options.narrow) {
    const pairedInOne = flowcharts.some((fence) => {
      const subgraphs = fence.body.filter((l) => /^\s*subgraph\b/i.test(l)).join('\n');
      return /before|current/i.test(subgraphs) && /after|planned/i.test(subgraphs);
    });
    if (flowcharts.length < 2 && !pairedInOne) {
      add(
        flowcharts[0].line,
        'expected paired before and after flowcharts (two fences, or before/after subgraphs); pass --narrow only for simple or narrow work',
      );
    }
  }

  // 4. Every AC- id maps to a task or a test.
  const bySection = sections(plan);
  const acLines = sectionLines(plan, bySection.get('Acceptance Criteria'));
  if (bySection.has('Acceptance Criteria')) {
    const ids = new Map();
    for (const entry of acLines) {
      if (entry.inFence) continue;
      for (const match of entry.line.matchAll(/\bAC-\d+\b/g)) {
        if (!ids.has(match[0])) ids.set(match[0], entry.n);
      }
    }
    if (ids.size === 0) add(bySection.get('Acceptance Criteria').start, 'Acceptance Criteria lists no AC- ids');
    const mapped = ['Tasks', 'Test Plan']
      .flatMap((name) => sectionLines(plan, bySection.get(name)))
      .map((entry) => entry.line)
      .join('\n');
    for (const [id, line] of ids) {
      if (!new RegExp(`\\b${id}\\b`).test(mapped)) add(line, `${id} is not mapped to any task or test`);
    }
  }

  // 5. Revision narration and sweep internals stay out of reviewed plans.
  plan.forEach((entry, index) => {
    if (entry.inFence) return;
    if (REVISION_NARRATION.some((re) => re.test(entry.line))) {
      add(index + 1, 'revision narration; state the requirement, gate, or risk forward-looking instead');
    }
    if (SWEEP_INTERNALS.some((re) => re.test(entry.line))) {
      add(index + 1, 'internal sweep or worker detail; keep it out of the reviewed plan');
    }
  });

  // 6. Flagged fields in the Test Plan.
  const testPlan = sectionLines(plan, bySection.get('Test Plan')).filter((entry) => !entry.inFence);
  const flagged = (label, pattern, message) => {
    const index = testPlan.findIndex((entry) => pattern.test(entry.line));
    if (index < 0) {
      add(bySection.get('Test Plan')?.start ?? 1, `${label}: Test Plan has no entry`);
      return;
    }
    if (!/`[^`]+`/.test(blockFrom(testPlan, index))) add(testPlan[index].n, `${label}: ${message}`);
  };
  if (options.safetyFact) {
    flagged('--safety-fact', /safety fact/i, 'name the test, script, or pnpm control command that proves it, in backticks');
  }
  if (options.bug) {
    flagged('--bug', /red-first/i, 'name the red-first test in backticks');
  }

  return problems.sort((a, b) => a.line - b.line);
}

export function parseArgs(argv) {
  const options = { bug: false, safetyFact: false, narrow: false, template: DEFAULT_TEMPLATE };
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bug') options.bug = true;
    else if (arg === '--safety-fact') options.safetyFact = true;
    else if (arg === '--narrow') options.narrow = true;
    else if (arg === '--template') {
      options.template = argv[i + 1];
      i += 1;
      if (!options.template) throw new Error('--template needs a path');
    } else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else files.push(arg);
  }
  if (files.length !== 1) throw new Error('pass exactly one plan file');
  return { file: files[0], options };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `check-plan: ${error.message}\nusage: check-plan.mjs <plan.md> [--template <path>] [--bug] [--safety-fact] [--narrow]\n`,
    );
    return 2;
  }
  let planText;
  let templateText;
  try {
    planText = readFileSync(parsed.file, 'utf8');
  } catch (error) {
    process.stderr.write(`check-plan: cannot read plan ${parsed.file}: ${error.message}\n`);
    return 2;
  }
  try {
    templateText = readFileSync(parsed.options.template, 'utf8');
  } catch (error) {
    process.stderr.write(`check-plan: cannot read template ${parsed.options.template}: ${error.message}; pass --template\n`);
    return 2;
  }
  const problems = lintPlan(planText, templateText, parsed.options);
  for (const problem of problems) process.stdout.write(`${parsed.file}:${problem.line}: ${problem.message}\n`);
  if (problems.length) {
    process.stderr.write(`check-plan: ${problems.length} problem(s)\n`);
    return 1;
  }
  process.stdout.write(`check-plan: ${parsed.file} passes\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
