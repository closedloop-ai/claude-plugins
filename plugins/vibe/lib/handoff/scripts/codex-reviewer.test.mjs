import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLedgerLock, finalMarker, read as readLedger, write as writeLedger } from "../../fleet-orchestrator/scripts/helpers.mjs";
import { sourceIdentity } from "../../vibe/scripts/tested-head.mjs";
import { captureReviewReceipt, reviewReceiptProblems } from "./review-receipts.mjs";
import { acceptManagedReviewer, readCodexReviewTurn, runManagedReviewer } from "./codex-review-runtime.mjs";
import { reviewBrief } from "./review-context-test-support.mjs";

/** A deterministic App Server boundary. All session, helper and receipt code runs unchanged. */
function reviewFixture(t, { finalBody = JSON.stringify, markerSeparator = "\n", directory, helper = "first-pass" } = {}) {
  const orchDir = directory ?? realpathSync(mkdtempSync(path.join(tmpdir(), "managed-review-")));
  if (!directory) t.after(() => rmSync(orchDir, { recursive: true, force: true }));
  const worktree = path.join(orchDir, "worktree-" + helper);
  mkdirSync(worktree);
  execFileSync("git", ["init", "-q", "-b", "main", worktree]);
  execFileSync("git", ["-C", worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-qm", "base", "--allow-empty"]);
  const role = "vibe-adversarial-reviewer";
  const definitionPath = fileURLToPath(new URL("../../../agents/" + role + ".md", import.meta.url));
  const capabilities = path.join(orchDir, "capabilities.json");
  const brief = path.join(orchDir, "brief.md");
  writeFileSync(brief, reviewBrief(orchDir, "Review the source for regressions."));
  writeFileSync(capabilities, JSON.stringify([{ name: "mcp__test_graph__code_symbols", service: "graph", access: "read", operation: "code_symbols" }]));
  const input = { orchDir, worktree, role, helper, model: "gpt-6.2-astra", capabilities, brief,
    definitionPath };
  const calls = [];
  const threadId = directory ? "thread-" + helper : "thread-1";
  const turnId = "turn-1";
  const items = [{ type: "mcpToolCall", server: "test-graph", tool: "code_symbols",
    status: "completed" }];
  let notify;
  const client = {
    onNotification(handler) { notify = handler; return () => {}; },
    onConnection() { return () => {}; },
    close() {},
    async request(method, params) {
      calls.push([method, params]);
      switch (method) {
        case "model/list": return { data: [{ model: "gpt-6.2-astra" }] };
        case "thread/list": return { data: [] };
        case "thread/start":
        case "thread/read": return { thread: { id: threadId, cwd: worktree, turns: [], status: { type: "idle" } } };
        case "turn/start": return { turn: { id: turnId } };
        case "turn/steer": {
          const [fields, marker] = params.input[0].text.split("\nLast line: ");
          const result = { ...JSON.parse(fields.slice("Use these fields: ".length)), observedToolCalls: [], findings: [] };
          const final = { type: "agentMessage", phase: "final_answer",
            text: finalBody(result) + markerSeparator + marker };
          items.push(final);
          notify("item/completed", { threadId, turnId, item: final });
          notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
          return { turnId };
        }
        case "thread/turns/list": return { data: [{ id: turnId, status: "completed" }] };
        case "thread/items/list": return { data: items.map(item => ({ item })) };
        default: throw new Error("Unexpected App Server method " + method);
      }
    },
  };
  const runtimeRead = (threadId, turnId) => readCodexReviewTurn(threadId, turnId, client);
  return { input, calls, client, items, runtimeRead, readHelper: () => JSON.parse(readFileSync(path.join(orchDir, "helpers.json"), "utf8"))[input.helper] };
}

test("AC 12 refuses an ungrounded review before connecting to a model", async t => {
  const { input } = reviewFixture(t);
  writeFileSync(input.brief, "Review the list of changes.");
  await assert.rejects(runManagedReviewer(input, async () => { throw new Error("opened client"); }),
    /read.*tracker.*slug.*review-ticket/i);
});

test("AC-1, AC-2, AC-3, AC-6, AC-7: the named read-only managed reviewer yields an independently accepted native receipt", async t => {
  const { input, calls, client, readHelper } = reviewFixture(t);
  const { threadId, report, deliverable } = await runManagedReviewer(input, async () => client);
  assert.equal(threadId, "thread-1");
  const request = method => calls.find(([name]) => name === method)[1];
  assert.equal(request("thread/start").model, "gpt-6.2-astra");
  assert.equal(request("thread/start").cwd, input.worktree);
  assert.equal(request("thread/start").sandbox, "read-only");
  assert.equal(request("turn/start").approvalPolicy, "never");
  assert.deepEqual(request("turn/start").sandboxPolicy, { type: "readOnly" });
  assert.ok(request("turn/start").input[0].text.includes("Adversarially review one implemented session"));
  assert.ok(request("turn/start").input[0].text.includes("Keep the original label."));
  assert.ok(request("turn/start").input[0].text.includes("keeps that label on mobile too."));
  assert.equal(readHelper().reviewCriteria.ticket, "TASK-42");
  assert.equal(request("turn/steer").expectedTurnId, "turn-1");
  assert.equal(readHelper().workerId, threadId);
  assert.equal(readHelper().agentDefinition.path, input.definitionPath);
  assert.equal(readHelper().acceptedAt, undefined);
  await assert.rejects(acceptManagedReviewer({ ...input, report: deliverable }), /finalized report/);
  const receipt = await acceptManagedReviewer({ ...input, report }, (thread, turn) => readCodexReviewTurn(thread, turn, client));
  const captured = JSON.parse(readFileSync(receipt.receipt, "utf8"));
  assert.equal(captured.kind, "native-final");
  assert.deepEqual(captured.graphCalls, ["mcp__test_graph__code_symbols"]);
  assert.equal(captured.trace.path, deliverable);
  assert.ok(readHelper().acceptedAt);
  assert.deepEqual(reviewReceiptProblems([captured], captured.source).problems.filter(problem => problem.startsWith(input.role)), []);
});

const helperCli = fileURLToPath(new URL("../../fleet-orchestrator/scripts/helpers.mjs", import.meta.url));

/** Wait inside an isolated child fixture until the test releases it, including a bound on test failure. */
function waitForFileCommand(file) {
  return `"${process.execPath}" -e 'const end = Date.now() + 20000;
    while (!require("node:fs").existsSync(process.argv[1]) && Date.now() < end)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    if (!require("node:fs").existsSync(process.argv[1])) process.exit(1)' "${file}" || exit 1`;
}

/** Observe full reads of the external fixture report, including its streaming hash. */
function observeReportReads(bin, report, owner) {
  const hook = path.join(bin, "report-reads.cjs");
  writeFileSync(hook, `const fs = require("node:fs");
    const read = fs.readFileSync;
    for (const method of ["openSync", "readFileSync"]) {
      const original = fs[method];
      fs[method] = function (file, ...args) {
        if (file === ${JSON.stringify(report)}) {
          let locked = false;
          try { locked = JSON.parse(read(${JSON.stringify(owner)})).pid === process.pid; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
          fs.writeFileSync(${JSON.stringify(bin)} + (locked ? "/locked-report" : "/read-report"), "");
        }
        return original.call(this, file, ...args);
      };
    }
    require("node:module").syncBuiltinESMExports();`);
  return ["--require", hook];
}

/** Pause the first Git source read of one real helper command inside this test's temporary directory. */
async function pauseHelperSource(input, args, { waitingForLock, ownerPid = process.pid, resumeProbe } = {}) {
  const bin = path.join(input.orchDir, "bin");
  mkdirSync(bin);
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  if (waitingForLock) {
    // This probe is reached only after the ledger command reads the peer's owner record.
    const ps = execFileSync("which", ["ps"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(bin, "ps"), `#!/bin/sh
if [ "$4" = "${ownerPid}" ]; then
  touch "${waitingForLock}"
  ${resumeProbe ? waitForFileCommand(resumeProbe) : ""}
fi
exec "${ps}" "$@"
`, { mode: 0o700 });
  }
  const entered = path.join(bin, "entered");
  const resume = path.join(bin, "resume");
  const locked = path.join(bin, "owned-lock-during-scan");
  const owner = path.join(input.orchDir, "helpers.lock", "owner.json");
  writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$3" = ls-files ] && [ "$4" = --others ]; then
  "${process.execPath}" -e 'const fs = require("node:fs");
    try {
      if (JSON.parse(fs.readFileSync(process.argv[1])).pid === Number(process.argv[2])) fs.writeFileSync(process.argv[3], "");
    } catch (e) { if (e.code !== "ENOENT") throw e; }' "${owner}" "$PPID" "${locked}" || exit 1
fi
if [ "$3" = ls-files ] && [ "$4" = --others ] && [ ! -f "${entered}" ]; then
  touch "${entered}"
  # The fixture always releases on success or failure, including if a test process exits early.
  ${waitForFileCommand(resume)}
fi
exec "${git}" "$@"
`, { mode: 0o700 });
  const report = args.includes("--report") ? args[args.indexOf("--report") + 1] : null;
  const options = report ? observeReportReads(bin, report, owner) : [];
  const finished = promisify(execFile)(process.execPath, [...options, helperCli, input.orchDir, ...args],
    { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }).then(() => null, error => error);
  const release = async () => {
    writeFileSync(resume, "");
    const failure = await finished;
    assert.ok(!existsSync(locked), "the helper held the shared ledger lock during a Git source read");
    if (report) {
      assert.ok(existsSync(path.join(bin, "read-report")), "the helper read its fixture report");
      assert.ok(!existsSync(path.join(bin, "locked-report")), "the helper read the report while it held the ledger lock");
    }
    if (failure) throw failure;
  };
  const deadline = Date.now() + 10_000;
  while (!existsSync(entered) && Date.now() < deadline) await delay(20);
  if (!existsSync(entered)) {
    await release();
    assert.fail("the competing helper never reached its source check");
  }
  // A regression fails at the offending source read without waiting for the production timeout.
  if (existsSync(locked)) await release();
  return release;
}

/** Prepare the normal ledger state and arguments for a competing source-backed command. */
async function competingCommand(first, action, startOptions = []) {
  const { input, client, readHelper, runtimeRead } = first;
  if (action === "start") return ["start", input.helper, "--worktree", input.worktree];
  if (action === "final") {
    const worker = "first-final-thread";
    execFileSync(process.execPath, [...startOptions, helperCli, input.orchDir, "start", input.helper, "--kind", "reviewer",
      "--worktree", input.worktree, "--runtime", "codex", "--worker-id", worker, "--role", input.role,
      "--agent-definition", input.definitionPath, "--capabilities", input.capabilities, "--brief", input.brief]);
    const deliverable = path.join(input.orchDir, "first-final.txt");
    const completion = { sessionId: worker, turnId: "first-turn" };
    writeFileSync(deliverable, finalMarker(readHelper(), completion));
    return ["final", input.helper, "--deliverable", deliverable, "--session-id", worker,
      "--turn-id", completion.turnId, "--out", path.join(input.orchDir, "first-report.json")];
  }
  const { report } = await runManagedReviewer(input, async () => client);
  if (action === "accepted") return ["accepted", input.helper, "--report", report];
  await acceptManagedReviewer({ ...input, report }, runtimeRead);
  return ["stopped", input.helper];
}

for (const [outcome, competing, peerField] of [
  ["final", "accepted", "acceptedAt"], ["abandoned", "accepted", "acceptedAt"],
  ["abandoned", "final", "finalizedAt"], ["final", "start", "startedAt"], ["final", "stopped", "stoppedAt"],
]) {
  test(`ISS-14552: managed reviewer records ${outcome} while another helper checks its worktree for ${competing}`, async t => {
    const first = reviewFixture(t);
    const second = reviewFixture(t, { directory: first.input.orchDir, helper: "second-pass" });
    const args = await competingCommand(first, competing);
    // Begin the competing acceptance after the second helper is registered, just
    // before the launcher decides whether it can finalize the completed turn.
    let accepting;
    const request = second.client.request.bind(second.client);
    second.client.request = async (method, params) => {
      if (method === "thread/items/list" && !accepting) {
        accepting = await pauseHelperSource(first.input, args);
        if (outcome === "abandoned") throw new Error("Fixture turn evidence unavailable");
      }
      return request(method, params);
    };
    try {
      const result = runManagedReviewer(second.input, async () => second.client);
      if (outcome === "final") {
        const finished = await result;
        await acceptManagedReviewer({ ...second.input, report: finished.report }, second.runtimeRead);
        assert.ok(second.readHelper().acceptedAt);
      } else {
        await assert.rejects(result, { message: "Fixture turn evidence unavailable" });
        assert.ok(second.readHelper().abandonedAt);
        assert.equal(second.readHelper().acceptedAt, undefined);
      }
    } finally {
      await accepting?.();
    }
    assert.ok(first.readHelper()[peerField]);
    assert.ok(second.readHelper()[outcome === "final" ? "acceptedAt" : "abandonedAt"]);
  });
}

for (const action of ["final", "accepted"]) {
  test(`an already abandoned reviewer cannot transition through ${action}`, async t => {
    const fixture = reviewFixture(t);
    const { input } = fixture;
    const args = await competingCommand(fixture, action);
    execFileSync(process.execPath, [helperCli, input.orchDir, "abandoned", input.helper, "--reason", "Fixture review superseded"]);
    const before = fixture.readHelper();
    const attempted = spawnSync(process.execPath, [helperCli, input.orchDir, ...args], { encoding: "utf8" });
    assert.notEqual(attempted.status, 0);
    assert.match(attempted.stderr, /an abandoned helper cannot finalize or accept a report/);
    assert.deepEqual(fixture.readHelper(), before);
    if (action === "final") assert.ok(!existsSync(args.at(-1)));
  });
}

test("stopping a legacy abandoned and accepted reviewer cleans up its process and releases its name", async t => {
  const { input, client, readHelper, runtimeRead } = reviewFixture(t);
  const { report } = await runManagedReviewer(input, async () => client);
  const { receipt } = await acceptManagedReviewer({ ...input, report }, runtimeRead);
  const captured = JSON.parse(readFileSync(receipt, "utf8"));

  // Older ledgers could retain both timestamps after an interrupted review.
  const ledger = readLedger(input.orchDir);
  ledger[input.helper].abandonedAt = ledger[input.helper].finalizedAt;
  ledger[input.helper].abandonReason = "Interrupted review";
  writeLedger(input.orchDir, ledger);
  const { problems } = reviewReceiptProblems([captured], captured.source);
  assert.ok(problems.includes(`${input.role}: native FINAL owner or evidence changed`));

  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => child.kill());
  const exited = new Promise(resolve => child.once("exit", (_, signal) => resolve(signal)));
  const cli = (...args) => promisify(execFile)(process.execPath, [helperCli, input.orchDir, ...args]);
  await cli("pid", input.helper, String(child.pid));
  await cli("stopped", input.helper);
  assert.equal(await exited, "SIGTERM");
  assert.ok(readHelper().stoppedAt);
  assert.equal(readHelper().abandonedAt, ledger[input.helper].abandonedAt);
  assert.equal(readHelper().acceptedAt, ledger[input.helper].acceptedAt);
  await cli("start", input.helper);
  assert.equal(readHelper().kind, "other");
});

/** Simulate an editor save only when this fixture child reads its own capability file. */
function editOnCapabilityRead(input, saved) {
  const editor = path.join(input.orchDir, "fixture-editor.cjs");
  writeFileSync(editor, `const fs = require("node:fs");
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (file === ${JSON.stringify(input.capabilities)}) fs.writeFileSync(${JSON.stringify(saved)}, "fixture edit");
      return read.call(this, file, ...args);
    };
    require("node:module").syncBuiltinESMExports();`);
  return editor;
}

test("reviewer start captures a tracked save during the capability read and can finalize", async t => {
  const fixture = reviewFixture(t);
  const { input } = fixture;
  const saved = path.join(input.worktree, "reviewed.txt");
  writeFileSync(saved, "before start");
  execFileSync("git", ["-C", input.worktree, "add", "reviewed.txt"]);
  const editor = editOnCapabilityRead(input, saved);
  const args = await competingCommand(fixture, "final", ["--require", editor]);
  assert.equal(readFileSync(saved, "utf8"), "fixture edit");
  execFileSync(process.execPath, [helperCli, input.orchDir, ...args]);
  assert.ok(fixture.readHelper().finalizedAt);
});

test("an edit during evidence validation leaves the review unaccepted", async t => {
  const { input, client, readHelper } = reviewFixture(t);
  const { report } = await runManagedReviewer(input, async () => client);
  const saved = path.join(input.worktree, "edited.txt");
  const editor = editOnCapabilityRead(input, saved);
  const attempted = spawnSync(process.execPath, ["--require", editor, helperCli, input.orchDir,
    "accepted", input.helper, "--report", report], { encoding: "utf8" });
  assert.ok(existsSync(saved));
  assert.notEqual(attempted.status, 0);
  assert.match(attempted.stderr, /helper source changed since start/);
  assert.equal(readHelper().acceptedAt, undefined);
});

test("a reviewer abandoned during source verification keeps its abandonment and receives no acceptance", async t => {
  const { input, client, readHelper } = reviewFixture(t);
  const { report } = await runManagedReviewer(input, async () => client);
  const finishAcceptance = await pauseHelperSource(input, ["accepted", input.helper, "--report", report]);
  try {
    execFileSync(process.execPath, [helperCli, input.orchDir, "abandoned", input.helper, "--reason", "Review superseded"]);
  } finally {
    await assert.rejects(finishAcceptance(), /helper registration changed while verifying its source/);
  }
  assert.ok(readHelper().abandonedAt);
  assert.equal(readHelper().acceptedAt, undefined);
});

test("acceptance rechecks the worktree when its fingerprint predates a ledger wait", async t => {
  const { input, client, readHelper } = reviewFixture(t);
  const { report } = await runManagedReviewer(input, async () => client);
  const waiting = path.join(input.orchDir, "waiting-for-fixture-owner");
  const finishAcceptance = await pauseHelperSource(input, ["accepted", input.helper, "--report", report], { waitingForLock: waiting });
  const releaseLedger = await acquireLedgerLock(input.orchDir);
  const accepted = finishAcceptance();
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(waiting) && Date.now() < deadline) await delay(20);
    assert.ok(existsSync(waiting), "acceptance observed the real fixture lock after its fingerprint");
    writeFileSync(path.join(input.worktree, "edited.txt"), "source changed during ledger wait");
  } finally {
    releaseLedger();
  }
  await assert.rejects(accepted, /helper source changed since start/);
  assert.equal(readHelper().acceptedAt, undefined);
});

for (const action of ["final", "accepted"]) {
  test(`DT-03: ${action} validates process, source, revision and evidence in order`, async t => {
    const fixture = reviewFixture(t);
    const { input } = fixture;
    const args = await competingCommand(fixture, action);
    const evidence = args[args.indexOf(action === "final" ? "--deliverable" : "--report") + 1];
    const trace = path.join(input.orchDir, "validation-order");
    const observer = path.join(input.orchDir, "observe-order.cjs");
    // Observe the real, successful CLI without changing its inputs or the results of any call.
    writeFileSync(observer, `const fs = require("node:fs");
      const cp = require("node:child_process");
      const locked = () => fs.existsSync(${JSON.stringify(path.join(input.orchDir, "helpers.lock", "owner.json"))});
      const record = (step) => fs.appendFileSync(${JSON.stringify(trace)}, step + "\\n");
      const { spawnSync, execFileSync } = cp;
      cp.spawnSync = function (cmd, args, ...rest) {
        if (cmd === "ps" && args.at(-1) === String(process.pid)) record("owner");
        return spawnSync(cmd, args, ...rest);
      };
      cp.execFileSync = function (cmd, args, ...rest) {
        if (cmd === "git" && args.includes("--others")) record(locked() ? "locked scan" : "source");
        if (cmd === "git" && args.join(" ") === "rev-parse HEAD" && locked()) record("revision");
        return execFileSync(cmd, args, ...rest);
      };
      const { lstatSync } = fs;
      fs.lstatSync = function (file, ...rest) {
        if (file === ${JSON.stringify(evidence)} && locked()) record("evidence");
        return lstatSync(file, ...rest);
      };
      require("node:module").syncBuiltinESMExports();`);
    execFileSync(process.execPath, ["--require", observer, helperCli, input.orchDir, ...args]);
    assert.deepEqual(readFileSync(trace, "utf8").trim().split("\n"), ["owner", "source", "revision", "evidence"]);
  });
}

for (const action of ["final", "accepted", "start", "stopped"]) {
  test(`DT-03: ${action} preserves the ledger when the locked HEAD check sees a new revision`, async t => {
    const fixture = reviewFixture(t);
    const { input } = fixture;
    const args = await competingCommand(fixture, action);
    const before = readLedger(input.orchDir);
    const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const next = execFileSync(git, ["-C", input.worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org",
      "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "next revision"], { encoding: "utf8" }).trim();
    // Advance the fixture at its locked revision read. Both fingerprints and the revision check run real Git.
    const bin = path.join(input.orchDir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$*" = "rev-parse HEAD" ] && [ -f "${input.orchDir}/helpers.lock/owner.json" ]; then
  "${git}" -C "${input.worktree}" update-ref HEAD "${next}" || exit 1
fi
exec "${git}" "$@"
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [helperCli, input.orchDir, ...args], {
      encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /helper HEAD changed during verification/);
    assert.equal(execFileSync(git, ["-C", input.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), next);
    assert.deepEqual(readLedger(input.orchDir), before);
    if (action === "final") assert.equal(existsSync(args.at(-1)), false);
  });
}

test("finalization retains a PID recorded for the same helper during source verification", async t => {
  const fixture = reviewFixture(t);
  const { input, readHelper } = fixture;
  const args = await competingCommand(fixture, "final");
  const finish = await pauseHelperSource(input, args);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => child.kill());
  try {
    execFileSync(process.execPath, [helperCli, input.orchDir, "pid", input.helper, String(child.pid)]);
  } finally {
    await finish();
  }
  assert.ok(readHelper().finalizedAt);
  assert.ok(readHelper().pids.includes(child.pid));
  assert.ok(readHelper().identities[child.pid]);
});

test("acceptance refuses a replaced report after preparation and preserves the registration", async t => {
  const fixture = reviewFixture(t);
  const { input, readHelper } = fixture;
  const args = await competingCommand(fixture, "accepted");
  const before = readHelper();
  const finish = await pauseHelperSource(input, args);
  const report = args.at(-1);
  const replacement = path.join(input.orchDir, "replacement-report.json");
  // Identical valid bytes isolate the file-version witness from content and source validation.
  writeFileSync(replacement, readFileSync(report));
  renameSync(replacement, report);
  await assert.rejects(finish(), /helper evidence changed during verification/);
  assert.deepEqual(readHelper(), before);
});

test("start refreshes when the previous lock owner exits during its identity check", async t => {
  const { input, readHelper } = reviewFixture(t);
  const waiting = path.join(input.orchDir, "probing-fixture-owner");
  const resumeProbe = path.join(input.orchDir, "fixture-owner-exited");
  const owner = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireLedgerLock } from ${JSON.stringify(helperCli)};
    const release = await acquireLedgerLock(${JSON.stringify(input.orchDir)});
    process.stdout.write("ready");
    for await (const _ of process.stdin) break;
    release();
  `], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise(resolve => owner.once("exit", resolve));
  t.after(() => owner.stdin.end());
  await new Promise((resolve, reject) => {
    owner.stdout.once("data", resolve);
    owner.once("error", reject);
    owner.once("exit", () => reject(new Error("fixture owner exited before registration")));
  });
  const finish = await pauseHelperSource(input, ["start", input.helper, "--worktree", input.worktree],
    { waitingForLock: waiting, ownerPid: owner.pid, resumeProbe });
  const started = finish();
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(waiting) && Date.now() < deadline) await delay(20);
    assert.ok(existsSync(waiting), "the helper observed the fixture lock owner");
    writeFileSync(path.join(input.worktree, "saved.txt"), "saved before registration");
    owner.stdin.end();
    assert.equal(await exited, 0);
  } finally {
    writeFileSync(resumeProbe, "");
    await started;
  }
  assert.deepEqual(readHelper().source, sourceIdentity(input.worktree));
});

