import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { changedVisualBaselines, claimProblems, titleProblems } from "./pr-preflight.mjs";
import { visualBaselineLedgerProblems } from "../../handoff/scripts/visual-baseline-ledger.mjs";
import { git, makeHome, mutationPreload } from './test-fixtures.mjs';
import { sourceIdentity } from './tested-head.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "pr-preflight.mjs");

test('preflight rejects body movement and returns the accepted dirty-source identity', t => {
  const { root, home, cleanup } = makeHome('pr-preflight-source-race-');
  t.after(cleanup);
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  writeFileSync(path.join(repo, 'input'), 'base');
  git(repo, ['init', '--quiet'], home);
  git(repo, ['add', '.'], home);
  git(repo, ['commit', '--quiet', '-m', 'base'], home);
  const base = git(repo, ['rev-parse', 'HEAD'], home);
  const body = path.join(repo, 'body.md');
  writeFileSync(body, 'Summary: accepted candidate');
  const args = [SCRIPT, '--title', 'ISS-13430: Ready', '--body-file', body, '--worktree', repo, '--base', base];
  const preload = mutationPreload(root, { file: body, caller: 'main', excludeCaller: 'hashFiles', text: 'Changed during the body read' });
  const moved = spawnSync(process.execPath, ['--import', preload, ...args], { encoding: 'utf8' });
  assert.equal(moved.status, 2, moved.stdout + moved.stderr);
  assert.match(moved.stderr, /SOURCE-MOVED/);
  assert.equal(moved.stdout, '');
  assert.equal(readFileSync(body, 'utf8'), 'Changed during the body read', 'mutation occurs in classification, not fingerprint capture');
  const accepted = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout).source, sourceIdentity(repo));
});

test('private-body receipts bind exact title bytes base and source before publication', t => {
  const { root, home, cleanup } = makeHome('pr-exact-input-');
  t.after(cleanup);
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  writeFileSync(path.join(repo, 'input'), 'base');
  git(repo, ['init', '--quiet', '--initial-branch=main'], home);
  git(repo, ['add', '.'], home);
  git(repo, ['commit', '--quiet', '-m', 'base'], home);
  const base = git(repo, ['rev-parse', 'HEAD'], home);
  git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'current'], home);
  const publishedHead = git(repo, ['rev-parse', 'HEAD'], home);
  const gitdir = git(repo, ['rev-parse', '--absolute-git-dir'], home);
  const body = path.join(gitdir, 'pr-body-ISS-13430.md');
  const bytes = 'Summary: private-exact-input-marker\r\n';
  writeFileSync(body, bytes);
  const bin = path.join(root, 'bin'); mkdirSync(bin);
  const calls = path.join(root, 'calls.jsonl');
  const remoteHead = path.join(root, 'remote-head');
  writeFileSync(remoteHead, publishedHead);
  writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs=require('fs');
