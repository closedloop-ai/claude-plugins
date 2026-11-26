import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { bindProviderInProcess, writeActiveTicketSnapshot } from "./test-fixtures.mjs";
import { completedReceipt, gitFixtureResult, linkedCloudFixture, sourcedCloudRequest } from "./fixtures/vibe-triage-cloud.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { importResult } = await vibeCore("lib/vibe/scripts/cloud-worker.mjs");
bindProviderInProcess(after);

function gitAt(cwd, ...args) {
  const result = gitFixtureResult(cwd, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const vibeFixture = () => linkedCloudFixture(gitAt);

test('ISS-14476 cloud placement validates the actual import, dispatch request and exact passing lane receipt', (t) => {
  const { root, worktree, gitDir } = vibeFixture();
  t.after(() => rmSync(path.dirname(root), { recursive: true, force: true }));
  gitAt(worktree, 'switch', '-c', 'cloud/iss-13804-cloud');
  writeFileSync(path.join(worktree, 'existing.txt'), 'cloud edit\n');
  gitAt(worktree, 'add', 'existing.txt');
  gitAt(worktree, 'commit', '-m', 'fixture cloud change');
  const commit = gitAt(worktree, 'rev-parse', 'HEAD');
  gitAt(worktree, 'push', 'origin', 'cloud/iss-13804-cloud');
  gitAt(worktree, 'switch', 'vibe/iss-13804-cloud-dispatch');
  const request = { ...sourcedCloudRequest(worktree), provider: 'claude', branch: 'cloud/iss-13804-cloud' };
  const receipt = completedReceipt(request, gitDir, 'run_placement', { runId: 'run_placement', sessionId: 'session_placement' });
  const { witness } = importResult(request, receipt);
  const requestFile = path.join(gitDir, 'placement-request.json');
  writeFileSync(requestFile, JSON.stringify(request));
  const digest = 'a'.repeat(64);
  const laneReceiptName = `cloud-validate-${commit.slice(0, 12)}-${digest.slice(0, 12)}.json`;
  const laneFile = path.join(gitDir, laneReceiptName);
  const [lane] = request.validationCommands;
  const laneKey = createHash('sha256').update(lane).digest('hex');
  const report = { commit, repository: request.repository, passed: true, lanes: [{ command: lane, passed: true, exitCode: 0 }],
    provenance: { host: 'vm', remote: 'true', origin: 'https://github.com/acme/widgets', commit } };
  const laneReceipt = { status: 'completed', taskId: 'exact-lane', commit, requestDigest: digest, laneKeys: [laneKey], validationReport: report };
  writeFileSync(laneFile, JSON.stringify(laneReceipt));
  const board = fileURLToPath(new URL('../../fleet-orchestrator/scripts/board.mjs', import.meta.url));
  const program = path.join(path.dirname(root), 'fleet', 'programs', 'fixture');
  mkdirSync(program, { recursive: true });
  writeActiveTicketSnapshot(program, [request.ticket, 'ISS-9']);
  const run = (...args) => spawnSync(process.execPath, [board, program, ...args], { encoding: 'utf8' });
  for (const ticket of [request.ticket, 'ISS-9']) {
    const placed = run('placement', ticket, '--evidence', requestFile);
    assert.equal(placed.status, 0, placed.stderr);
  }
  const assign = (ticket = request.ticket) => run('placement', ticket, '--worktree', worktree, '--import-request', requestFile, '--lane-receipt', laneReceiptName);
  const kept = assign();
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(run('writer', 'verified', '--tickets', request.ticket, '--worktree', worktree).status, 0);
  assert.equal(run('writer', 'unrelated', '--tickets', 'ISS-9', '--worktree', worktree).status, 2);
  assert.equal(assign('ISS-9').status, 2);
  assert.equal(run('writer', 'wrong-worktree', '--tickets', request.ticket, '--worktree', root).status, 2);
  writeFileSync(requestFile, JSON.stringify({ ...request, branch: 'cloud/other' }));
  assert.match(assign().stderr, /witness differs from the completed dispatch request/);
  writeFileSync(requestFile, JSON.stringify(request));
  writeFileSync(laneFile, JSON.stringify({ ...laneReceipt, commit: 'b'.repeat(40) }));
  assert.match(assign().stderr, /does not prove the imported commit/);
  writeFileSync(laneFile, JSON.stringify(laneReceipt));
  const original = readFileSync(witness, 'utf8');
  writeFileSync(witness, JSON.stringify({ ...JSON.parse(original), requestDigest: '0'.repeat(64) }));
  assert.match(assign().stderr, /witness differs from the completed dispatch request/);
  writeFileSync(witness, original);
  writeFileSync(path.join(worktree, 'existing.txt'), 'source changed after import\n');
  assert.match(assign().stderr, /witness is stale for the worktree/);
});
