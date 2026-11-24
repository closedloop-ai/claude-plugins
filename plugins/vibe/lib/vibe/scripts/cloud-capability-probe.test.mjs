import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { probeCloudCapabilities, startDockerProbe } from "./cloud-capability-probe.mjs";
import { CLOUD_CAPABILITIES_COMMAND, directValidationLanes, isCheckCommand } from "./cloud-check-command.mjs";

const COMMIT = "a".repeat(40);
const YES = (output) => ({ result: "YES", exitCode: 0, output });
const NO = (output, reason, exitCode = 1) => ({ result: "NO", exitCode, output, reason });

function canonicalRequest() {
  const request = { commit: COMMIT, repository: "closedloop-ai/claude-plugins", lanes: [{ name: "cloud-capabilities" }] };
  return request;
}

test("ISS-14476 fixed cloud capability lane refuses caller argv and uses only the exact supplied proof checkout", () => {
  const files = [];
  const request = canonicalRequest();
  const deps = { currentHead: () => COMMIT, readCommitted: (file) => files.push(file) };
  assert.ok(isCheckCommand(CLOUD_CAPABILITIES_COMMAND));
  assert.deepEqual(directValidationLanes(request, deps), [{ name: "cloud-capabilities", command: CLOUD_CAPABILITIES_COMMAND, capabilityProbe: true }]);
  assert.deepEqual(files.map((file) => path.basename(file)), ["cloud-capability-probe.mjs", "cloud-capability-electron.cjs"]);
  const command = (command) => ({ name: "cloud-capabilities", command });
  for (const lane of [
    command(CLOUD_CAPABILITIES_COMMAND + " --extra"), command("docker info"), command("node -e 123"),
    { name: "cloud-capabilities", steps: ["docker info"] }, { name: "other", command: CLOUD_CAPABILITIES_COMMAND },
  ]) assert.throws(() => directValidationLanes({ ...request, lanes: [lane] }, deps), /no caller arguments or steps/);
  assert.throws(() => directValidationLanes(request, { ...deps, currentHead: () => "b".repeat(40) }), /pushed claude-plugins/);
  for (const inline of ["node -e 123", "node --eval=123", "pnpm exec /bin/sh -c echo", "dockerd &", "xvfb-run -a electron"]) {
    assert.equal(isCheckCommand(inline), false);
  }
});

function fixture(t, { missingDocker = false, missingSocket = false, pullFails = false, electronFails = false, composeFails = false } = {}) {
  const home = makeHome("vibe-probe-capability-");
  t.after(home.cleanup);
  const calls = [];
  const stopped = [];
  let time = 0;
  const run = () => probeCloudCapabilities({
    directory: home.root,
    now: () => time,
    wait: async (ms) => { time += 2_500 * ms; },
    socketExists: () => !missingSocket,
    start: (args) => {
      calls.push(["dockerd", ...args]);
      const id = args[1];
      return { status: () => missingDocker ? NO("dockerd unavailable", "ENOENT", null) : null, output: () => "daemon startup\n",
        stop: async () => { stopped.push(id); return true; } };
    },
    command: async (file, args) => {
      calls.push([file, ...args]);
      if (file === "xvfb-run") {
        if (electronFails) return NO("xauth not found", "Xvfb failed", 3);
        return YES(args.includes("--version") ? "v43.8.4" : "Electron loaded about:blank on its virtual display");
      }
      if (args[0] === "compose") return composeFails ? NO("compose unavailable", "no plugin") : YES("Docker Compose version v5.7.1");
      if (args.includes("hello-world") && pullFails) return NO("rate limited", "Docker Hub pull failed", 125);
      return YES(args.includes("info") ? "daemon ready" : "Hello from Docker!");
    },
  });
  return { calls, stopped, run };
}

test("ISS-14476 probe separately reports both private daemons, hello-world, Compose and virtual-display Electron", async (t) => {
  const f = fixture(t);
  const report = await f.run();
  for (const driver of [report.defaultDriver, report.vfsDriver]) {
    assert.equal(driver.daemon.result, "YES");
    assert.match(driver.helloWorld.output, /Hello from Docker/);
    assert.equal(driver.cleanup, "YES");
  }
  assert.match(report.compose.output, /v5.7.1/);
  assert.match(report.electron.version.output, /v43.8.4/);
  assert.match(report.electron.window.output, /about:blank/);
  const starts = f.calls.filter(([command]) => command === "dockerd");
  assert.equal(starts.length, 2);
  assert.ok(!starts[0].includes("--storage-driver"));
  assert.deepEqual(starts[1].slice(-2), ["--storage-driver", "vfs"]);
  assert.equal(new Set(f.stopped).size, 2);
  assert.ok(f.stopped.every((socket) => socket.startsWith("unix://") && !socket.endsWith("run/docker.sock")));
  assert.equal(f.calls.filter(([command, flag]) => command === "xvfb-run" && flag === "-a").length, 2);
  assert.ok(!f.calls.flat().includes("--no-sandbox"));
});

test("ISS-14476 missing binary or socket, image/compose failure and Xvfb failure preserve independent evidence", async (t) => {
  const absence = fixture(t, { missingDocker: true, electronFails: true, composeFails: true });
  const first = await absence.run();
  assert.equal(first.defaultDriver.daemon.reason, "ENOENT");
  assert.equal(first.compose.result, "NO");
  assert.match(first.electron.version.output, /xauth/);
  assert.equal(first.electron.window.result, "NO");
  assert.ok(!absence.calls.flat().includes("hello-world"));
  const noSocket = fixture(t, { missingSocket: true });
  const second = await noSocket.run();
  assert.match(second.defaultDriver.daemon.reason, /socket never became ready/);
  assert.equal(noSocket.stopped.length, 2);
  assert.equal(second.electron.window.result, "YES");
  const pull = fixture(t, { pullFails: true });
  const third = await pull.run();
  assert.equal(third.defaultDriver.daemon.result, "YES");
  assert.equal(third.defaultDriver.helloWorld.exitCode, 125);
  assert.equal(third.vfsDriver.helloWorld.result, "NO");
});

