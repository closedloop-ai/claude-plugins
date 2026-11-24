import { commitAt } from "./fixtures/e2e-lock-args.mjs";
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUSY_EXIT } from './e2e-lock.mjs';

const SCRIPT = fileURLToPath(new URL('./e2e-lock.mjs', import.meta.url));
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'machine-slot-')));
const original = process.cwd();
const worktree = path.join(root, 'checkout');
mkdirSync(worktree);
const SHA = commitAt(worktree);
process.chdir(worktree);
after(() => { process.chdir(original); rmSync(root, {recursive: true, force: true}); });

/** Exercise the shell's actual filesystem contract against a disposable slot and a genuine Vibe run. */
test("AC-097/098/099 existing machine holder refuses Vibe before the command and names the holder", async t => {
  const { runE2e } = await import('./e2e-lock.mjs');
  const slot = path.join(root, 'existing-machine-slot');
  const local = path.join(root, 'new-writer-state');
  mkdirSync(slot); writeFileSync(path.join(slot, 'pid'), String(process.pid));
  const holder = {owner: 'machine-operator', label: 'desktop check QA-42', ticket: 'QA-42', composeProject: 'qa-product'};
  writeFileSync(path.join(slot, 'owner'), JSON.stringify(holder));
  const output = []; t.mock.method(process.stdout, 'write', bytes => { output.push(bytes); return true; });
  const marker = path.join(root, 'machine-busy-marker');
  const args = ['run', '--head', SHA, '--lock-dir', local, '--ticket', 'QA-43', '--wait-seconds', '0', process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1],"ran")', marker];
  assert.equal(await runE2e(args, slot), BUSY_EXIT);
  assert.deepEqual(JSON.parse(output.pop()).holder, holder);
  assert.equal(existsSync(marker), false);
  writeFileSync(path.join(slot, 'owner'), 'legacy QA-42 since 14:32');
  assert.equal(await runE2e(args, slot), BUSY_EXIT);
  assert.match(JSON.parse(output.pop()).holder.label, /legacy QA-42/);
  assert.ok(existsSync(path.join(slot,'pid')));
});

test("AC-099 Vibe holder is visible to the existing shell mkdir and cat path", async t => {
  const {runE2e} = await import('./e2e-lock.mjs');
  const originalProject = process.env.COMPOSE_PROJECT_NAME; process.env.COMPOSE_PROJECT_NAME = 'qa-vibe-fixture';
  t.after(() => { if (originalProject === undefined) delete process.env.COMPOSE_PROJECT_NAME; else process.env.COMPOSE_PROJECT_NAME = originalProject; });
  const slot = path.join(root,'reverse-machine-slot');
  const local = path.join(root,'reverse-private-lock');
  const observed = path.join(root,'reverse-observation');
  // The external queue only grants on successful mkdir. Its busy message reads exactly this owner file.
  const shell = 'if mkdir "$1" 2>/dev/null; then exit 9; fi; cat "$1/owner" > "$2"; cat "$3"/e2e-command-*.json > "$2.child"';
  const code = await runE2e(['run','--head',SHA,'--lock-dir',local,'--owner','writer','--label','review stack','--ticket','QA-43',
    '--wait-seconds','0','sh','-c',shell,'fixture',slot,observed,root], slot);
  assert.equal(code,0);
  const holder = JSON.parse(readFileSync(observed,'utf8'));
  assert.equal(holder.owner,'writer'); assert.equal(holder.label,'review stack'); assert.equal(holder.ticket,'QA-43');
  assert.equal(holder.composeProject, 'qa-vibe-fixture');
  const command = JSON.parse(readFileSync(observed + '.child', 'utf8'));
  assert.ok(command.child.pgid > 1 && command.child.identity);
  assert.equal(existsSync(slot),false);
});

