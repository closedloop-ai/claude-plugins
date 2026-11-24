import { parseArgs, promisify } from "node:util";
import { visualQaFindingsProblems } from "../../vibe/scripts/required-visual-qa.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLedgerLock, finalMarker, read as readLedger, write as writeLedger } from "../../fleet-orchestrator/scripts/helpers.mjs";
import { sourceIdentity } from "../../vibe/scripts/tested-head.mjs";
import { captureReviewReceipt, reviewReceiptProblems } from "./review-receipts.mjs";
import { acceptManagedReviewer, readCodexReviewTurn, runManagedReviewer } from "./codex-review-runtime.mjs";
import { reviewBrief } from "./review-context-test-support.mjs";

/** A deterministic App Server boundary. All session, helper and receipt code runs unchanged. */
function reviewFixture(t, { finalBody = JSON.stringify, markerSeparator = "\n", role = "vibe-adversarial-reviewer", directory, helper = "first-pass" } = {}) {
  const orchDir = directory ?? realpathSync(mkdtempSync(path.join(tmpdir(), "managed-review-")));
  if (!directory) t.after(() => rmSync(orchDir, { recursive: true, force: true }));
  const worktree = path.join(orchDir, "worktree-" + helper);
  mkdirSync(worktree);
  execFileSync("git", ["init", "-q", "-b", "main", worktree]);
  execFileSync("git", ["-C", worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-qm", "base", "--allow-empty"]);
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

// ISS-14552 receipt hardening moved to ISS-14476 (AC-88): handoff replay, capture and cached publication.
async function acceptedReceipt(t) {
  const fixture = reviewFixture(t);
  const { report } = await runManagedReviewer(fixture.input, async () => fixture.client);
  const accepted = await acceptManagedReviewer({ ...fixture.input, report }, fixture.runtimeRead);
  return { ...fixture, report, receiptFile: accepted.receipt, saved: JSON.parse(readFileSync(accepted.receipt, "utf8")) };
}

test("AC-88 R26 handoff replay binds a native receipt to its accepted ledger fingerprints, Codex runtime and worktree", async t => {
  const { input, saved } = await acceptedReceipt(t);
  const problems = (receipt, options) => reviewReceiptProblems([receipt], saved.source, options).problems.filter(line => line.startsWith(input.role));
  assert.deepEqual(problems(saved), []);
  for (const field of ["result", "trace", "capabilities", "runtimeEvidence"]) {
    assert.match(problems({ ...saved, [field]: { ...saved[field], sha256: "0".repeat(64) } }).join(), /native FINAL owner or evidence changed/, field);
  }
  assert.match(problems({ ...saved, runtime: "claude" }).join(), /native FINAL owner or evidence changed/);
  assert.match(problems({ ...saved, workerId: "another-thread" }).join(), /native FINAL owner or evidence changed/);
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), "other-worktree-")));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  assert.match(problems(saved, { worktree: elsewhere }).join(), /receipt belongs to another worktree/);
  assert.match(reviewReceiptProblems([saved, { ...saved, role: "unlisted-reviewer" }], saved.source).problems.join(), /unvalidated role/,
    "an extra receipt for an unvalidated role is refused, as cloud import relies on");
});

test("AC-88 R31 native capture binds the live App Server thread's working directory to the helper worktree", async t => {
  const { input, client, report } = await (async () => {
    const fixture = reviewFixture(t);
    const { report } = await runManagedReviewer(fixture.input, async () => fixture.client);
    return { ...fixture, report };
  })();
  const sibling = path.join(input.orchDir, "sibling");
  mkdirSync(sibling);
  const moved = { ...client, request: async (method, params) => {
    const answer = await client.request(method, params);
    return method === "thread/read" ? { ...answer, thread: { ...answer.thread, cwd: sibling } } : answer;
  } };
  await assert.rejects(acceptManagedReviewer({ ...input, report }, (thread, turn) => readCodexReviewTurn(thread, turn, moved)));
  const accepted = await acceptManagedReviewer({ ...input, report }, (thread, turn) => readCodexReviewTurn(thread, turn, client));
  assert.deepEqual(reviewReceiptProblems([JSON.parse(readFileSync(accepted.receipt, "utf8"))], sourceIdentity(input.worktree)).problems
    .filter(line => line.startsWith(input.role)), [], "the matching directory recaptures");
});