test("managed failure cleanup preserves a replacement registration under the same helper name", async t => {
  const { input, client, readHelper } = reviewFixture(t);
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === "thread/items/list") {
      // A replacement is already present by the time App Server reports the failed turn.
      const ledger = readLedger(input.orchDir);
      ledger[input.helper] = { ...ledger[input.helper], workerId: "replacement-thread", finalToken: "replacement-token" };
      writeLedger(input.orchDir, ledger);
      throw new Error("Fixture turn evidence unavailable");
    }
    return request(method, params);
  };
  await assert.rejects(runManagedReviewer(input, async () => client), /registration changed before abandonment/);
  assert.equal(readHelper().workerId, "replacement-thread");
  assert.equal(readHelper().abandonedAt, undefined);
});

// The reported checkpoint and FINAL are separate lines after the JSON review.
const terminalCheckpoint = {
  event_id: "cd5d7702-230f-44a1-b101-d9b7657ab951", kind: "checkpoint", status: "completed", terminal: true,
  payload: { verdict: "CHANGES_REQUIRED", blocking_findings: 7, source_frozen: true },
};
const checkpointLine = event => "APP_SERVER_ORCHESTRATOR_EVENT v1 " + JSON.stringify(event);
const withCheckpoint = (result, event = terminalCheckpoint) => JSON.stringify(result, null, 2) + "\n\n" + checkpointLine(event);

