// The read-only QA guide on the managed launcher: its dispatch, brief, skills and running product number checks.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewFixture } from "./codex-reviewer-test-support.mjs";

/** Product text and both skill documents are synthetic. The managed transport never leaves the fixture. */
function guideFixture(t) {
  const { input, calls, client } = reviewFixture(t);
  const control = path.join(input.worktree, 'control', 'SKILL.md');
  const guide = path.join(input.orchDir, 'guided-manual-qa', 'SKILL.md');
  for (const [file, body] of [[control, '---\nname: control\n---\nRepository control instructions.'], [guide, 'Installed manual QA instructions.']]) {
    mkdirSync(path.dirname(file)); writeFileSync(file, body);
  }
  const spec = { pullRequest: {repository:"sample/guide",number:27,head:"a".repeat(40)}, plan: 'Check the minimum page size of 25.', stackFacts: 'Local QA stack.', productOrigin: 'http://localhost',
    controlSkill: 'control/SKILL.md', numberChecks: [{ claim: 'Check the minimum page size of 25.', observation: 'minimum page size of 25', evidence: 'observed.json' }] };
  writeFileSync(path.join(input.orchDir, 'observed.json'), JSON.stringify({ url: 'http://localhost/settings', text: 'Current minimum page size of 25.' }));
  writeFileSync(input.brief, JSON.stringify(spec));
  const original = client.request.bind(client);
  client.request = (method, params) => method === 'skills/list' ? {data: [{cwd: input.worktree, skills: [{enabled: true, name: 'closedloop-core:guided-manual-qa', pluginId: 'closedloop-core@closedloop-ai', path: guide}]}]} : original(method, params);
  return { input: { ...input, writerThread: 'current-writer' }, calls, client, spec };
}

async function dispatchGuide(fixture) {
  const runtime = await import('./codex-review-runtime.mjs');
  return runtime.launchQaGuide(fixture.input, async () => fixture.client, () => ({url:"https://github.com/sample/guide/pull/27",headRefOid:"a".repeat(40)}));
}

test('AC-093: fresh read-only QA guide loads both skills on the managed launcher', async t => {
  const fixture = guideFixture(t);
  const { threadId, stateFile } = await dispatchGuide(fixture);
  assert.notEqual(threadId, fixture.input.writerThread);
  assert.equal(JSON.parse(readFileSync(stateFile)).threadId, threadId);
  const start = fixture.calls.find(([method]) => method === 'thread/start')[1];
  assert.equal(start.sandbox, 'read-only');
  const turn = fixture.calls.find(([method]) => method === 'turn/start')[1];
  assert.deepEqual(turn.sandboxPolicy, {type: 'readOnly'});
  for (const loaded of ['Repository control instructions.', 'Installed manual QA instructions.']) assert.ok(turn.input[0].text.includes(loaded));
  const collision = guideFixture(t); collision.input.writerThread = threadId;
  await assert.rejects(dispatchGuide(collision), /writer thread/);
  assert.ok(!collision.calls.some(([method]) => method === 'turn/start'));
});

test('AC-094: dispatched QA brief contains plan, stack, API permission and unblock rule', async t => {
  const fixture = guideFixture(t); await dispatchGuide(fixture);
  const prompt = fixture.calls.find(([method]) => method === 'turn/start')[1].input[0].text;
  for (const text of [fixture.spec.plan, fixture.spec.stackFacts, 'QA-database data through the product API', 'try every documented unblock before BLOCKED', 'ready and waiting']) assert.ok(prompt.includes(text), text);
});

test('AC-095: an unchecked or contradicted product number refuses before guide dispatch', async t => {
  for (const update of [s => { s.plan = 'Check the minimum page size of 5/10.'; }, s => { s.numberChecks[0].observation = 'minimum page size of 5'; }, s => { s.stackFacts += '\nDesktop has 25 rows.'; }, s => { s.productOrigin = 'http://other.invalid'; }]) {
    const fixture = guideFixture(t); update(fixture.spec); writeFileSync(fixture.input.brief, JSON.stringify(fixture.spec));
    await assert.rejects(dispatchGuide(fixture), /product number/);
    assert.equal(fixture.calls.length, 0);
  }
});

