import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { canonicalGitTimestamp, cloudHostEnvironment, prepareHostChromium, reserveCloudPorts, runCloudHostPlan, validationHostActor } from "./cloud-validation-host.mjs";
import { installPnpmHelpFixture } from "./pnpm-help-test-fixture.mjs";

installPnpmHelpFixture();

const PASS = { exitCode: 0, stdoutTail: "ok", stderrTail: "", diagnosis: "" };
const FAIL = { exitCode: 1, stdoutTail: "", stderrTail: "fixture failure", diagnosis: "fixture failure" };

function fixture(t) {
  const f = makeHome("vibe-validation-host-");
  t.after(f.cleanup);
  const checkout = path.join(f.root, "checkout");
  const directory = path.join(f.root, "state");
  mkdirSync(checkout);
  mkdirSync(directory);
  return { checkout, directory };
}

test("ISS-14476 reserves ten disjoint cloud ranges, refuses exhaustion, and reuses exact released leases", async (t) => {
  const { directory } = fixture(t);
  const range = { first: 30000, last: 30319, width: 32 };
  const active = await Promise.all(Array.from({ length: 10 }, async () => reserveCloudPorts(directory, range)));
  assert.equal(new Set(active.map(({ first }) => first)).size, 10);
  assert.ok(active.every((entry, index) => index === 0 || active[index - 1].last < entry.first));
  assert.throws(() => reserveCloudPorts(directory, range), /CLOUD_PORT_RANGE_EXHAUSTED/);
  active[1].release();
  const reused = reserveCloudPorts(directory, range);
  assert.equal(reused.first, active[1].first);
  active[1].release();
  assert.throws(() => reserveCloudPorts(directory, range), /CLOUD_PORT_RANGE_EXHAUSTED/);
  reused.release();
  active.forEach((entry) => entry.release());
});

test("ISS-14476 the runtime sends every lane to a non-root actor with fixed disjoint ports and handles mode 000 as EACCES", (t) => {
  const f = fixture(t);
  const called = [];
  const selection = [{ name: "web", command: "pnpm control up web" }, { name: "node", command: "node check.mjs" }];
  const observed = runCloudHostPlan({ ...f, lanes: selection, uid: 0, gid: 0, provision: () => {},
    environment: { PATH: "/bin", SECRET_EXAMPLE: "fixture" },
    run: (command, args, options) => { called.push({ command, args, options }); return PASS; } });
  assert.deepEqual(validationHostActor({ uid: 0, gid: 0 }), { uid: 65534, gid: 65534 });
  assert.ok(called.every(({ options }) => options.uid > 0 && options.gid > 0 && !options.env.SECRET_EXAMPLE));
  assert.deepEqual(called[0].args.slice(-4), ["--app-port", "20000", "--api-port", "20001"]);
  assert.notEqual(called[0].options.env.CONTROL_REGISTRY_DIR, called[1].options.env.CONTROL_REGISTRY_DIR);
  assert.ok(observed[0].runtime.ports[1] < observed[1].runtime.ports[0]);
  if (process.getuid() !== 0) {
    const unreadable = path.join(f.checkout, "restricted");
    writeFileSync(unreadable, "fixture");
    chmodSync(unreadable, 0o500);
    assert.throws(() => writeFileSync(unreadable, "write refused"), (error) => error.code === "EACCES");
    chmodSync(unreadable, 0o000);
    assert.throws(() => readFileSync(unreadable), (error) => error.code === "EACCES");
  }
});

test("ISS-14476 Chromium setup retries a failed install, caches only success and uses a headless smoke", (t) => {
  const { checkout, directory } = fixture(t);
  writeFileSync(path.join(checkout, "pnpm-lock.yaml"), "fixture\n");
  const calls = [];
  let installFails = true;
  const options = { environment: {}, actor: { uid: 1500, gid: 1500 }, home: directory,
    run: (_file, args) => {
      calls.push(args);
      if (args.includes("--version")) return {...PASS,stdoutTail:"Version 1.65.0"};
      return args.includes("install") && installFails ? FAIL : PASS;
    } };
  assert.equal(prepareHostChromium(checkout, options).exitCode, 1);
  installFails = false;
  assert.equal(prepareHostChromium(checkout, options).exitCode, 0);
  assert.equal(prepareHostChromium(checkout, options).exitCode, 0);
  assert.deepEqual(calls.filter(args=>args.includes("install")), [["exec", "playwright", "install", "chromium"], ["exec", "playwright", "install", "chromium"]]);
  assert.equal(calls.length, 7);
  assert.ok(calls.at(-1).includes("--browser=chromium"));
  assert.ok(!calls.flat().includes("--with-deps"));
});