test("a managed checkpoint before FINAL passes native capture and handoff verification", async t => {
  const { input, client, runtimeRead, readHelper } = reviewFixture(t, { finalBody: withCheckpoint });
  const { report } = await runManagedReviewer(input, async () => client);
  const accepted = await acceptManagedReviewer({ ...input, report }, runtimeRead);
  assert.ok(readHelper().acceptedAt);
  const saved = JSON.parse(readFileSync(accepted.receipt));
  assert.deepEqual(reviewReceiptProblems([saved], saved.source).problems.filter(problem => problem.startsWith(input.role)), []);
});

test("a leading UTF-8 BOM remains valid during native capture and handoff replay", async t => {
  const { input, client, runtimeRead } = reviewFixture(t, {
    finalBody: result => "\uFEFF" + JSON.stringify(result),
  });
  const { report } = await runManagedReviewer(input, async () => client);
  const accepted = await acceptManagedReviewer({ ...input, report }, runtimeRead);
  const saved = JSON.parse(readFileSync(accepted.receipt));
  assert.deepEqual(reviewReceiptProblems([saved], saved.source).problems.filter(problem => problem.startsWith(input.role)), []);
});

test("a checkpoint and FINAL on the same line fail native receipt capture", async t => {
  const { input, client, runtimeRead } = reviewFixture(t, { finalBody: withCheckpoint, markerSeparator: "" });
  const { report } = await runManagedReviewer(input, async () => client);
  await assert.rejects(acceptManagedReviewer({ ...input, report }, runtimeRead), /exact final line/);
});

