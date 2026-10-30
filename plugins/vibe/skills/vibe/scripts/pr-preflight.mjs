#!/usr/bin/env node
// The pull request title and body checks a code host gate would run, before
// the pull request opens or its title or body changes. A fix pull request once
// failed the metadata gate on a 73-character title: the squash subject is the
// title plus the ` (#<n>)` the host appends, and the limit counts both. Another
// merged on a regenerated baseline called "pixel-identical" to CI from a broken
// compare; it differed by about 3,900 pixels. So a line claiming a result is
// identical, matches or shows no difference carries the measured count.
//
// Usage: pr-preflight.mjs --title "<title>" [--body-file <file>] [--worktree <dir> --base <sha>] [--pr <number>] [--max <72>]
//
// Without --pr the suffix is counted at five digits. Prints {"ok","problems"}
// and exits 1 on any problem. Worktree checks retain a content-addressed receipt
// in Git metadata. --verify-receipt <sha256> checks exact inputs; --publish
// create|update requires that receipt plus --repo and publishes its verified
// body bytes on stdin. --base-ref names the target branch (default main), and
// --head-oid binds the pushed branch commit that GitHub must still expose.

import { sameSource, sourceIdentity, validSourceIdentity, withStableSource } from "./tested-head.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import { pointerProblems } from "./publishable-text.mjs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isVisualBaseline, visualBaselineLedgerProblems } from "../../handoff/scripts/visual-baseline-ledger.mjs";

const CLAIM = /\b(?:(?:pixel|byte)[- ]identical|identical to|no (?:visual |pixel )?(?:diffs?|differences?)\b|match(?:es|ing)? (?:the )?(?:CI|baseline|snapshot|reference|golden|Linux|main)\b)/i;
const MEASURED = /\b\d[\d,.]*\s*(?:%|px\b|pixels?\b|bytes?\b|lines?\b|differ\w*|diffs?\b|of\s+\d)/i;

/** Problems with a pull request title: its length with the ` (#<n>)` suffix the host appends. */
export function titleProblems(title, { pr = null, max = 72 } = {}) {
  const suffix = ` (#${pr ?? "99999"})`.length;
  const total = title.trim().length + suffix;
  return total > max ? [`title is ${total} characters with the ${suffix}-character " (#n)" suffix; the limit is ${max}`] : [];
}

/** Body lines that claim an identical or matching result without the measured count. */
export function claimProblems(body) {
  return body.split("\n").flatMap((line, index) => CLAIM.test(line) && !MEASURED.test(line)
    ? [`line ${index + 1}: comparison needs a measured pixel/byte count`] : []);
}

