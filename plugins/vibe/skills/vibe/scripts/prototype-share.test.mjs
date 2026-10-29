import assert from "node:assert/strict";
import test from "node:test";
import { createPrototypeShare, newestStatus, previewUrlFor, prototypesDeployment, Status } from "./prototype-share.mjs";

const SHA = "a".repeat(40);
const ok = (stdout = "") => ({ status: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
const bad = (stderr = "boom") => ({ status: 1, stdout: "", stderr });

function router(routes, calls = []) {
  return (command, args, options) => {
    const text = [command, ...args].map((part) => String(part).replace(/^.*\/scripts\//, "")).join(" ");
    calls.push({ line: text, options });
    for (const [matcher, result] of routes) {
      if (text.includes(matcher)) return typeof result === "function" ? result(text) : result;
    }
    return bad(`no route for ${text}`);
  };
}

function clock() {
  let at = 0;
  return { now: () => at, sleep: async (ms) => { at += ms; } };
}

const DEPLOYMENTS = [
  { id: 1, environment: "Preview – app", created_at: "2026-10-29T10:00:00Z" },
  { id: 2, environment: "Preview – prototypes", created_at: "2026-10-29T10:01:00Z" },
  { id: 3, environment: "Preview – prototypes", created_at: "2026-10-29T10:05:00Z" },
  { id: 4, environment: "Production – prototypes", created_at: "2026-10-29T10:09:00Z" },
];

test("the deployment is the newest preview of the prototypes project, never another project or production", () => {
  assert.equal(prototypesDeployment(DEPLOYMENTS).id, 3);
  assert.equal(prototypesDeployment([{ id: 9, environment: "Preview – app" }]), null);
  assert.equal(prototypesDeployment("nope"), null);
  assert.equal(newestStatus([{ state: "success" }, { state: "pending" }]).state, "success");
  assert.equal(newestStatus([]), null);
});

test("the preview URL is the deployment's own https URL with /p/<slug>; credentials, query, fragment or a non-https URL give none", () => {
  assert.equal(previewUrlFor("https://prototypes-abc123.preview.closedloop-stage.ai", "bulk-bar"), "https://prototypes-abc123.preview.closedloop-stage.ai/p/bulk-bar");
  assert.equal(previewUrlFor("https://prototypes-abc123.preview.closedloop-stage.ai/old?x=1", "bulk-bar"), null);
  assert.equal(previewUrlFor("http://prototypes-abc123.preview.closedloop-stage.ai", "bulk-bar"), null);
  assert.equal(previewUrlFor("https://u:p@host.example", "bulk-bar"), null);
  assert.equal(previewUrlFor("not a url", "bulk-bar"), null);
  assert.equal(previewUrlFor(null, "bulk-bar"), null);
});

function shareRoutes({ statuses = [{ state: "success", environment_url: "https://prototypes-abc123.preview.closedloop-stage.ai" }], extra = [] } = {}) {
  return [
    ...extra,
    ["local-plans.mjs", ok({ ok: true, committedLocalPlans: [] })],
    ["main-sync-share", ok({ ok: true, mainSync: { status: "DONE" } })],
    ["main-sync-push", ok({ ok: true, mainSync: { pushed: true } })],
    ["rev-parse HEAD", ok(`${SHA}\n`)],
    ["rev-parse --absolute-git-dir", ok("/gd\n")],
    ["vibe-sessions.mjs show", ok({ ok: true, session: { slug: "bulk-bar" } })],
    ["deployments?sha=", ok(DEPLOYMENTS)],
    ["deployments/3/statuses", ok(statuses)],
    ["prototype-result", ok({ ok: true })],
  ];
}

test("share checks plans, admits, pushes, waits for the exact SHA's deployment and records the immutable URL", async () => {
  const calls = [];
  const written = {};
  const share = createPrototypeShare({ run: router(shareRoutes(), calls), ...clock(), write: (file, text) => { written[file] = text; } });
  const result = await share.share({ worktree: "/wt", stdin: "{\"ctx\":1}" });
  assert.deepEqual(result, { status: Status.Done, previewUrl: "https://prototypes-abc123.preview.closedloop-stage.ai/p/bulk-bar", deployedCommit: SHA, slug: "bulk-bar", deploymentId: 3 });
  const order = ["local-plans.mjs", "main-sync-share", "main-sync-push", "deployments?sha=", "prototype-result"].map((part) => calls.findIndex((call) => call.line.includes(part)));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(calls.find((call) => call.line.includes("main-sync-push")).options.input === "{\"ctx\":1}");
  assert.ok(calls.some((call) => call.line.includes(`deployments?sha=${SHA}`)));
  const recorded = JSON.parse(written["/gd/vibe-prototype-result.json"]);
  assert.equal(recorded.deployedCommit, SHA);
  assert.equal(recorded.slug, "bulk-bar");
  assert.ok(!calls.some((call) => /vercel|--force|commit|stash/.test(call.line.replace(/prototype-result/g, ""))));
});

test("a pending deployment is polled until ready, and a branch alias is never consulted", async () => {
  let reads = 0;
  const routes = shareRoutes({ extra: [["deployments/3/statuses", () => { reads += 1; return ok(reads < 3 ? [{ state: "pending" }] : [{ state: "success", environment_url: "https://prototypes-abc123.preview.closedloop-stage.ai" }]); }]] });
  const calls = [];
  const result = await createPrototypeShare({ run: router(routes, calls), ...clock(), write: () => {} }).share({ worktree: "/wt", pollSeconds: 15 });
  assert.equal(result.status, Status.Done);
  assert.equal(reads, 3);
  assert.ok(!calls.some((call) => call.line.includes("prototypes-git-")));
});

test("an ended deployment stops at once with its state and records nothing", async () => {
  const calls = [];
  const routes = shareRoutes({ statuses: [{ state: "failure" }], extra: [] });
  const result = await createPrototypeShare({ run: router(routes, calls), ...clock(), write: () => {} }).share({ worktree: "/wt" });
  assert.equal(result.status, Status.Blocked);
  assert.equal(result.error, "the deployment ended as failure");
  assert.equal(result.deployedCommit, SHA);
  assert.ok(!calls.some((call) => call.line.includes("prototype-result")));
});

test("the deadline stops the wait, blocked and never done; no deployment at all is the same", async () => {
  const pendingRoutes = shareRoutes({ statuses: [{ state: "in_progress" }] });
  const pending = await createPrototypeShare({ run: router(pendingRoutes), ...clock(), write: () => {} }).share({ worktree: "/wt", pollSeconds: 60, deadlineMinutes: 2 });
  assert.equal(pending.status, Status.Blocked);
  assert.match(pending.error, /deadline passed/);
  const none = await createPrototypeShare({ run: router(shareRoutes({ extra: [["deployments?sha=", ok([])]] })), ...clock(), write: () => {} }).share({ worktree: "/wt", pollSeconds: 60, deadlineMinutes: 1 });
  assert.equal(none.status, Status.Blocked);
  assert.equal(none.reason, "no prototypes deployment for the SHA appeared");
});

test("a committed plan, a refused admission or a refused push stops before anything later runs", async () => {
  const calls = [];
  const plans = await createPrototypeShare({ run: router(shareRoutes({ extra: [["local-plans.mjs", ok({ ok: false, committedLocalPlans: [".closedloop-ai/vibe-plans/a.md"] })]] }), calls), ...clock() }).share({ worktree: "/wt" });
  assert.deepEqual(plans, { status: Status.Blocked, problems: [".closedloop-ai/vibe-plans/a.md"] });
  assert.ok(!calls.some((call) => call.line.includes("main-sync")));
  const admission = await createPrototypeShare({ run: router(shareRoutes({ extra: [["main-sync-share", ok({ ok: false, status: "NEEDS_COMMIT", error: "uncommitted" })]] })), ...clock() }).share({ worktree: "/wt" });
  assert.equal(admission.status, "NEEDS_COMMIT");
  const pushCalls = [];
  const push = await createPrototypeShare({ run: router(shareRoutes({ extra: [["main-sync-push", ok({ ok: false, error: "hook failed" })]] }), pushCalls), ...clock() }).share({ worktree: "/wt" });
  assert.equal(push.status, Status.Blocked);
  assert.ok(!pushCalls.some((call) => call.line.includes("deployments")));
});

test("an already published result is a true no-op: nothing is pushed or recorded", async () => {
  const calls = [];
  const routes = shareRoutes({ extra: [["main-sync-share", ok({ ok: true, mainSync: { alreadyPublished: true } })]] });
  const result = await createPrototypeShare({ run: router(routes, calls), ...clock() }).share({ worktree: "/wt" });
  assert.deepEqual(result, { status: Status.Done, alreadyPublished: true, pushed: false, requested: false });
  assert.ok(!calls.some((call) => call.line.includes("main-sync-push") || call.line.includes("deployments")));
});

test("a record the session script refuses is BLOCKED with the URL it refused, not reported as shared", async () => {
  const routes = shareRoutes({ extra: [["prototype-result", ok({ ok: false, error: "alias is not allowed" })]] });
  const result = await createPrototypeShare({ run: router(routes), ...clock(), write: () => {} }).share({ worktree: "/wt" });
  assert.equal(result.status, Status.Blocked);
  assert.equal(result.error, "alias is not allowed");
});

test("a read failure from GitHub is BLOCKED naming the read, not retried into a pass", async () => {
  const routes = shareRoutes({ extra: [["deployments?sha=", bad("HTTP 502")]] });
  const result = await createPrototypeShare({ run: router(routes), ...clock() }).share({ worktree: "/wt" });
  assert.equal(result.status, Status.Blocked);
  assert.equal(result.error, "reading deployments failed");
  assert.equal(result.detail, "HTTP 502");
});