test("AC-100 the operator's one-line shell adapter writes all holder facts or refuses an unlabeled ticket", () => {
  const result = spawnSync(process.execPath,[SCRIPT,'machine-owner','desktop QA-42','qa-product'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{owner:os.userInfo().username,label:'desktop QA-42',ticket:'QA-42',composeProject:'qa-product'});
  const missing = spawnSync(process.execPath,[SCRIPT,'machine-owner','desktop','qa-product'],{encoding:'utf8'});
  assert.notEqual(missing.status,0); assert.match(missing.stderr,/ticket/i);
});

test("machine E2E recovery preserves foreign, partial and live-child slots", async () => {
  const {claimMachineSlot, releaseMachineSlot} = await import('./machine-stack-slot.mjs');
  const slot = path.join(root, 'recovery-slot'), local = path.join(root, 'private-recovery');
  const first = {pid: process.pid, token: 'f0ce9dd7-b16c-4cb1-b9ed-b0856e9a42e0', name:'old', label:'old', ticket:'QA-1', composeProject:'old'};
  const next = {...first, token:'56365901-e65b-45db-b99f-5d2bb0bce0ff', name:'new', label:'new'};
  assert.equal(claimMachineSlot(slot,local,first,() => false),null);
  assert.equal(claimMachineSlot(slot,local,next,() => true).owner,'old');
  assert.equal(claimMachineSlot(slot,local+'-other',next,() => false).owner,'old');
  releaseMachineSlot(slot,local,next.token); assert.ok(existsSync(slot));
  assert.equal(claimMachineSlot(slot,local,next,() => false),null);
  releaseMachineSlot(slot,local,next.token); assert.equal(existsSync(slot),false);
  mkdirSync(slot); utimesSync(slot, new Date(0),new Date(0));
  assert.ok(claimMachineSlot(slot,local,next,() => false)); assert.ok(existsSync(slot));
});

test("machine E2E CLI requires a real ticket before acquiring a slot", async () => {
  const {runE2e} = await import('./e2e-lock.mjs');
  const slot = path.join(root, 'missing-ticket-slot');
  await assert.rejects(runE2e(['run','--head',SHA,'--lock-dir',path.join(root,'missing-ticket-state'),'true'],slot),/needs --ticket/);
  assert.equal(existsSync(slot),false);
});

test("a descriptive branch uses its recorded ticket", async t => {
  const {runE2e} = await import('./e2e-lock.mjs');
  const session = path.join(worktree, '.git', 'vibe-session.json');
  writeFileSync(session, JSON.stringify({liveTicket: "QA-74"}));
  t.after(() => rmSync(session));
  const slot = path.join(root, 'session-slot');
  mkdirSync(slot); writeFileSync(path.join(slot, 'pid'), String(process.pid));
  assert.equal(await runE2e(['run','--head',SHA,'--lock-dir',path.join(root,'session-state'),'--wait-seconds','0','true'],slot),BUSY_EXIT);
});

test("a failed first lease write releases only its own empty slot",async t=>{
  const {claimMachineSlot}=await import("./machine-stack-slot.mjs");
  const {default:fs}=await import("node:fs");
  const {syncBuiltinESMExports}=await import("node:module");
  const owner={pid:process.pid,token:"f0ce9dd7-b16c-4cb1-b9ed-b0856e9a42e0",name:"writer",label:"fixture",ticket:"QA-1",composeProject:"fixture"};
  for(const replacement of [false,true]){
    const slot=path.join(root,"unwritten-"+replacement), local=path.join(root,"private-"+replacement);
    const original=fs.writeFileSync;
    const mock=t.mock.method(fs,"writeFileSync",function(file,...args){
      if(file===path.join(slot,"vibe-lease.json")){
        if(replacement){fs.renameSync(slot,slot+"-old");fs.mkdirSync(slot);}
        throw Object.assign(new Error("disk full"),{code:"ENOSPC"});
      }
      return original(file,...args);
    });
    syncBuiltinESMExports();
    try {assert.throws(()=>claimMachineSlot(slot,local,owner,()=>false),{code:"ENOSPC"});}
    finally {mock.mock.restore();syncBuiltinESMExports();}
    assert.equal(existsSync(slot),replacement);
    if(!replacement) assert.equal(claimMachineSlot(slot,local,owner,()=>false),null);
  }
});
