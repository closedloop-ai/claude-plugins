import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('writer and fleet extend the existing ready rule and cite the human source once', () => {
  const writer = read('../../../agents/vibe-change-worker.md');
  const fleet = read('../../fleet-orchestrator/SKILL.md');
  const template = read('../../fleet-orchestrator/references/templates.md');
  const quality = read('../references/quality-loop.md');
  assert.match(writer, /uncommitted.*push-ready/s);
  assert.match(fleet, /--ready.*UNREADY-COMMIT/s);
  assert.match(template, /--ready.*uncommitted/s);
  assert.doesNotMatch(fleet + template, /checkpoint at least every 45 minutes|review findings.*follow-up commits/);
  assert.doesNotMatch(quality, /writer commits every change that compiles/);
  assert.equal((fleet + writer + template + quality).split("we don't commit until we're sure that commit is push ready").length - 1, 1);
});

test('criteria audit, rulings, rollout, independent review and verification precede PR creation', () => {
  const handoff = read('../../handoff/SKILL.md');
  const open = handoff.indexOf('It opens the pull request on the already pushed branch');
  for (const gate of ['scripts/criteria-audit.mjs --ticket', 'node scripts/rulings-check.mjs --ticket', 'node scripts/rollout-gate.mjs --worktree']) {
    const index = handoff.indexOf(gate);
    assert.ok(index !== -1 && index < open, `${gate} must run before the PR opens`);
  }
  assert.ok(handoff.indexOf('## 6. Independent integrated review') < open);
  assert.ok(handoff.indexOf('### Running app verification') < open);
  assert.match(handoff.slice(handoff.indexOf('## 9. Hand it over'), open), /uncommitted/);
  const commit = handoff.indexOf('ROOT commits the reviewed deliverable LOCALLY');
  const push = handoff.indexOf('It runs normal pre-push checks, pushes and deploys');
  for (const gate of ['### Running app verification', 'scripts/criteria-audit.mjs --ticket', 'node scripts/rulings-check.mjs --ticket',
    'node scripts/rollout-gate.mjs --worktree', 'in `pre-pr` mode', '### Pinned-base Storybook train',
    'Before readiness in step 6, resume the SAME writer', '`scripts/live-ticket-check.mjs` on the private candidate ticket']) {
    const index = handoff.indexOf(gate);
    assert.ok(index >= 0 && index < commit && index < push, `${gate} must accept the dirty candidate before first commit/push`);
  }
  assert.doesNotMatch(handoff, /After step 7 verifies the final publication, dispatch read-only/);
  assert.doesNotMatch(handoff.slice(handoff.indexOf('## 8.'), handoff.indexOf('## 9.')), /a behavior\s+answer goes through/, 'post-publication ticket fill cannot start a source-fix/redeploy cycle');
  const monitor = read('../../codex-fleet-monitor/SKILL.md');
  assert.doesNotMatch(monitor, /add the new PR to `prs.txt` and start its review/);
  assert.match(monitor, /observe automatically started checks and reviews/);
});

test('public Claude eval examples always freeze identified inputs in fresh directories', () => {
  const readme = read('../../../README.md');
  const commands = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]).filter(code => /claude-eval|claude plugin eval/.test(code));
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.doesNotMatch(command, /claude plugin eval\s+\./);
    assert.match(command, /tested-head\.mjs claude-eval/);
    assert.match(command, /mktemp -d/);
    assert.match(command, /--no-publish/);
  }
  assert.match(commands[1], /--tag visual-cues --scaffold --allow-tools Bash Write Edit --model opus --runs 3 -j 4 --no-publish --ablation none/);
});

test('ticket execution keeps failing-first evidence without committing a red checkpoint', () => {
  const execute = read('../../cl-execute/references/implementation-review-pr.md');
  assert.doesNotMatch(execute, /Commit the focused test that fails on the base first/);
  assert.match(execute, /recorded failing run.*uncommitted/s);
  const planning = read('../../cl-execute/references/planning-and-gates.md');
  assert.doesNotMatch(planning, /red-first test that implementation commits before the fix/);
});

test('writer E2E guidance accepts dirty source and refuses HEAD-only prepush evidence', () => {
  const writer = read('../../../agents/vibe-change-worker.md');
  const verifier = read('../../../agents/vibe-verify-worker.md');
  const fleet = read('../../fleet-orchestrator/SKILL.md');
  assert.match(writer, /HEAD-only.*prepush/s);
  assert.match(verifier, /--source-hash/);
  assert.match(verifier, /vibe-e2e-results/);
  assert.doesNotMatch(verifier, /--head <the pushed sha>/);
  assert.match(fleet, /--source-hash/);
  assert.match(verifier, /working-tree/);
});

test('final main-sync and exact pre-push inputs precede independent review and the sole writer commit', () => {
  const handoff = read('../../handoff/SKILL.md');
  const review = handoff.indexOf('## 6. Independent integrated review');
  const commit = handoff.indexOf('ROOT commits the reviewed deliverable LOCALLY');
  const push = handoff.indexOf('It runs normal pre-push checks, pushes and deploys');
  for (const marker of ['### Final main-sync candidate', '### Exact pre-push gate inputs']) {
    const index = handoff.indexOf(marker);
    assert.ok(index >= 0 && index < review && index < commit && index < push, `${marker} must be settled uncommitted before independent review`);
  }
  const publish = handoff.slice(commit, handoff.indexOf('## 8.'));
  assert.doesNotMatch(publish, /Before committing merged source|push returns to the SAME writer for fixes|ROOT's merge commit/);
  assert.match(publish, /source fixes are forbidden/);
  assert.match(handoff, /Operational merge exception/);
  assert.match(handoff, /zero writer-source delta/);
  assert.match(handoff, /both equal the same captured `candidateTree`/);
  assert.match(handoff, /--main-merge deferred/);
  const canonical = read('../references/environment.md').replace(/\s+/g, ' ');
  assert.ok(canonical.includes('After its sole writer commit these APIs are admission-only'));
  assert.ok(canonical.includes("Only handoff's proven zero-tree-delta operational ancestry exception applies"));
});

test('PR creation and body updates consume the exact-input receipt in the publication helper', () => {
  const worker = read('../../../agents/vibe-environment-worker.md');
  const publish = worker.slice(worker.indexOf('## Pull-request mode'));
  assert.match(publish, /pr-preflight\.mjs --publish create --verify-receipt <receiptSha256>/);
  assert.match(publish, /pr-preflight\.mjs --publish update --verify-receipt <receiptSha256>/);
  assert.match(publish, /--head-oid <published commit>/);
  assert.match(publish, /--head-oid <pushed fixing commit>/);
  assert.doesNotMatch(publish, /`gh pr (?:create|edit)\b/);
  assert.match(publish, /verified body buffer/);
});
