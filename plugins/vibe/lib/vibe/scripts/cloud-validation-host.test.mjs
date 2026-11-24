import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { git, makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { canonicalGitTimestamp, cloudHostEnvironment, pinnedPnpmVersion, prepareHostChromium, reserveCloudPorts, runCloudHostPlan, hostLanesLine, hostPhaseLanes, hostResultLines, hostTimeLine, mergeHostPhases, runHostReporter, validationHostActor, writeHostRunFiles } from "./cloud-validation-host.mjs";
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
  const {hostLanesLine, writeHostLaneFiles} = await import("./cloud-validation-host.mjs");
  for (const count of [2,11]) {
    const lanes = Array.from({length:count},(_,i)=>({name:"fixture-"+i,...FAIL,stderrTail:"retained log ".repeat(800)}));
    const record = hostLanesLine(writeHostLaneFiles(directory,lanes),lanes.length);
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

// A lane leader that ignores SIGTERM and waits on a SIGTERM-ignoring grandchild, the shape of the r17 hang
// (pnpm waiting on its own stalled `pnpm add`).
const HANG_LANE = `const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
require("node:fs").writeFileSync("grandchild.pid", String(child.pid));
setInterval(() => {}, 1000);
`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

test("AC-101 a lane timeout ends the lane's whole process group, its SIGTERM-ignoring grandchild included", async t=>{
  const f=fixture(t);
  writeFileSync(path.join(f.checkout,"hang.cjs"),HANG_LANE);
  const started=Date.now();
  const [outcome]=runCloudHostPlan({...f,lanes:[{name:"hang",command:"node hang.cjs"}],laneLimits:{timeout:1500,grace:500}});
  const grandchild=Number(readFileSync(path.join(f.checkout,"grandchild.pid"),"utf8"));
  t.after(()=>{ if (grandchild>1 && alive(grandchild)) process.kill(grandchild,"SIGKILL"); });
  assert.equal(outcome.exitCode,124);
  assert.match(outcome.diagnosis,/^ETIMEDOUT: the lane's process group was ended after 2 s$/);
  assert.ok(Date.now()-started<15_000,"the lane ends at its limit, not when its hung grandchild does");
  for (let waited=0; alive(grandchild) && waited<5000; waited+=100) await new Promise((resolve)=>setTimeout(resolve,100));
  assert.equal(alive(grandchild),false,"the SIGTERM-ignoring grandchild ended with its lane's group");
});

test("managed lane retains both full private streams and actual exit above the previous buffer cap", async t=>{
  const f=fixture(t), size=33*1024*1024;
  writeFileSync(path.join(f.checkout,"emit.cjs"),`const fs=require('node:fs');const b=Buffer.alloc(1048576,97);for(let i=0;i<33;i++){fs.writeSync(1,b);fs.writeSync(2,b)}process.exitCode=17`);
  const [outcome]=runCloudHostPlan({...f,lanes:[{name:"verbose",command:"node emit.cjs"}]});
  assert.equal(outcome.exitCode,17);
  for(const file of Object.values(outcome.streamFiles)) assert.equal(readFileSync(file).length,size);
  assert.ok(outcome.stdoutTail.length<8192 && outcome.stderrTail.length<8192);
  const {hostLanesLine,writeHostLaneFiles}=await import("./cloud-validation-host.mjs");
  const marker=hostLanesLine(writeHostLaneFiles(f.directory,[outcome]),1);
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

// The trust and proxy assertions changed with the CA passthrough's removal (team-lead, 2026-11-24, attempt six:
// "Drop the CA passthrough unless the run proves it's needed"); the secret assertions are unchanged.
test("the non-root lane actor gets no host trust, proxy or secret setting", () => {
  const env = cloudHostEnvironment({
    PATH: "/usr/bin", NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt", SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    NODE_USE_SYSTEM_CA: "1", HTTPS_PROXY: "http://proxy.internal:3128", NO_PROXY: "localhost,127.0.0.1",
    http_proxy: "http://user:token@proxy.internal:3128", GIT_SSL_CAINFO: "relative/ca.pem", CURL_CA_BUNDLE: "/etc/ca.pem; rm -rf /",
    GITHUB_TOKEN: "ghs_fixture", ANTHROPIC_API_KEY: "sk-fixture", NODE_OPTIONS: "--require /tmp/x.js",
  }, "/home/actor", "/fixture");
  for (const dropped of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "NODE_USE_SYSTEM_CA", "HTTPS_PROXY", "NO_PROXY", "http_proxy",
    "GIT_SSL_CAINFO", "CURL_CA_BUNDLE", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "NODE_OPTIONS"]) {
    assert.equal(env[dropped], undefined, dropped);
  }
  assert.equal(env.HOME, "/home/actor");
});

test("AC-101 root fetches the checkout's pinned pnpm into the actor's pnpm home before any lane and hands it back", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.checkout, "package.json"), JSON.stringify({ packageManager: "pnpm@12.14.0+sha512.abc123" }));
  assert.equal(pinnedPnpmVersion(f.checkout), "12.14.0");
  const called = [], provisioned = [], timed = [];
  const lanes = [{ name: "setup:repo-bootstrap", command: "pnpm install --frozen-lockfile", prerequisite: true },
    { name: "api", command: "pnpm --filter api test" }];
  const run = (command, args, options) => {
    called.push({ command: [command, ...args].join(" "), uid: options.uid, env: options.env, cwd: options.cwd });
    return command === "pnpm" && args[0] === "--version" ? { ...PASS, stdoutTail: "! Corepack is about to download\n12.14.0\n" } : PASS;
  };
  runCloudHostPlan({ ...f, lanes, uid: 0, gid: 0, environment: { PATH: "/bin", PNPM_HOME: "/root/.local/share/pnpm" }, run,
    provision: (dir) => provisioned.push([called.length, dir]), onLane: (result) => timed.push([result.name, result.exitCode]) });
  assert.deepEqual(called.map(({ command, uid }) => [command, uid]), [["pnpm --version", undefined],
    ["pnpm install --frozen-lockfile", undefined], ["pnpm --filter api test", 65534]]);
  const [fetch, , lane] = called;
  assert.equal(fetch.cwd, realpathSync(f.checkout));
  const home = path.join(realpathSync(f.directory), "home");
  for (const { env } of [fetch, lane]) {
    assert.equal(env.PNPM_HOME, path.join(home, ".local", "share", "pnpm"), "root and the actor share one pnpm home inside the actor's home");
    assert.equal(env.XDG_CACHE_HOME, path.join(home, ".cache"));
  }
  assert.ok(provisioned.some(([after, dir]) => after === 1 && dir === home), "the actor owns the fetched pnpm before the bootstrap and lanes");
  assert.deepEqual(timed[0], ["root pnpm 12.14.0", 0]);
});

test("AC-101 a root pnpm fetch that does not report the pinned version stops setup before any lane", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.checkout, "package.json"), JSON.stringify({ packageManager: "pnpm@12.14.0" }));
  const called = [];
  const run = (command, args) => { called.push([command, ...args].join(" ")); return { ...PASS, stdoutTail: "11.20.0\n" }; };
  const observed = runCloudHostPlan({ ...f, lanes: [{ name: "api", command: "pnpm --filter api test" }], uid: 0, gid: 0,
    environment: { PATH: "/bin" }, run, provision: () => {} });
  assert.deepEqual(called, ["pnpm --version"]);
  assert.match(observed[0].notRun ?? observed[0].diagnosis ?? "", /prerequisite root setup: pnpm 12\.14\.0 failed/);
});