test("native receipt rejects trailing text and a checkpoint report missing its owner identity", async t => {
  for (const [finalBody, expected] of [
    [result => JSON.stringify(result) + "\ntrailing output", /Native FINAL requires one JSON review object/],
    [() => withCheckpoint({ verdict: "CHANGES_REQUIRED", disposition: "changes requested", data: {} }), /identity or source differs/],
  ]) {
    const { input, client, runtimeRead } = reviewFixture(t, { finalBody });
    const { report } = await runManagedReviewer(input, async () => client);
    await assert.rejects(acceptManagedReviewer({ ...input, report }, runtimeRead), expected);
  }
});

test("AC-4: a raw codex exec result cannot become a native receipt", async t => {
  const { input } = reviewFixture(t);
  const raw = path.join(input.orchDir, "raw.json");
  writeFileSync(raw, JSON.stringify({ runtime: "codex", agentName: input.role, status: "DONE", sessionId: "raw", requestId: "raw", tracePath: raw }));
  assert.throws(() => captureReviewReceipt({ worktree: input.worktree, role: input.role, resultFile: raw,
    outFile: path.join(input.orchDir, "receipt.json") }), /launcher result needs matching role/);
  await assert.rejects(acceptManagedReviewer({ ...input, report: raw }), /finalized report/);
});