/** Changed visual baselines between the session base and its current working tree, including new baselines. */
export function changedVisualBaselines(worktree, base) {
  const changed = execFileSync("git", ["-C", worktree, "diff", "--name-only", "-z", "--diff-filter=ACMRT", base, "--"], { encoding: "utf8" });
  const untracked = execFileSync("git", ["-C", worktree, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
  return [...new Set([...changed.split("\0"), ...untracked.split("\0")].filter(isVisualBaseline))];
}

const HASH = /^[a-f0-9]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function inputBytes(file, label) {
  try { return readFileSync(file); }
  catch { throw new Error(`INPUT-UNREADABLE ${label}`); }
}

function gitValue(worktree, args) {
  try { return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('WORKTREE-INPUT-UNAVAILABLE'); }
}

function publicRef(worktree, ref) {
  if (ref !== 'HEAD') gitValue(worktree, ['check-ref-format', '--branch', ref]);
  return ref;
}

/** A deterministic receipt names inputs by hashes, with public repository context only. */
function exactReceipt(values, inspected) {
  const payload = {
    version: 1,
    titleSha256: sha256(values.title),
    bodySha256: sha256(inspected.bodyBytes),
    baseInputSha256: sha256(values.base),
    baseOid: inspected.baseOid,
    source: inspected.source,
    context: inspected.context,
    max: inspected.max,
  };
  return { ...payload, sha256: sha256(JSON.stringify(payload)) };
}

function receiptLocation(worktree, digest) {
  if (!HASH.test(digest)) throw new Error('RECEIPT-INVALID digest');
  return path.join(gitValue(worktree, ['rev-parse', '--absolute-git-dir']), 'vibe-pr-preflight', `${digest}.json`);
}

function readReceipt(worktree, digest) {
  try {
    const file = receiptLocation(worktree, digest);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { throw new Error('RECEIPT-UNREADABLE'); }
}

/** Store immutable, content-addressed evidence in Git metadata; never store title/body text. */
function retainReceipt(worktree, receipt) {
  const file = receiptLocation(worktree, receipt.sha256);
  const dir = path.dirname(file);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('invalid');
    writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
  } catch (error) {
    if (error.code !== 'EEXIST' || JSON.stringify(readReceipt(worktree, receipt.sha256)) !== JSON.stringify(receipt)) {
      throw new Error('RECEIPT-STORAGE-FAILED');
    }
  }
}

function inspectInputs(values) {
  const inspect = () => {
    const bodyBytes = values['body-file'] ? inputBytes(values['body-file'], 'body') : Buffer.alloc(0);
    let body;
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes); }
    catch { throw new Error('BODY-ENCODING-INVALID'); }
    const max = Number(values.max ?? 72);
    if (!Number.isSafeInteger(max) || max <= 0) throw new Error('INPUT-INVALID max');
    const baseOid = values.worktree ? gitValue(values.worktree, ['rev-parse', '--verify', '--end-of-options', `${values.base}^{commit}`]) : null;
    const context = values.worktree ? {
      repo: values.repo ?? null,
      baseRef: publicRef(values.worktree, values['base-ref'] ?? 'main'),
      headRef: publicRef(values.worktree, gitValue(values.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])),
      headOid: values['head-oid'] ?? null,
      pr: values.pr ?? null,
    } : null;
    if (values.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo)) throw new Error('INPUT-INVALID repository');
    if (values.pr && !/^[1-9][0-9]*$/.test(values.pr)) throw new Error('INPUT-INVALID PR');
    if (values['head-oid'] && !/^[a-f0-9]{40}$/i.test(values['head-oid'])) throw new Error('INPUT-INVALID head OID');
    const problems = [
      ...titleProblems(values.title, { pr: values.pr ?? null, max }),
      ...claimProblems(body),
      ...pointerProblems(body).map(problem => `body line ${problem.line}: ${problem.kind}`),
      ...pointerProblems(values.title).map(problem => `title line ${problem.line}: ${problem.kind}`),
      ...visualBaselineLedgerProblems(body, values.worktree ? changedVisualBaselines(values.worktree, baseOid) : []),
    ];
    if (values['body-file'] && !inputBytes(values['body-file'], 'body').equals(bodyBytes)) throw new Error('SOURCE-MOVED body input');
    if (values.worktree && (gitValue(values.worktree, ['rev-parse', '--verify', '--end-of-options', `${values.base}^{commit}`]) !== baseOid
      || gitValue(values.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']) !== context.headRef)) throw new Error('SOURCE-MOVED base/context');
    return { ok: problems.length === 0, problems, bodyBytes, baseOid, context, max };
  };
  return values.worktree ? withStableSource(values.worktree, inspect) : inspect();
}

/** Verify again at the write boundary, then give gh the accepted in-memory bytes on stdin. */
function publishExact(values, inspected) {
  const context = inspected.context;
  if (!values.worktree || !values['body-file'] || !context?.repo || context.headRef === 'HEAD'
    || !/^[a-f0-9]{40}$/i.test(context.headOid ?? '') || !validSourceIdentity(inspected.source)
    || context.headOid !== inspected.source.head
    || inspected.source.diffSha256 !== sha256(Buffer.alloc(0))
    || !['create', 'update'].includes(values.publish) || (values.publish === 'update') !== Boolean(context.pr)) {
    throw new Error('PUBLICATION-CONTEXT-INVALID');
  }
  let privateBody = false;
  try {
    const metadata = realpathSync(gitValue(values.worktree, ['rev-parse', '--absolute-git-dir']));
    const file = realpathSync(values['body-file']);
    privateBody = file.startsWith(`${metadata}${path.sep}`) && lstatSync(values['body-file']).isFile() && !lstatSync(values['body-file']).isSymbolicLink();
  } catch { /* Fail closed below. */ }
  if (!privateBody) throw new Error('PUBLICATION-CONTEXT-INVALID private body');
  if (values.publish === 'update') {
    let target;
    try {
      target = JSON.parse(execFileSync('gh', ['pr', 'view', context.pr, '--repo', context.repo, '--json', 'baseRefName,headRefName,headRefOid'], { encoding: 'utf8', input: '', stdio: ['pipe', 'pipe', 'pipe'] }));
    } catch { throw new Error('PUBLICATION-TARGET-UNAVAILABLE'); }
    if (target.baseRefName !== context.baseRef || target.headRefName !== context.headRef || target.headRefOid !== context.headOid) {
      throw new Error('PUBLICATION-TARGET-MISMATCH');
    }
  } else {
    let headOid;
    try {
      headOid = execFileSync('gh', ['api', `repos/${context.repo}/git/ref/heads/${context.headRef}`, '--jq', '.object.sha'], {
        encoding: 'utf8', input: '', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch { throw new Error('PUBLICATION-TARGET-UNAVAILABLE'); }
    if (headOid !== context.headOid) throw new Error('PUBLICATION-TARGET-MISMATCH');
  }
  if (!sameSource(inspected.source, sourceIdentity(values.worktree))) throw new Error('SOURCE-MOVED before publication');
  const args = values.publish === 'create'
    ? ['pr', 'create', '--repo', context.repo, '--base', context.baseRef, '--head', context.headRef]
    : ['pr', 'edit', context.pr, '--repo', context.repo];
  args.push('--title', values.title, '--body-file', '-');
  const result = spawnSync('gh', args, { input: inspected.bodyBytes, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error('PUBLICATION-FAILED');
  // gh diagnostics can quote private input. Emit only a verified PR URL, never raw stdout/stderr.
  const url = result.stdout.trim().split(/\s+/).find(candidate => {
    try {
      const parsed = new URL(candidate);
      const parts = parsed.pathname.split('/');
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
        && parts.length === 5 && `${parts[1]}/${parts[2]}` === context.repo && parts[3] === 'pull' && /^[1-9][0-9]*$/.test(parts[4]);
    } catch { return false; }
  }) ?? null;
  return { action: values.publish, url };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    title: { type: 'string' }, 'body-file': { type: 'string' }, worktree: { type: 'string' }, base: { type: 'string' },
    pr: { type: 'string' }, max: { type: 'string' }, repo: { type: 'string' }, 'base-ref': { type: 'string' },
    'head-oid': { type: 'string' }, 'verify-receipt': { type: 'string' }, publish: { type: 'string' },
  } });
  if (!values.title?.trim() || Boolean(values.worktree) !== Boolean(values.base)
    || ((values['verify-receipt'] || values.publish) && !values.worktree)
    || (values.publish && !values['verify-receipt'])) throw new Error('USAGE-INVALID pr-preflight inputs');
  const inspected = inspectInputs(values);
  if (values['head-oid'] && inspected.source?.head !== values['head-oid']) {
    inspected.ok = false;
    inspected.problems.push('HEAD-OID-MISMATCH verified source differs from published head');
  }
  const result = { ok: inspected.ok, problems: inspected.problems, ...(inspected.source ? { source: inspected.source } : {}) };
  if (inspected.ok && inspected.source) result.receipt = exactReceipt(values, inspected);
  if (values['verify-receipt']) {
    const expected = readReceipt(values.worktree, values['verify-receipt']);
    if (!result.receipt || JSON.stringify(expected) !== JSON.stringify(result.receipt) || result.receipt.sha256 !== values['verify-receipt']) {
      result.ok = false;
      result.problems.push('RECEIPT-MISMATCH title/body/base/context/source');
    }
  } else if (result.receipt) retainReceipt(values.worktree, result.receipt);
  if (result.ok && values.publish) result.publication = publishExact(values, inspected);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (error) {
    const message = /^(?:SOURCE-MOVED|INPUT-|BODY-ENCODING-|WORKTREE-INPUT-|RECEIPT-|PUBLICATION-|USAGE-INVALID)/.test(error.message ?? '')
      ? error.message : 'PR-PREFLIGHT-FAILED';
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }
}
