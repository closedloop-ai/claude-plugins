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