test("ISS-14476 runtime stops requested lanes after a failed dependency and normalizes UTC Git timestamps", (t) => {
  const f = fixture(t);
  const called = [];
  const selected = [{ name: "setup:telemetry", command: "pnpm --filter @closedloop-ai/telemetry-contract build", prerequisite: true },
    { name: "desktop", command: "pnpm --dir apps/desktop test", browser: true }];
  const observed = runCloudHostPlan({ ...f, lanes: selected, uid: 1200, gid: 1200,
    run: (_command, args) => { called.push(args); return FAIL; }, browser: () => assert.fail("the requested browser lane should not start") });
  assert.equal(called.length, 1);
  assert.equal(observed[0].exitCode, 1);
  assert.equal(observed[1].exitCode, null);
  assert.match(observed[1].notRun, /setup:telemetry failed/);
  const env = cloudHostEnvironment({ TZ: "America/Chicago", GIT_CONFIG_KEY_2: "source" }, f.directory, "/fixture");
  assert.deepEqual([env.TZ, env.LC_ALL, env.GIT_CONFIG_VALUE_0, env.GIT_CONFIG_KEY_2], ["UTC", "C", "iso-strict-local", undefined]);
  for (const utc of ["2026-11-19T22:10:00Z", "2026-11-19T22:10:00+00:00"]) assert.equal(canonicalGitTimestamp(utc), "2026-11-19T22:10:00Z");
  for (const invalid of ["2026-11-19T22:10:00-05:00", "2026-02-30T00:00:00Z", "2026-11-19", null]) {
    assert.throws(() => canonicalGitTimestamp(invalid), /valid UTC/);
  }
});

test("oversized results for two and eleven lanes survive a capped tool message", async t => {
  const {directory} = fixture(t);
  const {persistHostOutcomes} = await import("./cloud-validation-host.mjs");
  for (const count of [2,11]) {
    const lanes = Array.from({length:count},(_,i)=>({name:"fixture-"+i,...FAIL,stderrTail:"retained log ".repeat(800)}));
    const record = persistHostOutcomes(directory,lanes);
    assert.ok(record.length < 400);
    const {directory:store,count:total} = JSON.parse(record.slice("CLOUD_HOST_LANES ".length));
    assert.equal(total,count);
    const read = lanes.map((_,index)=>JSON.parse(readFileSync(path.join(store,index+".json"),"utf8")));
    assert.deepEqual(read,lanes);
  }
});
test("filtered typechecks run serially and permission-sensitive application lanes select the non-root actor", async t => {
  const {describeCloudLanes} = await import("./cloud-validation-environment.mjs");
  const command = "pnpm turbo typecheck --filter=...[origin/main]";
  for (const lane of describeCloudLanes([{name:"type",command},{name:"app",command:"pnpm --filter @repo/app test"}])) {
    assert.ok(lane.prerequisites.capabilities.includes("nonRoot"));
  }
  const calls=[];
  runCloudHostPlan({...fixture(t),lanes:[{name:"type",command}],uid:0,gid:0,provision:()=>{},
    run:(bin,args,options)=>{calls.push({bin,args,options});return PASS;}});
  assert.ok(calls[0].args.includes("--concurrency=1"));
  assert.ok(calls[0].options.uid>0);
});

test("the pinned browser, headless shell and non-root launch must all agree", t => {
  const {checkout,directory} = fixture(t);
  writeFileSync(path.join(checkout,"pnpm-lock.yaml"), "fixture");
  const options = {home:directory,actor:{uid:65534,gid:65534},environment:{PLAYWRIGHT_BROWSERS_PATH:"/opt/pw-browsers"}};
  for (const mismatch of ["shell","version"]) {
    const calls=[];
    const result = prepareHostChromium(checkout,{...options,run:(bin,args,opt)=>{
      calls.push(bin);
      assert.equal(opt.uid,65534);
      if (bin === "test") {assert.match(args[1],/chromium_headless_shell-1254/);return mismatch==="shell"?FAIL:PASS;}
      return {...PASS,stdoutTail:"Version 1.60.0"};
    }});
    assert.notEqual(result.exitCode,0);
    assert.deepEqual(calls,mismatch==="shell"?["test"]:["test","pnpm"]);
  }
});