test("AC-101 workspace prerequisite builds are root environment setup and hand ownership back before the lanes run", (t) => {
  const f = fixture(t);
  const called = [], provisioned = [];
  const lanes = [{ name: "setup:repo-bootstrap", command: "pnpm install --frozen-lockfile", prerequisite: true },
    { name: "setup:workspace:0123456789ab", command: "pnpm --filter @scope/contract build", prerequisite: true },
    { name: "api", command: "pnpm --filter api test" }];
  const run = (command, args, options) => { called.push({ command: [command, ...args].join(" "), uid: options.uid, env: options.env }); return PASS; };
  const observed = runCloudHostPlan({ ...f, lanes, uid: 0, gid: 0, environment: { PATH: "/bin" }, run,
    provision: (dir) => provisioned.push([called.length, dir]) });
  assert.deepEqual(called.map(({ command, uid }) => [command, uid]), [["pnpm install --frozen-lockfile", undefined],
    ["pnpm --filter @scope/contract build", undefined], ["pnpm --filter api test", 65534]]);
  assert.deepEqual(observed.map(({ runtime }) => runtime.uid), [0, 0, 65534]);
  assert.ok(provisioned.some(([after]) => after === 2), "the actor owns what the workspace build wrote before its lanes run");
  const build = called.find(({ command }) => command.endsWith("contract build")).env;
  assert.equal(build[`GIT_CONFIG_VALUE_${Number(build.GIT_CONFIG_COUNT) - 1}`], realpathSync(f.checkout));
});