test("AC-1, AC-5, AC-7: the shipped launcher requires the selected model and refuses a writer role", t => {
  const { input } = reviewFixture(t);
  const cli = fileURLToPath(new URL("../../../skills/vibe/scripts/dist/codex-reviewer.mjs", import.meta.url));
  const args = [cli, "run", "--orch-dir", input.orchDir, "--helper", "cli-test", "--role", "vibe-change-worker",
    "--worktree", input.worktree, "--capabilities", input.capabilities, "--brief", input.brief];
  const missing = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing --model/);
  const writer = spawnSync(process.execPath, [...args, "--model", input.model], { encoding: "utf8" });
  assert.equal(writer.status, 1);
  assert.match(writer.stderr, /Unknown native review role: vibe-change-worker/);
  for (const doc of ["../../../skills/handoff/references/handoff-pr.md", "../../../skills/fleet-orchestrator/SKILL.md"]) {
    assert.match(readFileSync(new URL(doc, import.meta.url), "utf8"), /vibe\/scripts\/dist\/codex-reviewer\.mjs/);
  }
});

function criticFixture(t, options) {
  const fixture = reviewFixture(t, options);
  const { input } = fixture;
  input.role = "visual-qa-critic";
  input.agentDefinition = path.join(input.worktree, "critic.md");
  writeFileSync(input.agentDefinition, "---\nname: visual-qa-critic\n---\nReview screens.\n");
  execFileSync("git", ["-C", input.worktree, "add", "critic.md"]);
  execFileSync("git", ["-C", input.worktree, "-c", "user.name=Fixture", "-c", "user.email=test@example.org", "commit", "-qm", "critic"]);
  return fixture;
}

