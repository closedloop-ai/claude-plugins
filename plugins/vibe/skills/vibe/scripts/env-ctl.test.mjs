import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvCtl, extractFailure, NO_ANALYTICS_KEY, NOT_CONFIRMED_READY, parseWorkflowInputs, runForRequest, Status, uncommittedDeliverables,
} from "./env-ctl.mjs";

const YAML = `name: dispatch
on:
  workflow_dispatch:
    inputs:
      branch:
        description: b
        required: true
      mode:
        required: true
        default: seeded
      keep_flag_snapshot:
        required: false
        type: string
      request_id:
        required: true
jobs:
  x:
    runs-on: ubuntu-latest
`;
const ok = (stdout = "") => ({ status: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
const bad = (stderr = "boom") => ({ status: 1, stdout: "", stderr });

/** A command router: `routes` maps a matcher over the joined command line to a result or a function of the call. */
function router(routes, calls = []) {
  return (command, args, options) => {
    const line = [command, ...args].map((part) => String(part).replace(/^.*\/scripts\//, "")).join(" ");
    calls.push({ line, options });
    for (const [matcher, result] of routes) {
      if (line.includes(matcher)) return typeof result === "function" ? result(line, options) : result;
    }
    return bad(`no route for ${line}`);
  };
}

function clock() {
  let at = 0;
  return { now: () => at, sleep: async (ms) => { at += ms; } };
}

test("workflow inputs: names, and only inputs that are required without a default", () => {
  const { declared, required } = parseWorkflowInputs(YAML);
  assert.deepEqual([...declared], ["branch", "mode", "keep_flag_snapshot", "request_id"]);
  assert.deepEqual([...required].sort(), ["branch", "request_id"]);
  assert.deepEqual(parseWorkflowInputs("on: push\n"), { declared: new Set(), required: new Set() });
});

test("a failed job's log yields its error lines, the refusal and the orgs the worker's steps read", () => {
  const log = [
    "2026-10-29T10:00:00.1Z org: Acme (org_1)",
    "2026-10-29T10:00:01.1Z clerk_org_refusal=clerk_org_ambiguous",
    `2026-10-29T10:00:02.1Z clerk_orgs_json=[{"id":"org_1","name":"Acme","isAdmin":true}]`,
    "2026-10-29T10:00:03.1Z ##[error]Process completed with exit code 1.",
  ].join("\n");
  const failure = extractFailure(log);
  assert.deepEqual(failure.errors, ["Process completed with exit code 1."]);
  assert.equal(failure.refusal, "clerk_org_ambiguous");
  assert.deepEqual(failure.orgs, [{ id: "org_1", name: "Acme", isAdmin: true }]);
  assert.deepEqual(failure.orgLines, ["org: Acme (org_1)"]);
});

test("a run is found by the request id in its title, never by position", () => {
  const runs = [{ displayTitle: "Vibe environment vibe/a (req-1)", databaseId: 1 }, { displayTitle: "Vibe environment vibe/a (req-2)", databaseId: 2 }];
  assert.equal(runForRequest(runs, "req-2").databaseId, 2);
  assert.equal(runForRequest(runs, "req-3"), null);
  assert.equal(runForRequest("not a list", "req-1"), null);
});

test("uncommitted deliverables leave out local fixes and the files a commit never takes", () => {
  const porcelain = " M apps/app/a.tsx\n?? .env.local\n?? .control/x.png\n M packages/fix.ts\n?? .closedloop-ai/vibe-plans/p.md\n";
  assert.deepEqual(uncommittedDeliverables(porcelain, ["packages/fix.ts"]), ["apps/app/a.tsx"]);
});

test("flags saves the evaluated flags and never prints the key", async () => {
  const calls = [];
  const written = {};
  const ctl = createEnvCtl({
    run: router([
      ["vibe-sessions.mjs repo", ok({ ok: true, repo: "/r" })],
      ["posthog-key.mjs", ok({ ok: true, key: "phc_secretsecretsecretsecret", host: "https://us.i.posthog.com" })],
      ["rev-parse --absolute-git-dir", ok("/gd\n")],
      ["flag-snapshot", ok({ ok: true })],
    ], calls),
    fetchFn: async (url, init) => {
      assert.equal(url, "https://us.i.posthog.com/flags?v=2");
      assert.equal(JSON.parse(init.body).distinct_id, "user_1");
      return { ok: true, json: async () => ({ flags: { a: { enabled: true }, b: { enabled: true, variant: "test" }, c: { enabled: false } } }) };
    },
    write: (file, text) => { written[file] = text; },
    now: () => 0,
  });
  const result = await ctl.flags({ worktree: "/wt", distinctId: "user_1", orgId: "org_1", replace: true });
  assert.deepEqual(result, { status: Status.Done, flagCount: 3, replaced: true });
  assert.ok(!JSON.stringify(result).includes("phc_"));
  const snapshot = JSON.parse(written["/gd/vibe-flag-snapshot.new.json"]);
  assert.deepEqual(snapshot.flags, { a: true, b: "test", c: false });
  assert.ok(calls.some((call) => call.line.includes("flag-snapshot") && call.line.includes("--replace")));
});

test("flags without a key returns the worker's own sentence and the error for engineering", async () => {
  const ctl = createEnvCtl({ run: router([["vibe-sessions.mjs repo", ok({ repo: "/r" })], ["posthog-key.mjs", ok({ ok: false, error: "offline" })]]) });
  const result = await ctl.flags({ worktree: "/wt", distinctId: "u", orgId: "o" });
  assert.equal(result.status, Status.Blocked);
  assert.equal(result.message, NO_ANALYTICS_KEY);
  assert.equal(result.error, "offline");
});

function requestRoutes({ envView, requestView = { status: "completed", conclusion: "success", jobs: [] }, extra = [] }) {
  return [
    ...extra,
    ["workflow view", ok(YAML)],
    ["rev-parse --absolute-git-dir", ok("/gd\n")],
    ["dispatch-inputs", ok({ ok: true, workflow: "vibe-environment-dispatch.yml", ref: "main", requestId: "req-9", inputNames: ["branch", "mode", "request_id", "keep_flag_snapshot"] })],
    ["workflow run", ok("")],
    ["run list --repo closedloop-ai/symphony-alpha --workflow vibe-environment-dispatch.yml", ok([{ displayTitle: "Vibe environment vibe/a (req-9)", databaseId: 11 }])],
    ["run list --repo closedloop-ai/symphony-alpha --workflow vibe-environment.yml", ok([{ displayTitle: "Vibe environment vibe/a (req-9)", databaseId: 22 }])],
    ["run view 11", ok(requestView)],
    ["run view 22", ok(envView)],
    ["run download", ok("")],
    ["environment-result", ok({ ok: true, appUrl: "https://app.example", headSha: "a".repeat(40) })],
  ];
}

test("request follows both runs to success and records the verified result", async () => {
  const calls = [];
  const time = clock();
  const ctl = createEnvCtl({ run: router(requestRoutes({ envView: { status: "completed", conclusion: "success", jobs: [] } }), calls), ...time, read: () => "{\"branch\":\"vibe/a\"}" });
  const result = await ctl.request({ worktree: "/wt", mode: "create", personEmail: "p@example.com" });
  assert.equal(result.status, Status.Done);
  assert.equal(result.appUrl, "https://app.example");
  const dispatch = calls.find((call) => call.line.includes("dispatch-inputs")).line;
  assert.match(dispatch, /--keep-flag-snapshot true/);
  assert.match(dispatch, /--person-email p@example.com/);
  const started = calls.find((call) => call.line.includes("workflow run"));
  assert.equal(started.options.input, "{\"branch\":\"vibe/a\"}");
  assert.ok(calls.findIndex((call) => call.line.includes("run view 11")) < calls.findIndex((call) => call.line.includes("run view 22")));
});

test("flags mode asks the request workflow not to keep the snapshot", async () => {
  const calls = [];
  const ctl = createEnvCtl({ run: router(requestRoutes({ envView: { status: "completed", conclusion: "success", jobs: [] } }), calls), ...clock(), read: () => "{}" });
  await ctl.request({ worktree: "/wt", mode: "flags" });
  assert.match(calls.find((call) => call.line.includes("dispatch-inputs")).line, /--keep-flag-snapshot false/);
});

test("a failed job stops the follow at once and an org refusal goes to the worker as evidence, with no words written", async () => {
  const jobs = [{ name: "seed", databaseId: 77, status: "completed", conclusion: "failure" }, { name: "later", databaseId: 78, status: "in_progress" }];
  const log = "clerk_org_refusal=clerk_org_ambiguous\nclerk_orgs_json=[{\"id\":\"org_1\",\"name\":\"A\",\"isAdmin\":true}]\n##[error]refused";
  const ctl = createEnvCtl({
    run: router(requestRoutes({ envView: { status: "in_progress", jobs }, extra: [["jobs/77/logs", ok(log)]] })),
    ...clock(), read: () => "{}",
  });
  const result = await ctl.request({ worktree: "/wt", mode: "create" });
  assert.equal(result.status, Status.NeedsAgent);
  assert.equal(result.reason, "org-or-identity-refusal");
  assert.equal(result.refusal, "clerk_org_ambiguous");
  assert.equal(result.orgs[0].id, "org_1");
  assert.equal(result.job, "seed");
  assert.equal(result.message, undefined);
});

test("a failed job with no org evidence is BLOCKED with its error lines", async () => {
  const jobs = [{ name: "build", databaseId: 5, status: "completed", conclusion: "timed_out" }];
  const ctl = createEnvCtl({ run: router(requestRoutes({ envView: { status: "in_progress", jobs }, extra: [["jobs/5/logs", ok("##[error]Build failed")]] })), ...clock(), read: () => "{}" });
  const result = await ctl.request({ worktree: "/wt", mode: "create" });
  assert.equal(result.status, Status.Blocked);
  assert.deepEqual(result.errors, ["Build failed"]);
});

test("a run still going at the limit is BLOCKED naming the job, never DONE", async () => {
  const jobs = [{ name: "deploy-app", status: "in_progress" }];
  const ctl = createEnvCtl({ run: router(requestRoutes({ envView: { status: "in_progress", jobs } })), ...clock(), read: () => "{}" });
  const result = await ctl.request({ worktree: "/wt", mode: "create", giveUpSeconds: 60, pollSeconds: 15 });
  assert.equal(result.status, Status.Blocked);
  assert.deepEqual(result.stillRunning, ["deploy-app"]);
});

test("a run that never appears is BLOCKED after the find window", async () => {
  const routes = requestRoutes({ envView: {} }).map(([matcher, result]) => matcher.includes("--workflow vibe-environment-dispatch.yml") ? [matcher, ok([])] : [matcher, result]);
  const ctl = createEnvCtl({ run: router(routes), ...clock(), read: () => "{}" });
  const result = await ctl.request({ worktree: "/wt", mode: "create", findSeconds: 30, pollSeconds: 10 });
  assert.equal(result.status, Status.Blocked);
  assert.equal(result.error, "The request run did not appear.");
});

test("a missing result artifact or a refused record is BLOCKED with the worker's sentence and never a URL", async () => {
  const noArtifact = requestRoutes({ envView: { status: "completed", conclusion: "success", jobs: [] } }).map(([m, r]) => m === "run download" ? [m, bad("no artifact")] : [m, r]);
  const first = await createEnvCtl({ run: router(noArtifact), ...clock(), read: () => "{}" }).request({ worktree: "/wt", mode: "create" });
  assert.equal(first.status, Status.Blocked);
  assert.equal(first.message, NOT_CONFIRMED_READY);
  assert.equal(first.appUrl, undefined);
  const refused = requestRoutes({ envView: { status: "completed", conclusion: "success", jobs: [] } }).map(([m, r]) => m === "environment-result" ? [m, ok({ ok: false, error: "headSha mismatch" })] : [m, r]);
  const second = await createEnvCtl({ run: router(refused), ...clock(), read: () => "{}" }).request({ worktree: "/wt", mode: "create" });
  assert.equal(second.message, NOT_CONFIRMED_READY);
  assert.equal(second.error, "headSha mismatch");
});

test("a workflow input the session never sends is BLOCKED before anything starts", async () => {
  const calls = [];
  const routes = requestRoutes({ envView: {} }).map(([m, r]) => m === "dispatch-inputs" ? [m, ok({ ok: true, workflow: "w.yml", requestId: "r", inputNames: ["branch"] })] : [m, r]);
  const result = await createEnvCtl({ run: router(routes, calls), ...clock(), read: () => "{}" }).request({ worktree: "/wt", mode: "create" });
  assert.equal(result.status, Status.Blocked);
  assert.match(result.error, /request_id/);
  assert.ok(!calls.some((call) => call.line.includes("workflow run")));
});

test("an already published head makes no request", async () => {
  const calls = [];
  const routes = requestRoutes({ envView: {} }).map(([m, r]) => m === "dispatch-inputs" ? [m, ok({ ok: true, mainSync: { status: "DONE", alreadyPublished: true, pushed: false } })] : [m, r]);
  const result = await createEnvCtl({ run: router(routes, calls), ...clock() }).request({ worktree: "/wt", mode: "redeploy" });
  assert.equal(result.status, "DONE");
  assert.equal(result.requested, false);
  assert.ok(!calls.some((call) => call.line.includes("workflow run")));
});

function publishRoutes(overrides = {}) {
  return [
    ["vibe-sessions.mjs show", ok({ ok: true, session: { baseCommit: "b".repeat(40), localFixes: [{ path: "fix.ts" }], vercel: {} } })],
    ["local-plans.mjs", overrides.plans ?? ok({ ok: true, committedLocalPlans: [] })],
    ["migration-publish.mjs", overrides.migrations ?? ok({ ok: true, problems: [] })],
    ["status --porcelain", overrides.status ?? ok(" M fix.ts\n")],
    ["main-sync-push", overrides.push ?? ok({ ok: true, mainSync: { pushed: true } })],
  ];
}

test("publish stops on a committed plan, an unsafe migration or an uncommitted file, and pushes nothing", () => {
  const calls = [];
  const plans = createEnvCtl({ run: router(publishRoutes({ plans: ok({ ok: false, committedLocalPlans: [".closedloop-ai/vibe-plans/a.md"] }) }), calls) }).publish({ worktree: "/wt" });
  assert.equal(plans.status, Status.Blocked);
  assert.deepEqual(plans.problems, [".closedloop-ai/vibe-plans/a.md"]);
  const migrations = createEnvCtl({ run: router(publishRoutes({ migrations: ok({ ok: false, problems: ["no test"] }) }), calls) }).publish({ worktree: "/wt" });
  assert.deepEqual(migrations.problems, ["no test"]);
  const dirty = createEnvCtl({ run: router(publishRoutes({ status: ok(" M apps/app/a.tsx\n") }), calls) }).publish({ worktree: "/wt" });
  assert.equal(dirty.status, Status.NeedsCommit);
  assert.deepEqual(dirty.files, ["apps/app/a.tsx"]);
  assert.ok(!calls.some((call) => call.line.includes("main-sync-push")));
});

test("publish passes the parent context on stdin and forwards a refusal's own status", () => {
  const calls = [];
  const clean = createEnvCtl({ run: router(publishRoutes(), calls) }).publish({ worktree: "/wt", stdin: "{\"ctx\":1}" });
  assert.equal(clean.status, Status.Done);
  assert.equal(clean.pushed, true);
  assert.equal(calls.find((call) => call.line.includes("main-sync-push")).options.input, "{\"ctx\":1}");
  const refused = createEnvCtl({ run: router(publishRoutes({ push: ok({ ok: false, status: "NEEDS_DESKTOP_STOP", error: "desktop running" }) })) }).publish({ worktree: "/wt" });
  assert.equal(refused.status, "NEEDS_DESKTOP_STOP");
});

test("an already published head is reported as such and redeploy then requests nothing", async () => {
  const routes = publishRoutes({ push: ok({ ok: true, mainSync: { alreadyPublished: true, pushed: false } }) });
  const published = createEnvCtl({ run: router(routes) }).publish({ worktree: "/wt" });
  assert.deepEqual([published.alreadyPublished, published.pushed], [true, false]);
  const result = await createEnvCtl({ run: router(routes), ...clock() }).redeploy({ worktree: "/wt" });
  assert.equal(result.requested, false);
  assert.equal(result.alreadyPublished, true);
});

test("redeploy with no environment stops after the push", async () => {
  const result = await createEnvCtl({ run: router(publishRoutes()), ...clock() }).redeploy({ worktree: "/wt" });
  assert.equal(result.status, Status.Done);
  assert.equal(result.requested, false);
  assert.equal(result.progress, "pushed");
});

test("the pull request is opened only when origin is at the verified commit, and an open one is reused", () => {
  const sha = "c".repeat(40);
  const base = [["ls-remote", ok(`${sha}\trefs/heads/vibe/a\n`)]];
  const stale = createEnvCtl({ run: router([["ls-remote", ok(`${"d".repeat(40)}\trefs/heads/vibe/a`)]]) });
  assert.equal(stale.openPullRequest({ worktree: "/wt", branch: "vibe/a", commit: sha }).status, Status.Blocked);
  const reuse = createEnvCtl({ run: router([...base, ["pr list", ok([{ url: "https://github.com/x/pull/3", number: 3 }])]]) });
  assert.deepEqual(reuse.openPullRequest({ worktree: "/wt", branch: "vibe/a", commit: sha }), { status: Status.Done, created: false, url: "https://github.com/x/pull/3", number: 3 });
  const calls = [];
  const create = createEnvCtl({ run: router([...base, ["pr list", ok([])], ["pr-preflight.mjs", ok({ ok: true, problems: [] })], ["pr create", ok("https://github.com/x/pull/4\n")]], calls) });
  const made = create.openPullRequest({ worktree: "/wt", branch: "vibe/a", commit: sha, title: "ISS-1: Do it", bodyFile: "/b.md", base: "e".repeat(40) });
  assert.deepEqual(made, { status: Status.Done, created: true, url: "https://github.com/x/pull/4" });
  assert.ok(!calls.some((call) => call.line.includes("--draft") || call.line.includes("merge")));
});

test("a title or body the preflight refuses opens nothing", () => {
  const sha = "c".repeat(40);
  const calls = [];
  const ctl = createEnvCtl({ run: router([["ls-remote", ok(`${sha}\trefs/heads/vibe/a`)], ["pr list", ok([])], ["pr-preflight.mjs", ok({ ok: false, problems: ["title is 80 characters"] })]], calls) });
  const result = ctl.openPullRequest({ worktree: "/wt", branch: "vibe/a", commit: sha, title: "t", bodyFile: "/b", base: sha });
  assert.deepEqual(result, { status: Status.Blocked, problems: ["title is 80 characters"] });
  assert.ok(!calls.some((call) => call.line.includes("pr create")));
});
