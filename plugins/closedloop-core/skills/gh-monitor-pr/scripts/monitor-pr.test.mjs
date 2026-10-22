import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appServerAttempt,
  buildCommentMonitoring,
  buildInitialMaterialState,
  buildReregistrationDelta,
  buildMonitorHandoff,
  claimMonitorTransfer,
  evaluateMonitorPoll,
  evaluateSnapshot,
  evaluateUnsettledSnapshot,
  fetchAuthenticatedLogin,
  materialEvents,
  normalizeMonitorState,
  NOTIFICATION_DELIVERY_WAIT_SECONDS,
  parseArgs,
  parseOwnerMetadata,
  parsePrUrl,
  recoverSameOwner,
  runNotifierProbe,
  SNAPSHOT_EXIT_CODES,
  snapshotVerdict,
  stallEvent,
  summarizeSnapshot,
  takeSnapshot,
  validateReplacementLineage,
  verifyStoppedMonitor,
} from "./monitor-pr.mjs";

test("notifier probe honors the child RPC lifecycle beyond the former synchronous timeout boundary", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gh-monitor-probe-timeout-")));
  const helper = join(root, "delayed-probe.mjs");
  writeFileSync(helper, `
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    result: "probed",
    transport: "proxy",
    threadStatus: "active",
    activeTurnId: "turn-active",
  }) + "\\n");
}, 75);
`);
  try {
    const formerBoundary = spawnSync(process.execPath, [helper], {
      encoding: "utf8",
      timeout: 25,
    });
    assert.equal(formerBoundary.error?.code, "ETIMEDOUT");

    const probe = await runNotifierProbe(
      { node: process.execPath, transport: "proxy", env: process.env },
      { socket: join(root, "unused.sock"), executable: join(root, "unused-codex") },
      "thread-exact",
      { helper },
    );
    assert.deepEqual(probe, {
      result: "probed",
      transport: "proxy",
      threadStatus: "active",
      activeTurnId: "turn-active",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("monitor event delivery allows a large root thread to resume before timing out", () => {
  assert.ok(NOTIFICATION_DELIVERY_WAIT_SECONDS > 60);
});

test("notifier probe still fails closed on invalid child output", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gh-monitor-probe-invalid-")));
  const helper = join(root, "invalid-probe.mjs");
  writeFileSync(helper, "process.stdout.write('not-json\\n');\n");
  try {
    await assert.rejects(runNotifierProbe(
      { node: process.execPath, transport: "proxy", env: process.env },
      { socket: join(root, "unused.sock"), executable: join(root, "unused-codex") },
      "thread-exact",
      { helper },
    ), /returned invalid output/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshot(overrides = {}) {
  const { core: coreOverrides = {}, ...snapshotOverrides } = overrides;
  return {
    observedAt: "2026-08-11T20:00:00Z",
    checkSha: "abc",
    comments: [],
    reviewThreads: [],
    checks: [{ kind: "check_run", name: "test", status: "COMPLETED", conclusion: "SUCCESS", url: null }],
    core: {
      state: "OPEN",
      merged: false,
      mergedAt: null,
      isDraft: false,
      headRefOid: "abc",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      mergeQueueEntry: null,
      ...coreOverrides,
    },
    ...snapshotOverrides,
  };
}

function reviewThread(overrides = {}) {
  const comments = overrides.comments ?? [{
    id: "10",
    author: "reviewer",
    body: "please address this",
    createdAt: "2026-08-11T19:30:00Z",
    url: "https://github.com/openai/codex/pull/123#discussion_r10",
  }];
  return {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    path: "src/example.ts",
    line: 42,
    startLine: null,
    comments,
    commentIds: comments.map((comment) => comment.id),
    commentsTotalCount: comments.length,
    commentsTruncated: false,
    url: comments.find((comment) => comment.url)?.url ?? null,
    ...overrides,
  };
}

function state(overrides = {}) {
  return { seenCommentIds: ["1"], wasQueued: false, ...overrides };
}

test("parses canonical PR URLs", () => {
  assert.deepEqual(parsePrUrl("https://github.com/openai/codex/pull/123/files"), {
    host: "github.com", owner: "openai", repo: "codex", number: 123,
    url: "https://github.com/openai/codex/pull/123",
  });
});

test("parses the self-comment opt-in as a boolean CLI switch", () => {
  assert.deepEqual(parseArgs([
    "start",
    "https://github.com/openai/codex/pull/123",
    "--include-self-comments",
    "--interval", "20",
  ]), {
    command: "start",
    positional: ["https://github.com/openai/codex/pull/123"],
    options: { "include-self-comments": true, interval: "20" },
  });
});

test("resolves and validates the authenticated gh login", () => {
  let observed;
  assert.equal(fetchAuthenticatedLogin("github.example.com", (args, host) => {
    observed = { args, host };
    return { login: " worker-login " };
  }), "worker-login");
  assert.deepEqual(observed, { args: ["user"], host: "github.example.com" });
  assert.throws(
    () => fetchAuthenticatedLogin("github.com", () => ({})),
    /did not return the authenticated login/,
  );
  assert.throws(
    () => fetchAuthenticatedLogin("github.com", () => { throw new Error("auth unavailable"); }),
    /auth unavailable/,
  );
});

test("self-comment opt-in is explicit and survives monitor recovery or transfer", () => {
  assert.deepEqual(buildCommentMonitoring({}, "Worker-Login"), {
    schema: "GH_MONITOR_PR_COMMENT_MONITORING v1",
    authenticatedLogin: "Worker-Login",
    includeSelfComments: false,
  });
  assert.equal(buildCommentMonitoring({ "include-self-comments": true }, "worker-login")
    .includeSelfComments, true);
  assert.equal(buildCommentMonitoring({}, "new-login", {
    commentMonitoring: { includeSelfComments: true },
  }).includeSelfComments, true);
});

test("black box: CLI dispatch reaches recover-same-owner", () => {
  const result = spawnSync(process.execPath, [
    new URL("./monitor-pr.mjs", import.meta.url).pathname,
    "recover-same-owner",
    "https://github.com/openai/codex/pull/123",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /recover-same-owner requires --state-file/);
});

test("same-owner recovery fails closed on acknowledgement and preserves delivery history", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gh-monitor-recovery-")));
  const stateFile = join(root, "monitor.json");
  const head = "a".repeat(40);
  const pr = parsePrUrl("https://github.com/openai/codex/pull/123");
  const delivered = {
    eventId: "delivered-event",
    kind: "ready_to_merge",
    severity: "success",
    details: {},
  };
  const previousRecovery = { schema: "GH_MONITOR_PR_SAME_OWNER_RECOVERY v1", recoveryId: "prior" };
  const legacyOwnerBindingRepair = {
    schema: "GH_MONITOR_PR_LEGACY_BINDING_REPAIR v1",
    repairId: "binding-repair-1",
  };
  const previousState = {
    version: 4,
    status: "completed",
    pr,
    threadId: "thread-exact",
    cwd: root,
    intervalSeconds: 60,
    ownerSurface: "cli",
    ownerGeneration: 1,
    pid: null,
    registrationSnapshot: {
      observedAt: "2026-08-11T19:00:00Z",
      state: "OPEN",
      merged: false,
      headRefOid: head,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      isDraft: false,
      checkSha: head,
      queueEntryId: null,
      queueState: null,
      commentIds: [],
      checkStates: [],
    },
    deliveredEventIds: [delivered.eventId],
    pendingEvents: [],
    deliveryOutbox: [{
      event: delivered,
      delivery: { status: "delivered", attemptId: "attempt-prior" },
    }],
    recoveryHistory: [previousRecovery],
    legacyOwnerBindingRepair,
  };
  writeFileSync(stateFile, `${JSON.stringify(previousState)}\n`);
  const baseline = snapshot({
    checkSha: head,
    checks: [{ kind: "check_run", name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
    core: { headRefOid: head },
  });
  let launches = 0;
  const dependencies = {
    statePathFor: () => stateFile,
    activeRegistrationTransport: async () => ({
      appServer: { executable: "codex", socket: join(root, "app-server.sock"), version: { appServerVersion: "test" } },
      threadProbe: { threadStatus: "active", activeTurnId: "turn-active" },
      invocation: { transport: "proxy" },
    }),
    fetchSnapshot: () => baseline,
    fetchAuthenticatedLogin: () => "worker-login",
    launchDetachedMonitor: (monitorState) => {
      launches += 1;
      return monitorState;
    },
  };
  const options = {
    "state-file": stateFile,
    "expected-head": head,
    "thread-id": "thread-exact",
    cwd: root,
    "owner-surface": "cli",
    "owner-generation": "1",
  };
  try {
    const blocked = await recoverSameOwner(pr.url, options, dependencies);
    assert.equal(blocked.monitorStarted, false);
    assert.equal(blocked.status, "initial_material_state");
    assert.equal(launches, 0);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), previousState);

    const recovered = await recoverSameOwner(pr.url, {
      ...options,
      "acknowledge-initial-event": blocked.initialMaterialState.eventId,
    }, dependencies);
    assert.equal(launches, 1);
    assert.equal(recovered.registration.status, "monitor_started_same_owner_recovery");
    assert.equal(recovered.registration.acknowledgedInitialEventId, blocked.initialMaterialState.eventId);
    assert.deepEqual(recovered.deliveredEventIds, [delivered.eventId]);
    assert.deepEqual(recovered.deliveryOutbox, previousState.deliveryOutbox);
    assert.equal(recovered.recoveryHistory.length, 2);
    assert.deepEqual(recovered.recoveryHistory[0], previousRecovery);
    assert.equal(recovered.recoveryHistory[1].priorStateSha256, recovered.sameOwnerRecovery.priorStateSha256);
    assert.deepEqual(recovered.legacyOwnerBindingRepair, legacyOwnerBindingRepair);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-owner recovery filters self-only registration deltas and baselines their ids", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gh-monitor-self-recovery-")));
  const stateFile = join(root, "monitor.json");
  const head = "f".repeat(40);
  const pr = parsePrUrl("https://github.com/openai/codex/pull/126");
  const previousState = {
    version: 5,
    status: "completed",
    pr,
    threadId: "thread-exact",
    cwd: root,
    intervalSeconds: 60,
    ownerSurface: "cli",
    ownerGeneration: 1,
    pid: null,
    registrationSnapshot: {
      observedAt: "2026-08-11T19:00:00Z",
      state: "OPEN",
      merged: false,
      headRefOid: head,
      mergeable: "MERGEABLE",
      mergeStateStatus: "UNSTABLE",
      reviewDecision: "APPROVED",
      isDraft: false,
      checkSha: head,
      queueEntryId: null,
      queueState: null,
      commentIds: [],
    },
    seenCommentIds: [],
    deliveredEventIds: [],
    pendingEvents: [],
    deliveryOutbox: [],
  };
  writeFileSync(stateFile, `${JSON.stringify(previousState)}\n`);
  const baseline = snapshot({
    checkSha: head,
    comments: [{ id: "self-1", author: "worker-login", body: "worker reply" }],
    checks: [{ kind: "check_run", name: "test", status: "IN_PROGRESS", conclusion: null }],
    core: { headRefOid: head, mergeStateStatus: "UNSTABLE" },
  });
  const dependencies = {
    statePathFor: () => stateFile,
    activeRegistrationTransport: async () => ({
      appServer: { executable: "codex", socket: join(root, "app-server.sock"), version: { appServerVersion: "test" } },
      threadProbe: { threadStatus: "active", activeTurnId: "turn-active" },
      invocation: { transport: "proxy" },
    }),
    fetchAuthenticatedLogin: () => "worker-login",
    fetchSnapshot: () => baseline,
    launchDetachedMonitor: (monitorState) => monitorState,
  };
  try {
    const recovered = await recoverSameOwner(pr.url, {
      "state-file": stateFile,
      "expected-head": head,
      "thread-id": "thread-exact",
      cwd: root,
      "owner-surface": "cli",
      "owner-generation": "1",
    }, dependencies);
    assert.equal(recovered.version, 7);
    assert.equal(recovered.sameOwnerRecovery.registrationDelta.detected, false);
    assert.deepEqual(recovered.seenCommentIds, ["self-1"]);
    assert.deepEqual(recovered.registrationSnapshot.commentIds, ["self-1"]);
    assert.deepEqual(recovered.commentMonitoring, buildCommentMonitoring({}, "worker-login"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-owner recovery inherits owner metadata from the stopped state", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gh-monitor-recovery-owner-inherit-")));
  const stateFile = join(root, "monitor.json");
  const head = "a".repeat(40);
  const pr = parsePrUrl("https://github.com/openai/codex/pull/7417");
  const previousState = {
    version: 7,
    status: "stopped",
    pr,
    threadId: "thread-exact",
    ownerSurface: "cli",
    ownerGeneration: 1,
    cwd: root,
    intervalSeconds: 60,
    stoppedAt: "2026-09-16T20:23:23.855Z",
    processIdentity: {
      pid: 999_999,
      startToken: "missing",
      commandSha256: "0".repeat(64),
    },
    registrationSnapshot: snapshot({ core: { headRefOid: head } }),
    lastSnapshot: snapshot({ core: { headRefOid: head } }),
    deliveredEventIds: [],
    deliveryOutbox: [],
  };
  writeFileSync(stateFile, `${JSON.stringify(previousState)}\n`);
  const baseline = snapshot({
    checkSha: head,
    core: { headRefOid: head, reviewDecision: null },
    checks: [{ kind: "check_run", name: "test", status: "IN_PROGRESS", conclusion: null, url: null }],
  });
  let launchedState;
  const dependencies = {
    statePathFor: () => stateFile,
    activeRegistrationTransport: async () => ({
      appServer: { executable: "codex", socket: join(root, "app-server.sock"), version: { appServerVersion: "test" } },
      threadProbe: { threadStatus: "active", activeTurnId: "turn-active" },
      invocation: { transport: "proxy" },
    }),
    fetchSnapshot: () => baseline,
    fetchAuthenticatedLogin: () => "worker-login",
    launchDetachedMonitor: (monitorState) => {
      launchedState = monitorState;
      return monitorState;
    },
  };
  try {
    const recovered = await recoverSameOwner(pr.url, {
      "state-file": stateFile,
      "expected-head": head,
    }, dependencies);

    assert.equal(recovered.registration.status, "monitor_started_same_owner_recovery");
    assert.equal(launchedState.threadId, "thread-exact");
    assert.equal(launchedState.ownerSurface, "cli");
    assert.equal(launchedState.ownerGeneration, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-owner recovery settles a concurrent conflict and failure baseline without hiding later changes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gh-monitor-recovery-baseline-")));
  const stateFile = join(root, "monitor.json");
  const head = "b".repeat(40);
  const pr = parsePrUrl("https://github.com/openai/codex/pull/124");
  const conflictEvent = {
    eventId: "delivered-conflict",
    kind: "source_pr_conflicting",
    severity: "attention",
    summary: "GitHub marked the unqueued source pull request conflicting",
    details: {
      headRefOid: head,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    },
  };
  const previousState = {
    version: 5,
    status: "completed",
    pr,
    threadId: "thread-exact",
    cwd: root,
    intervalSeconds: 60,
    ownerSurface: "cli",
    ownerGeneration: 1,
    pid: null,
    registrationSnapshot: {
      observedAt: "2026-08-11T19:00:00Z",
      state: "OPEN",
      merged: false,
      headRefOid: head,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      reviewDecision: "APPROVED",
      isDraft: false,
      checkSha: head,
      queueEntryId: null,
      queueState: null,
      commentIds: [],
      checkStates: [],
    },
    event: conflictEvent,
    deliveredEventIds: [conflictEvent.eventId],
    pendingEvents: [],
    deliveryOutbox: [{
      event: conflictEvent,
      delivery: { status: "delivered", attemptId: "attempt-conflict" },
    }],
  };
  writeFileSync(stateFile, `${JSON.stringify(previousState)}\n`);
  const baseline = snapshot({
    observedAt: "2026-08-11T20:00:00Z",
    checkSha: head,
    core: { headRefOid: head, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
    checks: [{
      kind: "check_run", runId: "100", appId: "9", name: "Datadog PR Gates / No new flaky tests",
      startedAt: "2026-08-11T19:30:00Z", status: "COMPLETED", conclusion: "FAILURE",
    }],
  });
  const dependencies = {
    statePathFor: () => stateFile,
    activeRegistrationTransport: async () => ({
      appServer: { executable: "codex", socket: join(root, "app-server.sock"), version: { appServerVersion: "test" } },
      threadProbe: { threadStatus: "active", activeTurnId: "turn-active" },
      invocation: { transport: "proxy" },
    }),
    fetchSnapshot: () => baseline,
    fetchAuthenticatedLogin: () => "worker-login",
    launchDetachedMonitor: (monitorState) => monitorState,
  };
  const options = {
    "state-file": stateFile,
    "expected-head": head,
    "thread-id": "thread-exact",
    cwd: root,
    "owner-surface": "cli",
    "owner-generation": "1",
  };

  try {
    const blocked = await recoverSameOwner(pr.url, options, dependencies);
    assert.equal(blocked.status, "initial_material_state");
    assert.deepEqual(
      blocked.initialMaterialState.event.details.currentEvents.map((event) => event.kind),
      ["source_pr_conflicting", "ci_checks_failed"],
    );

    const recovered = await recoverSameOwner(pr.url, {
      ...options,
      "acknowledge-initial-event": blocked.initialMaterialState.eventId,
    }, dependencies);
    assert.equal(recovered.acknowledgedMaterialFingerprints.length, 2);
    assert.equal(evaluateUnsettledSnapshot(recovered, baseline), null);

    const queueRecoveryState = structuredClone(recovered);
    const queued = snapshot({
      observedAt: "2026-08-11T20:00:30Z",
      checkSha: "d".repeat(40),
      core: {
        headRefOid: head,
        mergeable: "MERGEABLE",
        mergeStateStatus: "UNSTABLE",
        mergeQueueEntry: { id: "queue-1", state: "AWAITING_CHECKS" },
      },
      checks: [{ kind: "check_run", name: "queue", status: "IN_PROGRESS", conclusion: null }],
    });
    assert.equal(evaluateUnsettledSnapshot(queueRecoveryState, queued), null);
    const ejected = snapshot({
      observedAt: "2026-08-11T20:00:31Z",
      checkSha: head,
      core: { headRefOid: head, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
    });
    assert.equal(evaluateUnsettledSnapshot(queueRecoveryState, ejected)?.kind, "merge_queue_ejected");

    const changedFailure = snapshot({
      observedAt: "2026-08-11T20:01:00Z",
      checkSha: head,
      core: { headRefOid: head, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
      checks: [{
        kind: "check_run", runId: "101", appId: "9", name: "Datadog PR Gates / No new flaky tests",
        startedAt: "2026-08-11T20:01:00Z", status: "COMPLETED", conclusion: "FAILURE",
      }],
    });
    assert.equal(evaluateUnsettledSnapshot(recovered, changedFailure)?.kind, "ci_checks_failed");

    const changedHead = snapshot({
      observedAt: "2026-08-11T20:02:00Z",
      checkSha: "c".repeat(40),
      core: { headRefOid: "c".repeat(40), mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
      checks: baseline.checks,
    });
    assert.equal(evaluateUnsettledSnapshot(recovered, changedHead)?.kind, "source_pr_conflicting");

    const closed = snapshot({
      observedAt: "2026-08-11T20:03:00Z",
      checkSha: head,
      core: { state: "CLOSED", headRefOid: head, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
      checks: baseline.checks,
    });
    assert.equal(evaluateUnsettledSnapshot(recovered, closed)?.kind, "closed_unmerged");

    const newComment = snapshot({
      observedAt: "2026-08-11T20:04:00Z",
      checkSha: head,
      core: { headRefOid: head, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
      checks: baseline.checks,
      comments: [{ id: "new-comment", author: "reviewer", body: "new material" }],
    });
    assert.equal(evaluateUnsettledSnapshot(recovered, newComment)?.kind, "new_inline_comments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("black box: completed delivered conflict and failure survive recovery launch and transient next polls", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gh-monitor-recovery-next-poll-")));
  const stateFile = join(root, "monitor.json");
  const head = "e".repeat(40);
  const pr = parsePrUrl("https://github.com/openai/codex/pull/125");
  const failure = {
    kind: "check_run", runId: "500", appId: "9", name: "Datadog PR Gates / No new flaky tests",
    startedAt: "2026-08-11T19:30:00Z", status: "COMPLETED", conclusion: "FAILURE",
  };
  const baseline = snapshot({
    observedAt: "2026-08-11T20:00:00Z",
    checkSha: head,
    core: { headRefOid: head, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
    checks: [failure],
  });
  const [conflictEvent, failureEvent] = materialEvents(state(), baseline).map((event, index) => ({
    ...event,
    eventId: `delivered-${index}`,
    observedAt: "2026-08-11T19:59:00Z",
  }));
  const previousState = {
    version: 5,
    status: "completed",
    pr,
    threadId: "thread-exact",
    cwd: root,
    intervalSeconds: 60,
    ownerSurface: "cli",
    ownerGeneration: 1,
    pid: null,
    registrationSnapshot: {
      observedAt: "2026-08-11T19:59:00Z",
      state: "OPEN",
      merged: false,
      headRefOid: head,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      reviewDecision: "APPROVED",
      isDraft: false,
      checkSha: head,
      queueEntryId: null,
      queueState: null,
      commentIds: [],
      checkStates: [],
    },
    event: conflictEvent,
    deliveredEventIds: [conflictEvent.eventId, failureEvent.eventId],
    pendingEvents: [],
    deliveryOutbox: [conflictEvent, failureEvent].map((event) => ({
      event,
      delivery: { status: "delivered", attemptId: `attempt-${event.eventId}` },
    })),
  };
  writeFileSync(stateFile, `${JSON.stringify(previousState)}\n`);
  const observedEvents = [];
  let launchedState;
  const transientUnknown = snapshot({
    observedAt: "2026-08-11T20:01:00Z",
    checkSha: head,
    core: { headRefOid: head, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
    checks: [],
  });
  const dependencies = {
    statePathFor: () => stateFile,
    activeRegistrationTransport: async () => ({
      appServer: { executable: "codex", socket: join(root, "app-server.sock"), version: { appServerVersion: "test" } },
      threadProbe: { threadStatus: "active", activeTurnId: "turn-active" },
      invocation: { transport: "proxy" },
    }),
    fetchSnapshot: () => baseline,
    fetchAuthenticatedLogin: () => "worker-login",
    launchDetachedMonitor: (monitorState) => {
      launchedState = monitorState;
      observedEvents.push(evaluateMonitorPoll(monitorState, transientUnknown));
      observedEvents.push(evaluateMonitorPoll(monitorState, baseline));
      return monitorState;
    },
  };

  try {
    const recovered = await recoverSameOwner(pr.url, {
      "state-file": stateFile,
      "expected-head": head,
      "thread-id": "thread-exact",
      cwd: root,
      "owner-surface": "cli",
      "owner-generation": "1",
    }, dependencies);
    assert.equal(recovered.registration.initialMaterialDelivery, "same_owner_reconciled");
    assert.deepEqual(observedEvents, [null, null]);
    assert.equal(launchedState.acknowledgedMaterialConditions.length, 2);

    const authoritativeCheckResolution = snapshot({
      observedAt: "2026-08-11T20:02:00Z",
      checkSha: head,
      core: { headRefOid: head, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
      checks: [{ ...failure, status: "COMPLETED", conclusion: "SUCCESS" }],
    });
    const checkRecurrenceState = structuredClone(launchedState);
    assert.equal(evaluateMonitorPoll(checkRecurrenceState, authoritativeCheckResolution), null);
    assert.equal(evaluateMonitorPoll(checkRecurrenceState, baseline)?.kind, "ci_checks_failed");

    const authoritativeConflictResolution = snapshot({
      observedAt: "2026-08-11T20:03:00Z",
      checkSha: head,
      core: { headRefOid: head, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
      checks: [{ ...failure, status: "IN_PROGRESS", conclusion: null }],
    });
    const conflictRecurrenceState = structuredClone(launchedState);
    assert.equal(evaluateMonitorPoll(conflictRecurrenceState, authoritativeConflictResolution), null);
    assert.equal(evaluateMonitorPoll(conflictRecurrenceState, baseline)?.kind, "source_pr_conflicting");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-owner recovery treats delivered initial material as covering nested events", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gh-monitor-initial-material-recovery-")));
  const stateFile = join(root, "monitor.json");
  const head = "e".repeat(40);
  const pr = parsePrUrl("https://github.com/openai/codex/pull/123");
  const baseline = snapshot({
    checkSha: head,
    core: { headRefOid: head },
    reviewThreads: [reviewThread()],
    checks: [{ kind: "check_run", name: "lint", status: "COMPLETED", conclusion: "FAILURE" }],
  });
  const initial = buildInitialMaterialState({
    prUrl: pr.url,
    threadId: "thread-exact",
    cwd: root,
    ownerSurface: "cli",
    ownerGeneration: 1,
  }, baseline);
  const previousState = {
    version: 7,
    status: "completed",
    pr,
    threadId: "thread-exact",
    cwd: root,
    intervalSeconds: 60,
    ownerSurface: "cli",
    ownerGeneration: 1,
    pid: null,
    registrationSnapshot: summarizeSnapshot(baseline),
    deliveredEventIds: [initial.eventId],
    pendingEvents: [],
    deliveryOutbox: [{
      event: initial.event,
      delivery: { status: "delivered", attemptId: "attempt-initial" },
    }],
  };
  writeFileSync(stateFile, `${JSON.stringify(previousState)}\n`);
  const dependencies = {
    statePathFor: () => stateFile,
    activeRegistrationTransport: async () => ({
      appServer: { executable: "codex", socket: join(root, "app-server.sock"), version: { appServerVersion: "test" } },
      threadProbe: { threadStatus: "active", activeTurnId: "turn-active" },
      invocation: { transport: "proxy" },
    }),
    fetchSnapshot: () => baseline,
    fetchAuthenticatedLogin: () => "worker-login",
    launchDetachedMonitor: (monitorState) => monitorState,
  };
  const options = {
    "state-file": stateFile,
    "expected-head": head,
    "thread-id": "thread-exact",
    cwd: root,
    "owner-surface": "cli",
    "owner-generation": "1",
  };

  try {
    const recovered = await recoverSameOwner(pr.url, options, dependencies);
    assert.equal(recovered.registration.status, "monitor_started_same_owner_recovery");
    assert.equal(recovered.initialMaterialState.delivery, "same_owner_reconciled");
    assert.deepEqual(
      recovered.initialMaterialState.event.details.currentEvents.map((event) => event.kind),
      ["unresolved_review_threads", "ci_checks_failed"],
    );
    assert.equal(evaluateUnsettledSnapshot(recovered, baseline), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("material enumeration does not report readiness beside a failing check", () => {
  const events = materialEvents(state(), snapshot({
    checks: [{ kind: "check_run", name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
  }));
  assert.deepEqual(events.map((event) => event.kind), ["ci_checks_failed"]);
});

test("unresolved review threads at registration are initial material instead of false ready", () => {
  const baseline = snapshot({
    reviewThreads: [reviewThread()],
  });
  const events = materialEvents(state(), baseline);
  assert.deepEqual(events.map((event) => event.kind), ["unresolved_review_threads"]);
  assert.equal(events[0].details.totalUnresolvedThreads, 1);
  assert.equal(events[0].details.threads[0].commentIds[0], "10");

  const initial = buildInitialMaterialState({
    prUrl: "https://github.com/openai/codex/pull/123",
    threadId: "thread-1",
    cwd: "/tmp",
    ownerSurface: "cli",
    ownerGeneration: 1,
  }, baseline);
  assert.equal(initial.detected, true);
  assert.equal(initial.event.severity, "attention");
  assert.deepEqual(
    initial.event.details.currentEvents.map((event) => event.kind),
    ["unresolved_review_threads"],
  );
  assert.equal(initial.event.details.currentEvents.some((event) => event.kind === "ready_to_merge"), false);
});

test("review thread unresolved and resolved transitions update persisted monitor state", () => {
  const current = state();
  const resolved = snapshot({
    reviewThreads: [reviewThread({ isResolved: true })],
    checks: [{ kind: "check_run", name: "test", status: "IN_PROGRESS", conclusion: null }],
    core: { mergeStateStatus: "UNSTABLE" },
  });
  assert.equal(evaluateMonitorPoll(current, resolved), null);
  assert.equal(current.reviewThreadStates[0].isResolved, true);
  assert.deepEqual(current.unresolvedReviewThreads, []);

  const unresolved = snapshot({
    observedAt: "2026-08-11T20:01:00Z",
    reviewThreads: [reviewThread({ isResolved: false })],
    checks: [{ kind: "check_run", name: "test", status: "IN_PROGRESS", conclusion: null }],
    core: { mergeStateStatus: "UNSTABLE" },
  });
  const event = evaluateMonitorPoll(current, unresolved);
  assert.equal(event.kind, "unresolved_review_threads");
  assert.equal(current.unresolvedReviewThreads[0].id, "thread-1");
  assert.deepEqual(current.seenCommentIds, ["1", "10"]);

  const resolvedAgain = snapshot({
    observedAt: "2026-08-11T20:02:00Z",
    reviewThreads: [reviewThread({ isResolved: true })],
    checks: [{ kind: "check_run", name: "test", status: "IN_PROGRESS", conclusion: null }],
    core: { mergeStateStatus: "UNSTABLE" },
  });
  assert.equal(evaluateMonitorPoll(current, resolvedAgain), null);
  assert.equal(current.reviewThreadStates[0].isResolved, true);
  assert.deepEqual(current.unresolvedReviewThreads, []);
});

test("ready-to-merge stays suppressed while unresolved review threads exist", () => {
  const baseline = snapshot({
    reviewThreads: [reviewThread()],
  });
  assert.deepEqual(
    materialEvents(state(), baseline).map((event) => event.kind),
    ["unresolved_review_threads"],
  );

  const initial = buildInitialMaterialState({
    prUrl: "https://github.com/openai/codex/pull/123",
    threadId: "thread-1",
    cwd: "/tmp",
    ownerSurface: "cli",
    ownerGeneration: 1,
  }, baseline);
  const acknowledged = state({
    acknowledgedMaterialFingerprints: initial.currentMaterialFingerprints,
    acknowledgedMaterialConditions: initial.currentMaterialConditions,
  });
  assert.equal(evaluateUnsettledSnapshot(acknowledged, baseline), null);
  assert.equal(
    materialEvents(acknowledged, baseline).some((event) => event.kind === "ready_to_merge"),
    false,
  );
});

test("registration deltas record review thread resolution changes", () => {
  const previousResolved = {
    registrationSnapshot: summarizeSnapshot(snapshot({
      observedAt: "2026-08-11T19:59:00Z",
      reviewThreads: [reviewThread({ isResolved: true })],
    })),
    seenCommentIds: ["10"],
  };
  const unresolvedDelta = buildReregistrationDelta(previousResolved, snapshot({
    observedAt: "2026-08-11T20:00:00Z",
    reviewThreads: [reviewThread({ isResolved: false })],
  }));
  assert.equal(unresolvedDelta.detected, true);
  assert.deepEqual(unresolvedDelta.changes.find(({ field }) => field === "reviewThreads"), {
    field: "reviewThreads",
    before: previousResolved.registrationSnapshot.reviewThreads,
    after: summarizeSnapshot(snapshot({ reviewThreads: [reviewThread({ isResolved: false })] })).reviewThreads,
  });

  const previousUnresolved = {
    registrationSnapshot: summarizeSnapshot(snapshot({
      observedAt: "2026-08-11T20:00:00Z",
      reviewThreads: [reviewThread({ isResolved: false })],
    })),
    seenCommentIds: ["10"],
  };
  const resolvedDelta = buildReregistrationDelta(previousUnresolved, snapshot({
    observedAt: "2026-08-11T20:01:00Z",
    reviewThreads: [reviewThread({ isResolved: true })],
  }));
  assert.equal(resolvedDelta.detected, true);
  assert.equal(
    resolvedDelta.changes.find(({ field }) => field === "reviewThreads").after[0].isResolved,
    true,
  );
});

test("initial registration baselines every inline comment without waking for them", () => {
  const baseline = snapshot({
    comments: [
      { id: "1", author: "reviewer" },
      { id: "2", author: "worker-login" },
    ],
    checks: [{ kind: "check_run", name: "test", status: "IN_PROGRESS", conclusion: null }],
    core: { mergeStateStatus: "UNSTABLE" },
  });
  const initial = buildInitialMaterialState({
    prUrl: "https://github.com/openai/codex/pull/123",
    threadId: "thread-1",
    cwd: "/tmp",
    ownerSurface: "cli",
    ownerGeneration: 1,
  }, baseline);
  assert.equal(initial, null);
});

test("wakes for a new inline comment", () => {
  const result = evaluateSnapshot(state(), snapshot({ comments: [{ id: "2", author: "reviewer" }] }));
  assert.equal(result.kind, "new_inline_comments");
});

test("polling ignores only the authenticated login and records every observed comment id", () => {
  const current = state({
    commentMonitoring: buildCommentMonitoring({}, "Worker-Login"),
  });
  const result = evaluateSnapshot(current, snapshot({
    comments: [
      { id: "2", author: "worker-login", body: "worker reply" },
      { id: "3", author: "github-actions[bot]", body: "bot feedback" },
      { id: "4", author: "reviewer", body: "human feedback" },
    ],
  }));
  assert.equal(result.kind, "new_inline_comments");
  assert.deepEqual(result.details.comments.map(({ id }) => id), ["3", "4"]);
  assert.deepEqual(current.seenCommentIds, ["1", "2", "3", "4"]);
});

test("a self-only poll stays quiet and cannot reappear on the next poll", () => {
  const current = state({
    commentMonitoring: buildCommentMonitoring({}, "worker-login"),
  });
  const selfOnly = snapshot({
    comments: [{ id: "2", author: "WORKER-LOGIN", body: "worker reply" }],
    checks: [{ kind: "check_run", name: "test", status: "IN_PROGRESS", conclusion: null }],
    core: { mergeStateStatus: "UNSTABLE" },
  });
  assert.equal(evaluateSnapshot(current, selfOnly), null);
  assert.deepEqual(current.seenCommentIds, ["1", "2"]);
  assert.equal(evaluateSnapshot(current, selfOnly), null);
});

test("the explicit opt-in wakes for an authenticated user's own comment", () => {
  const current = state({
    commentMonitoring: buildCommentMonitoring({ "include-self-comments": true }, "worker-login"),
  });
  const result = evaluateSnapshot(current, snapshot({
    comments: [{ id: "2", author: "worker-login", body: "please monitor this too" }],
  }));
  assert.equal(result.kind, "new_inline_comments");
  assert.equal(result.details.comments[0].id, "2");
});

test("version-5 states without a persisted comment policy retain include-all behavior", () => {
  const legacy = state({ version: 5 });
  const result = evaluateSnapshot(legacy, snapshot({
    comments: [{ id: "2", author: "worker-login", body: "legacy monitor reply" }],
  }));
  assert.equal(result.kind, "new_inline_comments");
});

test("wakes for failing CI", () => {
  const result = evaluateSnapshot(state(), snapshot({
    checks: [{ kind: "check_run", name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
  }));
  assert.equal(result.kind, "ci_checks_failed");
});

test("ignores an older cancelled check run replaced by success on the same head", () => {
  const result = evaluateSnapshot(state(), snapshot({
    checks: [
      {
        kind: "check_run", runId: "100", appId: "1", name: "check-pr-body-sections",
        startedAt: "2026-08-11T19:00:00Z", status: "COMPLETED", conclusion: "CANCELLED",
      },
      {
        kind: "check_run", runId: "101", appId: "1", name: "check-pr-body-sections",
        startedAt: "2026-08-11T19:05:00Z", status: "COMPLETED", conclusion: "SUCCESS",
      },
    ],
  }));
  assert.equal(result.kind, "ready_to_merge");
});

test("wakes when the current duplicate check run is cancelled", () => {
  const result = evaluateSnapshot(state(), snapshot({
    checks: [
      {
        kind: "check_run", runId: "101", appId: "1", name: "test",
        startedAt: "2026-08-11T19:00:00Z", status: "COMPLETED", conclusion: "SUCCESS",
      },
      {
        kind: "check_run", runId: "102", appId: "1", name: "test",
        startedAt: "2026-08-11T19:05:00Z", status: "COMPLETED", conclusion: "CANCELLED",
      },
    ],
  }));
  assert.equal(result.kind, "ci_checks_failed");
  assert.equal(result.details.failing[0].runId, "102");
});

test("does not collapse same-named check runs from different apps", () => {
  const result = evaluateSnapshot(state(), snapshot({
    checks: [
      {
        kind: "check_run", runId: "101", appId: "1", name: "test",
        startedAt: "2026-08-11T19:05:00Z", status: "COMPLETED", conclusion: "SUCCESS",
      },
      {
        kind: "check_run", runId: "100", appId: "2", name: "test",
        startedAt: "2026-08-11T19:00:00Z", status: "COMPLETED", conclusion: "FAILURE",
      },
    ],
  }));
  assert.equal(result.kind, "ci_checks_failed");
  assert.equal(result.details.failing[0].appId, "2");
});

test("wakes when an unqueued source PR is conflicting", () => {
  const result = evaluateSnapshot(state(), snapshot({
    core: { mergeable: "CONFLICTING", mergeStateStatus: "UNKNOWN" },
  }));
  assert.equal(result.kind, "source_pr_conflicting");
  assert.deepEqual(result.details, {
    headRefOid: "abc",
    mergeable: "CONFLICTING",
    mergeStateStatus: "UNKNOWN",
  });
});

test("wakes when GitHub reports a dirty unqueued source PR", () => {
  const result = evaluateSnapshot(state(), snapshot({
    core: { mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" },
  }));
  assert.equal(result.kind, "source_pr_conflicting");
});

test("source conflicts take precedence over generic CI failures", () => {
  const result = evaluateSnapshot(state(), snapshot({
    core: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
    checks: [{ kind: "check_run", name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
  }));
  assert.equal(result.kind, "source_pr_conflicting");
});

test("queued PRs keep using merge-queue conflict handling", () => {
  const result = evaluateSnapshot(state(), snapshot({
    core: {
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      mergeQueueEntry: { id: "mq1", state: "UNMERGEABLE" },
    },
    checkSha: "merge-group-sha",
  }));
  assert.equal(result.kind, "merge_queue_unmergeable");
});

test("uses merge-queue checks and wakes on failure", () => {
  const result = evaluateSnapshot(state({ wasQueued: true, queueEntryId: "mq1" }), snapshot({
    core: { mergeQueueEntry: { id: "mq1", state: "AWAITING_CHECKS" } },
    checkSha: "merge-group-sha",
    checks: [{ kind: "commit_status", name: "deploy", status: "ERROR", conclusion: null }],
  }));
  assert.equal(result.kind, "merge_queue_checks_failed");
  assert.equal(result.details.checkSha, "merge-group-sha");
});

test("merge queue ignores a cancelled check replaced by success", () => {
  const current = state({ wasQueued: true, queueEntryId: "mq1" });
  const result = evaluateSnapshot(current, snapshot({
    core: { mergeQueueEntry: { id: "mq1", state: "AWAITING_CHECKS" } },
    checkSha: "merge-group-sha",
    checks: [
      {
        kind: "check_run", runId: "200", appId: "1", name: "test",
        startedAt: "2026-08-11T19:00:00Z", status: "COMPLETED", conclusion: "CANCELLED",
      },
      {
        kind: "check_run", runId: "201", appId: "1", name: "test",
        startedAt: "2026-08-11T19:05:00Z", status: "COMPLETED", conclusion: "SUCCESS",
      },
    ],
  }));
  assert.equal(result, null);
  assert.equal(current.lastCheckSha, "merge-group-sha");
});

test("merge queue wakes when the current replacement check is cancelled", () => {
  const result = evaluateSnapshot(state({ wasQueued: true, queueEntryId: "mq1" }), snapshot({
    core: { mergeQueueEntry: { id: "mq1", state: "AWAITING_CHECKS" } },
    checkSha: "merge-group-sha",
    checks: [
      {
        kind: "check_run", runId: "200", appId: "1", name: "test",
        startedAt: "2026-08-11T19:00:00Z", status: "COMPLETED", conclusion: "SUCCESS",
      },
      {
        kind: "check_run", runId: "201", appId: "1", name: "test",
        startedAt: "2026-08-11T19:05:00Z", status: "COMPLETED", conclusion: "CANCELLED",
      },
    ],
  }));
  assert.equal(result.kind, "merge_queue_checks_failed");
  assert.equal(result.details.failing[0].runId, "201");
});

test("wakes when a queued PR is ejected", () => {
  const result = evaluateSnapshot(state({ wasQueued: true, queueEntryId: "mq1" }), snapshot());
  assert.equal(result.kind, "merge_queue_ejected");
});

test("merged wins over queue disappearance", () => {
  const result = evaluateSnapshot(state({ wasQueued: true }), snapshot({ core: { state: "MERGED", merged: true } }));
  assert.equal(result.kind, "merged");
});

test("unqueued clean PR wakes as ready", () => {
  assert.equal(evaluateSnapshot(state(), snapshot()).kind, "ready_to_merge");
});

test("pending checks keep monitoring", () => {
  const result = evaluateSnapshot(state(), snapshot({
    checks: [{ kind: "check_run", name: "test", status: "IN_PROGRESS", conclusion: null }],
    core: { mergeStateStatus: "UNSTABLE" },
  }));
  assert.equal(result, null);
});

test("entering the queue updates state without declaring ready", () => {
  const current = state();
  const result = evaluateSnapshot(current, snapshot({
    core: { mergeQueueEntry: { id: "mq2", state: "QUEUED" } },
    checkSha: "queue-sha",
  }));
  assert.equal(result, null);
  assert.equal(current.wasQueued, true);
  assert.equal(current.queueEntryId, "mq2");
});

test("normalizes version-3 Desktop state additively", () => {
  const legacy = { version: 3, status: "running", threadId: "thread-1" };
  assert.deepEqual(normalizeMonitorState(legacy), {
    ...legacy,
    ownerSurface: "desktop",
    ownerGeneration: 0,
    notificationTransport: "desktop",
  });
});

test("does not synthesize ownership for malformed version-4 state", () => {
  const current = { version: 4, status: "stopped", threadId: "thread-1" };
  assert.deepEqual(normalizeMonitorState(current), {
    ...current,
    ownerSurface: null,
    ownerGeneration: null,
    notificationTransport: null,
  });
});

test("preserves Desktop owner defaults and accepts an explicit CLI generation", () => {
  assert.deepEqual(parseOwnerMetadata({}), { ownerSurface: "desktop", ownerGeneration: 0 });
  assert.deepEqual(parseOwnerMetadata({
    "owner-surface": "cli",
    "owner-generation": "7",
  }), { ownerSurface: "cli", ownerGeneration: 7 });
  assert.throws(() => parseOwnerMetadata({ "owner-generation": "-1" }), /non-negative/);
  assert.throws(() => parseOwnerMetadata({
    "owner-surface": "cli",
    "owner-generation": "0",
  }), /at least 1/);
});

function monitorOwnerState(overrides = {}) {
  return {
    version: 4,
    status: "stopped",
    pid: 999999,
    threadId: "thread-1",
    ownerSurface: "desktop",
    ownerGeneration: 2,
    pr: parsePrUrl("https://github.com/openai/codex/pull/123"),
    ...overrides,
  };
}

const replacementPr = parsePrUrl("https://github.com/openai/codex/pull/123");

test("accepts an exact next-generation replacement for the same PR and thread", () => {
  assert.deepEqual(validateReplacementLineage(
    monitorOwnerState(),
    replacementPr,
    "thread-1",
    { ownerSurface: "cli", ownerGeneration: 3 },
  ), { previousOwnerSurface: "desktop", previousOwnerGeneration: 2 });
});

test("accepts matching legacy v3 state only as Desktop generation zero", () => {
  const legacy = monitorOwnerState({
    version: 3,
    ownerSurface: "invalid-legacy-value",
    ownerGeneration: 99,
    pr: {
      ...replacementPr,
      url: "https://github.com/openai/codex/pull/123/files",
    },
  });
  assert.deepEqual(validateReplacementLineage(
    legacy,
    replacementPr,
    "thread-1",
    { ownerSurface: "cli", ownerGeneration: 1 },
  ), { previousOwnerSurface: "desktop", previousOwnerGeneration: 0 });
});

test("rejects a replacement state from another pull request", () => {
  assert.throws(() => validateReplacementLineage(
    monitorOwnerState({ pr: parsePrUrl("https://github.com/openai/codex/pull/124") }),
    replacementPr,
    "thread-1",
    { ownerSurface: "cli", ownerGeneration: 3 },
  ), /different pull request/);
});

test("rejects inconsistent stored pull-request identity", () => {
  assert.throws(() => validateReplacementLineage(
    monitorOwnerState({ pr: { ...replacementPr, number: 124 } }),
    replacementPr,
    "thread-1",
    { ownerSurface: "cli", ownerGeneration: 3 },
  ), /inconsistent pull-request identity/);
});

test("rejects a replacement state from another root thread", () => {
  assert.throws(() => validateReplacementLineage(
    monitorOwnerState({ threadId: "thread-other" }),
    replacementPr,
    "thread-1",
    { ownerSurface: "cli", ownerGeneration: 3 },
  ), /different root thread/);
});

test("accepts a cross-root monitor transfer only with an exact prepared receipt", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gh-monitor-root-transfer-")));
  try {
    const receipt = {
      schema: "CL_SWEEP_ROOT_TRANSFER v1",
      status: "PREPARED",
      transferId: "transfer-1",
      from: { threadId: "thread-other", cwd, surface: "desktop", generation: 2 },
      to: { threadId: "thread-1", surface: "cli", generation: 3, cwd },
    };
    assert.deepEqual(validateReplacementLineage(
      monitorOwnerState({ threadId: "thread-other", cwd }),
      replacementPr,
      "thread-1",
      { ownerSurface: "cli", ownerGeneration: 3 },
      { receipt, cwd },
    ), { previousOwnerSurface: "desktop", previousOwnerGeneration: 2 });
    assert.throws(() => validateReplacementLineage(
      monitorOwnerState({ threadId: "thread-other", cwd }),
      replacementPr,
      "thread-1",
      { ownerSurface: "cli", ownerGeneration: 3 },
      { receipt: { ...receipt, to: { ...receipt.to, generation: 4 } }, cwd },
    ), /does not authorize/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rejects an invalid prior owner surface", () => {
  assert.throws(() => validateReplacementLineage(
    monitorOwnerState({ ownerSurface: "unknown" }),
    replacementPr,
    "thread-1",
    { ownerSurface: "cli", ownerGeneration: 3 },
  ), /invalid prior owner surface/);
});

test("rejects invalid prior and next owner generations", () => {
  assert.throws(() => validateReplacementLineage(
    monitorOwnerState({ ownerGeneration: null }),
    replacementPr,
    "thread-1",
    { ownerSurface: "cli", ownerGeneration: 1 },
  ), /invalid prior owner generation/);
  assert.throws(() => validateReplacementLineage(
    monitorOwnerState(),
    replacementPr,
    "thread-1",
    { ownerSurface: "cli", ownerGeneration: 0 },
  ), /invalid next owner generation/);
});

test("rejects equal, stale, and skipped replacement generations", () => {
  for (const [generation, pattern] of [[2, /equal or stale/], [1, /equal or stale/], [4, /skipped/]]) {
    assert.throws(() => validateReplacementLineage(
      monitorOwnerState(),
      replacementPr,
      "thread-1",
      { ownerSurface: "cli", ownerGeneration: generation },
    ), pattern);
  }
});

test("reports a replacement registration delta from legacy state", () => {
  const previous = {
    version: 3,
    startedAt: "2026-08-11T19:00:00Z",
    seenCommentIds: ["1"],
    lastHeadOid: "old-head",
    lastMergeable: "UNKNOWN",
    lastMergeStateStatus: "UNKNOWN",
    lastCheckSha: "old-head",
  };
  const current = snapshot({
    comments: [{ id: "1" }, { id: "2", author: "reviewer" }],
  });
  const delta = buildReregistrationDelta(previous, current);
  assert.equal(delta.detected, true);
  assert.equal(delta.newInlineComments[0].id, "2");
  assert.deepEqual(delta.changes.find(({ field }) => field === "headRefOid"), {
    field: "headRefOid",
    before: "old-head",
    after: "abc",
  });
  assert.match(delta.guidance, /registration material.*(?:acknowledgement|queue)/);
});

test("registration delta ignores only self comments while retaining raw baseline ids", () => {
  const previous = {
    seenCommentIds: ["1"],
    registrationSnapshot: { observedAt: "2026-08-11T19:00:00Z", commentIds: ["1"] },
  };
  const current = snapshot({
    comments: [
      { id: "1", author: "reviewer" },
      { id: "2", author: "worker-login" },
      { id: "3", author: "dependabot[bot]" },
      { id: "4", author: "other-user" },
    ],
  });
  const policy = buildCommentMonitoring({}, "worker-login");
  const delta = buildReregistrationDelta(previous, current, policy);
  assert.deepEqual(delta.newInlineComments.map(({ id }) => id), ["3", "4"]);
  assert.deepEqual(current.comments.map(({ id }) => id), ["1", "2", "3", "4"]);
});

test("reports no replacement delta when generation state is unchanged", () => {
  const current = snapshot();
  const previous = {
    registrationSnapshot: {
      observedAt: "2026-08-11T19:00:00Z",
      state: "OPEN",
      merged: false,
      headRefOid: "abc",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      isDraft: false,
      checkSha: "abc",
      queueEntryId: null,
      queueState: null,
      commentIds: [],
      checkStates: [{
        kind: "check_run", name: "test", status: "COMPLETED", conclusion: "SUCCESS",
        runId: null, appId: null,
      }],
    },
  };
  assert.equal(buildReregistrationDelta(previous, current).detected, false);
});

test("requires both a dead PID and durable stopped state", () => {
  const stopped = verifyStoppedMonitor({ pid: 42, status: "stopped", stoppedAt: "now" }, () => false);
  assert.equal(stopped.verifiedStopped, true);
  assert.equal(stopped.processAlive, false);
  assert.equal(stopped.stateStatus, "stopped");
  assert.equal(verifyStoppedMonitor({ pid: 42, status: "running" }, () => false).verifiedStopped, false);
  assert.equal(verifyStoppedMonitor({ pid: 42, status: "stopped" }, () => true).verifiedStopped, false);
});

test("refuses a reused PID even when durable monitor state says stopped", () => {
  const result = verifyStoppedMonitor({
    pid: 42,
    processIdentity: { pid: 42, startToken: "old", commandSha256: "a".repeat(64) },
    status: "stopped",
  }, () => ({ alive: true, matches: false, reason: "pid_reused_or_command_changed" }));
  assert.equal(result.verifiedStopped, false);
  assert.equal(result.processIdentityMatches, false);
  assert.equal(result.processIdentityReason, "pid_reused_or_command_changed");
});

test("monitor transfer preserves pending events, delivery receipts, and registration deltas", () => {
  const pending = { eventId: "pending-1", kind: "ci_checks_failed", severity: "attention", details: {} };
  const delivered = { eventId: "delivered-1", kind: "ready_to_merge", severity: "success", details: {} };
  const handoff = buildMonitorHandoff({
    status: "notification_failed",
    deliveredEventIds: ["delivered-1"],
    pendingEvents: [pending, delivered],
    deliveryOutbox: [{ event: pending, delivery: { status: "pending" } }],
    event: pending,
  }, { detected: true, changes: [{ field: "headRefOid", before: "a", after: "b" }] });
  assert.deepEqual(handoff.deliveredEventIds, ["delivered-1"]);
  assert.equal(handoff.pendingEvents.filter((event) => event.eventId === "pending-1").length, 1);
  assert.equal(handoff.pendingEvents.some((event) => event.eventId === "delivered-1"), false);
  assert.equal(handoff.pendingEvents.some((event) => event.kind === "monitor_registration_delta"), true);
  assert.equal(handoff.deliveryOutbox[0].event.eventId, "pending-1");
});

test("monitor notification persists a durable attempt before acceptance and never replays ambiguity", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gh-monitor-delivery-")));
  const stateFile = join(root, "monitor.json");
  const event = { eventId: "pending-1", kind: "ci_checks_failed", severity: "attention", details: {} };
  const monitor = {
    version: 4, stateFile, cwd: root, threadId: "root-1", ownerGeneration: 1,
    pr: parsePrUrl("https://github.com/openai/codex/pull/123"),
    notificationTransport: "proxy", pendingEvents: [event], deliveredEventIds: [], deliveryOutbox: [],
  };
  writeFileSync(stateFile, `${JSON.stringify(monitor)}\n`);
  let sends = 0;
  try {
    await assert.rejects(appServerAttempt(monitor, event, {
      spawnNotification: async () => {
        sends += 1;
        const durable = JSON.parse(readFileSync(stateFile, "utf8"));
        assert.equal(durable.deliveryOutbox[0].delivery.status, "delivering");
        return { status: "accepted", mode: "start", turnId: "parent-turn", transport: "proxy" };
      },
      afterRemoteAcceptance: async () => { throw new Error("simulated monitor crash"); },
    }), /simulated monitor crash/);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).deliveryOutbox[0].delivery.status, "delivering");
    await assert.rejects(appServerAttempt(monitor, event, {
      spawnNotification: async () => { sends += 1; },
    }), /ambiguous accepted outcome/);
    assert.equal(sends, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("root-transfer monitor claims are idempotent and reject a different target", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-monitor-claim-"));
  const receiptFile = join(root, "receipt.json");
  const receipt = {
    schema: "CL_SWEEP_ROOT_TRANSFER v1", status: "PREPARED", transferId: "transfer-1",
    from: {}, to: {}, monitorClaims: [],
  };
  writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`);
  try {
    const claim = {
      previousStateSha256: "a".repeat(64), prUrl: replacementPr.url,
      target: { threadId: "root-2", cwd: root, ownerSurface: "cli", ownerGeneration: 2 },
    };
    const first = claimMonitorTransfer(receiptFile, receipt, claim);
    const replay = claimMonitorTransfer(receiptFile, receipt, claim);
    assert.equal(replay.claimId, first.claimId);
    assert.equal(JSON.parse(readFileSync(receiptFile, "utf8")).monitorClaims.length, 1);
    assert.throws(() => claimMonitorTransfer(receiptFile, receipt, {
      ...claim, target: { ...claim.target, threadId: "root-3" },
    }), /different monitor target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const prRef = parsePrUrl("https://github.com/openai/codex/pull/123");
const kinds = (state, snap) => materialEvents(state, snap).map((event) => event.kind);

test("a CHANGES_REQUESTED review decision wakes and settles only when the decision changes", () => {
  const state = { seenCommentIds: [], seenReviewIds: ["r1"] };
  const requested = snapshot({
    core: { reviewDecision: "CHANGES_REQUESTED" },
    reviews: [{ id: "r1", author: "reviewer", state: "CHANGES_REQUESTED", body: "", submittedAt: null, url: null }],
  });
  assert.ok(kinds(state, requested).includes("changes_requested"));
  const event = evaluateUnsettledSnapshot(state, requested);
  assert.equal(event.kind, "changes_requested");
  assert.deepEqual(event.details.requestingReviewIds, ["r1"]);

  // Once acknowledged, an unchanged decision does not wake again.
  const ack = { seenCommentIds: [], seenReviewIds: ["r1"] };
  const initial = buildInitialMaterialState({ prUrl: prRef.url, threadId: "t", cwd: "/x", ownerSurface: "cli", ownerGeneration: 1 }, requested);
  ack.acknowledgedMaterialConditions = initial.currentMaterialConditions;
  ack.acknowledgedMaterialFingerprints = initial.currentMaterialFingerprints;
  assert.equal(evaluateUnsettledSnapshot(ack, requested), null);
  // The condition clears when the decision changes, so a later request wakes again.
  assert.equal(evaluateUnsettledSnapshot(ack, snapshot({ core: { reviewDecision: "APPROVED" } }))?.kind, "ready_to_merge");
  assert.equal(ack.acknowledgedMaterialConditions.some((c) => c.kind === "changes_requested"), false);
  assert.equal(evaluateUnsettledSnapshot(ack, requested)?.kind, "changes_requested");
});

test("a review body with no inline comments wakes; inline-backed, self, legacy, and seen reviews do not", () => {
  const review = (id, overrides = {}) => ({ id, author: "reviewer", state: "COMMENTED", body: "Please rethink the cache.", submittedAt: null, url: `u${id}`, ...overrides });
  const state = {
    seenCommentIds: [],
    seenReviewIds: ["old"],
    commentMonitoring: { schema: "x", authenticatedLogin: "me", includeSelfComments: false },
  };
  const snap = snapshot({
    reviews: [
      review("old"),
      review("fresh"),
      review("with-inline"),
      review("mine", { author: "me" }),
      review("empty", { body: "  " }),
    ],
    comments: [{ id: "c1", author: "reviewer", body: "nit", reviewId: "with-inline", createdAt: null, url: null }],
  });
  state.seenCommentIds = ["c1"];
  const events = materialEvents(state, snap);
  const bodies = events.find((event) => event.kind === "new_review_bodies");
  assert.deepEqual(bodies.details.reviews.map((r) => r.id), ["fresh"]);

  // A state from before review tracking adopts current reviews instead of waking for history.
  const legacy = { seenCommentIds: ["c1"] };
  assert.equal(kinds(legacy, snap).includes("new_review_bodies"), false);
  evaluateUnsettledSnapshot(legacy, snap);
  assert.deepEqual(new Set(legacy.seenReviewIds), new Set(["old", "fresh", "with-inline", "mine", "empty"]));

  // Registration treats existing reviews as the baseline.
  const initial = buildInitialMaterialState({ prUrl: prRef.url, threadId: "t", cwd: "/x", ownerSurface: "cli", ownerGeneration: 1 }, snap);
  assert.equal(initial?.event.details.currentEvents.some((e) => e.kind === "new_review_bodies") ?? false, false);
});

test("BLOCKED with a failing head rollup and no visible failing check wakes as ci_rollup_refused", () => {
  const state = { seenCommentIds: [], seenReviewIds: [] };
  const refused = snapshot({ core: { mergeStateStatus: "BLOCKED", reviewDecision: "APPROVED" }, headRollupState: "FAILURE" });
  const event = materialEvents(state, refused).find((e) => e.kind === "ci_rollup_refused");
  assert.deepEqual(event.details, { headRefOid: "abc", mergeStateStatus: "BLOCKED", rollupState: "FAILURE" });
  assert.equal(kinds(state, snapshot({ core: { mergeStateStatus: "BLOCKED" }, headRollupState: "SUCCESS" })).includes("ci_rollup_refused"), false);
  const visible = snapshot({
    core: { mergeStateStatus: "BLOCKED" },
    headRollupState: "FAILURE",
    checks: [{ kind: "check_run", name: "test", status: "COMPLETED", conclusion: "FAILURE", url: null }],
  });
  assert.deepEqual(kinds(state, visible).filter((k) => k.startsWith("ci_")), ["ci_checks_failed"]);
  assert.equal(kinds(state, snapshot({ core: { mergeStateStatus: "BLOCKED", mergeQueueEntry: { id: "q", state: "QUEUED", headCommit: { oid: "abc" } } }, headRollupState: "FAILURE" })).includes("ci_rollup_refused"), false);
});

test("a stall deadline wakes once after no observable progress and restarts on any change", () => {
  const at = (iso, overrides = {}) => snapshot({ observedAt: iso, core: { reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" }, ...overrides });
  const state = { seenCommentIds: [], seenReviewIds: [], stallAfterSeconds: 600 };
  assert.equal(stallEvent(state, at("2026-09-29T10:00:00Z")), null);
  assert.equal(stallEvent(state, at("2026-09-29T10:05:00Z")), null);
  const woke = stallEvent(state, at("2026-09-29T10:10:00Z"));
  assert.equal(woke.kind, "stalled");
  assert.equal(woke.details.since, "2026-09-29T10:00:00Z");
  assert.equal(stallEvent(state, at("2026-09-29T10:30:00Z")), null, "one stall wakes once");

  // Any observable change restarts the clock.
  const moved = at("2026-09-29T10:31:00Z", { reviews: [{ id: "r9", author: "x", state: "COMMENTED", body: "", submittedAt: null, url: null }] });
  assert.equal(stallEvent(state, moved), null);
  assert.equal(state.stallSince, "2026-09-29T10:31:00Z");

  // No deadline, a queued PR, or a merged PR never stalls.
  assert.equal(stallEvent({}, at("2026-09-29T12:00:00Z")), null);
  const queuedState = { stallAfterSeconds: 60 };
  const queued = (iso) => at(iso, { core: { mergeQueueEntry: { id: "q", state: "QUEUED", headCommit: { oid: "abc" } } } });
  stallEvent(queuedState, queued("2026-09-29T10:00:00Z"));
  assert.equal(stallEvent(queuedState, queued("2026-09-29T11:00:00Z")), null);

  // evaluateMonitorPoll surfaces the stall with an event id.
  const polled = { seenCommentIds: [], seenReviewIds: [], stallAfterSeconds: 600, stallFingerprint: state.stallFingerprint, stallSince: "2026-09-29T10:31:00Z" };
  const event = evaluateMonitorPoll(polled, at("2026-09-29T10:45:00Z", { reviews: moved.reviews }));
  assert.equal(event.kind, "stalled");
  assert.ok(event.eventId);
});

test("snapshot returns one typed verdict with a stable exit code and never registers a monitor", () => {
  const verdict = (overrides) => snapshotVerdict(prRef, snapshot(overrides));
  assert.equal(verdict({}).verdict, "ready");
  assert.equal(verdict({}).exitCode, 0);
  assert.equal(verdict({ core: { merged: true, state: "MERGED" } }).verdict, "merged");
  assert.equal(verdict({ core: { state: "CLOSED" } }).exitCode, 6);
  assert.equal(verdict({ core: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } }).exitCode, 2);
  const threads = verdict({ reviewThreads: [reviewThread()] });
  assert.equal(threads.exitCode, 3);
  assert.equal(threads.unresolvedThreads.count, 1);
  const failing = verdict({ checks: [{ kind: "check_run", name: "test", status: "COMPLETED", conclusion: "FAILURE", url: "f" }] });
  assert.equal(failing.exitCode, 4);
  assert.deepEqual(failing.failingChecks, [{ name: "test", url: "f" }]);
  const refused = verdict({ core: { mergeStateStatus: "BLOCKED" }, headRollupState: "ERROR" });
  assert.equal(refused.verdict, "ci_failing");
  assert.equal(refused.rollupRefused, true);
  assert.equal(verdict({ checks: [{ kind: "check_run", name: "slow", status: "IN_PROGRESS", conclusion: null, url: null }] }).exitCode, 5);
  assert.equal(verdict({ core: { mergeQueueEntry: { id: "q", state: "QUEUED", position: 2 } } }).verdict, "queued");
  const gate = verdict({ core: { reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED" } });
  assert.equal(gate.exitCode, 6);
  assert.deepEqual(gate.gates, ["changes_requested", "merge_state_blocked"]);
  assert.equal(SNAPSHOT_EXIT_CODES.query_failed, 7);

  const failed = takeSnapshot(prRef.url, { fetchSnapshot: () => { throw new Error("rate limited"); } });
  assert.equal(failed.verdict, "query_failed");
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.error, "rate limited");
  assert.equal(takeSnapshot(prRef.url, { fetchSnapshot: () => snapshot() }).exitCode, 0);
});

test("snapshot CLI requires a PR URL", () => {
  const result = spawnSync(process.execPath, [new URL("./monitor-pr.mjs", import.meta.url).pathname, "snapshot"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: monitor-pr\.mjs snapshot <pr-url>/);
});