test("environment setup runs once as root before the lanes and every lane command, tests included, still runs as the actor", (t) => {
  const f = fixture(t);
  const called = [], provisioned = [];
  const contract = { data: { recipes: { cloudValidation: { rootServices: ["postgresql", "redis-server"] } } } };
  const lanes = [{ name: "setup:repo-bootstrap", command: "pnpm install --frozen-lockfile", prerequisite: true },
    { name: "api-integration-native-postgres", command: "pnpm --filter api test:integration:cloud" }];
  const run = (command, args, options) => { called.push({ command: [command, ...args].join(" "), uid: options.uid, env: options.env }); return PASS; };
  const observed = runCloudHostPlan({ ...f, lanes, uid: 0, gid: 0, contract, environment: { PATH: "/bin" }, run,
    provision: (dir) => provisioned.push([called.length, dir]) });
  assert.deepEqual(called.map(({ command, uid }) => [command, uid]), [
    ["service postgresql start", undefined], ["service redis-server start", undefined],
    ["pnpm install --frozen-lockfile", undefined], ["pnpm --filter api test:integration:cloud", 65534]]);
  assert.ok(provisioned.some(([after]) => after === 3), "the actor owns what the root bootstrap wrote before its lanes run");
  assert.deepEqual(observed.map(({ runtime }) => runtime.uid), [0, 65534]);
  // Git refuses a root command in the actor-owned checkout as dubious ownership unless that one checkout is trusted.
  const gitConfig = (env) => Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  const setup = called.find(({ command }) => command === "pnpm install --frozen-lockfile").env;
  assert.deepEqual(gitConfig(setup), { "log.date": "iso-strict-local", "safe.directory": realpathSync(f.checkout) });
  const laneEnv = called.find(({ command }) => command.startsWith("pnpm --filter api")).env;
  assert.deepEqual(gitConfig(laneEnv), { "log.date": "iso-strict-local" }, "actor lanes trust nothing extra");
  const failing = (command, args, options) => { called.push({ command: [command, ...args].join(" "), uid: options.uid }); return command === "service" ? { ...PASS, exitCode: 1 } : PASS; };
  called.length = 0;
  const blocked = runCloudHostPlan({ ...fixture(t), lanes, uid: 0, gid: 0, contract, environment: { PATH: "/bin" }, run: failing, provision: () => {} });
  assert.deepEqual(called.map(({ command }) => command), ["service postgresql start"]);
  assert.ok(blocked.every((lane) => lane.exitCode === null && /root setup: service postgresql start/.test(lane.notRun)));
  called.length = 0;
  runCloudHostPlan({ ...fixture(t), lanes, uid: 1000, gid: 1000, contract, environment: { PATH: "/bin" }, run, provision: () => {} });
  assert.ok(called.every(({ command, uid }) => !command.startsWith("service") && uid === 1000), "a non-root host account starts nothing as root");
});

test("the API fixture is admitted when only the repository's CI workflow, not its test setup, references it", async () => {
  const { cloudApiEnvironment } = await import("./cloud-validation-host.mjs");
  const provider = JSON.parse(readFileSync(new URL("../../../../vibe-closedloop-provider/provider.json", import.meta.url), "utf8"));
  const recipe = provider.data.recipes.cloudValidation;
  const fixtureBytes = "AWS_ACCESS_KEY_ID=test-key-id\nAWS_SECRET_ACCESS_KEY=test-secret-key\nAWS_REGION=us-east-1\n";
  const files = (workflow) => ({ [recipe.apiFixture]: fixtureBytes, [recipe.apiSetup]: "export default {};\n", [recipe.apiWorkflow]: workflow });
  const read = (workflow) => (file) => { const text = files(workflow)[file]; if (text === undefined) throw new Error("absent"); return text; };
  const referenced = "jobs:\n  test:\n    steps:\n      - name: API tests\n        run: pnpm --filter api test --env-file apps/api/.env.test\n";
  const bound = cloudApiEnvironment(read(referenced), "c".repeat(40), recipe);
  assert.equal(bound?.source, recipe.apiWorkflow);
  assert.deepEqual(bound?.keys, ["AWS_ACCESS_KEY_ID", "AWS_REGION", "AWS_SECRET_ACCESS_KEY"]);
  assert.equal(cloudApiEnvironment(read("jobs:\n  test:\n    steps:\n      - name: API tests\n        run: pnpm --filter api test\n"), "c".repeat(40), recipe), null,
    "a workflow that never names the fixture does not admit it");
});

