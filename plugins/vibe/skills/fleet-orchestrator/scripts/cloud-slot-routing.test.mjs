import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validationCommandKey, validationReceiptName } from "../../../lib/vibe/scripts/cloud-receipts.mjs";
import { git, makeCheckout } from "../../vibe/scripts/test-fixtures.mjs";
import { fixture, remoteConfig } from "./fleet-test-support.mjs";

const BOARD = fileURLToPath(new URL("./board.mjs", import.meta.url));
const COMMAND = ["node", "--test", "selected.test.mjs"];
const LEDGER = "cloud-heavy-refusals.jsonl";

/** Real fleet and board CLIs with a private Git fixture and loopback SSH transport. */
function setup(t) {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const worktree = path.join(f.root, "owned");
  const home = path.join(f.root, "fixture-home");
  makeCheckout({ root: f.root, home, checkout: worktree, files: { "selected.test.mjs": "export {};\n" } });
  const head = git(worktree, ["rev-parse", "HEAD"], home);
  const gitdir = git(worktree, ["rev-parse", "--absolute-git-dir"], home);
  const config = path.join(f.orch, "config.env");
  const nodeStub = path.join(f.root, "bin", "node");
  const stub = readFileSync(nodeStub, "utf8");
  const stagedCase = '*fleet-plugin-preflight.mjs) exec ' + JSON.stringify(process.execPath)
    + ' "$1" "${FLEET_TEST_STAGED_ROOT:-$2}" "$3";; ';
  writeFileSync(nodeStub, stub.replace('case "$1" in ', 'case "$1" in ' + stagedCase)
    .replace("*ship-plugins.mjs", "*cloud-slot-routing.mjs|*ship-plugins.mjs"));
  writeFileSync(path.join(f.orch, "board.json"), JSON.stringify({ writers: { w1: { worktree, head, status: "building" } } }));
  const slot = (where, argv = COMMAND, env = {}) => f.run([where, "slot", "heavy", "w1", worktree, ...argv], env);
  const audit = () => spawnSync(process.execPath, [BOARD, f.orch, "status"], { encoding: "utf8" });
  return { ...f, worktree, head, gitdir, config, slot, audit };
}