const args=process.argv.slice(2), head=fs.readFileSync(${JSON.stringify(remoteHead)},'utf8').trim();
if(args[0]==='api') process.stdout.write(head+'\\n');
else if(args[0]==='pr'&&args[1]==='view') process.stdout.write(JSON.stringify({baseRefName:'main',headRefName:'main',headRefOid:head}));
else {
  fs.writeFileSync(${JSON.stringify(body)},'Raced original body file');
  fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,body:fs.readFileSync(0,'utf8')})+'\\n');
  process.stdout.write('DO_NOT_PRINT_PRIVATE_CLI_CONTEXT /private/fake\\nhttps://DO_NOT_PRINT_PRIVATE_CLI_CONTEXT:secret@github.com/acme/repo/pull/999\\nhttps://github.com/acme/repo/pull/12\\n');
}
`, { mode: 0o755 });
  const common = ['--title', 'ISS-13430: Exact inputs', '--body-file', body, '--worktree', repo, '--base', base,
    '--repo', 'acme/repo', '--head-oid', publishedHead];
  const run = (args = common, extra = []) => spawnSync(process.execPath, [SCRIPT, ...args, ...extra], {
    encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  const initialSource = sourceIdentity(repo);
  const core = common.slice(0, -4);
  const before = JSON.parse(run(core).stdout);
  writeFileSync(body, bytes + 'Different private draft');
  const after = JSON.parse(run(core).stdout);
  assert.deepEqual(before.source, after.source);
  assert.notDeepEqual(before.receipt, after.receipt, 'private body changes need different receipts even when worktree identity is unchanged');
  writeFileSync(body, bytes);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const accepted = JSON.parse(first.stdout);
  assert.match(accepted.receipt.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(run().stdout).receipt, accepted.receipt, 'receipt is deterministic');
  assert.doesNotMatch(first.stdout, /private-exact-input-marker/);
  assert.equal(first.stdout.includes(root), false);
  const verify = ['--verify-receipt', accepted.receipt.sha256, '--publish', 'create'];
  const otherHead = 'd'.repeat(40);
  const wrongHeadArgs = common.map(value => value === publishedHead ? otherHead : value);
  writeFileSync(remoteHead, otherHead);
  assert.equal(run(wrongHeadArgs).status, 1, 'remote and supplied head cannot differ from verified local source');
  assert.equal(run(wrongHeadArgs, verify).status, 1, 'create refuses a remote/supplied head that differs from verified source');
  writeFileSync(remoteHead, publishedHead);
  writeFileSync(body, bytes.replace('\r\n', '\n'));
  assert.deepEqual(sourceIdentity(repo), initialSource, 'the private Git body is outside worktree identity');
  assert.equal(run(common, verify).status, 1, 'body byte mismatch blocks publication');
  writeFileSync(body, bytes);
  const titleChanged = common.map(value => value === 'ISS-13430: Exact inputs' ? 'ISS-13430: Other inputs' : value);
  assert.equal(run(titleChanged, verify).status, 1, 'title mismatch blocks publication');
  const baseChanged = common.map(value => value === base ? 'HEAD' : value);
  assert.equal(run(baseChanged, verify).status, 1, 'base mismatch blocks publication');
  assert.equal(run([...common, '--base-ref', 'other'], verify).status, 1, 'target base ref mismatch blocks publication');
  writeFileSync(path.join(repo, 'input'), 'unverified source');
  assert.equal(run(common, verify).status, 1, 'source mismatch blocks publication');
  writeFileSync(path.join(repo, 'input'), 'base');
  writeFileSync(remoteHead, 'f'.repeat(40));
  assert.notEqual(run(common, verify).status, 0, 'remote head movement blocks create');
  writeFileSync(remoteHead, publishedHead);
  const publishedResult = run(common, verify);
  assert.equal(publishedResult.status, 0, publishedResult.stderr);
  assert.doesNotMatch(publishedResult.stdout + publishedResult.stderr, /private-exact-input-marker|DO_NOT_PRINT_PRIVATE_CLI_CONTEXT|\/private\/fake/);
  const published = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(published.length, 1, 'no failed verification reaches gh');
  assert.deepEqual(published[0].args, ['pr', 'create', '--repo', 'acme/repo', '--base', 'main', '--head', 'main', '--title', 'ISS-13430: Exact inputs', '--body-file', '-']);
  assert.equal(published[0].body, bytes, 'gh consumes the verified buffer, not a reopened file');
  assert.equal(readFileSync(body, 'utf8'), 'Raced original body file');
  writeFileSync(body, bytes);
  const updateArgs = [...common, '--pr', '12'];
  const update = JSON.parse(run(updateArgs).stdout).receipt;
  const wrongUpdateArgs = [...wrongHeadArgs, '--pr', '12'];
  writeFileSync(remoteHead, otherHead);
  assert.equal(run(wrongUpdateArgs).status, 1, 'update receipt refuses a remote/supplied head that differs from verified source');
  assert.equal(run(wrongUpdateArgs, ['--verify-receipt', update.sha256, '--publish', 'update']).status, 1);
  writeFileSync(remoteHead, publishedHead);
  writeFileSync(body, 'Another worker overwrote the draft');
  assert.equal(run(updateArgs, ['--verify-receipt', update.sha256, '--publish', 'update']).status, 1);
  writeFileSync(body, bytes);
  writeFileSync(remoteHead, 'e'.repeat(40));
  assert.notEqual(run(updateArgs, ['--verify-receipt', update.sha256, '--publish', 'update']).status, 0, 'remote head movement blocks update');
  writeFileSync(remoteHead, publishedHead);
  assert.equal(run(updateArgs, ['--verify-receipt', update.sha256, '--publish', 'update']).status, 0);
  const edited = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual(edited.args, ['pr', 'edit', '12', '--repo', 'acme/repo', '--title', 'ISS-13430: Exact inputs', '--body-file', '-']);
  assert.equal(edited.body, bytes);
  writeFileSync(body, 'Snapshot matches Linux: DO_NOT_ECHO_PRIVATE_BODY /private/sensitive/file');
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.doesNotMatch(refused.stdout + refused.stderr, /DO_NOT_ECHO_PRIVATE_BODY|\/private\/sensitive/);
});

test("a title over 72 characters with the ' (#n)' suffix fails, as the metadata gate does (#9188 at 73)", () => {
  const title = (length) => `ISS-12901: ${"x".repeat(length - 11)}`;
  assert.match(titleProblems(title(65), { pr: 9188 }).join(), /title is 73 characters/);
  assert.deepEqual(titleProblems(title(64), { pr: 9188 }), []);
  assert.match(titleProblems(title(64)).join(), /title is 73 characters/, "before the PR exists the suffix counts five digits");
});

test("an identical or matching claim needs its measured count (#9186 was about 3,900 pixels off)", () => {
  assert.equal(claimProblems("Regenerated baseline is pixel-identical to CI.").length, 1);
  assert.equal(claimProblems("Snapshot matches the Linux render.").length, 1);
  assert.equal(claimProblems("No visual diff against main.").length, 1);
  assert.deepEqual(claimProblems("Regenerated baseline is pixel-identical to CI: 0 of 1,048,576 pixels differ."), []);
  assert.deepEqual(claimProblems("Matches CI within 0.02% (210 pixels differ, threshold 0.1%)."), []);
  assert.deepEqual(claimProblems("Fixes the star column header."), []);
  assert.deepEqual(claimProblems("The empty state matches the design and the ticket's wording."), [], "only result comparisons need a count");
});

test("the command fails a 73-character title and passes a fitting one", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pr-preflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const body = path.join(dir, "body.md");
  writeFileSync(body, "## Summary\n- Fix the reds.\n");
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const long = run("--title", "x".repeat(65), "--pr", "9188", "--body-file", body);
  assert.equal(long.status, 1);
  assert.equal(JSON.parse(long.stdout).ok, false);
  assert.equal(run("--title", "x".repeat(64), "--pr", "9188", "--body-file", body).status, 0);
});

test("a changed visual baseline needs a counted, sourced element ledger (#9188)", (t) => {
  const file = "e2e/__screenshots__/visual-regression.spec.ts/branches-desktop.png";
  assert.match(visualBaselineLedgerProblems("The checkbox is plausibly intended.\n", [file]).join(), /needs exactly one/);
  const incomplete = [
    `Baseline inventory: ${file}: Branches: 3 new elements`,
    `Baseline element: ${file}: Branches: star column: ISS-12918 AC-2`,
    `Baseline element: ${file}: Branches: header select-all checkbox: plausibly intended`,
  ].join("\n");
  assert.match(visualBaselineLedgerProblems(incomplete, [file]).join(), /declares 3 new elements but lists 2/);
  assert.match(visualBaselineLedgerProblems(incomplete, [file]).join(), /plausibly intended/);

  const dir = mkdtempSync(path.join(os.tmpdir(), "pr-baseline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), "old");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "base"]);
  const base = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(dir, file), "new");
  assert.deepEqual(changedVisualBaselines(dir, base), [file], 'uncommitted visual baselines receive the same ledger gate');
  const body = path.join(dir, "body.md");
  writeFileSync(body, incomplete);
  const failed = spawnSync(process.execPath, [SCRIPT, "--title", "ISS-12901: Fix baselines", "--body-file", body, "--worktree", dir, "--base", base], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  writeFileSync(body, `${incomplete}\nBaseline element: ${file}: Branches: avatar style: ISS-12576 ruling\n`.replace("header select-all checkbox: plausibly intended", "header select-all checkbox: ISS-100 AC-3"));
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--title", "ISS-12901: Fix baselines", "--body-file", body, "--worktree", dir, "--base", base], { encoding: "utf8" }).status, 0);
});