test("AC 12 keeps a contradiction out of defects in a reviewer receipt and critic deliverable", async t => {
  const conflict = { id: "one", blocking: true, contradicts: "keeps that label on mobile too.", question: "Should mobile use the new label?" };
  for (const create of [reviewFixture, criticFixture]) {
    const { input, client, runtimeRead } = create(t, { finalBody: identity => JSON.stringify({ ...identity, findings: [conflict] }) });
    const run = await runManagedReviewer(input, async () => client);
    const file = run.visualQa ?? (await acceptManagedReviewer({ ...input, report: run.report }, runtimeRead)).receipt;
    const result = JSON.parse(readFileSync(file));
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.questions, [{ kind: "QUESTION", contradicts: conflict.contradicts, question: conflict.question }]);
  }
});

test("AC 12 refuses missing or changed tracker authority before launching any final helper kind", t => {
  const { input } = reviewFixture(t);
  const cli = fileURLToPath(new URL("../../fleet-orchestrator/scripts/helpers.mjs", import.meta.url));
  const args = [input.orchDir, "start", "review", "--runtime", "codex", "--role", input.role, "--worker-id", "native",
    "--worktree", input.worktree, "--agent-definition", input.definitionPath, "--capabilities", input.capabilities, "--brief", input.brief];
  const complete = readFileSync(input.brief, "utf8");
  for (const kind of ["reviewer", "verifier", "critic"]) {
    writeFileSync(input.brief, "Review without a ticket.");
    const missing = spawnSync(process.execPath, [cli, ...args, "--kind", kind], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /tracker by slug.*review-ticket/);
  }
  writeFileSync(input.brief, complete);
  writeFileSync(path.join(input.orchDir, "rulings.md"), "- Ruling 2026-01-03 (ticket: operator): TASK-42 requires a second label.");
  const omitted = spawnSync(process.execPath, [cli, ...args, "--kind", "reviewer"], { encoding: "utf8" });
  assert.match(omitted.stderr, /tracker by slug.*review-ticket/);
  writeFileSync(path.join(input.orchDir, "review-ticket.json"), "{}");
  const changed = spawnSync(process.execPath, [cli, ...args, "--kind", "reviewer"], { encoding: "utf8" });
  assert.match(changed.stderr, /tracker by slug.*review-ticket/);
  assert.throws(() => readFileSync(path.join(input.orchDir, "helpers.json")), { code: "ENOENT" });
});

