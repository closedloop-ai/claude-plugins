import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { imageProblem, invalidateImages, recordImages, reusesImages } from "./image-head.mjs";
import { git, makeHome, mutationPreload } from '../../../../vibe/skills/vibe/scripts/test-fixtures.mjs';

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
  const args = ['--project', 'p', '--worktree', wt, '--head', head, '--records', records, '--', 'e2e/run-containerized.sh'];
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
  for (const unrelated of ["node --version","echo e2e/run-containerized.sh","true || e2e/run-containerized.sh",
    "node e2e/run-containerized.sh","docker compose -p fixture -f docker-compose.yml build","docker compose -f e2e/compose.yml -f extra.yml build","docker compose build","docker compose ps","docker compose up --no-build","docker compose build --print","docker compose build --check","docker compose build --help","docker compose --dry-run build"]) {
    assert.equal(recordImages({...base,head:A,command:unrelated}),false);
  }
  assert.equal(imageProblem({ ...base, head: A, command: "e2e/run-containerized.sh" }), null);
  assert.match(imageProblem({ ...base, head: A, command: "e2e/run-containerized.sh --no-build" }), /no recorded build/);
  assert.equal(recordImages({ ...base, head: A, command: "e2e/run-containerized.sh --no-build" }), false);
  for (const command of ["docker compose -f e2e/compose.yml build","docker compose -f e2e/compose.yml up --build","e2e/run-containerized.sh"]) {
    assert.equal(recordImages({ ...base, head: A, command }), true, command);
  }
  const compound={...base,command:"docker compose -f e2e/compose.yml build api && true"};
  invalidateImages(compound);
  assert.match(imageProblem({...base,head:A,command:"e2e/run-containerized.sh --no-build"}),/no recorded build/);
  assert.equal(recordImages({...compound,head:B}),false);
  assert.equal(recordImages({...base,head:A,command:"docker compose -f e2e/compose.yml build"}),true);
  for (const option of ["--print","--check"]) invalidateImages({...base,command:"docker compose build "+option});
  const partial = { ...base, command:"docker compose -f e2e/compose.yml build api" };
  invalidateImages(partial);
  assert.match(imageProblem({...base,head:A,command:"e2e/run-containerized.sh --no-build"}),/no recorded build/);
  assert.equal(recordImages({...partial,head:B}),false);
  assert.equal(recordImages({...base,head:A,command:"docker compose -f e2e/compose.yml build"}),true);
  assert.equal(imageProblem({ ...base, head: A.slice(0, 12), command: "e2e/run-containerized.sh --no-build" }), null);
  assert.match(imageProblem({ ...base, head: B, command: "e2e/run-containerized.sh --no-build" }), /built from aaaaaaaaaaaa, not bbbbbbbbbbbb/);
  assert.match(imageProblem({ ...base, worktree: "/wt/baseline", head: A, command: "e2e/run-containerized.sh --no-build" }), /worktree switch/);
  const wt = path.join(records, 'wt');
  mkdirSync(wt);
  const git = (...args) => execFileSync('git', ['-C', wt, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'base');
  const head = git('rev-parse', 'HEAD');
  const cli = (action, head, ...command) => spawnSync(process.execPath, [SCRIPT, action, "--project", "cl-e2e", "--worktree", wt,
    "--head", head, "--records", records, "--", ...command], { encoding: "utf8" });
  assert.equal(cli("check", B, "e2e/run-containerized.sh", "--no-build").status, 1);
  assert.equal(cli("record", head, "e2e/run-containerized.sh").status, 0);
  assert.equal(cli("check", head, "e2e/run-containerized.sh", "--no-build").status, 0);
  writeFileSync(path.join(wt, 'dirty.txt'), 'uncommitted input');
  assert.equal(cli('check', head, 'e2e/run-containerized.sh', '--no-build').status, 1, 'HEAD alone cannot validate reused images after uncommitted edits');
  assert.equal(cli('record', head, 'e2e/run-containerized.sh').status, 0);
  assert.equal(cli('check', head, 'e2e/run-containerized.sh', '--no-build').status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "check"], { encoding: "utf8" }).status, 2);
});

test("Compose receipt project and runner path follow the actual build", async t => {
  const {explicitComposeProject, certifiesComposeImages, changesComposeImages} = await import("./docker-disk-admission.mjs");
  const envBuild = "COMPOSE_PROJECT_NAME=secondary docker compose -f e2e/compose.yml";
  assert.equal(explicitComposeProject("sh", ["-c", envBuild+" build"]), "secondary");
  assert.equal(explicitComposeProject("sh", ["-c", envBuild+" -p primary build"]), "primary");
  assert.throws(()=>explicitComposeProject("sh",["-c",envBuild+" build && docker compose -p other start"]), /project/i);
  const records=mkdtempSync(path.join(os.tmpdir(),"project-witness-"));
  t.after(()=>rmSync(records,{recursive:true,force:true}));
  assert.equal(recordImages({project:"primary",worktree:"/owned",head:A,records,command:envBuild+" build"}),false);
  assert.equal(recordImages({project:"secondary",worktree:"/owned",head:A,records,command:envBuild+" build"}),true);
  for (const runner of ["/foreign/e2e/run-containerized.sh","../foreign/e2e/run-containerized.sh"]) {
    assert.equal(changesComposeImages("bash",[runner]),true);
    assert.equal(certifiesComposeImages("bash",[runner],"/owned"),false);
  }
  assert.equal(certifiesComposeImages("bash",["/owned/e2e/run-containerized.sh"],"/owned"),true);
  assert.equal(certifiesComposeImages("bash",["e2e/run-containerized.sh"],"/owned","/owned/subdir"),false);
  mkdirSync(path.join(records,"e2e"));
  const foreign=path.join(records,"foreign.sh");
  writeFileSync(foreign,"fixture");
  symlinkSync(foreign,path.join(records,"e2e","run-containerized.sh"));
  assert.equal(certifiesComposeImages("bash",["e2e/run-containerized.sh"],records),false);
});