test("the nested control test gets its own loopback namespace and reports product port exhaustion", t => {
  const selection = [{name:"control-a",command:"pnpm test",isolateControlPorts:true},{name:"control-b",command:"pnpm test",isolateControlPorts:true}];
  const calls=[];
  const observed = runCloudHostPlan({...fixture(t),lanes:selection,uid:0,gid:0,provision:()=>{},run:(binary,args,options)=>{
    calls.push({binary,args,options});
    return {...FAIL,stderrTail:"no free app/api port pair in 3200-3999"};
  }});
  assert.ok(calls.every(({binary,args,options})=>binary==="unshare" && args.includes("--net") && options.uid>0));
  assert.notEqual(calls[0].options.env.CONTROL_REGISTRY_DIR,calls[1].options.env.CONTROL_REGISTRY_DIR);
  assert.ok(observed.every(result=>result.diagnosis.includes("CLOUD_PORT_RANGE_UNAVAILABLE")));
});

test("host executes quoted literal filters and the root typecheck with cloud concurrency", t=>{
  const calls=[];
  const commands = ["pnpm turbo typecheck --filter=\"...[origin/main]\"","pnpm typecheck"];
  runCloudHostPlan({...fixture(t),lanes:commands.map(command=>({name:command,command})),run:(bin,args,options)=>{
    calls.push({args,limit:options.env.TURBO_TYPECHECK_CONCURRENCY});return PASS;
  }});
  assert.ok(calls[0].args.includes("--filter=...[origin/main]"));
  assert.equal(calls[1].limit,"1");
});

test("managed lane retains both full private streams and actual exit above the previous buffer cap", async t=>{
  const f=fixture(t), size=33*1024*1024;
  writeFileSync(path.join(f.checkout,"emit.cjs"),`const fs=require('node:fs');const b=Buffer.alloc(1048576,97);for(let i=0;i<33;i++){fs.writeSync(1,b);fs.writeSync(2,b)}process.exitCode=17`);
  const [outcome]=runCloudHostPlan({...f,lanes:[{name:"verbose",command:"node emit.cjs"}]});
  assert.equal(outcome.exitCode,17);
  for(const file of Object.values(outcome.streamFiles)) assert.equal(readFileSync(file).length,size);
  assert.ok(outcome.stdoutTail.length<8192 && outcome.stderrTail.length<8192);
  const {persistHostOutcomes}=await import("./cloud-validation-host.mjs");
  const marker=persistHostOutcomes(f.directory,[outcome]);
  const directory=JSON.parse(marker.slice("CLOUD_HOST_LANES ".length)).directory;
  const saved=JSON.parse(readFileSync(path.join(directory,"0.json")));
  for(const channel of ["stdout","stderr"]){
    assert.equal(saved.privateStreams[channel].bytes,size);
    assert.match(saved.privateStreams[channel].sha256,/^[a-f0-9]{64}$/);
  }
});

test("root and Turbo typecheck aliases select non-root serial execution",async t=>{
  const {describeCloudLanes}=await import("./cloud-validation-environment.mjs");
  for(const [command,turbo] of [["pnpm run typecheck",false],["pnpm exec turbo run typecheck --concurrency 4",true]]){
    const lane={name:"check",command}, calls=[];
    assert.ok(describeCloudLanes([lane])[0].prerequisites.capabilities.includes("nonRoot"));
    runCloudHostPlan({...fixture(t),lanes:[lane],uid:0,gid:0,provision:()=>{},run:(bin,args,opt)=>{calls.push({args,opt});return PASS;}});
    assert.ok(calls[0].opt.uid>0);
    if(turbo) assert.deepEqual(calls[0].args.filter(arg=>arg.startsWith("--concurrency")),["--concurrency=1"]);
    else assert.equal(calls[0].opt.env.TURBO_TYPECHECK_CONCURRENCY,"1");
  }
});