test("DT-10 AC-10 managed repository critic produces only ready-gate findings for the registered head", async t => {
  const { input, client, readHelper } = criticFixture(t);
  const { visualQa } = await runManagedReviewer(input, async () => client);
  const head = execFileSync("git", ["-C", input.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.deepEqual(JSON.parse(readFileSync(visualQa)), { head, findings: [] });
  const boardCli = fileURLToPath(new URL("../../../skills/fleet-orchestrator/scripts/board.mjs", import.meta.url));
  const program = path.join(input.orchDir, "programs", "critic-test");
  mkdirSync(program, { recursive: true });
  writeFileSync(path.join(input.orchDir, "current"), "critic-test\n");
  const placement = path.join(program, "placement.json");
  writeFileSync(placement, JSON.stringify({ codeOnly: false, needsRunningApp: true, localEvidence: ["visual"] }));
  execFileSync(process.execPath, [boardCli, program, "placement", "#1", "--evidence", placement]);
  execFileSync(process.execPath, [boardCli, program, "writer", "author", "--tickets", "#1", "--ready", head, "--visual-qa", visualQa]);
  const row = JSON.parse(readFileSync(path.join(program, "board.json"))).writers.author;
  assert.equal(row.visualQa.findings.path, visualQa);
  assert.equal(readHelper().kind, "critic");
  await assert.rejects(acceptManagedReviewer({ ...input, report: readHelper().finalReportPath }), /finalized report/);
  assert.throws(() => readFileSync(path.join(path.dirname(visualQa), "receipt.json")), { code: "ENOENT" });
});

test("DT-10 AC-10 rejects mismatched heads and malformed findings before publishing", async t => {
  for (const [change, message] of [[{ head: "0".repeat(40) }, /registered head/], [{ findings: [{}] }, /boolean touchedSurface/],
    [{ findings: [{ touchedSurface: true }] }, /no summary/]]) {
    const { input, client, readHelper } = criticFixture(t, { finalBody: result => JSON.stringify({ ...result, ...change }) });
    await assert.rejects(runManagedReviewer(input, async () => client), message);
    assert.ok(readHelper().abandonedAt);
    assert.equal(readHelper().finalizedAt, undefined);
  }
});

test("DT-10 AC-10 shipped CLI accepts the critic flags and rejects a definition outside the source before launch", t => {
  const { input } = reviewFixture(t);
  const cli = fileURLToPath(new URL("../../../skills/vibe/scripts/dist/codex-reviewer.mjs", import.meta.url));
  const args = [cli, "run", "--orch-dir", input.orchDir, "--helper", input.helper, "--role", "visual-qa-critic",
    "--worktree", input.worktree, "--capabilities", input.capabilities, "--brief", input.brief, "--model", input.model];
  assert.match(spawnSync(process.execPath, args, { encoding: "utf8" }).stderr, /require --agent-definition/);
  const outside = spawnSync(process.execPath, [...args, "--agent-definition", input.brief], { encoding: "utf8" });
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /definition must belong to the source repository/);
});

test("F12 an actionable critic finding reaches the writer and a resolved finding reaches readiness", async t => {
  const { findingProblems } = await import("../../../skills/fleet-orchestrator/scripts/finding-brief.mjs");
  const { visualQaFindingsProblems } = await import("../../vibe/scripts/required-visual-qa.mjs");
  const finding = { id: "F1", touchedSurface: true, summary: "Button is clipped", route: "/edit", viewport: "800x600", selector: "#save" };
  for (const disposition of [undefined, "fixed: 1234567"]) {
    const { input, client } = criticFixture(t, { finalBody: result => JSON.stringify({ ...result, findings: [{ ...finding, disposition }] }) });
    const { visualQa } = await runManagedReviewer(input, async () => client);
    const artifact = JSON.parse(readFileSync(visualQa));
    assert.deepEqual(findingProblems(artifact.findings), []);
    assert.equal(visualQaFindingsProblems(visualQa, artifact.head).length, disposition ? 0 : 1);
  }
});

test("AC-8: helper registration uses the YAML name of a repository critic", t => {
  const { input } = reviewFixture(t);
  const cli = fileURLToPath(new URL("../../fleet-orchestrator/scripts/helpers.mjs", import.meta.url));
  const critic = "visual-qa-critic";
  const cases = [
    [critic, `name: ${critic}`], [critic, `name: "${critic}"`], [critic, `name: '${critic}'`],
    [critic, `{\nname: ${critic}\n}`],
    [critic, `name: ${critic}`, undefined, { opening: "\uFEFF---" }],
    [critic, `name: ${critic}`, undefined, { closing: "--- " }],
    [critic, `name: ${critic}`, undefined, { opening: "---\t" }],
    ["api-architect", "name: api-architect\ndescription: Reviews routes in apps/api: thin routes and service logic."],
    [critic, "name: another-critic", /canonical agent definition does not name the requested role/],
    [critic, `name:  ${critic}\n  assistant\ndescription: Legacy: text.`, /canonical agent definition does not name the requested role/],
    [critic, `name: >- # folded role\n  ${critic}\ndescription: Legacy: text.`],
    [critic, `name: ${critic}\nname: other`, /top-level string name/],
    [critic, `metadata:\n  name: ${critic}`, /top-level string name/],
    [critic, "name: true", /top-level string name/],
  ];
  for (const [index, [role, metadata, refusal, { opening = "---", closing = "---" } = {}]] of cases.entries()) {
    const definition = path.join(input.orchDir, `critic-${index}.md`);
    writeFileSync(definition, `${opening}\n${metadata}\n${closing}\nname: ${role}\n`);
    const result = spawnSync(process.execPath, [cli, input.orchDir, "start", `critic-${index}`, "--kind", "critic",
      "--worktree", input.worktree, "--runtime", "codex", "--worker-id", `critic-thread-${index}`, "--role", role,
      "--agent-definition", definition, "--capabilities", input.capabilities, "--brief", input.brief], { encoding: "utf8" });
    if (refusal) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, refusal);
    } else {
      assert.equal(result.status, 0, result.stderr);
    }
  }
});

