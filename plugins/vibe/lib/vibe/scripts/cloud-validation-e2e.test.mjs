import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateValidationRequest, validationBrief, validationLanes } from "../../../../vibe-closedloop/lib/vibe/scripts/cloud-worker.mjs";
import { git, makeCheckout, makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";

const desktopPath = "apps/desktop/test/e2e/approved.spec.ts";
const desktop = "pnpm --dir apps/desktop test:e2e test/e2e/approved.spec.ts";
const web = "e2e/run-containerized.sh -- --list";

/** Use only a synthetic committed runner and stub capability commands. A lane cannot open a browser or Docker. */
function fixture(t) {
  const f = makeHome("vibe-cloud-e2e-");
  t.after(f.cleanup);
  const worktree = path.join(f.root, "repo");
  makeCheckout({ ...f, checkout: worktree, files: {
    "package.json": JSON.stringify({ scripts: { "docker:ensure": "node scripts/docker.mjs", "e2e:containerized": "bash e2e/run-containerized.sh" } }),
    "e2e/small.spec.ts": "export {};\n",
    [desktopPath]: "export {};\n",
    ".github/workflows/desktop-e2e-validation.yml": 'run: xvfb-run -a --server-args="-screen 0 1920x1080x24" pnpm test:e2e\n',
    "e2e/run-containerized.sh": "#!/bin/sh\nprintf '%s\\n' SAFE-WEB-RUNNER\n",
  } });
  chmodSync(path.join(worktree, "e2e/run-containerized.sh"), 0o755);
  const gitBase = git(worktree, ["rev-parse", "HEAD"], f.home);
  const request = (command) => ({
    worktree, provider: "claude", model: "claude-sonnet-5-5", repository: "closedloop-ai/symphony-alpha",
    branch: "main", commit: gitBase, lanes: [{ name: "capability", command }],
  });
  const bin = path.join(f.root, "bin");
  mkdirSync(bin);
  const command = (name, body) => writeFileSync(path.join(bin, name), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
  command("pnpm", "printf '%s\\n' SAFE-DESKTOP-RUNNER");
  command("xvfb-run", "printf '%s\\n' SAFE-DISPLAYLESS-RUNNER");
  const run = (shell) => spawnSync("/bin/bash", ["-c", shell], {
    cwd: worktree, encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH }, timeout: 8_000,
  });
  return { request, command, run };
}

test("ISS-14476 allows only the two documented cloud E2E argv shapes at the exact commit", (t) => {
  const f = fixture(t);
  for (const argv of [web, desktop, "pnpm --dir apps/desktop test:e2e " + desktopPath]) {
    assert.doesNotThrow(() => validateValidationRequest(f.request(argv)));
    assert.match(validationLanes(f.request(argv)).lanes[0].cloudE2E, /CLOUD_E2E_UNAVAILABLE/);
  }
  for (const argv of [
    "e2e/run-containerized.sh --keep-up -- --list", web + " && echo ignored", "pnpm test:e2e",
    desktop + " --headed", desktop.replace("approved", "../approved"), desktop.replace("approved", "missing"),
    "pnpm exec playwright test --headed", "pnpm --dir apps/desktop test:e2e 'test/e2e/approved.spec.ts'",
  ]) {
    assert.throws(() => validateValidationRequest(f.request(argv)), /Cloud E2E lanes|committed file/);
  }
  assert.match(validationBrief(f.request(desktop)), /cd apps\/desktop && xvfb-run -a.*pnpm test:e2e test\/e2e\/approved\.spec\.ts/);
});

test("ISS-14476 refuses missing cloud Docker or displayless capability before invoking the harmless runners", (t) => {
  const f = fixture(t);
  f.command("docker", "exit 1");
  f.command("uname", "printf '%s\\n' Darwin");
  const result = (argv) => f.run(validationLanes(f.request(argv)).lanes[0].cloudE2E);
  const noDocker = result(web);
  assert.equal(noDocker.status, 78);
  assert.match(noDocker.stderr, /Docker daemon and Compose/);
  assert.doesNotMatch(noDocker.stdout, /SAFE-WEB/);
  const noDisplay = result(desktop);
  assert.equal(noDisplay.status, 78);
  assert.match(noDisplay.stderr, /Linux Xvfb and xauth/);
  assert.doesNotMatch(noDisplay.stdout, /SAFE-DESKTOP|SAFE-DISPLAYLESS/);
  f.command("docker", "exit 0");
  assert.match(result(web).stdout, /SAFE-WEB-RUNNER/);
  for (const name of ["Xvfb", "xauth"]) f.command(name, "exit 0");
  f.command("uname", "printf '%s\\n' Linux");
  assert.match(result(desktop).stdout, /SAFE-DISPLAYLESS-RUNNER/);
});

test("AC-101 committed pnpm container lanes retain private output and a compact status", (t) => {
  const f = fixture(t);
  f.command("pnpm", "printf '%0600d' 0; printf 'fixture diagnosis' >&2; exit 7");
  for (const argv of ["pnpm docker:ensure", "pnpm e2e:containerized", "pnpm e2e:containerized -- --list", "pnpm e2e:containerized -- e2e/small.spec.ts"]) {
    const lane = validationLanes(f.request(argv)).lanes.at(-1);
    assert.equal(lane.containerPnpm, true);
    assert.ok(lane.prerequisites.capabilities.includes("dockerBootstrap"));
    const result = f.run(lane.cloudE2E);
    assert.equal(result.status, 7);
    assert.ok(result.stdout.length < 400);
    const output = /exit=7 log=(.+)/.exec(result.stdout)?.[1];
    assert.ok(output);
    t.after(() => rmSync(path.dirname(output), { recursive: true, force: true }));
    assert.match(readFileSync(output, "utf8"), /0{600}fixture diagnosis/);
    assert.equal(statSync(output).mode & 0o077, 0);
    assert.match(validationBrief(f.request(argv)), /600000 ms/);
  }
  for (const argv of ["pnpm docker:ensure --other", "pnpm run e2e:containerized -- --headed", "pnpm run docker:ensure", "pnpm e2e:containerized -- e2e/unknown.spec.ts", "pnpm e2e:containerized -- --headed", "docker info"]) {
    assert.throws(() => validationLanes(f.request(argv)));
  }
});

test("the machine result references the actual combined private pnpm output",async t=>{
  const {mkdtempSync}=await import("node:fs");
  const {createHash}=await import("node:crypto");
  const {retainedContainerStream}=await import("./cloud-outcome-writer.mjs");
  const {encodeOutcomes,outcomeLine}=await import("./cloud-outcome-artifact.mjs");
  const {parseValidationResult}=await import("../../../../vibe-closedloop/lib/vibe/scripts/cloud-worker.mjs");
  const f=fixture(t);f.command("pnpm","printf 'original stdout';printf 'original stderr' >&2;exit 7");
  const dir=mkdtempSync("/tmp/vibe-lane-results-");t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const req=f.request("pnpm docker:ensure"),result=f.run(validationLanes(req).lanes[0].cloudE2E);
  const source=/log=(.+)/.exec(result.stdout)[1];t.after(()=>rmSync(path.dirname(source),{recursive:true,force:true}));
  writeFileSync(path.join(dir,"0.stdout"),result.stdout);
  const rec=retainedContainerStream(dir,0,result.status);
  assert.equal(readFileSync(rec.file,"utf8"),"original stdoutoriginal stderr");
  assert.equal(rec.sha256,createHash("sha256").update("original stdoutoriginal stderr").digest("hex"));
  const key=createHash("sha256").update(JSON.stringify(req)).digest("hex");
  const encoded=encodeOutcomes({commit:req.commit,repository:req.repository,host:"vm",directory:dir,key,lanes:[{exitCode:7,privateStreams:{stdout:rec,stderr:{bytes:0,sha256:"0".repeat(64)}}}]});
  assert.deepEqual(parseValidationResult(outcomeLine(encoded),req,{outcomeTransport:"machine-v2"}).lanes[0].combinedOutput,rec);
  assert.throws(()=>retainedContainerStream(dir,0,0),/wrapper exit/);
});

test("AC-101 the pre-dispatch log fit counts the prerequisite lanes validate adds and its advice matches that budget", async () => {
  const { requireOutcomeCapacity, logLaneCapacity } = await import("./cloud-outcome-artifact.mjs");
  assert.equal(logLaneCapacity(), 2);
  assert.doesNotThrow(() => requireOutcomeCapacity(2, null));
  assert.doesNotThrow(() => requireOutcomeCapacity(9, { path: "outcomes.json", branch: "results" }));
  assert.throws(() => requireOutcomeCapacity(3, null, ["setup:workspace:abc"]), (error) =>
    error.message.includes("resolves to 3 lanes, including 1 prerequisite lane validate adds (setup:workspace:abc)")
    && error.message.includes("holds at most 2; send at most 1 caller lane per request or authorize a validation-outcomes resultArtifact"));
  assert.throws(() => requireOutcomeCapacity(3, null), /resolves to 3 lanes, and the log holds at most 2; send at most 2 caller lanes per request/);
  assert.throws(() => requireOutcomeCapacity(4, null, ["setup:a", "setup:b"]), (error) =>
    /holds at most 2; authorize a validation-outcomes resultArtifact$/.test(error.message) && !error.message.includes("send at most"));
});

test("AC-101 the documented single-project spec form is admitted and a long lane leaves an exit file to poll", (t) => {
  const f = fixture(t);
  f.command("pnpm", "printf 'ran %s\\n' \"$*\"; exit 3");
  const argv = "pnpm e2e:containerized -- --project=local-trusted e2e/small.spec.ts";
  const lane = validationLanes(f.request(argv)).lanes.at(-1);
  assert.equal(lane.containerPnpm, true);
  const result = f.run(lane.cloudE2E);
  assert.equal(result.status, 3);
  const exitFile = /^started log=.+ exit-file=(.+\/exit)$/m.exec(result.stdout)?.[1];
  assert.ok(exitFile, "the exit-file path is printed before the lane runs");
  t.after(() => rmSync(path.dirname(exitFile), { recursive: true, force: true }));
  assert.equal(readFileSync(exitFile, "utf8"), "3\n");
  assert.match(readFileSync(path.join(path.dirname(exitFile), "output.log"), "utf8"), /ran e2e:containerized -- --project=local-trusted e2e\/small\.spec\.ts/);
  assert.match(validationBrief(f.request(argv)), /poll that file with a foreground `until` loop in later calls/);
  assert.match(validationBrief(f.request(argv)), /with stdout and stderr redirected into \$d\/<index>\.stdout and \.stderr, so its two summary lines land in that file even after the Bash tool moves it to the background; never write or rewrite that file yourself/);
  for (const bad of ["pnpm e2e:containerized -- --project=a;b e2e/small.spec.ts", "pnpm e2e:containerized -- --project= e2e/small.spec.ts",
    "pnpm e2e:containerized -- --project=web --project=app e2e/small.spec.ts", "pnpm e2e:containerized -- --project=web --list",
    "pnpm docker:ensure -- --project=web e2e/small.spec.ts"]) {
    assert.throws(() => validationLanes(f.request(bad)), bad);
  }
});

test("the container wrapper writes its own summary into the lane's stream file, so an unredirected backgrounded lane still yields its record", async (t) => {
  const { mkdtempSync } = await import("node:fs");
  const { retainedContainerStream } = await import("./cloud-outcome-writer.mjs");
  const f = fixture(t);
  f.command("pnpm", "printf 'spec output'; exit 0");
  const lanes = validationLanes(f.request("pnpm e2e:containerized -- --project=local-trusted e2e/small.spec.ts")).lanes;
  const index = lanes.length - 1;
  assert.doesNotMatch(lanes[index].cloudE2E, /__VIBE_LANE_INDEX__/, "the final lane position replaces the placeholder");
  const d = mkdtempSync("/tmp/vibe-lane-results-");
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const result = f.run(`d=${d}; ${lanes[index].cloudE2E}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "with the stream directory set, the summary goes to the lane's own file");
  assert.match(result.stderr, /^started exit-file=\/tmp\/vibe-lane\.\w{8}\/exit summary=/);
  const summary = readFileSync(path.join(d, `${index}.stdout`), "utf8");
  assert.match(summary, /^started log=(\/tmp\/vibe-lane\.\w{8})\/output\.log exit-file=\1\/exit\nexit=0 log=\1\/output\.log\n$/);
  t.after(() => rmSync(path.dirname(/log=(\S+)/.exec(summary)[1]), { recursive: true, force: true }));
  assert.match(readFileSync(retainedContainerStream(d, index, 0).file, "utf8"), /spec output/);
  const outside = f.run(lanes[index].cloudE2E);
  assert.match(outside.stdout, /^started log=.+\nexit=0 log=.+\n$/, "without a stream directory it prints the summary as before");
  t.after(() => rmSync(path.dirname(/exit=0 log=(\S+)/.exec(outside.stdout)[1]), { recursive: true, force: true }));
});

test("ISS-14476 a managed host plan carries the shipped reporter, and the brief never asks the agent to run or redirect it", (t) => {
  const f = fixture(t);
  const tool = { commit: "a".repeat(40), ref: "refs/heads/vibe-proof" };
  const managed = { tool, affected: [] };
  const artifact = { kind: "validation-outcomes", branch: "vibe-validation-results/fixture-run", path: ".vibe-validation-outcomes-0123456789abcdef.json" };
  for (const request of [f.request("pnpm docker:ensure"), { ...f.request("pnpm docker:ensure"), resultArtifact: artifact }]) {
    const brief = validationBrief(request, managed);
    const runner = brief.split("\n").find((line) => line.startsWith("node .git/vibe-validation-host-"));
    const plan = JSON.parse(runner.slice(runner.indexOf("'") + 1, runner.lastIndexOf("'")).replaceAll("'\"'\"'", "'"));
    assert.equal(plan.reporter.tool, tool.commit);
    assert.match(plan.reporter.root, /^plugins\/vibe/);
    assert.ok(plan.reporter.files.includes("cloud-outcome-writer.mjs"));
    const spec = JSON.parse(Buffer.from(plan.reporter.spec, "base64url").toString("utf8"));
    assert.deepEqual([spec.commit, spec.repository, spec.names.at(-1), spec.artifact], [request.commit, request.repository, "capability", request.resultArtifact ?? null]);
    assert.doesNotMatch(brief, /Install the shipped machine reporter|vibe-outcomes-[a-f0-9]{16}\/cloud-outcome-writer\.mjs/, "the agent installs and runs no reporter");
    assert.match(brief, /The managed runner runs the shipped reporter itself after its lanes[.,].*Do not run a reporter yourself/);
  }
});