test("ISS-14476 timed-out daemon cleanup signals only the child this probe started", async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 4321, exitCode: null, signalCode: null });
  const signals = [];
  child.kill = (signal) => {
    signals.push([child.pid, signal]);
    if (signal === "SIGKILL") {
      child.signalCode = signal;
      child.emit("close", null, signal);
    }
  };
  const docker = startDockerProbe([], () => child, async () => null);
  assert.equal(await docker.stop(), true);
  assert.deepEqual(signals, [[4321, "SIGTERM"], [4321, "SIGKILL"]]);
  assert.equal(await docker.stop(), true, "a terminated child never receives another signal");
  assert.equal(signals.length, 2);
});

test("a compact capability line retains each independent outcome despite oversized private logs",async t=>{
  const {capabilityStatusLine}=await import("./cloud-capability-probe.mjs");
  const outcome=await fixture(t,{pullFails:true}).run();
  outcome.defaultDriver.daemon.output="private details".repeat(5000);
  const line=capabilityStatusLine(outcome);
  assert.ok(Buffer.byteLength(line)<400);
  assert.deepEqual(JSON.parse(line.slice("CLOUD_CAPABILITY_STATUS ".length)),{defaultDaemon:"YES",defaultHello:"NO",vfsDaemon:"YES",vfsHello:"NO",compose:"YES",electronVersion:"YES",electronWindow:"YES"});
  assert.equal(outcome.defaultDriver.daemon.output.length,75000);
});

test("a fresh eval result cannot pass a canonical probe without complete measurements", async t=>{
  const {parseValidationResult}=await import("./cloud-worker.mjs");
  const {git,makeCheckout}=await import("../../../skills/vibe/scripts/test-fixtures.mjs");
  const {join}=await import("node:path");
  const f=makeHome("probe-import-");t.after(f.cleanup);
  const base=canonicalRequest();
  const worktree=join(f.root,"checkout"), probe=CLOUD_CAPABILITIES_COMMAND.slice(5),artifact={path:"results.json",branch:"results/fixture"};
  const origin="https://github.com/"+base.repository;
  makeCheckout({...f,checkout:worktree,remoteUrl:origin,files:{[probe]:"export {};",[probe.replace("probe.mjs","electron.cjs")]:""}});
  const commit=git(worktree,["rev-parse","HEAD"],f.home);
  const request={...base,commit,worktree,branch:"main",resultArtifact:artifact};
  const report=fields=>"VIBE_VALIDATION_RESULT "+JSON.stringify({commit,status:[],provenance:{commit,host:"worker",remote:"true",origin},lanes:[{name:"cloud-capabilities",exitCode:0,...fields}],artifact:{...artifact,commit:"b".repeat(40),sha256:"c".repeat(64)}});
  const parse=fields=>parseValidationResult(report(fields),request,{outcomeTransport:"eval-artifact"});
  assert.throws(()=>parse({}),/incomplete canonical capability/);
  const checks={workspace:true,nonRoot:true,ports:true,chromium:false,gitUtc:true,controlNamespace:false,chromium1254:false,docker:false,dockerBootstrap:false,display:false,zsh:true,uv:true,python313:true,node24:true,pnpm:true};
  const observations={defaultDaemon:"NO",defaultHello:"NO",vfsDaemon:"YES",vfsHello:"NO",compose:"YES",electronVersion:"NO",electronWindow:"NO"};
  const lines=["CLOUD_CAPABILITY_STATUS "+JSON.stringify(observations),"CLOUD_HOST_RUNTIME "+JSON.stringify({commit,checks})];
  assert.throws(()=>parse({stdoutTail:lines[0]}),/incomplete canonical capability/);
  assert.throws(()=>parse({stdoutTail:[...lines,lines[0]].join("\n")}),/duplicate canonical/);
  assert.equal(parse({stdoutTail:lines.join("\n")}).lanes[0].stdoutTail,lines.join("\n"));
});

test("AC-101 a probe state cleanup failure is named on its own line and never fails or replaces the runtime report", async () => {
  const { removeProbeState } = await import("./cloud-capability-probe.mjs");
  const lines = [];
  const busy = Object.assign(new Error("EBUSY: resource busy or locked, rmdir 'exec/netns'"), { code: "EBUSY" });
  const removed = removeProbeState("/probe/.git/vibe-cloud-capabilities-x", { remove: () => { throw busy; }, write: (line) => lines.push(line) });
  assert.equal(removed, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^CLOUD_CAPABILITY_CLEANUP \{.*\}\n$/);
  assert.deepEqual(JSON.parse(lines[0].slice("CLOUD_CAPABILITY_CLEANUP ".length)),
    { removed: false, path: "/probe/.git/vibe-cloud-capabilities-x", error: "EBUSY" });
  const calls = [];
  assert.equal(removeProbeState("/probe/state", { remove: (...args) => calls.push(args), write: (line) => lines.push(line) }), true);
  assert.deepEqual(calls, [["/probe/state", { recursive: true, maxRetries: 3, retryDelay: 200 }]]);
  assert.equal(lines.length, 1, "a successful removal prints nothing");
});
