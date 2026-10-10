import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability } from "./contracts.js";

export const graph: Capability[] = [{ name: "mcp__custom_graph__sync_status", service: "graph", operation: "sync_status", access: "read" }];
export const recordWrite: Capability = { name: "mcp__live_workspace__create_document_version", service: "closedloop", operation: "create_document_version", access: "write" };
export const bundleDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins/vibe/skills/vibe/scripts/dist");

export function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "vibe-workers-test-")));
  const worktree = join(base, "session");
  mkdirSync(worktree);
  execFileSync("git", ["init", "-b", "vibe/test"], { cwd: worktree, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture initial state"], { cwd: worktree, stdio: "ignore" });
  const metadata = join(worktree, ".git");
  writeFileSync(join(metadata, "vibe-session.json"), JSON.stringify({ worktree, branch: "vibe/test" }));
  const agentRoot = join(base, "vibe");
  mkdirSync(join(agentRoot, "agents"), { recursive: true });
  mkdirSync(join(agentRoot, ".claude-plugin"));
  writeFileSync(join(agentRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe" }));
  writeAgent(agentRoot, "vibe-change-worker", "Read, Write, Edit, Grep, Glob, Bash, Skill");
  writeAgent(agentRoot, "vibe-guardrails-reviewer", "Read, Grep, Glob, Bash, Skill");
  writeAgent(agentRoot, "vibe-prototype-worker", "Read, Write, Grep, Glob, Bash, Skill");
  writeAgent(agentRoot, "vibe-requirements-worker", "Read, Grep, Glob, Bash");
  writeAgent(agentRoot, "vibe-setup-worker", "Read, Write, Edit, Grep, Glob, Bash");
  writeAgent(agentRoot, "vibe-ticket-worker", "Read, Write, Edit, Grep, Glob, Bash");
  writeAgent(agentRoot, "vibe-environment-worker", "Read, Write, Edit, Grep, Glob, Bash");
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
const id = option(args.includes('--resume') ? '--resume' : '--session-id');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  const definition = JSON.parse(fs.readFileSync(option('--agents'), 'utf8'));
  const proof = { args, payload, definition, pid: process.pid };
  fs.appendFileSync(path.join(process.cwd(), '.git', 'fake-proof.jsonl'), JSON.stringify(proof) + '\n');
  if (payload.input === 'PUBLISHER_FOOTER_CONTROL'
    && definition[option('--agent')].prompt.includes('Never start another implementation writer, commit, or push.')) {
    process.stdout.write(JSON.stringify({ type: 'result', session_id: id, is_error: false,
      result: JSON.stringify({ status: 'BLOCKED', summary: 'Publisher is still forbidden to push' }) }) + '\n');
    return;
  }
  let discardReceipt;
  if (payload.input === 'DISCARD_OWNED_FIXTURE') {
    const target = payload.discardTarget.worktree;
    const cp = require('node:child_process');
    const metadata = cp.execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: target, encoding: 'utf8' }).trim();
    if (!fs.existsSync(path.join(metadata, 'vibe-record-turn.lock'))
      || !fs.existsSync(path.join(process.cwd(), '.git', 'vibe-record-turn.lock'))) process.exit(2);
    discardReceipt = JSON.parse(cp.execFileSync(process.execPath,
      [${JSON.stringify(resolve(bundleDirectory, "../vibe-sessions.mjs"))}, 'discard', '--worktree', target, '--confirm'],
      { cwd: process.cwd(), encoding: 'utf8' }));
  }
  if (payload.input.includes('STARTUP_FAILURE')) process.exit(2);
  if (payload.input.includes('WAIT_FOR_CANCEL')) { setInterval(() => {}, 1000); return; }
  if (payload.input.includes('INVALID_OUTPUT')) { process.stdout.write('invalid\n'); process.exit(0); }
  let status = payload.input.includes('PLAN_FIRST') ? 'PLAN' : 'DONE';
  let mainSyncResult;
  if (payload.input.startsWith('MAIN_SYNC_')) {
    const cp = require('node:child_process');
    const action = payload.input.slice('MAIN_SYNC_'.length).toLowerCase();
    const script = action === 'prepare' ? ${JSON.stringify(resolve(bundleDirectory, "../commit-worktree.mjs"))}
      : ${JSON.stringify(resolve(bundleDirectory, "../vibe-sessions.mjs"))};
    const command = action === 'prepare' ? ['--prepare-main-sync', '--worktree', process.cwd()]
      : action === 'request' ? ['dispatch-inputs', '--worktree', process.cwd(), '--out', path.join(process.cwd(), '.git', 'sdk-request.json')]
      : ['main-sync-' + action, '--worktree', process.cwd()];
    const response = cp.spawnSync(process.execPath, [script, ...command], {
      cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify({context:payload.operationContext}) });
    mainSyncResult = JSON.parse(response.stdout);
    status = response.status === 0 ? (mainSyncResult.mainSync?.status || 'DONE') : 'BLOCKED';
  }
  const reportedId = payload.input.includes('WRONG_ID') ? '11111111-1111-4111-8111-111111111111' : id;
  const compact = { status, summary: 'fixture result', data: { inputSeen: true } };
  if (mainSyncResult) compact.data.mainSyncResult = mainSyncResult;
  if (discardReceipt) compact.data.discardReceipt = discardReceipt;
  const result = { type: 'result', session_id: reportedId, is_error: false,
    result: JSON.stringify(compact) };
  const schemaTool = definition[option('--agent')].tools.includes('StructuredOutput')
    && option('--tools').split(',').includes('StructuredOutput')
    && option('--allowedTools').split(',').includes('StructuredOutput');
  if (payload.input.includes('FENCED_RESULT')) {
    result.result = '\x60\x60\x60json\n' + JSON.stringify(compact) + '\n\x60\x60\x60';
    if (schemaTool && args.includes('--json-schema')) result.structured_output = compact;
  }
  if (payload.input.includes('INVALID_STRUCTURED')) result.structured_output = { status: 'DONE' };
  process.stdout.write(JSON.stringify(result) + '\n');
});
`, { mode: 0o700 });
  chmodSync(join(bin, "claude"), 0o700);
  return { base, worktree, metadata, agentRoot, bin, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function writeAgent(root: string, name: string, tools: string) {
  writeFileSync(join(root, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Fixture role\nmodel: sonnet\ntools: ${tools}\nskills: closedloop-core:plan-structure\n---\nCanonical fixture prompt for ${name}.\n`);
}

export function readProof(metadata: string) {
  return readFileSync(join(metadata, "fake-proof.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; payload: { input: string; mode: string;
      authority: { testAuthoringAuthorized: boolean } }; pid: number;
      definition: Record<string, { model: string; tools: string[]; prompt: string }> });
}