test("ISS-14476 the host runner runs the shipped reporter from the exact tool commit on its own lane directory", (t) => {
  const { root, home, cleanup } = makeHome("vibe-host-reporter-");
  t.after(cleanup);
  const checkout = path.join(root, "checkout");
  const scripts = path.join(checkout, "plugins/vibe-closedloop/lib/vibe/scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(path.join(scripts, "cloud-outcome-artifact.mjs"), "export const helper = 'shipped';\n");
  writeFileSync(path.join(scripts, "cloud-outcome-writer.mjs"), "import { helper } from './cloud-outcome-artifact.mjs';\n"
    + "console.log(JSON.stringify({ helper, spec: JSON.parse(Buffer.from(process.argv[2], 'base64url')), lanes: process.argv[3], cwd: process.cwd() }));\n");
  git(root, ["init", "--quiet", checkout], home);
  git(checkout, ["add", "-A"], home);
  git(checkout, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "tool"], home);
  const tool = git(checkout, ["rev-parse", "HEAD"], home);
  writeFileSync(path.join(scripts, "cloud-outcome-writer.mjs"), "console.log('uncommitted writer');\n");
  const artifact = { kind: "validation-outcomes", branch: "vibe-validation-results/fixture", path: ".vibe-validation-outcomes-0123456789abcdef.json" };
  const reporter = { tool, root: "plugins/vibe-closedloop", files: ["cloud-outcome-artifact.mjs", "cloud-outcome-writer.mjs"],
    key: "e".repeat(64), repository: "example/app", probe: -1, frozen: [], artifact };
  const plan = { commit: "c".repeat(40), lanes: [{ name: "setup:repo-bootstrap" }, { name: "api" }], reporter };
  const lanes = path.join(root, "vibe-lane-results-abc123");
  const report = runHostReporter(checkout, plan, lanes);
  assert.equal(report.exitCode, 0, report.stderrTail);
  assert.deepEqual(JSON.parse(report.stdoutTail), { helper: "shipped", lanes, cwd: realpathSync(checkout),
    spec: { key: "e".repeat(64), commit: "c".repeat(40), repository: "example/app", names: ["setup:repo-bootstrap", "api"], combined: [], probe: -1, frozen: [], artifact } },
    "the committed writer, not the working copy, runs in the checkout with the identity built from the plan and the lane directory");
  assert.deepEqual(readdirSync(path.join(checkout, ".git")).filter((name) => name.startsWith("vibe-outcomes-host-")), [], "the private reporter copy is removed");
  for (const bad of [{ ...reporter, tool: "b".repeat(40) }, { ...reporter, files: ["cloud-outcome-artifact.mjs"] },
    { ...reporter, files: [...reporter.files, "../escape.mjs"] }, { ...reporter, root: "../plugins" }, { ...reporter, key: "short" }]) {
    assert.throws(() => runHostReporter(checkout, { ...plan, reporter: bad }, lanes), /valid shipped reporter|cannot read reporter file/);
  }
});

test("ISS-14476 the runner prints the reporter line before the lane pointer, so a cut tool result keeps the record", () => {
  const record = "VIBE_OUTCOMES_V1 " + "A".repeat(300);
  const lines = hostResultLines("/tmp/vibe-lane-results-abc123", 4, { exitCode: 0, stdoutTail: record + "\n", stderrTail: "" });
  assert.deepEqual(lines, [{ line: record }, { line: hostLanesLine("/tmp/vibe-lane-results-abc123", 4) }]);
  assert.ok(lines.map(({ line }) => line).join("\n").slice(0, 400).includes(record), "the whole record sits inside the first 400 characters");
  const failed = hostResultLines("/tmp/vibe-lane-results-abc123", 4, { exitCode: 1, stdoutTail: "", stderrTail: "denied" });
  assert.deepEqual(failed.map(({ line, error }) => [line.split(" ")[0], Boolean(error)]), [["CLOUD_HOST_REPORTER_FAILED", true], ["CLOUD_HOST_LANES", false]]);
  assert.deepEqual(hostResultLines("/tmp/vibe-lane-results-abc123", 4), [{ line: hostLanesLine("/tmp/vibe-lane-results-abc123", 4) }]);
});