test("prevention names cloud validate after local capacity refusals and pairs exact writer/head/lane receipts", (t) => {
  const f = setup(t);
  writeFileSync(f.config, "LOCAL_HEAVY_BARRED=1\n");
  const barred = f.slot("local");
  assert.equal(barred.status, 78, barred.stderr);
  assert.match(barred.stderr, /LOCAL_HEAVY_BARRED/);
  assert.match(barred.stderr, /CLOUD-VALIDATE node-[0-9a-f]{12}: node '[^']+cloud-worker\.mjs' validate --request '[^']+\.json'/);
  assert.doesNotMatch(f.audit().stdout, /^CLOUD-VALIDATE-MISSING/m, "a single refusal does not meet repeat threshold");
  writeFileSync(f.config, "");
  const overloaded = f.slot("local", COMMAND, { FLEET_TEST_LOAD: "9999" });
  assert.equal(overloaded.status, 4, overloaded.stderr);
  assert.match(overloaded.stderr, /CLOUD-VALIDATE/);
  const finding = f.audit();
  assert.equal(finding.status, 1);
  assert.match(finding.stdout, /^CLOUD-VALIDATE-MISSING w1 .*2 heavy refusals without matching validation receipts/m);
  const history = readFileSync(path.join(f.orch, LEDGER), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(history.map(({ status, head }) => [status, head]), [[78, f.head], [4, f.head]]);
  assert.ok(!JSON.stringify(history).includes(COMMAND.join(" ")));
  const digest = "a".repeat(64);
  const receipt = (head, lane, status = "completed") => {
    writeFileSync(path.join(f.gitdir, validationReceiptName(head, digest)), JSON.stringify({
      requestDigest: digest, commit: head, laneKeys: [validationCommandKey(lane)], taskId: "claude-task", status,
    }));
  };
  receipt("c".repeat(40), COMMAND.join(" "));
  receipt(f.head, "node --test unrelated.test.mjs");
  assert.match(f.audit().stdout, /^CLOUD-VALIDATE-MISSING/m);
  receipt(f.head, COMMAND.join(" "), "failed");
  assert.match(f.audit().stdout, /^CLOUD-VALIDATE-MISSING/m);
  receipt(f.head, COMMAND.join(" "));
  assert.doesNotMatch(f.audit().stdout, /^CLOUD-VALIDATE-MISSING/m);
  const boardFile = path.join(f.orch, "board.json"), board = JSON.parse(readFileSync(boardFile, "utf8"));
  for (const row of Object.values(board.writers)) row.where = "remote";
  writeFileSync(boardFile, JSON.stringify(board));
  writeFileSync(f.config, remoteConfig(f.root));
  const nodeStub = path.join(f.root, "bin/node");
  writeFileSync(nodeStub, readFileSync(nodeStub, "utf8").replace("case \"$1\" in ", 'case "$1" in -e) exec ' + JSON.stringify(process.execPath) + ' "$@";; '));
  const stubDir = path.join(f.root, "bin");
  writeFileSync(path.join(stubDir, "zsh"), '#!/bin/sh\nexec bash -c "$2"\n', { mode: 0o755 });
  const audited = spawnSync(process.execPath, [BOARD, f.orch, "status"], { encoding: "utf8",
    env: { ...process.env, PATH: stubDir + path.delimiter + process.env.PATH, HOME: path.join(f.root, "fixture-home") } });
  assert.doesNotMatch(audited.stdout, /^CLOUD-VALIDATE-MISSING/m);
  assert.match(readFileSync(path.join(f.root, "ssh-args"), "utf8"), /cloud-validate-/);
});

test("prevention routes only a witnessed ordinary remote refusal and never an identical payload or E2E exit", (t) => {
  const f = setup(t);
  writeFileSync(f.config, remoteConfig(f.root));
  const overloaded = f.slot("remote", COMMAND, { FLEET_TEST_LOAD: "9999" });
  assert.equal(overloaded.status, 4, overloaded.stderr);
  assert.match(overloaded.stderr, /CLOUD-VALIDATE node-/);
  t.diagnostic(overloaded.stderr.split("\n").find((line) => line.startsWith("CLOUD-VALIDATE ")));
  const payload = f.slot("remote", ["/bin/bash", "-c", "exit 4"]);
  assert.equal(payload.status, 4, payload.stderr);
  assert.doesNotMatch(payload.stderr, /CLOUD-VALIDATE/);
  const mismatch = path.join(f.root, "wrong-install");
  mkdirSync(path.join(mismatch, "plugins", "vibe", ".codex-plugin"), { recursive: true });
  writeFileSync(path.join(mismatch, "plugins", "vibe", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "0.1.0" }));
  const skew = f.slot("remote", ["--shipped-plugin-script", "vibe/scripts/cloud-worker.mjs", "check"], { FLEET_TEST_STAGED_ROOT: mismatch });
  assert.equal(skew.status, 78, skew.stderr);
  assert.match(skew.stderr, /CLOUD-VALIDATE workflow-/);
  const e2e = f.slot("remote", ["--containerized-e2e-build", ...COMMAND], { FLEET_TEST_LOAD: "9999" });
  assert.ok([4, 78].includes(e2e.status), e2e.stderr);
  assert.doesNotMatch(e2e.stderr, /CLOUD-VALIDATE/);
  const count = readFileSync(path.join(f.orch, LEDGER), "utf8").trim().split("\n").length;
  assert.equal(count, 2);
});

test("an indirect refusal clears only for its advised request and committed workflow check", (t) => {
  const f = setup(t);
  writeFileSync(f.config, "LOCAL_HEAVY_BARRED=1\n");
  const cmd = COMMAND.join(" ");
  const argv = ["bash", "-lc", cmd];
  f.slot("local", argv);
  const result = f.slot("local", argv);
  assert.match(f.audit().stdout, /CLOUD-VALIDATE-MISSING/);
  const requestFile = /--request '([^']+)'/.exec(result.stderr)[1];
  mkdirSync(path.dirname(requestFile), {recursive:true});
  const request = {worktree:f.worktree, commit:f.head, lanes:[{name:"checks"}],
    laneSource:{kind:"github-workflow",path:".github/workflows/checks.yml",commit:f.head,sha256:"a".repeat(64)}};
  writeFileSync(requestFile, JSON.stringify(request));
  const digest = validationCommandKey(JSON.stringify(request));
  const record = (command, requestDigest = digest) => {
    const lane = {name:"checks", workflow:request.laneSource, command:JSON.stringify({version:1, job:{steps:[{run:command}]}})};
    writeFileSync(path.join(f.gitdir, validationReceiptName(f.head, requestDigest)), JSON.stringify({commit:f.head, requestDigest,
      laneKeys:[validationCommandKey(lane.command)], taskId:"fixture",status:"completed",
      validationReport:{passed:true,commit:f.head,laneSource:request.laneSource,lanes:[{...lane,passed:true,exitCode:0}]}}));
  };
  record(cmd, "b".repeat(64));
  record("node --test other.test.mjs");
  assert.match(f.audit().stdout, /CLOUD-VALIDATE-MISSING/);
  record(cmd);
  assert.doesNotMatch(f.audit().stdout, /CLOUD-VALIDATE-MISSING/);
});