test("a committed typecheck package script executes its measured serial non-root operation",t=>{
  const input=fixture(t),calls=[];
  writeFileSync(path.join(input.checkout,"package.json"), JSON.stringify({scripts:{"desktop:typecheck":"pnpm turbo typecheck --filter=desktop"}}));
  runCloudHostPlan({...input,lanes:[{name:"check",command:"pnpm desktop:typecheck"}],uid:0,gid:0,provision:()=>{},
    run:(bin,args,opt)=>{calls.push({bin,args,opt});return PASS;}});
  assert.deepEqual(calls[0].args,["turbo","typecheck","--filter=desktop","--concurrency=1"]);
  assert.ok(calls[0].opt.uid>0);
});

test("actual package invocation selects the committed script irrespective of punctuation",t=>{
  const input=fixture(t),calls=[];
  writeFileSync(path.join(input.checkout,"package.json"),JSON.stringify({scripts:{verify:"pnpm turbo typecheck --filter=desktop","desktop:typecheck":"pnpm turbo typecheck --filter=desktop"}}));
  const commands=["pnpm run verify","pnpm -w verify","pnpm exec desktop:typecheck"];
  runCloudHostPlan({...input,lanes:commands.map(command=>({name:command,command})),uid:0,gid:0,provision:()=>{},
    run:(bin,args)=>{calls.push([bin,...args]);return PASS;}});
  assert.deepEqual(calls,[["pnpm","turbo","typecheck","--filter=desktop","--concurrency=1"],["pnpm","turbo","typecheck","--filter=desktop","--concurrency=1"],["pnpm","exec","desktop:typecheck"]]);
});

test("effective pnpm operation retains trailing script arguments and built-in precedence",t=>{
  const input=fixture(t),calls=[];
  writeFileSync(path.join(input.checkout,"package.json"),JSON.stringify({scripts:{root:"pnpm turbo typecheck","desktop:typecheck":"pnpm turbo typecheck --filter=desktop"}}));
  const commands=["pnpm root","pnpm run root","pnpm run desktop:typecheck --force","pnpm exec desktop:typecheck --force"];
  runCloudHostPlan({...input,lanes:commands.map(command=>({name:command,command})),uid:0,gid:0,provision:()=>{},run:(bin,args)=>{calls.push([bin,...args]);return PASS;}});
  assert.deepEqual(calls,[["pnpm","root"],["pnpm","turbo","typecheck","--concurrency=1"],["pnpm","turbo","typecheck","--filter=desktop","--force","--concurrency=1"],["pnpm","exec","desktop:typecheck","--force"]]);
});
test("browser preflight diagnostic survives combined control port admission",t=>{
  const row=runCloudHostPlan({...fixture(t),lanes:[{name:"browser",command:"pnpm test:storybook",isolateControlPorts:true,browser:true}],uid:1000,gid:1000,
    run:()=>assert.fail("browser lane must stay unrun"),browser:()=>({...FAIL,stderrTail:"Operation not permitted"})})[0];
  assert.equal(row.diagnosis,"Chromium preflight failed");assert.equal(row.exitCode,FAIL.exitCode);
});

test("Turbo scheduling respects the script dispatch and forwarded argument boundary",t=>{
  const input=fixture(t),calls=[];
  writeFileSync(path.join(input.checkout,"package.json"),JSON.stringify({scripts:{turbo:"node sibling.mjs",check:"pnpm exec turbo run typecheck"}}));
  const commands=["pnpm exec turbo run lint -- typecheck","pnpm run check --force","pnpm run turbo typecheck"];
  runCloudHostPlan({...input,lanes:commands.map(command=>({name:command,command})),uid:1000,gid:1000,run:(bin,args)=>{calls.push([bin,...args]);return PASS;}});
  assert.deepEqual(calls,[["pnpm","exec","turbo","run","lint","--","typecheck"],["pnpm","exec","turbo","run","typecheck","--force","--concurrency=1"],["pnpm","run","turbo","typecheck"]]);
});
test("empty browser preflight streams retain the originating setup failure",t=>{
  const row=runCloudHostPlan({...fixture(t),lanes:[{name:"browser",command:"node check.mjs",browser:true}],uid:1000,gid:1000,run:()=>assert.fail(),
    browser:()=>({...FAIL,stdoutTail:"",stderrTail:"",diagnosis:"workspace lockfile missing"})})[0];
  assert.match([row.diagnosis,row.stderrTail].join(" "),/workspace lockfile missing/);
});
