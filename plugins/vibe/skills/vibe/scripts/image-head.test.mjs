import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { imageProblem, recordImages, reusesImages } from "./image-head.mjs";
import { git, makeHome, mutationPreload } from './test-fixtures.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "image-head.mjs");
const A = "a".repeat(40);
const B = "b".repeat(40);

test('image check rejects source movement while reading the build receipt', t => {
  const { root, home, cleanup } = makeHome('image-source-race-');
  t.after(cleanup);
  const wt = path.join(root, 'wt');
  mkdirSync(wt);
  const file = path.join(wt, 'input');
  writeFileSync(file, 'checked');
  git(wt, ['init', '--quiet'], home);
  git(wt, ['add', '.'], home);
  git(wt, ['commit', '--quiet', '-m', 'base'], home);
  const head = git(wt, ['rev-parse', 'HEAD'], home);
  const records = path.join(root, 'records');
  const args = ['--project', 'p', '--worktree', wt, '--head', head, '--records', records, '--', 'run.sh'];
  assert.equal(spawnSync(process.execPath, [SCRIPT, 'record', ...args], { encoding: 'utf8' }).status, 0);
  const preload = mutationPreload(root, { file: path.join(records, 'p.json'), caller: 'imageProblem', writeTo: file, text: 'changed during receipt read' });
  const run = spawnSync(process.execPath, ['--import', preload, SCRIPT, 'check', ...args, '--no-build'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /SOURCE-MOVED/);
});

test("only a command that reuses images is checked, and only a building command records", (t) => {
  const records = mkdtempSync(path.join(os.tmpdir(), "image-head-"));
  t.after(() => rmSync(records, { recursive: true, force: true }));
  for (const command of ["e2e/run-containerized.sh --no-build -- e2e/x.spec.ts", "zsh -lc \"e2e/run-containerized.sh --no-build\""]) assert.equal(reusesImages(command), true, command);
  for (const command of ["e2e/run-containerized.sh -- e2e/x.spec.ts", "pnpm run no-build-check"]) assert.equal(reusesImages(command), false, command);
  const base = { project: "cl-e2e", worktree: "/wt/fix", records };
  assert.equal(imageProblem({ ...base, head: A, command: "run.sh" }), null);
  assert.match(imageProblem({ ...base, head: A, command: "run.sh --no-build" }), /no recorded build/);
  assert.equal(recordImages({ ...base, head: A, command: "run.sh --no-build" }), false);
  assert.equal(recordImages({ ...base, head: A, command: "run.sh" }), true);
  assert.equal(imageProblem({ ...base, head: A.slice(0, 12), command: "run.sh --no-build" }), null);
  assert.match(imageProblem({ ...base, head: B, command: "run.sh --no-build" }), /built from aaaaaaaaaaaa, not bbbbbbbbbbbb/);
  assert.match(imageProblem({ ...base, worktree: "/wt/baseline", head: A, command: "run.sh --no-build" }), /worktree switch/);
  const wt = path.join(records, 'wt');
  mkdirSync(wt);
  const git = (...args) => execFileSync('git', ['-C', wt, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'base');
  const head = git('rev-parse', 'HEAD');
  const cli = (action, head, ...command) => spawnSync(process.execPath, [SCRIPT, action, "--project", "cl-e2e", "--worktree", wt,
    "--head", head, "--records", records, "--", ...command], { encoding: "utf8" });
  assert.equal(cli("check", B, "run.sh", "--no-build").status, 1);
  assert.equal(cli("record", head, "run.sh").status, 0);
  assert.equal(cli("check", head, "run.sh", "--no-build").status, 0);
  writeFileSync(path.join(wt, 'dirty.txt'), 'uncommitted input');
  assert.equal(cli('check', head, 'run.sh', '--no-build').status, 1, 'HEAD alone cannot validate reused images after uncommitted edits');
  assert.equal(cli('record', head, 'run.sh').status, 0);
  assert.equal(cli('check', head, 'run.sh', '--no-build').status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "check"], { encoding: "utf8" }).status, 2);
});