test('QA numeric evidence cannot certify a prefix of the observed quantity', async t => {
  const fixture = guideFixture(t);
  writeFileSync(path.join(fixture.input.orchDir, 'observed.json'), JSON.stringify({ url: 'http://localhost/settings', text: 'minimum page size of 250' }));
  await assert.rejects(dispatchGuide(fixture), /product number/);
  assert.equal(fixture.calls.length, 0);
});

test('a foreign control document or disabled QA skill cannot launch the guide', async t => {
  const foreign = guideFixture(t); foreign.spec.controlSkill = '../guided-manual-qa/SKILL.md';
  writeFileSync(foreign.input.brief, JSON.stringify(foreign.spec));
  await assert.rejects(dispatchGuide(foreign), /inside this checkout/);
  const disabled = guideFixture(t);
  const original = disabled.client.request;
  disabled.client.request = async (method, params) => {
    const reply = await original(method, params);
    if (method === 'skills/list') reply.data[0].skills[0].enabled = false;
    return reply;
  };
  await assert.rejects(dispatchGuide(disabled), /missing or ambiguous/i);
  assert.ok(!disabled.calls.some(([method]) => method === 'thread/start'));
});

test('the bundled guide entry refuses an unverified brief before any model call', t => {
  const fixture = guideFixture(t);
  fixture.spec.numberChecks = []; writeFileSync(fixture.input.brief, JSON.stringify(fixture.spec));
  const { input } = fixture;
  const cli = fileURLToPath(new URL('../../../skills/vibe/scripts/dist/codex-reviewer.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'qa-guide', '--orch-dir', input.orchDir, '--worktree', input.worktree,
    '--helper', input.helper, '--model', input.model, '--writer-thread', input.writerThread, '--brief', input.brief], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unverified running product number/);
});

test('AC-096: Roles defaults the QA guide to Codex and the gate uses the shipped launcher', () => {
  const fleet = '../../../skills/fleet-orchestrator/';
  const roles = readFileSync(new URL(fleet + 'SKILL.md', import.meta.url), 'utf8');
  assert.match(roles, /^\|[^\n]*QA.guide[^\n]*Codex[^\n]*default/im);
  const gate = readFileSync(new URL(fleet + 'references/fleet-qa-gate.md', import.meta.url), 'utf8');
  assert.match(gate, /codex-reviewer\.mjs qa-guide/);
});

test('observed QA quantities retain their signs', async t => {
  const fixture = guideFixture(t);
  fixture.spec.plan = 'Expected offset +5.';
  fixture.spec.numberChecks = [{claim: fixture.spec.plan, observation: 'offset -5', evidence:'observed.json'}];
  writeFileSync(fixture.input.brief, JSON.stringify(fixture.spec));
  writeFileSync(path.join(fixture.input.orchDir,'observed.json'), JSON.stringify({url:'http://localhost/settings',text:'offset -5'}));
  await assert.rejects(dispatchGuide(fixture), /product number/);
});

test('the repository control skill must declare the required identity', async t => {
  const fixture = guideFixture(t);
  writeFileSync(path.join(fixture.input.worktree, fixture.spec.controlSkill), '---\nname: guide-notes\n---\nOther skill.');
  await assert.rejects(dispatchGuide(fixture), /control skill/i);
  assert.equal(fixture.calls.length, 0);
});

