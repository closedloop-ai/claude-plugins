import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vibeCore } from '../../../../shared/vibe-core.mjs';

const { hydrateCloudRequest, recordCloudEvidence } = await vibeCore("lib/vibe/scripts/cloud-worker.mjs");
const { writeSessionRecord } = await vibeCore("lib/vibe/scripts/session-record.mjs");

export const cloudRequest = (worktree = '/tmp/vibe-example') => ({
  worktree, ticket: 'ISS-13804', provider: 'codex', model: 'gpt-6-sol', reservedVersion: '1.1.61', branch: 'codex-cloud/iss-13804-cloud',
  repository: 'acme/widgets', codexEnvironment: 'widgets-env',
  placement: { codeOnly: true, needsRunningApp: false, localEvidence: [] },
  criteria: [{ id: 'AC-1', source: 'ISS-13804 v2', text: 'Dispatch autonomously.' }],
  graph: { ownership: 'dispatch-route.mjs owns routing', collisions: 'No active duplicate', blastRadius: 'fleet skill and tests' },
  validationCommands: ['node --test plugins/vibe/skills/fleet-orchestrator/scripts/dispatch-route.test.mjs'], connectorAllowlist: [],
});
export const OPERATOR = Object.freeze({ id: 'operator_1', name: 'Test Operator', email: 'operator@example.test' });

/** Run Git against the fixture using its fixed local identity. */
export function gitFixtureResult(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: OPERATOR.name, GIT_AUTHOR_EMAIL: OPERATOR.email, GIT_COMMITTER_NAME: OPERATOR.name, GIT_COMMITTER_EMAIL: OPERATOR.email } });
}

/** Create the real linked-worktree and private record used by cloud dispatch integration fixtures. */
export function linkedCloudFixture(gitAt) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cloud-'));
  const remote = path.join(dir, 'remote.git');
  const root = path.join(dir, 'repo');
  const worktree = path.join(root, '.claude', 'worktrees', 'vibe-iss-13804-cloud-dispatch');
  mkdirSync(root);
  gitAt(root, 'init', '--initial-branch=main');
  writeFileSync(path.join(root, 'existing.txt'), 'old\n');
  writeFileSync(path.join(root, 'AGENTS.md'), 'Run node --test for changed scripts.\n');
  gitAt(root, 'add', '.');
  gitAt(root, 'commit', '-m', 'baseline');
  gitAt(dir, 'clone', '--bare', root, remote);
  gitAt(root, 'remote', 'add', 'origin', remote);
  mkdirSync(path.dirname(worktree), { recursive: true });
  gitAt(root, 'worktree', 'add', '-b', 'vibe/iss-13804-cloud-dispatch', worktree);
  const gitDir = gitAt(worktree, 'rev-parse', '--absolute-git-dir');
  const now = new Date().toISOString();
  writeSessionRecord(worktree, { slug: 'iss-13804-cloud-dispatch', branch: 'vibe/iss-13804-cloud-dispatch', summary: 'Cloud worker test', ticket: 'ISS-13804', liveTicket: 'ISS-13804', liveTicketCreatedBySession: false, status: 'active', mode: 'blank', operator: OPERATOR, baseCommit: gitAt(worktree, 'rev-parse', 'HEAD'), createdAt: now, lastActiveAt: now });
  writeFileSync(path.join(gitDir, 'vibe-spec-card.json'), JSON.stringify({ stage: 'locked', source: 'ISS-13804', criteria: [{ id: 'AC-1', text: 'Dispatch autonomously.', source: 'ISS-13804 v2' }] }), { mode: 0o600 });
  return { root, worktree, gitDir, remote };
}

/** Give a fixture request its locked criteria and canonical graph evidence. */
export function sourcedCloudRequest(worktree) {
  const request = cloudRequest(worktree);
  const observedAt = new Date().toISOString();
  const evidence = recordCloudEvidence(request, { graph: {
    ownership: { tool: 'code_symbols', query: 'dispatch owner', text: request.graph.ownership, observedAt },
    collisions: { tool: 'query_collisions', query: 'ticket overlap', text: request.graph.collisions, observedAt },
    blastRadius: { tool: 'blast_radius_tickets', query: 'touched files', text: request.graph.blastRadius, observedAt },
  }, validationCommands: request.validationCommands, validationSources: ['AGENTS.md'] });
  return { ...request, evidenceSha256: evidence.evidenceSha256 };
}

/** Build a local completed provider receipt with the same dispatch fingerprint. */
export function completedReceipt(request, gitDir, taskId, extras = {}) {
  const dispatchIdentity = { ...hydrateCloudRequest(request, { requireCurrentSource: false }) };
  delete dispatchIdentity.reservedVersion;
  const receipt = { provider: request.provider, taskId, status: 'completed', requestDigest: createHash('sha256').update(JSON.stringify(dispatchIdentity)).digest('hex'), ...extras };
  writeFileSync(path.join(gitDir, 'cloud-worker-iss-13804.json'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return receipt;
}
