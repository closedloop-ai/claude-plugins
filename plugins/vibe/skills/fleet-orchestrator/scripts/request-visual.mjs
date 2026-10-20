// Usage: node request-visual.mjs <requestsDir> <draftFile> [--worktree <dir>]
// Files a visual-work request drafted from the template in references/templates.md into <requestsDir> as
// <session>-<yyyymmdd-hhmm>-<slug>.md. Refuses (exit 1) unless the draft's "Pushed head" equals the PR's
// current head on the code host (gh) and the worktree's HEAD (default: the current directory), so a
// request can never name a local, unpushed commit. Every field must be filled in.
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isEntryPoint } from '../../codex-fleet-monitor/scripts/liveness.mjs';

const FIELDS = ['Session', 'PR', 'Pushed head', 'Where', 'Flags', 'Expected', 'Requirement'];
const TITLE = /^# Visual request: (.+)$/m;
const PR = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;
const STEP = /^\d+\. \S/m;
// A template placeholder: angle brackets around words with a space, or the bare <step>. A tag such as
// <Select> in a real value has no space, so it is not mistaken for one.
const PLACEHOLDER = /<[^<>]*\s[^<>]*>|<step>/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMAND_TIMEOUT_MS = 30_000;

/** Parses and checks a draft; returns its fields or throws naming what is missing. */
export function parseDraft(text) {
  const title = TITLE.exec(text)?.[1]?.trim();
  if (!title) throw new Error('draft has no "# Visual request: <title>" line');
  const fields = { title };
  for (const name of FIELDS) {
    const value = new RegExp(`^${name}: (.*)$`, 'm').exec(text)?.[1]?.trim();
    if (!value) throw new Error(`draft has no ${name} line`);
    fields[name] = value;
  }
  if (!STEP.test(text)) throw new Error('draft has no numbered step');
  const unfilled = PLACEHOLDER.exec(text)?.[0];
  if (unfilled) throw new Error(`draft still has a placeholder: ${unfilled}`);
  const pr = PR.exec(fields.PR);
  if (!pr) throw new Error(`PR must be <owner/repo>#<number>, not ${fields.PR}`);
  if (!SHA.test(fields['Pushed head'])) throw new Error(`Pushed head must be a full 40-character sha, not ${fields['Pushed head']}`);
  if (!SESSION.test(fields.Session)) throw new Error('Session must be letters, digits, dot, dash or underscore');
  return { ...fields, repo: pr[1], number: pr[2], head: fields['Pushed head'] };
}

/** Throws naming both shas when the draft's head is not the PR head, or the worktree is ahead of or behind it. */
export function checkHeads({ head, prHead, worktreeHead }) {
  if (head !== prHead) throw new Error(`Pushed head ${head} is not the PR's current head ${prHead}; push first and name the PR head`);
  if (worktreeHead !== prHead) {
    throw new Error(`worktree HEAD ${worktreeHead} differs from the PR's pushed head ${prHead}; push the local commits (or update the worktree) before requesting`);
  }
}

export function requestName(session, title, now) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'request';
  return `${session}-${stamp}-${slug}.md`;
}

export function readPrHead(repo, number) {
  try {
    return execFileSync('gh', ['pr', 'view', number, '-R', repo, '--json', 'headRefOid', '--jq', '.headRefOid'], {
      encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(`cannot read the head of ${repo}#${number} with gh, so nothing was filed: ${error.message.split('\n')[0]}`);
  }
}

export function readWorktreeHead(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(`cannot read the worktree HEAD in ${dir}: ${error.message.split('\n')[0]}`);
  }
}

/** Validates the draft and both heads, then writes the request through a dotfile so a lister never sees half of it. */
export function fileRequest({ dir, draftPath, worktree, now = new Date(), prHead = readPrHead, worktreeHead = readWorktreeHead }) {
  const text = readFileSync(draftPath, 'utf8');
  const draft = parseDraft(text);
  checkHeads({ head: draft.head, prHead: prHead(draft.repo, draft.number), worktreeHead: worktreeHead(worktree) });
  const name = requestName(draft.Session, draft.title, now);
  const temp = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(temp, text);
  renameSync(temp, join(dir, name));
  return join(dir, name);
}

function main() {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ allowPositionals: true, options: { worktree: { type: 'string' } } }));
    if (positionals.length !== 2) throw new Error('expected <requestsDir> <draftFile>');
  } catch (error) {
    console.error(`request-visual: ${error.message}`);
    process.exit(2);
  }
  try {
    console.log(fileRequest({ dir: positionals[0], draftPath: positionals[1], worktree: values.worktree ?? process.cwd() }));
  } catch (error) {
    console.error(`request-visual: refused: ${error.message}`);
    process.exit(1);
  }
}

if (isEntryPoint(import.meta.url)) main();
