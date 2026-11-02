import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createEnvCtl, MAIN_SYNC_CONTEXT_MISSING, mainSyncContextProblem, Status } from "./env-ctl.mjs";
import { execCommand } from "./ws3-exec.mjs";
import { gitEnv, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS = path.join(HERE, "vibe-sessions.mjs");
const WRITER_STATE = path.join(HERE, "dist", "writer-state.mjs");
const PLUGIN_ROOT = path.resolve(HERE, "../../..");

/**
 * A genuine launcher context for a real throwaway session, built the way the main-sync tests build theirs
 * (test-fixtures.mjs, mainSyncAdmission): a real writer-state record lease, never a hand-written lease.
 */
function realContext(t) {
  const fixture = makeHome("env-ctl-context-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, "Documents", "Active Work", "symphony-alpha");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout, files: { "apps/app/page.tsx": "export const page = 1;\n" } });
  const created = runNode(SESSIONS, ["new", "--repo", checkout, "--slug", "ctx", "--summary", "ctx", "--mode", "seeded", "--operator-id", "user-operator", "--operator-email", "operator@example.com"], fixture.home);
  assert.equal(created.status, 0, created.stderr);
  const worktree = created.json.session.worktree;
  const grant = { worktree, agentRoot: PLUGIN_ROOT, agentName: "vibe-environment-worker", workerId: "env-worker-1", requestId: "env-request-1", mode: "record", recordAction: "create", exclusiveRecordTurn: true };
  const acquired = runNode(WRITER_STATE, ["acquire-record"], fixture.home, {}, grant);
  assert.equal(acquired.status, 0, acquired.stderr);
  const context = {
    runtime: "codex", worktree, agentName: grant.agentName, workerId: grant.workerId, requestId: grant.requestId,
    mode: "record", recordAction: "create", lease: acquired.json.lease,
  };
  return { context, worktree, home: fixture.home };
}

/** An envelope with the launcher's own key order and whitespace; `unknown` adds a field env-ctl has no business knowing. */
function envelope(context, { unknown = true } = {}) {
  const extra = unknown ? `  "futureField": { "kept": [1, 2,   3] },\n  "transactionId": "tx-parent-issued",\n` : "";
  return `{\n${extra}  "context": ${JSON.stringify(context, null, 3)}\n}\n`;
}

const ok = (stdout = "") => ({ status: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });

/** A recording runner with canned answers; `inputs(matcher)` lists the stdin each matching call received. */
function recorder(routes) {
  const calls = [];
  const run = (command, args, options = {}) => {
    const line = [command === process.execPath ? "node" : command, ...args].map((part) => String(part).replace(/^.*\/scripts\//, "")).join(" ");
    calls.push({ line, input: options.input });
    for (const [matcher, result] of routes) if (line.includes(matcher)) return typeof result === "function" ? result(line) : result;
    return { status: 1, stdout: "", stderr: `no route for ${line}` };
  };
  return { run, calls, inputs: (matcher) => calls.filter((call) => call.line.includes(matcher)).map((call) => call.input) };
}

const YAML = "on:\n  workflow_dispatch:\n    inputs:\n      branch:\n        required: true\n";
const clock = () => { let at = 0; return { now: () => at, sleep: async (ms) => { at += ms; } }; };

function routesFor({ push = ok({ ok: true, mainSync: { pushed: true } }), dispatch } = {}) {
  return [
    ["vibe-sessions.mjs show", ok({ ok: true, session: { baseCommit: "b".repeat(40), lastRequestId: "req-1", vercel: { mode: "seeded" } } })],
    ["local-plans.mjs", ok({ ok: true, committedLocalPlans: [] })],
    ["migration-publish.mjs", ok({ ok: true, problems: [] })],
    ["status --porcelain", ok("")],
    ["main-sync-push", push],
    ["rev-parse --absolute-git-dir", ok("/gd\n")],
    ["workflow view", ok(YAML)],
    ["dispatch-inputs", dispatch ?? ok({ ok: false, status: "NEEDS_CHANGE", error: "stop here" })],
  ];
}

test("publish hands main-sync-push the exact stdin bytes: key order, whitespace and unknown fields intact", (t) => {
  const { context } = realContext(t);
  const bytes = envelope(context);
  const rec = recorder(routesFor());
  const result = createEnvCtl({ run: rec.run }).publish({ worktree: "/wt", stdin: bytes });
  assert.equal(result.status, Status.Done);
  assert.deepEqual(rec.inputs("main-sync-push"), [bytes]);
  assert.ok(Buffer.from(rec.inputs("main-sync-push")[0]).equals(Buffer.from(bytes)));
});

test("request hands dispatch-inputs the same exact bytes", async (t) => {
  const { context } = realContext(t);
  const bytes = envelope(context);
  const rec = recorder(routesFor());
  const result = await createEnvCtl({ run: rec.run, ...clock() }).request({ worktree: "/wt", mode: "redeploy", stdin: bytes });
  assert.equal(result.status, "NEEDS_CHANGE");
  assert.deepEqual(rec.inputs("dispatch-inputs"), [bytes]);
});

test("redeploy hands the same bytes to main-sync-push and then to dispatch-inputs, in that order", async (t) => {
  const { context } = realContext(t);
  const bytes = envelope(context);
  const rec = recorder(routesFor());
  await createEnvCtl({ run: rec.run, ...clock() }).redeploy({ worktree: "/wt", stdin: bytes });
  const order = rec.calls.filter((call) => call.input !== undefined).map((call) => call.line.split(" ")[2]);
  assert.deepEqual(order, ["main-sync-push", "dispatch-inputs"]);
  assert.ok(rec.calls.filter((call) => call.input !== undefined).every((call) => call.input === bytes));
});

test("a context with one field altered is forwarded untouched and the real main-sync refusal names the field", (t) => {
  const { context, worktree, home } = realContext(t);
  const run = (command, args, options = {}) => execCommand(command, args, { ...options, env: gitEnv(home) });
  const seen = [];
  const spy = (command, args, options = {}) => {
    if (args.some((arg) => String(arg).endsWith("vibe-sessions.mjs")) && args.includes("main-sync-push")) seen.push(options.input);
    return run(command, args, options);
  };
  const genuine = envelope(context, { unknown: false });
  const valid = createEnvCtl({ run: spy }).publish({ worktree, stdin: genuine });
  // A genuine context is accepted by main-sync as the right grant; the session simply has no fresh transaction yet.
  assert.equal(valid.status, "NEEDS_CHANGE", JSON.stringify(valid));
  assert.match(valid.error, /no fresh main-sync transaction/);
  const altered = envelope({ ...context, workerId: "env-worker-2" }, { unknown: false });
  const refused = createEnvCtl({ run: spy }).publish({ worktree, stdin: altered });
  assert.equal(refused.status, Status.Blocked);
  assert.match(refused.error, /differs: workerId/);
  assert.match(refused.error, /never a rebuilt one/);
  // An unknown field is not stripped by env-ctl either: main-sync refuses it, and env-ctl surfaces that refusal.
  const unknown = envelope(context);
  const strict = createEnvCtl({ run: spy }).publish({ worktree, stdin: unknown });
  assert.equal(strict.status, Status.Blocked);
  assert.match(strict.error, /unrecognized_keys/);
  assert.deepEqual(seen, [genuine, altered, unknown]);
});

test("missing or invalid parent context is BLOCKED with evidence for the agent, and nothing runs", async () => {
  for (const stdin of [undefined, "", "   \n", "not json", "[]", "{}", "{\"context\":\"text\"}", "{\"context\":null}", "{\"context\":[1]}"]) {
    const rec = recorder(routesFor());
    const ctl = createEnvCtl({ run: rec.run, ...clock() });
    const results = [ctl.publish({ worktree: "/wt", stdin }), await ctl.request({ worktree: "/wt", mode: "create", stdin }), await ctl.redeploy({ worktree: "/wt", stdin })];
    for (const result of results) {
      assert.equal(result.status, Status.Blocked, JSON.stringify(stdin));
      assert.equal(result.code, "MAIN_SYNC_CONTEXT_MISSING");
      assert.equal(result.error, MAIN_SYNC_CONTEXT_MISSING);
    }
    assert.deepEqual(rec.calls, [], JSON.stringify(stdin));
  }
  assert.match(MAIN_SYNC_CONTEXT_MISSING, /^The parent-issued main-sync context is missing or invalid/);
  assert.equal(mainSyncContextProblem("{\"context\":{}}"), null);
});

test("recordResult downloads the artifact and records it with the arguments environment.md requires", () => {
  const rec = recorder([
    ["rev-parse --absolute-git-dir", ok("/gd\n")],
    ["run download", ok("")],
    ["environment-result", ok({ ok: true, appUrl: "https://app.example", apiUrl: "https://api.example", storybookUrl: "https://sb.example", headSha: "a".repeat(40) })],
  ]);
  const result = createEnvCtl({ run: rec.run }).recordResult({ worktree: "/wt", runId: 22, requestId: "req-9" });
  assert.deepEqual(rec.calls.map((call) => call.line), [
    "git -C /wt rev-parse --absolute-git-dir",
    "gh run download 22 --repo closedloop-ai/symphony-alpha -n vibe-environment-result -D /gd/vibe-environment-result",
    "node vibe-sessions.mjs environment-result --worktree /wt --file /gd/vibe-environment-result/vibe-environment-result.json --request-id req-9",
  ]);
  assert.equal(result.status, Status.Done);
  assert.equal(result.requestId, "req-9");
  assert.equal(result.runId, 22);
  assert.equal(result.appUrl, "https://app.example");
  assert.ok(!("ok" in result));
});

test("no context or lease value ever appears in the status env-ctl returns", async (t) => {
  const { context, worktree, home } = realContext(t);
  const values = Object.values(context).filter((value) => typeof value === "string" && value.length > 3 && value !== worktree);
  assert.ok(values.includes(context.lease));
  const guard = (result) => {
    const text = JSON.stringify(result);
    for (const value of [...values, "tx-parent-issued"]) assert.ok(!text.includes(value), `${value} leaked into ${text.slice(0, 200)}`);
  };
  const bytes = envelope(context);
  const fake = recorder(routesFor());
  const ctl = createEnvCtl({ run: fake.run, ...clock() });
  guard(ctl.publish({ worktree: "/wt", stdin: bytes }));
  guard(await ctl.request({ worktree: "/wt", mode: "create", stdin: bytes }));
  guard(await ctl.redeploy({ worktree: "/wt", stdin: bytes }));
  const real = (command, args, options = {}) => execCommand(command, args, { ...options, env: gitEnv(home) });
  guard(createEnvCtl({ run: real }).publish({ worktree, stdin: bytes }));
  guard(createEnvCtl({ run: real }).publish({ worktree, stdin: envelope({ ...context, lease: "a-different-lease" }) }));
});