test("direct Codex helper registration accepts a readable symlinked brief", t => {
  const { input, readHelper } = reviewFixture(t);
  const link = path.join(input.orchDir, "linked-brief.md");
  symlinkSync(input.brief, link);
  const cli = fileURLToPath(new URL("../../fleet-orchestrator/scripts/helpers.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, input.orchDir, "start", input.helper, "--kind", "reviewer",
    "--worktree", input.worktree, "--runtime", "codex", "--worker-id", "direct-thread", "--role", input.role,
    "--agent-definition", input.definitionPath, "--capabilities", input.capabilities, "--brief", link], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readHelper().brief, link);
});

test("a managed relative brief uses the orchestration directory and binds its symlink target", async t => {
  const { input, client, calls, readHelper } = reviewFixture(t);
  const name = "review-instructions.md";
  const intended = readFileSync(input.brief);
  symlinkSync(input.brief, path.join(input.orchDir, name));
  const decoy = "Instructions from the caller directory.";
  writeFileSync(path.join(input.worktree, name), decoy);
  const previous = process.cwd();
  try {
    process.chdir(input.worktree);
    await runManagedReviewer({ ...input, brief: name }, async () => client);
  } finally {
    process.chdir(previous);
  }
  const prompt = calls.find(([method]) => method === "turn/start")[1].input[0].text;
  assert.ok(prompt.includes(intended.toString("utf8")));
  assert.ok(!prompt.includes(decoy));
  assert.deepEqual(readHelper().briefEvidence, { path: input.brief, sha256: createHash("sha256").update(intended).digest("hex") });
});

test("changed launch inputs stop the registered helper before its review turn", async t => {
  for (const field of ["brief", "capabilities"]) {
    const { input, client, calls, readHelper } = reviewFixture(t);
    await assert.rejects(runManagedReviewer(input, async () => {
      writeFileSync(input[field], field === "brief" ? reviewBrief(input.orchDir, "Updated instructions") : "[]");
      return client;
    }), /Reviewer inputs changed before registration/);
    assert.ok(readHelper().abandonedAt);
    assert.equal(calls.some(([method]) => method === "turn/start"), false);
  }
});
