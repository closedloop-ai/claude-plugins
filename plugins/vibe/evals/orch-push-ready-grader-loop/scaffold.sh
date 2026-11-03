#!/bin/bash
set -euo pipefail
mkdir -p session
git -C session init -q
printf '0\n' > session/grader.txt
cat > session/check.mjs <<'JS'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.dirname(fileURLToPath(import.meta.url));
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const revision = Number(process.argv[2]);
if (!Number.isInteger(revision) || revision < 1 || revision > 19
  || Number(readFileSync(path.join(repo, 'grader.txt'), 'utf8')) !== revision) process.exit(1);
const head = git('rev-parse', 'HEAD');
const diff = createHash('sha256').update(git('diff', 'HEAD', '--', 'grader.txt')).digest('hex');
appendFileSync(path.join(repo, '.git/grader-runs'), `${revision} ${head} ${diff}\n`);
console.log(`revision ${revision} accepted at HEAD ${head} plus diff ${diff}`);
JS
git -C session add .
git -C session -c user.name=Eval -c user.email=eval@example.invalid commit -q -m base