test("only a foreground build from the selected package can publish an image witness", t => {
  const root = mkdtempSync(path.join(os.tmpdir(),"owned-witness-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const nested = path.join(root,"nested");
  mkdirSync(nested);
  writeFileSync(path.join(root,"package.json"),JSON.stringify({scripts:{"e2e:containerized":"bash e2e/run-containerized.sh"}}));
  writeFileSync(path.join(nested,"package.json"),JSON.stringify({scripts:{"e2e:containerized":"true"}}));
  const base={project:"fixture",worktree:root,head:A,records:path.join(root,"records")};
  for (const [argv,cwd,expected] of [
    [["pnpm","run","e2e:containerized"],root,true],
    [["pnpm","run","e2e:containerized"],nested,false],
    [["sh","-c","e2e/run-containerized.sh &"],root,false],
  ]) assert.equal(recordImages({...base,cwd,argv}),expected,argv.join(" ")+cwd);
});

test("Compose project follows the effective client environment and compact CLI options",async()=>{
  const {explicitComposeProject,containerizedIntent}=await import("./docker-disk-admission.mjs");
  const cli="docker compose -f e2e/compose.yml";
  assert.equal(explicitComposeProject("sh",["-c","export COMPOSE_PROJECT_NAME=second; "+cli+" build"],"first"),"second");
  for(const start of ["unset COMPOSE_PROJECT_NAME; ","env -u COMPOSE_PROJECT_NAME "]) {
    assert.throws(()=>explicitComposeProject("sh",["-c",start+cli+" build"],"first"),/project/i);
    assert.equal(explicitComposeProject("sh",["-c",start+cli+" -pother build"],"first"),"other");
  }
  assert.equal(containerizedIntent("docker",["compose","-pother","-f","e2e/compose.yml","up"]),"reuse");
});

test("effective Compose context preserves nested shell projects and executable wrappers",async()=>{
  const {explicitComposeProject, changesComposeImages,containerizedIntent}=await import("./docker-disk-admission.mjs");
  const docker="docker compose -f e2e/compose.yml build";
  for(const prefix of ["env COMPOSE_PROJECT_NAME=child","COMPOSE_PROJECT_NAME=child"]){
    const payload=prefix+" sh -c '"+docker+"'";
    assert.equal(explicitComposeProject("sh",["-c",payload],"outer"),"child");
  }
  for (const assignment of ["COMPOSE_PROJECT_NAME+=2 ","export COMPOSE_PROJECT_NAME+=2; "]) {
    assert.throws(()=>explicitComposeProject("bash",["-c",assignment+docker],"2"),/project/i);
    assert.equal(explicitComposeProject("bash",["-c",assignment+docker.replace(" build"," -pfinal build")],"2"),"final");
  }
  for(const prefix of ["pnpm exec ","pnpm -C . exec ",""])for(const ctx of ["","--context default "]) {
    const command=prefix+"docker "+ctx+"compose -f e2e/compose.yml build";
    assert.equal(containerizedIntent("sh",["-c",command]),"build",command);
    assert.equal(changesComposeImages("sh",["-c",command]),true,command);
  }
});

test("Compose project and invalidation follow the same reachable process",async()=>{
  const {changesComposeImages,containerizedIntent,explicitComposeProject}=await import("./docker-disk-admission.mjs");
  const build="compose -f e2e/compose.yml build";
  for(const [body,expected] of [["tool=docker; $tool "+build,true],["false && docker "+build,false],["true || docker "+build,false],["true && docker "+build,true]]) {
    assert.equal(changesComposeImages("sh",["-c",body]),expected,body);
    assert.equal(containerizedIntent("sh",["-c",body])==="build",expected,body);
  }
  assert.equal(explicitComposeProject("sh",["-c","false && docker compose -punused ps; docker compose -pcurrent ps"]),"current");
  const child="sh -c 'COMPOSE_PROJECT_NAME=$ONLY_PARENT docker "+build+"'";
  assert.throws(()=>explicitComposeProject("sh",["-c","ONLY_PARENT=sample; "+child],"default"),/project/i);
  assert.equal(explicitComposeProject("sh",["-c","export ONLY_PARENT=sample; "+child],"default"),"sample");
});