test("AC-88 R28 a malformed cached receipt is a receipt-specific refusal that leaves the accepted evidence intact", async t => {
  const { input, report, runtimeRead, receiptFile, readHelper } = await acceptedReceipt(t);
  const acceptedAt = readHelper().acceptedAt;
  writeFileSync(receiptFile, '{"kind": "native-final"');
  const failure = await acceptManagedReviewer({ ...input, report }, runtimeRead).then(() => null, error => error);
  assert.ok(failure, "a malformed cached receipt is refused");
  assert.doesNotMatch(String(failure.message), /^SyntaxError|Unexpected end of JSON/);
  assert.match(String(failure.message), /receipt\.json|native evidence/);
  assert.equal(readHelper().acceptedAt, acceptedAt, "the accepted helper record is unchanged");
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
  await assert.rejects(runManagedReviewer(input, async () => client), /exact FINAL marker/i);
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

test("ADV2-2 review helper registration refuses a brief naming a repository script missing from the review worktree", t => {
  const { input } = reviewFixture(t);
  const cli = fileURLToPath(new URL("../../fleet-orchestrator/scripts/helpers.mjs", import.meta.url));
  // The review worktree is a plugin checkout, so a repository-qualified script names its own source.
  const pluginRoot = path.join(input.worktree, "plugins", "vibe");
  mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vibe", version: "0.0.1" }));
  mkdirSync(path.join(pluginRoot, "skills", "vibe", "scripts"), { recursive: true });
  const script = "plugins/vibe/skills/vibe/scripts/not-yet-added.mjs";
  const brief = path.join(input.orchDir, "source-brief.md");
  writeFileSync(brief, `Review ${script} for regressions.`);
  const critic = path.join(input.orchDir, "critic.md");
  writeFileSync(critic, "---\nname: visual-qa-critic\n---\nname: visual-qa-critic\n");
  const kinds = [["reviewer", input.role, input.definitionPath],
    ["verifier", "vibe-verify-worker", fileURLToPath(new URL("../../../agents/vibe-verify-worker.md", import.meta.url))],
    ["critic", "visual-qa-critic", critic]];
  const register = (kind, role, definition, suffix) => spawnSync(process.execPath, [cli, input.orchDir, "start", `${kind}-${suffix}`,
    "--kind", kind, "--worktree", input.worktree, "--runtime", "codex", "--worker-id", `${kind}-thread-${suffix}`, "--role", role,
    "--agent-definition", definition, "--capabilities", input.capabilities, "--brief", brief], { encoding: "utf8" });
  for (const [kind, role, definition] of kinds) {
    const refused = register(kind, role, definition, "missing");
    assert.notEqual(refused.status, 0, kind);
    assert.match(refused.stderr, /not-yet-added\.mjs: plugin script is not a contained regular file in the review worktree/, kind);
  }
  writeFileSync(path.join(input.worktree, script), "export {};\n");
  for (const [kind, role, definition] of kinds) {
    const accepted = register(kind, role, definition, "present");
    assert.equal(accepted.status, 0, `${kind}: ${accepted.stderr}`);
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

test("documented reviewer, verifier and critic recipes reach the native receipt and visual-QA consumers", async t => {
  const fleet = readFileSync(new URL("../../../skills/fleet-orchestrator/SKILL.md", import.meta.url), "utf8");
  const handoff = readFileSync(new URL("../../../skills/handoff/references/handoff-pr.md", import.meta.url), "utf8");
  const runArgs = /`node [^`]*codex-reviewer\.mjs run ([^`]+)`/.exec(handoff)?.[1];
  const acceptArgs = /`accept ([^`]+)`/.exec(handoff)?.[1];
  function argumentsFrom(recipe, substitutions, required) {
    assert.ok(recipe);
    const args = recipe.split(" ").map(token => substitutions[token] ?? token);
    const options = Object.fromEntries(required.map(key => [key, { type: "string" }]));
    const { values } = parseArgs({ args, options });
    for (const key of required) assert.ok(values[key], "documented recipe needs --" + key);
    const { "orch-dir": orchDir, ...rest } = values;
    return { ...rest, orchDir };
  }
  for (const role of ["vibe-adversarial-reviewer", "vibe-verify-worker"]) {
    const { input, client, runtimeRead } = reviewFixture(t, { role });
    const substitutions = { "<dir>": input.orchDir, "<fresh-name>": input.helper, "<name>": input.helper, "<wt>": input.worktree,
      "<agent>": role, "<model>": input.model, "<parent-discovered-capabilities.json>": input.capabilities, "<file>": input.brief };
    const run = argumentsFrom(runArgs, substitutions, ["orch-dir", "helper", "worktree", "role", "model", "capabilities", "brief"]);
    const { report } = await runManagedReviewer(run, async () => client);
    const accept = argumentsFrom(acceptArgs, { ...substitutions, "<returned-report>": report }, ["orch-dir", "helper", "report"]);
    const { receipt } = await acceptManagedReviewer(accept, runtimeRead);
    const saved = JSON.parse(readFileSync(receipt, "utf8"));
    // Check against the reviewed checkout's live source, never the receipt's own record of it.
    assert.deepEqual(reviewReceiptProblems([saved], sourceIdentity(input.worktree)).problems.filter(line => line.startsWith(role)), []);
    writeFileSync(path.join(input.worktree, "changed-after-review.txt"), "edit\n");
    assert.ok(reviewReceiptProblems([saved], sourceIdentity(input.worktree)).problems.includes(`${role}: review source differs from current source`),
      "a receipt for an older source is refused");
    rmSync(path.join(input.worktree, "changed-after-review.txt"));
  }
  const { input, readHelper } = reviewFixture(t);
  const cli = fileURLToPath(new URL("../../fleet-orchestrator/scripts/helpers.mjs", import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [cli, input.orchDir, ...args], { encoding: "utf8" });
  const session = "native-critic", turn = "critic-turn";
  const definition = path.join(input.orchDir, "critic.md");
  writeFileSync(definition, "---\nname: visual-qa-critic\n---\nInspect the captures.");
  assert.match(fleet, /--kind reviewer\|verifier\|critic/);
  run("start", input.helper, "--runtime", "codex", "--kind", "critic", "--role", "visual-qa-critic", "--worktree", input.worktree,
    "--worker-id", session, "--agent-definition", definition, "--capabilities", input.capabilities, "--brief", input.brief);
  const page = path.join(input.orchDir, "thread.json"), output = path.join(input.orchDir, "final.txt");
  const report = path.join(input.orchDir, "report.json"), findings = path.join(input.orchDir, "findings.json");
  const head = execFileSync("git", ["-C", input.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(findings, JSON.stringify({ head, findings: [] }));
  writeFileSync(output, findings + "\n" + finalMarker(readHelper(), { sessionId: session, turnId: turn }));
  writeFileSync(page, JSON.stringify({ thread: { id: session, cwd: input.worktree, turns: [{ id: turn, status: "completed" }] } }));
  const substitutions = { "<name>": input.helper, "<file>": output, "<id>": session, "<turn>": turn, "<page>": page, "<report>": report };
  for (const action of ["final", "accepted"]) {
    const template = [...fleet.matchAll(/`helpers\.mjs <orchDir> ([^`]+)`/g)].map(match => match[1])
      .find(command => command.startsWith(action + " ") && (action === "accepted" || command.includes("--completion-event")));
    assert.ok(template, "documented critic " + action + " command");
    const args = template.split(" ").map(word => substitutions[word] ?? word);
    if (action === "final") {
      const eventIndex = args.indexOf("--completion-event");
      assert.throws(() => run(...args.filter((_, i) => i !== eventIndex && i !== eventIndex + 1)), /runtime completion evidence/);
      const completed = readFileSync(page, "utf8");
      const moved = JSON.parse(completed);
      moved.thread.cwd = input.orchDir;
      writeFileSync(page, JSON.stringify(moved));
      assert.throws(() => run(...args), /checkout differs/);
      writeFileSync(page, completed);
    }
    run(...args);
  }
  assert.ok(readHelper().acceptedAt);
  assert.deepEqual(visualQaFindingsProblems(findings, head, null, null, null, input.worktree), []);
  const accepted = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(accepted.findings.path, realpathSync(findings));
  writeFileSync(findings, JSON.stringify({head, findings: []}, null, 2));
  assert.match(visualQaFindingsProblems(findings, head, null, null, null, input.worktree).join(" "), /fingerprint|changed|match/i);

});

/** Product text and both skill documents are synthetic. The managed transport never leaves the fixture. */
function guideFixture(t) {
  const { input, calls, client } = reviewFixture(t);
  const control = path.join(input.worktree, 'control', 'SKILL.md');
  const guide = path.join(input.orchDir, 'guided-manual-qa', 'SKILL.md');
  for (const [file, body] of [[control, '---\nname: control\n---\nRepository control instructions.'], [guide, 'Installed manual QA instructions.']]) {
    mkdirSync(path.dirname(file)); writeFileSync(file, body);
  }
  const spec = { pullRequest: {repository:"sample/guide",number:27,head:"a".repeat(40)}, plan: 'Check the minimum page size of 25.', stackFacts: 'Local QA stack.', productOrigin: 'http://localhost',
    controlSkill: 'control/SKILL.md', numberChecks: [{ claim: 'Check the minimum page size of 25.', observation: 'minimum page size of 25', evidence: 'observed.json' }] };
  writeFileSync(path.join(input.orchDir, 'observed.json'), JSON.stringify({ url: 'http://localhost/settings', text: 'Current minimum page size of 25.' }));
  writeFileSync(input.brief, JSON.stringify(spec));
  const original = client.request.bind(client);
  client.request = (method, params) => method === 'skills/list' ? {data: [{cwd: input.worktree, skills: [{enabled: true, name: 'closedloop-core:guided-manual-qa', pluginId: 'closedloop-core@closedloop-ai', path: guide}]}]} : original(method, params);
  return { input: { ...input, writerThread: 'current-writer' }, calls, client, spec };
}

async function dispatchGuide(fixture) {
  const runtime = await import('./codex-review-runtime.mjs');
  return runtime.launchQaGuide(fixture.input, async () => fixture.client, () => ({url:"https://github.com/sample/guide/pull/27",headRefOid:"a".repeat(40)}));
}

test('AC-093: fresh read-only QA guide loads both skills on the managed launcher', async t => {
  const fixture = guideFixture(t);
  const { threadId, stateFile } = await dispatchGuide(fixture);
  assert.notEqual(threadId, fixture.input.writerThread);
  assert.equal(JSON.parse(readFileSync(stateFile)).threadId, threadId);
  const start = fixture.calls.find(([method]) => method === 'thread/start')[1];
  assert.equal(start.sandbox, 'read-only');
  const turn = fixture.calls.find(([method]) => method === 'turn/start')[1];
  assert.deepEqual(turn.sandboxPolicy, {type: 'readOnly'});
  for (const loaded of ['Repository control instructions.', 'Installed manual QA instructions.']) assert.ok(turn.input[0].text.includes(loaded));
  const collision = guideFixture(t); collision.input.writerThread = threadId;
  await assert.rejects(dispatchGuide(collision), /writer thread/);
  assert.ok(!collision.calls.some(([method]) => method === 'turn/start'));
});

test('AC-094: dispatched QA brief contains plan, stack, API permission and unblock rule', async t => {
  const fixture = guideFixture(t); await dispatchGuide(fixture);
  const prompt = fixture.calls.find(([method]) => method === 'turn/start')[1].input[0].text;
  for (const text of [fixture.spec.plan, fixture.spec.stackFacts, 'QA-database data through the product API', 'try every documented unblock before BLOCKED', 'ready and waiting']) assert.ok(prompt.includes(text), text);
});

test('AC-095: an unchecked or contradicted product number refuses before guide dispatch', async t => {
  for (const update of [s => { s.plan = 'Check the minimum page size of 5/10.'; }, s => { s.numberChecks[0].observation = 'minimum page size of 5'; }, s => { s.stackFacts += '\nDesktop has 25 rows.'; }, s => { s.productOrigin = 'http://other.invalid'; }]) {
    const fixture = guideFixture(t); update(fixture.spec); writeFileSync(fixture.input.brief, JSON.stringify(fixture.spec));
    await assert.rejects(dispatchGuide(fixture), /product number/);
    assert.equal(fixture.calls.length, 0);
  }
});

test('QA numeric evidence cannot certify a prefix of the observed quantity', async t => {
  const fixture = guideFixture(t);
  writeFileSync(path.join(fixture.input.orchDir, 'observed.json'), JSON.stringify({ url: 'http://localhost/settings', text: 'minimum page size of 250' }));
  await assert.rejects(dispatchGuide(fixture), /product number/);
  assert.equal(fixture.calls.length, 0);
});

test('a foreign control document or disabled QA skill cannot launch the guide', async t => {
  const foreign = guideFixture(t); foreign.spec.controlSkill = '../guided-manual-qa/SKILL.md';
  writeFileSync(foreign.input.brief, JSON.stringify(foreign.spec));
  await assert.rejects(dispatchGuide(foreign), /inside this checkout/);
  const disabled = guideFixture(t);
  const original = disabled.client.request;
  disabled.client.request = async (method, params) => {
    const reply = await original(method, params);
    if (method === 'skills/list') reply.data[0].skills[0].enabled = false;
    return reply;
  };
  await assert.rejects(dispatchGuide(disabled), /missing or ambiguous/i);
  assert.ok(!disabled.calls.some(([method]) => method === 'thread/start'));
});

test('the bundled guide entry refuses an unverified brief before any model call', t => {
  const fixture = guideFixture(t);
  fixture.spec.numberChecks = []; writeFileSync(fixture.input.brief, JSON.stringify(fixture.spec));
  const { input } = fixture;
  const cli = fileURLToPath(new URL('../../../skills/vibe/scripts/dist/codex-reviewer.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'qa-guide', '--orch-dir', input.orchDir, '--worktree', input.worktree,
    '--helper', input.helper, '--model', input.model, '--writer-thread', input.writerThread, '--brief', input.brief], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unverified running product number/);
});

test('AC-096: Roles defaults the QA guide to Codex and the gate uses the shipped launcher', () => {
  const fleet = '../../../skills/fleet-orchestrator/';
  const roles = readFileSync(new URL(fleet + 'SKILL.md', import.meta.url), 'utf8');
  assert.match(roles, /^\|[^\n]*QA.guide[^\n]*Codex[^\n]*default/im);
  const gate = readFileSync(new URL(fleet + 'references/fleet-qa-gate.md', import.meta.url), 'utf8');
  assert.match(gate, /codex-reviewer\.mjs qa-guide/);
});

test('observed QA quantities retain their signs', async t => {
  const fixture = guideFixture(t);
  fixture.spec.plan = 'Expected offset +5.';
  fixture.spec.numberChecks = [{claim: fixture.spec.plan, observation: 'offset -5', evidence:'observed.json'}];
  writeFileSync(fixture.input.brief, JSON.stringify(fixture.spec));
  writeFileSync(path.join(fixture.input.orchDir,'observed.json'), JSON.stringify({url:'http://localhost/settings',text:'offset -5'}));
  await assert.rejects(dispatchGuide(fixture), /product number/);
});

test('the repository control skill must declare the required identity', async t => {
  const fixture = guideFixture(t);
  writeFileSync(path.join(fixture.input.worktree, fixture.spec.controlSkill), '---\nname: guide-notes\n---\nOther skill.');
  await assert.rejects(dispatchGuide(fixture), /control skill/i);
  assert.equal(fixture.calls.length, 0);
});

test('QA guide verifies PR identifiers independently of product numbers', async t => {
  const fixture = guideFixture(t);
  const repo = 'sample/guide';
  fixture.spec.pullRequest = { repository: repo, number: 27, head: 'a'.repeat(40) };
  writeFileSync(fixture.input.brief, JSON.stringify(fixture.spec));
  const {prepareGuide} = await import('./qa-guide-brief.mjs');
  const lookup = () => ({url:'https://github.com/'+repo+'/pull/27', headRefOid: 'a'.repeat(40)});
  assert.match(prepareGuide(fixture.input.brief, fixture.input.worktree, lookup), /sample\/guide#27/);
  assert.throws(() => prepareGuide(fixture.input.brief,fixture.input.worktree,() => ({...lookup(), headRefOid: 'b'.repeat(40)})), /PR head/);
});

test("AC-095 distinguishes criterion references, product fields and fractional observations", async t => {
  const routed = guideFixture(t);
  routed.spec.plan = "### Q1\n- Criterion: AC-1\n" + routed.spec.plan;
  routed.spec.criteriaSource = "criteria.md";
  writeFileSync(path.join(routed.input.orchDir, "criteria.md"), "- AC-1: Minimum page size");
  writeFileSync(routed.input.brief, JSON.stringify(routed.spec));
  await dispatchGuide(routed);
  routed.spec.plan = routed.spec.plan.replace("AC-1", "AC-2");
  writeFileSync(routed.input.brief, JSON.stringify(routed.spec));
  await assert.rejects(dispatchGuide(routed), /criterion|criteria/i);
  for (const [claim, quote, text] of [
    ["Minimum page size 5.", "Selected rows 5.", "Minimum page size 25. Selected rows 5."],
    ["Delay 5 seconds", "5 seconds", "Delay .5 seconds"],
    ["Delay .5 seconds", ".5 seconds", "Delay -.5 seconds"],
  ]) {
    const guide = guideFixture(t);
    guide.spec.plan = claim;
    guide.spec.numberChecks = [{claim, observation: quote, evidence: "observed.json"}];
    writeFileSync(path.join(guide.input.orchDir, "observed.json"), JSON.stringify({url:"http://localhost/settings", text}));
    writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
    await assert.rejects(dispatchGuide(guide), /Unverified running product number/);
  }
});

for (const [label, claim, observation, captured] of [
  ["complete field", "Active users 5", "active users 5", "25 active users 5 days ago"],
  ["inactive word", "Active users 5", "active users 5", "inactive users 5"],
  ["unit before value","Verify power (MW): 5","power (mW): 5","power (mW): 5"],
  ["unit scale", "Rate 5%", "Rate 5‰", "Rate 5‰"],
  ["currency", "Discount 5%", "Discount $5", "Discount $5"],
]) test("AC-095 refuses a mismatched " + label + " before guide dispatch", async t => {
  const guide = guideFixture(t);
  guide.spec.plan = claim;
  guide.spec.numberChecks = [{claim, observation, evidence:"observed.json"}];
  writeFileSync(path.join(guide.input.orchDir, "observed.json"), JSON.stringify({url:"http://localhost/settings", text:captured}));
  writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
  await assert.rejects(dispatchGuide(guide), /Unverified running product number/);
});

test("AC-095 requires a criterion declaration in a separate ticket artifact", async t => {
  const guide = guideFixture(t);
  guide.spec.plan = "Check AC-999";
  for (const source of [path.basename(guide.input.brief), "notes.md"]) {
    guide.spec.criteriaSource = source;
    writeFileSync(path.join(guide.input.orchDir, "notes.md"), "Discussion mentions AC-999.");
    writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
    await assert.rejects(dispatchGuide(guide), /criterion|criteria/i);
  }
});

test("the QA guide binds a complete numeric field in a product API response", async t => {
  const guide = guideFixture(t);
  const claim = "Verify active users 25";
  guide.spec.plan = claim;
  guide.spec.numberChecks = [{claim, observation:'"active users":25', evidence:"observed.json"}];
  writeFileSync(path.join(guide.input.orchDir, "observed.json"), JSON.stringify({url:"http://localhost/settings", text:'{"active users":25,"inactive users":5}'}));
  writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
  await dispatchGuide(guide);
});

test("AC-095 review measurement unit case distinguishes bytes from bits", async t => {
  for (const [claimValue, observedValue] of [["5 A","5"],["5 A","5 a"],["5 MB/s","5 Mb/s"],["5′","5″"],["25 m²","25 m"],["5 kg·m/s²","5 kg m/s²"],["5 km","5"]]) {
    const guide = guideFixture(t), claim = "Verify measurement is " + claimValue, observation = "measurement " + observedValue;
    guide.spec.plan = claim;
    guide.spec.numberChecks = [{claim, observation, evidence:"observed.json"}];
    writeFileSync(path.join(guide.input.orchDir, "observed.json"), JSON.stringify({url:"http://localhost/settings", text:observation}));
    writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
    await assert.rejects(dispatchGuide(guide), /Unverified running product number/);
  }
});

test("AC-095 review numbered Markdown under Acceptance criteria declares only those items", async t => {
  const guide = guideFixture(t);
  guide.spec.criteriaSource = "criteria.md";
  writeFileSync(path.join(guide.input.orchDir, "criteria.md"), "## Acceptance criteria\n1. First criterion\n2. Second criterion\n## Notes\n3. Other material\n");
  for (const id of ["AC-1", "AC-2", "AC-3"]) {
    guide.spec.plan = "Check " + id;
    writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
    if (id === "AC-3") await assert.rejects(dispatchGuide(guide), /criterion/);
    else await dispatchGuide(guide);
  }
});

test("AC-095 review observation and brief must have distinct file identities", async t => {
  for (const alias of [false,true]) {
    const guide = guideFixture(t), claim = "Verify bandwidth 5";
    guide.spec.plan = claim;
    guide.spec.url = "http://localhost/settings";
    guide.spec.text = "bandwidth 5";
    const name = alias ? "observation.json" : path.basename(guide.input.brief);
    guide.spec.numberChecks = [{claim, observation:guide.spec.text, evidence:name}];
    writeFileSync(guide.input.brief, JSON.stringify(guide.spec));
    if (alias) linkSync(guide.input.brief, path.join(guide.input.orchDir,name));
    await assert.rejects(dispatchGuide(guide), /Unverified running product number/);
  }
});

test("QA criterion declarations preserve exact references across ordering, duplicates, whitespace and case",async t=>{
  const guide=guideFixture(t);
  guide.spec.criteriaSource="criteria.md";
  for(const rows of [["  - AC-11: Alpha","- AC-12: Beta","- AC-11: Twice"],["- AC-12: Beta","- AC-11: Alpha"]]){
    writeFileSync(path.join(guide.input.orchDir,"criteria.md"),rows.join("\n")+"\n- ac-13: Lowercase");
    guide.spec.plan="Verify AC-11 and AC-12";
    writeFileSync(guide.input.brief,JSON.stringify(guide.spec));
    await dispatchGuide(guide);
    guide.spec.plan="Verify AC-13";
    writeFileSync(guide.input.brief,JSON.stringify(guide.spec));
    await assert.rejects(dispatchGuide(guide),/criterion/i);
  }
});

test("QA guide verifies every declaration form against Markdown prose",async t=>{
  const guide=guideFixture(t);
  guide.spec.criteriaSource="criteria.md";
  const fence="`".repeat(3);
  for(const [document,id,live] of [
    ["## Acceptance criteria\n1. First\n- ~~~text\n  sample\n  ~~~\n2. Second","AC-2",true],
    ["## Acceptance criteria\n"+fence+"inline"+fence+"\n1. First","AC-1",true],
    ["## Acceptance criteria\n"+fence+"\n- AC-77: Example\n"+fence,"AC-77",false],
    ["## Acceptance criteria\n"+fence+"\n- [ ] Example\n"+fence,"AC-1",false],
  ]){
    writeFileSync(path.join(guide.input.orchDir,"criteria.md"),document);
    guide.spec.plan="Verify "+id;
    writeFileSync(guide.input.brief,JSON.stringify(guide.spec));
    if(live)await dispatchGuide(guide);else await assert.rejects(dispatchGuide(guide),/criterion/i);
  }
});