test("ISS-14476 the host runner writes its own output file before its exit file", (t) => {
  const { root, cleanup } = makeHome("vibe-host-files-");
  t.after(cleanup);
  const runner = path.join(root, "vibe-validation-host-x.mjs");
  writeHostRunFiles(runner, "CLOUD_HOST_LANES {}\nVIBE_OUTCOMES_V1 x\n", 0);
  assert.equal(readFileSync(runner + ".out", "utf8"), "CLOUD_HOST_LANES {}\nVIBE_OUTCOMES_V1 x\n");
  assert.equal(readFileSync(runner + ".exit", "utf8"), "0\n");
  assert.ok(statSync(runner + ".exit").mtimeMs >= statSync(runner + ".out").mtimeMs);
  assert.equal(existsSync(runner), false);
});

test("ISS-14476 every lane's port lease is released after the plan finishes and when a lane throws", (t) => {
  const released = [];
  let next = 0;
  const allocate = () => { const id = next++; return { first: 40000 + id * 10, last: 40009 + id * 10, release: () => released.push(id) }; };
  const lanes = [{ name: "one", command: "node a.cjs" }, { name: "two", command: "node b.cjs" }];
  runCloudHostPlan({ ...fixture(t), lanes, uid: 1000, gid: 1000, environment: { PATH: "/bin" }, run: () => PASS, provision: () => {}, allocate });
  assert.deepEqual(released.sort(), [0, 1], "a finished plan releases each lane's lease");
  released.length = 0;
  next = 0;
  const throwing = () => { throw new Error("lane runner crashed"); };
  assert.throws(() => runCloudHostPlan({ ...fixture(t), lanes, uid: 1000, gid: 1000, environment: { PATH: "/bin" }, run: throwing, provision: () => {}, allocate }), /lane runner crashed/);
  assert.deepEqual(released.sort(), [0, 1], "a throwing lane still releases every reserved lease");
});

test("ISS-14476 setup and the requested lanes run as two runner calls, and a failed setup leaves each requested lane not run", () => {
  const plan = { lanes: [{ name: "setup:repo-bootstrap", prerequisite: true }, { name: "setup:workspace:a", prerequisite: true }, { name: "api" }] };
  assert.deepEqual(hostPhaseLanes(plan, "setup").map(({ name }) => name), ["setup:repo-bootstrap", "setup:workspace:a"]);
  assert.deepEqual(hostPhaseLanes(plan, "lanes").map(({ name }) => name), ["api"]);
  const setup = [{ name: "setup:repo-bootstrap", exitCode: 0 }, { name: "setup:workspace:a", exitCode: 0 }];
  let ran = 0;
  assert.deepEqual(mergeHostPhases(plan, setup, () => { ran++; return [{ name: "api", exitCode: 0 }]; }).map(({ name, exitCode }) => [name, exitCode]),
    [["setup:repo-bootstrap", 0], ["setup:workspace:a", 0], ["api", 0]]);
  assert.equal(ran, 1);
  const failed = mergeHostPhases(plan, [{ name: "setup:repo-bootstrap", exitCode: 1 }, { name: "setup:workspace:a", exitCode: null }], () => { ran++; return []; });
  assert.equal(ran, 1, "the requested lanes never run after a failed setup");
  assert.deepEqual([failed[2].name, failed[2].exitCode, failed[2].notRun], ["api", null, "prerequisite setup:repo-bootstrap failed"]);
});

test("ISS-14476 each lane and the root service start report their wall time as they end", (t) => {
  let clock = 0;
  const now = () => clock;
  const run = (command) => { clock += command === "service" ? 4_000 : 61_400; return PASS; };
  const times = [];
  const contract = { data: { recipes: { cloudValidation: { rootServices: ["postgresql"] } } } };
  const lanes = [{ name: "setup:repo-bootstrap", command: "pnpm install --frozen-lockfile", prerequisite: true }, { name: "api", command: "pnpm --filter api test" }];
  runCloudHostPlan({ ...fixture(t), lanes, uid: 0, gid: 0, contract, environment: { PATH: "/bin" }, run, provision: () => {}, now,
    onLane: (result, seconds) => times.push(hostTimeLine(result, seconds)) });
  assert.deepEqual(times, [
    'CLOUD_HOST_LANE_TIME {"name":"root services","exitCode":0,"seconds":4}',
    'CLOUD_HOST_LANE_TIME {"name":"setup:repo-bootstrap","exitCode":0,"seconds":61}',
    'CLOUD_HOST_LANE_TIME {"name":"api","exitCode":0,"seconds":61}',
  ]);
});
