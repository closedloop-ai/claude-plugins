import assert from "node:assert/strict";
import { spawnSync as spawn } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitAt, isolatedArgs } from "./fixtures/e2e-lock-args.mjs";

const SCRIPT = fileURLToPath(new URL("./e2e-lock.mjs",import.meta.url));
const spawnSync = (cmd,args,opts) => spawn(cmd,isolatedArgs(cmd,args),opts);

test("a --no-build run needs images built from the head it tests in the same worktree (stale-image reruns, ISS-13067)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(),"vibe-image-witness-"));
  after(()=>rmSync(root,{recursive:true,force:true}));
  const lockDir = path.join(root, "image-head", "e2e-stack");
  const wt = path.join(root, "wt-images");
  const other = path.join(root, "wt-images-other");
  mkdirSync(wt);
  mkdirSync(other);
  const first = commitAt(wt);
  commitAt(other);
  const env = { ...process.env, COMPOSE_PROJECT_NAME: "cl-e2e-fixture" };
  Reflect.deleteProperty(env, "VIBE_E2E_FOREIGN_COMPOSE");
  const run = (cwd, sha, ...flags) => spawnSync(process.execPath, [SCRIPT, "run", "--head", sha, "--lock-dir", lockDir,
    process.execPath, "-e", "0", "--", ...flags], { encoding: "utf8", cwd, env });
  assert.match(run(wt, first, "--no-build").stderr, /STALE-IMAGES no recorded build/);
  assert.equal(run(wt, first).status, 0, "ordinary command completes");
  assert.match(run(wt, first, "--no-build").stderr, /no recorded build/);
  const build = (cwd, sha) => spawnSync(process.execPath, [SCRIPT, "run", "--head", sha, "--lock-dir", lockDir,
    "sh", path.join(root,"run-containerized.sh")], {encoding:"utf8",cwd,env});
  writeFileSync(path.join(root,"run-containerized.sh"), "exit 0\n");
  assert.equal(build(wt, first).status, 0, "an identified image build records its images");
  assert.equal(run(wt, first, "--no-build").status, 0, "reuse at the same head and worktree");
  const elsewhere = run(other, spawnSync("git", ["-C", other, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), "--no-build");
  assert.equal(elsewhere.status, 1);
  assert.match(elsewhere.stderr, /STALE-IMAGES .*(built from|built in)/);
  spawnSync("git", ["-C", wt, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "--allow-empty", "-m", "fix"]);
  const fix = spawnSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const reused = run(wt, fix, "--no-build");
  assert.equal(reused.status, 1);
  assert.match(reused.stderr, new RegExp(`STALE-IMAGES cl-e2e-fixture's images were built from ${first.slice(0, 12)}`));
  assert.equal(run(wt, fix).status, 0);
  assert.match(run(wt, fix, "--no-build").stderr, /STALE-IMAGES/);
  assert.equal(build(wt, fix).status, 0);
  assert.equal(run(wt, fix, "--no-build").status, 0);
});

test("explicit Compose project owns slot metadata and takes precedence over the caller environment",t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),"vibe-project-lease-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const worktree=path.join(root,"repo"), bin=path.join(root,"bin"), lock=path.join(root,"lease");
  mkdirSync(worktree);mkdirSync(bin);
  const head=commitAt(worktree), holder=path.join(root,"observed");
  writeFileSync(path.join(bin,"docker"),"#!/usr/bin/env node\nif(process.argv.includes('up'))require('node:fs').copyFileSync("+JSON.stringify(path.join(lock,"owner.json"))+","+JSON.stringify(holder)+");else console.log('[]');",{mode:0o700});
  const result=spawnSync(process.execPath,[SCRIPT,"run","--head",head,"--lock-dir",lock,"--ticket","fixture-42","--","docker","compose","-p","selected","-f","e2e/compose.yml","up","-d"],
    {cwd:worktree,encoding:"utf8",env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,COMPOSE_PROJECT_NAME:"ambient"}});
  assert.equal(result.status,0,result.stderr);
  const recorded=JSON.parse(readFileSync(holder,"utf8"));
  assert.equal(recorded.composeProject,"selected");assert.equal(recorded.ticket,"fixture-42");
});
