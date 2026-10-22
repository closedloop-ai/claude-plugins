import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { greenReport } from './green-watch.mjs';

const SCRIPT = fileURLToPath(new URL('./green-watch.mjs', import.meta.url));
const run = (id, headSha, name = 'ci-batch', createdAt = '2026-10-22T10:00:00Z') => ({ databaseId: id, headSha, name, workflowName: name, createdAt });
const job = (name, conclusion, status = 'completed') => ({ name, conclusion, status });

test('every call reports every lane of every run containing a program PR, including a batch that started later', () => {
  const jobs = { 1: [job('unit', 'success'), job('e2e', 'success')], 2: [job('lint', 'success'), job('a11y', 'failure')], 3: [job('unit', 'failure')] };
  const includesProgram = (sha) => sha !== 'before';
  const first = greenReport({ runs: [run(1, 'merge1')], head: 'merge1', jobsOf: (id) => jobs[id], includesProgram });
  assert.deepEqual(first, { lines: ['green-watch: 1 runs, 0 red, 0 pending'], ok: true });
  const later = [run(1, 'merge1'), run(2, 'head2', 'ci-push', '2026-10-22T11:00:00Z'), run(3, 'before')];
  const second = greenReport({ runs: later, head: 'head2', jobsOf: (id) => jobs[id], includesProgram });
  assert.deepEqual(second.lines, ['RED ci-push #2 head2 a11y', 'green-watch: 2 runs, 1 red, 0 pending']);
  assert.equal(second.ok, false, 'a red lane in a later push-triggered batch is reported');
  const noRun = greenReport({ runs: later, head: 'head3', jobsOf: (id) => jobs[id], includesProgram });
  assert.match(noRun.lines.join('\n'), /^NO-RUN head3$/m);
  const pending = greenReport({ runs: [run(4, 'head4')], head: 'head4', jobsOf: () => [job('e2e', null, 'in_progress')], includesProgram });
  assert.deepEqual(pending, { lines: ['PENDING ci-batch #4 head4 e2e', 'green-watch: 1 runs, 0 red, 1 pending'], ok: true });
});

test('the command re-lists runs through gh on every call and reads ancestry from git', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'green-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't' } }).trim();
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
  git('commit', '--quiet', '--allow-empty', '-m', 'before');
  const before = git('rev-parse', 'HEAD');
  git('commit', '--quiet', '--allow-empty', '-m', 'program PR');
  const merge = git('rev-parse', 'HEAD');
  git('commit', '--quiet', '--allow-empty', '-m', 'later push');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run(1, before), run(2, merge)]));
  writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\ncase "$1 $2" in\n  "run list") cat "${dir}/runs.json" ;;\n  "run view") if [ "$3" = 3 ]; then echo '{"jobs":[{"name":"a11y","status":"completed","conclusion":"failure"}]}'; else echo '{"jobs":[{"name":"unit","status":"completed","conclusion":"success"}]}'; fi ;;\n  "api repos/o/r/commits/main") echo '{"sha":"${head}"}' ;;\nesac\n`);
  chmodSync(path.join(dir, 'gh'), 0o755);
  const call = () => spawnSync(process.execPath, [SCRIPT, '--repo', 'o/r', '--worktree', repo, '--program', merge], { encoding: 'utf8', env: { ...process.env, GREEN_WATCH_GH: path.join(dir, 'gh') } });
  const early = call();
  assert.equal(early.status, 1);
  assert.match(early.stdout, new RegExp(`^NO-RUN ${head}$`, 'm'));
  assert.match(early.stdout, /green-watch: 1 runs, 0 red/, 'the run before the program PR is not watched');
  writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([run(1, before), run(2, merge), run(3, head, 'ci-push')]));
  const late = call();
  assert.equal(late.status, 1);
  assert.match(late.stdout, /^RED ci-push #3 \S+ a11y$/m);
});
