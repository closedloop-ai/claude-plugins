import assert from 'node:assert/strict';
import test from 'node:test';
import { completionEventProblem } from '../../fleet-orchestrator/scripts/helpers.mjs';
import { visualQaBodySection } from '../../vibe/scripts/required-visual-qa.mjs';
import { replaceFrontmatterDescription } from '../../vibe/scripts/agent-frontmatter.mjs';

test('critic runtime pages collectively attest the registered cwd', () => {
  const completion = { sessionId: 'fixture', turnId: 'done' };
  const thread = { id: 'fixture', turns: [{ id: 'done', status: 'completed' }] };
  assert.match(completionEventProblem({ thread }, completion, process.cwd()) ?? '', /checkout/);
  assert.equal(completionEventProblem(JSON.stringify({ thread: { id: 'fixture', cwd: process.cwd() } })+'\n'+JSON.stringify({ thread }), completion, process.cwd()), null);
});

test('the required Visual QA publication describes each finding and its disposition', () => {
  const body = visualQaBodySection({rounds: [], findings: [{id: 'F1', summary: 'Menu clips text', disposition: 'fixed: abcdef0'}]});
  assert.match(body, /Menu clips text/);
  assert.match(body, /fixed: abcdef0/);
});

test('a generated agent description preserves the block-header comment and next key', () => {
  const input = '---\r\nname: agent\r\ndescription: >- # keep context\r\n  old description\r\ntools: []\r\n---\r\nPrompt';
  const output = replaceFrontmatterDescription(input, 'updated');
  assert.match(output, /updated[^\r\n]*# keep context\r\ntools: \[\]/);
  assert.ok(output.endsWith('---\r\nPrompt'));
});

test('visual findings validation returns a fingerprint of the exact parsed bytes', async () => {
  const { readVisualQaFindings } = await import('../../vibe/scripts/required-visual-qa.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const root = mkdtempSync(join(tmpdir(), 'visual-evidence-'));
  try {
    const file = join(root, 'findings.json');
    const head = 'a'.repeat(40), text = JSON.stringify({ head, findings: [] });
    writeFileSync(file, text);
    const result = readVisualQaFindings(file, head, null, null);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.record, JSON.parse(text), "the renderer consumes the authenticated record");
    assert.equal(result.fingerprint.sha256, createHash('sha256').update(text).digest('hex'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publication requires a readable touched-finding summary", () => {
  assert.throws(() => visualQaBodySection({rounds: [], findings: [{id:"F1", touchedSurface:true, disposition:"fixed: abcdef0"}]}), /summary/i);
});
test("a worktree-less remote writer has no independently identified critic", async () => {
  const {fleetCriticFindings} = await import("../../vibe/scripts/visual-critic-evidence.mjs");
  const other = {role:"visual-qa-critic",acceptedAt:"now", worktree:"/fixture/other",source:{head:"abc"}};
  assert.equal(fleetCriticFindings({other}, null, "abc"), undefined);
});

test("published finding summaries preserve ordinary pipe punctuation", () => {
  assert.match(visualQaBodySection({rounds:[], findings:[{id:"F1", summary:"Open | Closed appears twice", disposition:"fixed: abcdef1"}]}), /Open \| Closed appears twice/);
});

test("equal latest critic timestamps require one authenticated findings identity",async t=>{
  const {fleetCriticFindings}=await import("../../vibe/scripts/visual-critic-evidence.mjs");
  const {mkdtempSync,writeFileSync,rmSync}=await import("node:fs");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const {evidenceFingerprint}=await import("./handoff-evidence.mjs");
  const root=mkdtempSync(join(tmpdir(),"critic-tie-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const head="a".repeat(40);
  function row(name) {
    const report=join(root,name+".json"),file=join(root,name+".findings");
    writeFileSync(file,name);
    const findings=evidenceFingerprint(file);
    writeFileSync(report,JSON.stringify({source:{head},findings}));
    return {worktree:root,source:{head},role:"visual-qa-critic",acceptedAt:"2026-01-01T00:00:00.000Z",report:evidenceFingerprint(report)};
  }
  const one=row("one"),two=row("two");
  for(const entries of [[one,two],[two,one]]) assert.throws(()=>fleetCriticFindings(entries,root,head),/ambiguous/i);
  assert.deepEqual(fleetCriticFindings([one,{...one}],root,head),fleetCriticFindings([one],root,head));
  assert.deepEqual(fleetCriticFindings([one,{...two,acceptedAt:"2026-01-01T00:00:01.000Z"}],root,head),fleetCriticFindings([two],root,head));
});