test('QA guide verifies PR identifiers independently of product numbers', async t => {
  const fixture = guideFixture(t);
  const repo = 'sample/guide';
  fixture.spec.pullRequest = { repository: repo, number: 27, head: 'a'.repeat(40) };
  writeFileSync(fixture.input.brief, JSON.stringify(fixture.spec));
  const {prepareGuide} = await import('./qa-guide-brief.mjs');
  const lookup = () => ({url:'https://github.com/'+repo+'/pull/27', headRefOid: 'a'.repeat(40)});
  assert.match(prepareGuide(fixture.input.brief, fixture.input.worktree, lookup), /sample\/guide#27/);
  assert.throws(() => prepareGuide(fixture.input.brief,fixture.input.worktree,() => ({...lookup(), headRefOid: 'b'.repeat(40)})), /PR head/);
});

test("AC-095 distinguishes criterion references, product fields and fractional observations", async t => {
  const routed = guideFixture(t);
  routed.spec.plan = "### Q1\n- Criterion: AC-1\n" + routed.spec.plan;
  routed.spec.criteriaSource = "criteria.md";
  writeFileSync(path.join(routed.input.orchDir, "criteria.md"), "- AC-1: Minimum page size");
  writeFileSync(routed.input.brief, JSON.stringify(routed.spec));
  await dispatchGuide(routed);
  routed.spec.plan = routed.spec.plan.replace("AC-1", "AC-2");
  writeFileSync(routed.input.brief, JSON.stringify(routed.spec));
  await assert.rejects(dispatchGuide(routed), /criterion|criteria/i);
  for (const [claim, quote, text] of [
    ["Minimum page size 5.", "Selected rows 5.", "Minimum page size 25. Selected rows 5."],
    ["Delay 5 seconds", "5 seconds", "Delay .5 seconds"],
    ["Delay .5 seconds", ".5 seconds", "Delay -.5 seconds"],
  ]) {
    const guide = guideFixture(t);
    guide.spec.plan = claim;
    guide.spec.numberChecks = [{claim, observation: quote, evidence: "observed.json"}];
    writeFileSync(path.join(guide.input.orchDir, "observed.json"), JSON.stringify({url:"http://localhost/settings", text}));
    writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
    await assert.rejects(dispatchGuide(guide), /Unverified running product number/);
  }
});

for (const [label, claim, observation, captured] of [
  ["complete field", "Active users 5", "active users 5", "25 active users 5 days ago"],
  ["inactive word", "Active users 5", "active users 5", "inactive users 5"],
  ["unit before value","Verify power (MW): 5","power (mW): 5","power (mW): 5"],
  ["unit scale", "Rate 5%", "Rate 5‰", "Rate 5‰"],
  ["currency", "Discount 5%", "Discount $5", "Discount $5"],
]) test("AC-095 refuses a mismatched " + label + " before guide dispatch", async t => {
  const guide = guideFixture(t);
  guide.spec.plan = claim;
  guide.spec.numberChecks = [{claim, observation, evidence:"observed.json"}];
  writeFileSync(path.join(guide.input.orchDir, "observed.json"), JSON.stringify({url:"http://localhost/settings", text:captured}));
  writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
  await assert.rejects(dispatchGuide(guide), /Unverified running product number/);
});

test("AC-095 requires a criterion declaration in a separate ticket artifact", async t => {
  const guide = guideFixture(t);
  guide.spec.plan = "Check AC-999";
  for (const source of [path.basename(guide.input.brief), "notes.md"]) {
    guide.spec.criteriaSource = source;
    writeFileSync(path.join(guide.input.orchDir, "notes.md"), "Discussion mentions AC-999.");
    writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
    await assert.rejects(dispatchGuide(guide), /criterion|criteria/i);
  }
});

test("the QA guide binds a complete numeric field in a product API response", async t => {
  const guide = guideFixture(t);
  const claim = "Verify active users 25";
  guide.spec.plan = claim;
  guide.spec.numberChecks = [{claim, observation:'"active users":25', evidence:"observed.json"}];
  writeFileSync(path.join(guide.input.orchDir, "observed.json"), JSON.stringify({url:"http://localhost/settings", text:'{"active users":25,"inactive users":5}'}));
  writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
  await dispatchGuide(guide);
});

test("AC-095 review measurement unit case distinguishes bytes from bits", async t => {
  for (const [claimValue, observedValue] of [["5 A","5"],["5 A","5 a"],["5 MB/s","5 Mb/s"],["5′","5″"],["25 m²","25 m"],["5 kg·m/s²","5 kg m/s²"],["5 km","5"]]) {
    const guide = guideFixture(t), claim = "Verify measurement is " + claimValue, observation = "measurement " + observedValue;
    guide.spec.plan = claim;
    guide.spec.numberChecks = [{claim, observation, evidence:"observed.json"}];
    writeFileSync(path.join(guide.input.orchDir, "observed.json"), JSON.stringify({url:"http://localhost/settings", text:observation}));
    writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
    await assert.rejects(dispatchGuide(guide), /Unverified running product number/);
  }
});

test("AC-095 review numbered Markdown under Acceptance criteria declares only those items", async t => {
  const guide = guideFixture(t);
  guide.spec.criteriaSource = "criteria.md";
  writeFileSync(path.join(guide.input.orchDir, "criteria.md"), "## Acceptance criteria\n1. First criterion\n2. Second criterion\n## Notes\n3. Other material\n");
  for (const id of ["AC-1", "AC-2", "AC-3"]) {
    guide.spec.plan = "Check " + id;
    writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
    if (id === "AC-3") await assert.rejects(dispatchGuide(guide), /criterion/);
    else await dispatchGuide(guide);
  }
});

test("AC-095 review observation and brief must have distinct file identities", async t => {
  for (const alias of [false,true]) {
    const guide = guideFixture(t), claim = "Verify bandwidth 5";
    guide.spec.plan = claim;
    guide.spec.url = "http://localhost/settings";
    guide.spec.text = "bandwidth 5";
    const name = alias ? "observation.json" : path.basename(guide.input.brief);
    guide.spec.numberChecks = [{claim, observation:guide.spec.text, evidence:name}];
    writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
    if (alias) linkSync(guide.input.brief, path.join(guide.input.orchDir,name));
    await assert.rejects(dispatchGuide(guide), /Unverified running product number/);
  }
});

test("QA criterion declarations preserve exact references across ordering, duplicates, whitespace and case",async t=>{
  const guide=guideFixture(t);
  guide.spec.criteriaSource="criteria.md";
  for(const rows of [["  - AC-11: Alpha","- AC-12: Beta","- AC-11: Twice"],["- AC-12: Beta","- AC-11: Alpha"]]){
    writeFileSync(path.join(guide.input.orchDir,"criteria.md"),rows.join("\n")+"\n- ac-13: Lowercase");
    guide.spec.plan="Verify AC-11 and AC-12";
    writeFileSync(guide.input.brief,JSON.stringify(guide.spec));
    await dispatchGuide(guide);
    guide.spec.plan="Verify AC-13";
    writeFileSync(guide.input.brief,JSON.stringify(guide.spec));
    await assert.rejects(dispatchGuide(guide),/criterion/i);
  }
});

test("QA guide verifies every declaration form against Markdown prose",async t=>{
  const guide=guideFixture(t);
  guide.spec.criteriaSource="criteria.md";
  const fence="`".repeat(3);
  for(const [document,id,live] of [
    ["## Acceptance criteria\n1. First\n- ~~~text\n  sample\n  ~~~\n2. Second","AC-2",true],
    ["## Acceptance criteria\n"+fence+"inline"+fence+"\n1. First","AC-1",true],
    ["## Acceptance criteria\n"+fence+"\n- AC-77: Example\n"+fence,"AC-77",false],
    ["## Acceptance criteria\n"+fence+"\n- [ ] Example\n"+fence,"AC-1",false],
  ]){
    writeFileSync(path.join(guide.input.orchDir,"criteria.md"),document);
    guide.spec.plan="Verify "+id;
    writeFileSync(guide.input.brief,JSON.stringify(guide.spec));
    if(live)await dispatchGuide(guide);else await assert.rejects(dispatchGuide(guide),/criterion/i);
  }
});
