#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureProcessIdentity,
  verifyProcessIdentity,
} from "./process-identity.mjs";

const FAILURE_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);
const SUCCESS_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const MAX_QUERY_FAILURES = 3;
const OWNER_SURFACES = new Set(["desktop", "cli"]);
const ROOT_TRANSFER_SCHEMA = "CL_SWEEP_ROOT_TRANSFER v1";
const ROOT_AUTHORITY_SCHEMA = "CL_SWEEP_ROOT_AUTHORITY v1";
const ROOT_SCOPE_SCHEMA = "CL_SWEEP_ROOT_SCOPE v1";
const ROOT_REGISTRY_SCHEMA = "CL_SWEEP_ROOT_REGISTRY v1";
const OWNERSHIP_SCHEMA = "CL_SWEEP_OWNERSHIP v1";
const LEGACY_BINDING_REPAIR_SCHEMA = "GH_MONITOR_PR_LEGACY_BINDING_REPAIR v1";
const LEGACY_BINDING_AUDIT_SCHEMA = "GH_MONITOR_PR_LEGACY_BINDING_AUDIT v1";
const REGISTRATION_SCHEMA = "GH_MONITOR_PR_REGISTRATION v1";
const COMMENT_MONITORING_SCHEMA = "GH_MONITOR_PR_COMMENT_MONITORING v1";
const INITIAL_MATERIAL_POLICIES = new Set(["reject", "deliver"]);
const INITIAL_MATERIAL_EXIT_CODE = 2;
const BOOLEAN_OPTIONS = new Set(["include-self-comments"]);
export const NOTIFICATION_DELIVERY_WAIT_SECONDS = 180;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function eventId(event) {
  return event.eventId || sha256(JSON.stringify({
    kind: event.kind,
    observedAt: event.observedAt,
    details: event.details,
  }));
}

function fail(message) {
  throw new Error(message);
}

function now() {
  return new Date().toISOString();
}

/** Parse monitor CLI arguments, including explicit boolean switches. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options, positional };
}

/** Parse and validate a GitHub pull-request URL. */
export function parsePrUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`Invalid pull-request URL: ${value}`);
  }
  if (url.protocol !== "https:") fail("The pull-request URL must use https");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull" || !/^\d+$/.test(parts[3])) {
    fail("Expected a URL shaped like https://github.com/OWNER/REPO/pull/123");
  }
  return {
    host: url.hostname,
    owner: parts[0],
    repo: parts[1],
    number: Number(parts[3]),
    url: `${url.protocol}//${url.host}/${parts[0]}/${parts[1]}/pull/${parts[3]}`,
  };
}

function runGh(args, host) {
  const hostArgs = host === "github.com" ? [] : ["--hostname", host];
  const result = spawnSync("gh", ["api", ...hostArgs, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) fail(`Unable to run gh: ${result.error.message}`);
  if (result.status !== 0) fail(result.stderr.trim() || `gh api exited ${result.status}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`GitHub returned invalid JSON: ${result.stdout.slice(0, 300)}`);
  }
}

/** Resolve the login used by `gh api` for the pull request's GitHub host. */
export function fetchAuthenticatedLogin(host, runner = runGh) {
  const user = runner(["user"], host);
  const login = typeof user?.login === "string" ? user.login.trim() : "";
  if (!login) {
    fail(`GitHub did not return the authenticated login for ${host}`);
  }
  return login;
}

/** Build the persisted inline-comment policy for one registration generation. */
export function buildCommentMonitoring(options, authenticatedLogin, previousState = null) {
  const login = typeof authenticatedLogin === "string" ? authenticatedLogin.trim() : "";
  if (!login) fail("Inline-comment monitoring requires the authenticated GitHub login");
  return {
    schema: COMMENT_MONITORING_SCHEMA,
    authenticatedLogin: login,
    includeSelfComments: options["include-self-comments"] === true ||
      previousState?.commentMonitoring?.includeSelfComments === true,
  };
}

function flattenSlurpedPages(value, field = null) {
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page) => {
    const rows = field ? page?.[field] : page;
    return Array.isArray(rows) ? rows : [];
  });
}

function fetchCore(pr) {
  const query = `
    query PrMonitor($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          title url state isDraft merged mergedAt headRefOid
          mergeable mergeStateStatus reviewDecision
          mergeQueueEntry {
            id state position enqueuedAt
            headCommit { oid }
          }
          commits(last: 1) {
            nodes { commit { oid statusCheckRollup { state } } }
          }
        }
      }
    }
  `;
  const response = runGh([
    "graphql",
    "-f", `query=${query}`,
    "-F", `owner=${pr.owner}`,
    "-F", `repo=${pr.repo}`,
    "-F", `number=${pr.number}`,
  ], pr.host);
  if (response.errors?.length) fail(`GitHub GraphQL error: ${response.errors.map((e) => e.message).join("; ")}`);
  const core = response.data?.repository?.pullRequest;
  if (!core) fail(`Pull request not found: ${pr.url}`);
  return core;
}

function fetchInlineComments(pr) {
  const value = runGh([
    `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments?per_page=100`,
    "--paginate",
    "--slurp",
  ], pr.host);
  return flattenSlurpedPages(value).map((comment) => ({
    id: String(comment.id),
    author: comment.user?.login ?? "unknown",
    body: comment.body ?? "",
    path: comment.path ?? null,
    line: comment.line ?? comment.original_line ?? null,
    createdAt: comment.created_at,
    url: comment.html_url,
    reviewId: comment.pull_request_review_id == null ? null : String(comment.pull_request_review_id),
  }));
}

function fetchReviews(pr) {
  const value = runGh([
    `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`,
    "--paginate",
    "--slurp",
  ], pr.host);
  return flattenSlurpedPages(value).map((review) => ({
    id: String(review.id),
    author: review.user?.login ?? "unknown",
    state: String(review.state ?? "").toUpperCase(),
    body: review.body ?? "",
    submittedAt: review.submitted_at ?? null,
    url: review.html_url ?? null,
  }));
}

function fetchReviewThreads(pr) {
  const query = `
    query PrReviewThreads($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $endCursor) {
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              startLine
              comments(first: 100) {
                totalCount
                nodes {
                  id
                  databaseId
                  author { login }
                  body
                  createdAt
                  url
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const value = runGh([
    "graphql",
    "-f", `query=${query}`,
    "-F", `owner=${pr.owner}`,
    "-F", `repo=${pr.repo}`,
    "-F", `number=${pr.number}`,
    "--paginate",
    "--slurp",
  ], pr.host);
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page) => {
    if (page.errors?.length) {
      fail(`GitHub GraphQL error: ${page.errors.map((error) => error.message).join("; ")}`);
    }
    const threads = page.data?.repository?.pullRequest?.reviewThreads?.nodes;
    return Array.isArray(threads) ? threads : [];
  }).map((thread) => {
    const comments = Array.isArray(thread.comments?.nodes) ? thread.comments.nodes : [];
    const normalizedComments = comments.map((comment) => ({
      id: comment.databaseId == null ? String(comment.id) : String(comment.databaseId),
      nodeId: comment.id == null ? null : String(comment.id),
      author: comment.author?.login ?? "unknown",
      body: comment.body ?? "",
      createdAt: comment.createdAt ?? null,
      url: comment.url ?? null,
    }));
    const totalCount = Number.isSafeInteger(thread.comments?.totalCount)
      ? thread.comments.totalCount
      : normalizedComments.length;
    return {
      id: String(thread.id),
      isResolved: Boolean(thread.isResolved),
      isOutdated: Boolean(thread.isOutdated),
      path: thread.path ?? null,
      line: thread.line ?? null,
      startLine: thread.startLine ?? null,
      comments: normalizedComments,
      commentIds: normalizedComments.map((comment) => comment.id),
      commentsTotalCount: totalCount,
      commentsTruncated: totalCount > normalizedComments.length,
      url: [...normalizedComments].reverse().find((comment) => comment.url)?.url ?? null,
    };
  });
}

function fetchChecks(pr, sha) {
  const checkPages = runGh([
    `repos/${pr.owner}/${pr.repo}/commits/${sha}/check-runs?per_page=100&filter=latest`,
    "-H", "Accept: application/vnd.github+json",
    "--paginate",
    "--slurp",
  ], pr.host);
  const statusPages = runGh([
    `repos/${pr.owner}/${pr.repo}/commits/${sha}/statuses?per_page=100`,
    "--paginate",
    "--slurp",
  ], pr.host);
  const checkRuns = flattenSlurpedPages(checkPages, "check_runs").map((check) => ({
    kind: "check_run",
    runId: check.id == null ? null : String(check.id),
    name: check.name,
    appId: check.app?.id == null ? null : String(check.app.id),
    appSlug: check.app?.slug ?? null,
    startedAt: check.started_at ?? null,
    status: String(check.status ?? "").toUpperCase(),
    conclusion: check.conclusion ? String(check.conclusion).toUpperCase() : null,
    url: check.html_url ?? check.details_url ?? null,
  }));

  // Commit-status history is newest-first. Only the latest state for each context matters.
  const latestStatuses = new Map();
  for (const status of flattenSlurpedPages(statusPages)) {
    if (!latestStatuses.has(status.context)) latestStatuses.set(status.context, status);
  }
  const statuses = [...latestStatuses.values()].map((status) => ({
    kind: "commit_status",
    name: status.context,
    status: String(status.state ?? "").toUpperCase(),
    conclusion: null,
    url: status.target_url ?? null,
  }));
  return [...checkRuns, ...statuses];
}

function compareCheckRunRecency(candidate, current) {
  if (candidate.runId != null && current.runId != null &&
      /^\d+$/.test(candidate.runId) && /^\d+$/.test(current.runId)) {
    const candidateId = BigInt(candidate.runId);
    const currentId = BigInt(current.runId);
    if (candidateId !== currentId) return candidateId > currentId ? 1 : -1;
  }

  const candidateStartedAt = Date.parse(candidate.startedAt ?? "");
  const currentStartedAt = Date.parse(current.startedAt ?? "");
  if (Number.isFinite(candidateStartedAt) && Number.isFinite(currentStartedAt) &&
      candidateStartedAt !== currentStartedAt) {
    return candidateStartedAt > currentStartedAt ? 1 : -1;
  }
  return 0;
}

/**
 * Collapse superseded check runs for one commit while retaining distinct apps.
 * GitHub's `filter=latest` is check-suite scoped, so replacements from different
 * suites may still expose an older run with the same branch-protection context.
 */
export function collapseCheckRuns(checks) {
  const authoritative = new Map();
  const passthrough = [];
  for (const check of checks) {
    if (check.kind !== "check_run") {
      passthrough.push(check);
      continue;
    }
    const appIdentity = check.appId ?? check.appSlug ?? "unknown-app";
    const key = `${appIdentity}\u0000${check.name}`;
    const current = authoritative.get(key);
    if (!current || compareCheckRunRecency(check, current) > 0) {
      authoritative.set(key, check);
    }
  }
  return [...authoritative.values(), ...passthrough];
}

function commentIsMaterial(state, comment) {
  const policy = state.commentMonitoring;
  // Version 5 and older states did not persist an authenticated login. Preserve
  // their historical include-all behavior until a new registration upgrades them.
  if (!policy || policy.includeSelfComments) return true;
  return String(comment.author ?? "").toLowerCase() !==
    String(policy.authenticatedLogin ?? "").toLowerCase();
}

function unseenMaterialComments(state, snapshot) {
  const seen = new Set(state.seenCommentIds ?? []);
  return snapshot.comments.filter((comment) => !seen.has(comment.id) && commentIsMaterial(state, comment));
}

function snapshotReviewIds(snapshot) {
  return [...new Set((snapshot.reviews ?? []).map((review) => review.id))];
}

/**
 * Reviews whose summary body carries feedback that no inline comment carries.
 * States from before review tracking have no `seenReviewIds`; they adopt the
 * current reviews as seen on their first poll instead of waking for history.
 */
function unseenMaterialReviewBodies(state, snapshot) {
  if (!Array.isArray(state.seenReviewIds)) return [];
  const seen = new Set(state.seenReviewIds);
  const reviewsWithInline = new Set((snapshot.comments ?? [])
    .map((comment) => comment.reviewId)
    .filter(Boolean));
  return (snapshot.reviews ?? []).filter((review) => !seen.has(review.id) &&
    String(review.body ?? "").trim().length > 0 &&
    !reviewsWithInline.has(review.id) &&
    commentIsMaterial(state, review));
}

function snapshotCommentIds(snapshot) {
  return [...new Set([
    ...(snapshot.comments ?? []).map((comment) => comment.id),
    ...(snapshot.reviewThreads ?? []).flatMap((thread) => thread.commentIds ?? []),
  ])];
}

function reviewThreadSummary(thread, state = null) {
  const comments = Array.isArray(thread.comments) ? thread.comments : [];
  const materialComments = state
    ? comments.filter((comment) => commentIsMaterial(state, comment))
    : comments;
  return {
    id: thread.id,
    isResolved: Boolean(thread.isResolved),
    isOutdated: Boolean(thread.isOutdated),
    path: thread.path ?? null,
    line: thread.line ?? null,
    startLine: thread.startLine ?? null,
    commentIds: Array.isArray(thread.commentIds)
      ? thread.commentIds
      : comments.map((comment) => comment.id),
    commentsTotalCount: thread.commentsTotalCount ?? comments.length,
    commentsTruncated: Boolean(thread.commentsTruncated),
    materialCommentIds: materialComments.map((comment) => comment.id),
    materialComments,
    url: thread.url ?? comments.find((comment) => comment.url)?.url ?? null,
  };
}

function reviewThreadStateSummary(thread) {
  const summary = reviewThreadSummary(thread);
  delete summary.materialCommentIds;
  delete summary.materialComments;
  return summary;
}

function reviewThreadStates(snapshot) {
  return (snapshot.reviewThreads ?? [])
    .map(reviewThreadStateSummary)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function unresolvedReviewThreads(snapshot) {
  return (snapshot.reviewThreads ?? []).filter((thread) => !thread.isResolved);
}

function unresolvedReviewThreadStates(snapshot) {
  return reviewThreadStates({
    reviewThreads: unresolvedReviewThreads(snapshot),
  });
}

function unresolvedReviewThreadEvent(state, snapshot) {
  const threads = unresolvedReviewThreads(snapshot);
  if (!threads.length) return null;
  const details = {
    totalUnresolvedThreads: threads.length,
    threads: threads.map((thread) => reviewThreadSummary(thread, state)),
  };
  return {
    kind: "unresolved_review_threads",
    severity: "attention",
    summary: `${threads.length} unresolved PR review thread${threads.length === 1 ? "" : "s"}`,
    details,
  };
}

/** Fetch one authoritative monitoring snapshot from GitHub. */
export function fetchSnapshot(pr) {
  const core = fetchCore(pr);
  const checkSha = core.mergeQueueEntry?.headCommit?.oid ?? core.headRefOid;
  const headCommit = core.commits?.nodes?.[0]?.commit ?? null;
  return {
    observedAt: new Date().toISOString(),
    core,
    checkSha,
    headRollupState: headCommit?.oid === core.headRefOid
      ? (headCommit?.statusCheckRollup?.state ?? null)
      : null,
    comments: fetchInlineComments(pr),
    reviews: fetchReviews(pr),
    reviewThreads: fetchReviewThreads(pr),
    checks: fetchChecks(pr, checkSha),
  };
}

function classifyChecks(checks) {
  const failing = [];
  const pending = [];
  for (const check of collapseCheckRuns(checks)) {
    if (check.kind === "commit_status") {
      if (["FAILURE", "ERROR"].includes(check.status)) failing.push(check);
      else if (check.status !== "SUCCESS") pending.push(check);
      continue;
    }
    if (check.status !== "COMPLETED") {
      pending.push(check);
    } else if (FAILURE_CONCLUSIONS.has(check.conclusion)) {
      failing.push(check);
    } else if (!SUCCESS_CONCLUSIONS.has(check.conclusion)) {
      pending.push(check);
    }
  }
  return { failing, pending };
}

/** Enumerate every concurrently material condition in priority order. */
export function materialEvents(state, snapshot) {
  const core = snapshot.core;
  const newComments = unseenMaterialComments(state, snapshot);
  const events = [];
  if (newComments.length) {
    events.push({
      kind: "new_inline_comments",
      severity: "attention",
      summary: `${newComments.length} new inline PR comment${newComments.length === 1 ? "" : "s"}`,
      details: { comments: newComments },
    });
  }
  const newReviewBodies = unseenMaterialReviewBodies(state, snapshot);
  if (newReviewBodies.length) {
    events.push({
      kind: "new_review_bodies",
      severity: "attention",
      summary: `${newReviewBodies.length} new PR review bod${newReviewBodies.length === 1 ? "y" : "ies"} without inline comments`,
      details: { reviews: newReviewBodies },
    });
  }

  if (core.merged || core.state === "MERGED") {
    events.push({
      kind: "merged",
      severity: "success",
      summary: "Pull request merged successfully",
      details: { mergedAt: core.mergedAt ?? null },
    });
    return events.filter((event) => eventKindAllowed(state, event));
  }
  if (core.state === "CLOSED") {
    events.push({
      kind: "closed_unmerged",
      severity: "attention",
      summary: "Pull request closed without merging",
      details: {},
    });
    return events.filter((event) => eventKindAllowed(state, event));
  }

  const unresolvedThreadsEvent = unresolvedReviewThreadEvent(state, snapshot);
  const hasUnresolvedReviewThreads = Boolean(unresolvedThreadsEvent);
  if (unresolvedThreadsEvent) events.push(unresolvedThreadsEvent);

  const queued = Boolean(core.mergeQueueEntry);
  if (!queued && core.reviewDecision === "CHANGES_REQUESTED") {
    events.push({
      kind: "changes_requested",
      severity: "attention",
      summary: "A reviewer requested changes",
      details: {
        headRefOid: core.headRefOid,
        reviewDecision: core.reviewDecision,
        requestingReviewIds: (snapshot.reviews ?? [])
          .filter((review) => review.state === "CHANGES_REQUESTED")
          .map((review) => review.id)
          .sort(),
      },
    });
  }
  if (state.wasQueued && !queued) {
    events.push({
      kind: "merge_queue_ejected",
      severity: "attention",
      summary: "Pull request left the merge queue before merging",
      details: { previousQueueEntryId: state.queueEntryId ?? null },
    });
  }

  if (!queued && (core.mergeable === "CONFLICTING" || core.mergeStateStatus === "DIRTY")) {
    events.push({
      kind: "source_pr_conflicting",
      severity: "attention",
      summary: "GitHub marked the unqueued source pull request conflicting",
      details: {
        headRefOid: core.headRefOid,
        mergeable: core.mergeable,
        mergeStateStatus: core.mergeStateStatus,
      },
    });
  }

  const { failing, pending } = classifyChecks(snapshot.checks);
  if (failing.length) {
    events.push({
      kind: queued ? "merge_queue_checks_failed" : "ci_checks_failed",
      severity: "attention",
      summary: `${failing.length} ${queued ? "merge-queue" : "CI"} check${failing.length === 1 ? "" : "s"} failed`,
      details: { checkSha: snapshot.checkSha, failing },
    });
  }
  if (!queued && failing.length === 0 && core.mergeStateStatus === "BLOCKED" &&
      ["FAILURE", "ERROR"].includes(snapshot.headRollupState)) {
    events.push({
      kind: "ci_rollup_refused",
      severity: "attention",
      summary: "GitHub blocks the PR on a failing head check rollup that no visible check explains",
      details: {
        headRefOid: core.headRefOid,
        mergeStateStatus: core.mergeStateStatus,
        rollupState: snapshot.headRollupState,
      },
    });
  }
  if (queued && core.mergeQueueEntry.state === "UNMERGEABLE") {
    events.push({
      kind: "merge_queue_unmergeable",
      severity: "attention",
      summary: "GitHub marked the merge-queue entry unmergeable",
      details: { queueEntry: core.mergeQueueEntry },
    });
  }

  if (!queued) {
    const reviewReady = core.reviewDecision !== "CHANGES_REQUESTED" && core.reviewDecision !== "REVIEW_REQUIRED";
    const mergeStateReady = core.mergeStateStatus === "CLEAN" || core.mergeStateStatus === "HAS_HOOKS";
    if (!hasUnresolvedReviewThreads &&
        !core.isDraft && core.mergeable === "MERGEABLE" && reviewReady && mergeStateReady &&
        failing.length === 0 && pending.length === 0) {
      events.push({
        kind: "ready_to_merge",
        severity: "success",
        summary: "Pull request is green and ready to merge",
        details: { checkSha: snapshot.checkSha, checks: snapshot.checks.length },
      });
    }
  }

  return events.filter((event) => eventKindAllowed(state, event));
}

function updateObservedCommentIds(state, snapshot) {
  state.seenCommentIds = [...new Set([
    ...(state.seenCommentIds ?? []),
    ...snapshotCommentIds(snapshot),
  ])];
  state.seenReviewIds = [...new Set([
    ...(state.seenReviewIds ?? []),
    ...snapshotReviewIds(snapshot),
  ])];
  state.reviewThreadStates = reviewThreadStates(snapshot);
  state.unresolvedReviewThreads = unresolvedReviewThreadStates(snapshot);
}

function updateObservedState(state, snapshot) {
  updateObservedCommentIds(state, snapshot);
  const queued = Boolean(snapshot.core.mergeQueueEntry);
  state.wasQueued ||= queued;
  if (queued) state.queueEntryId = snapshot.core.mergeQueueEntry.id;
  state.lastHeadOid = snapshot.core.headRefOid;
  state.lastMergeable = snapshot.core.mergeable;
  state.lastMergeStateStatus = snapshot.core.mergeStateStatus;
  state.lastCheckSha = snapshot.checkSha;
  state.lastObservedAt = snapshot.observedAt;
}

/** Decide whether a snapshot should wake Codex and update queue-tracking state. */
export function evaluateSnapshot(state, snapshot) {
  const event = materialEvents(state, snapshot)[0] ?? null;
  if (event) {
    updateObservedCommentIds(state, snapshot);
    return event;
  }
  updateObservedState(state, snapshot);
  return null;
}

function stableSnapshotSummary(snapshot) {
  const summary = summarizeSnapshot(snapshot);
  delete summary.observedAt;
  return summary;
}

function eventMaterialFingerprint(event) {
  const details = event.kind === "source_pr_conflicting"
    ? { headRefOid: event.details?.headRefOid ?? null }
    : (event.kind === "monitor_registration_delta"
      ? {
        changes: event.details?.changes || [],
        newInlineComments: event.details?.newInlineComments || [],
      }
      : (event.kind === "unresolved_review_threads"
        ? {
          threads: (event.details?.threads || []).map((thread) => ({
            id: thread.id,
            isResolved: thread.isResolved,
            isOutdated: thread.isOutdated,
            path: thread.path,
            line: thread.line,
            startLine: thread.startLine,
            materialCommentIds: thread.materialCommentIds || [],
            materialComments: thread.materialComments || [],
            commentsTruncated: Boolean(thread.commentsTruncated),
          })),
        }
        : event.details));
  return sha256(JSON.stringify({
    kind: event.kind,
    severity: event.severity,
    summary: event.summary,
    details,
  }));
}

function coveredMaterialFingerprints(event) {
  const fingerprints = [eventMaterialFingerprint(event)];
  if (event.kind !== "monitor_initial_material_state") return fingerprints;
  const currentEvents = event.details?.currentEvents
    || (event.details?.currentEvent ? [event.details.currentEvent] : []);
  for (const currentEvent of currentEvents) {
    fingerprints.push(eventMaterialFingerprint(currentEvent));
  }
  return [...new Set(fingerprints)];
}

/** Build a stable fingerprint for one material state, excluding observation time. */
export function materialStateFingerprint(snapshot, event) {
  return sha256(JSON.stringify({
    snapshot: stableSnapshotSummary(snapshot),
    event: eventMaterialFingerprint(event),
  }));
}

function materialCondition(event) {
  return {
    fingerprint: eventMaterialFingerprint(event),
    kind: event.kind,
    details: event.details,
  };
}

function checkContextKey(check) {
  if (check.kind === "commit_status") return `commit_status\u0000${check.name}`;
  return `check_run\u0000${check.appId ?? check.appSlug ?? "unknown-app"}\u0000${check.name}`;
}

function conditionAuthoritativelyResolved(condition, snapshot) {
  if (condition.kind === "source_pr_conflicting") {
    if (snapshot.core.headRefOid !== condition.details?.headRefOid) return true;
    return snapshot.core.mergeable === "MERGEABLE" &&
      ["CLEAN", "HAS_HOOKS"].includes(snapshot.core.mergeStateStatus);
  }
  if (["ci_checks_failed", "merge_queue_checks_failed"].includes(condition.kind)) {
    const currentByContext = new Map(collapseCheckRuns(snapshot.checks)
      .map((check) => [checkContextKey(check), check]));
    const priorFailures = condition.details?.failing || [];
    return priorFailures.length > 0 && priorFailures.every(
      (failure) => currentByContext.has(checkContextKey(failure)),
    );
  }
  if (condition.kind === "unresolved_review_threads") {
    const unresolvedIds = new Set(unresolvedReviewThreads(snapshot).map((thread) => thread.id));
    const priorThreads = condition.details?.threads || [];
    return priorThreads.length > 0 && priorThreads.every((thread) => !unresolvedIds.has(thread.id));
  }
  if (condition.kind === "changes_requested") {
    return snapshot.core.reviewDecision !== "CHANGES_REQUESTED";
  }
  if (condition.kind === "ci_rollup_refused") {
    return snapshot.core.headRefOid !== condition.details?.headRefOid ||
      snapshot.core.mergeStateStatus !== "BLOCKED" ||
      !["FAILURE", "ERROR"].includes(snapshot.headRollupState);
  }
  if (condition.kind === "ready_to_merge") {
    if (snapshot.core.headRefOid !== condition.details?.checkSha) return true;
    const { failing, pending } = classifyChecks(snapshot.checks);
    return snapshot.core.isDraft ||
      unresolvedReviewThreads(snapshot).length > 0 ||
      snapshot.core.reviewDecision === "CHANGES_REQUESTED" ||
      snapshot.core.reviewDecision === "REVIEW_REQUIRED" ||
      snapshot.core.mergeable === "CONFLICTING" ||
      snapshot.core.mergeStateStatus === "DIRTY" ||
      failing.length > 0 || pending.length > 0;
  }
  return false;
}

/**
 * Return the highest-priority condition not settled by the current continuous
 * baseline. Settled fingerprints are pruned when their condition disappears,
 * so a later recurrence is material again.
 */
export function evaluateUnsettledSnapshot(state, snapshot) {
  const events = materialEvents(state, snapshot);
  const current = new Map(events.map((event) => [eventMaterialFingerprint(event), event]));
  const acknowledged = new Map((state.acknowledgedMaterialConditions || [])
    .map((condition) => [condition.fingerprint, condition]));
  for (const fingerprint of state.acknowledgedMaterialFingerprints || []) {
    if (!acknowledged.has(fingerprint)) {
      acknowledged.set(fingerprint, { fingerprint, kind: "legacy_opaque", details: null });
    }
  }

  // Migrate version-5 states that recorded only the winning condition.
  if (state.acknowledgedCurrentMaterialFingerprint) {
    for (const [fingerprint, event] of current) {
      if (materialStateFingerprint(snapshot, event) === state.acknowledgedCurrentMaterialFingerprint) {
        acknowledged.set(fingerprint, materialCondition(event));
      }
    }
    delete state.acknowledgedCurrentMaterialFingerprint;
  }

  for (const [fingerprint, condition] of acknowledged) {
    if (!current.has(fingerprint) && conditionAuthoritativelyResolved(condition, snapshot)) {
      acknowledged.delete(fingerprint);
    }
  }
  state.acknowledgedMaterialConditions = [...acknowledged.values()]
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  state.acknowledgedMaterialFingerprints = state.acknowledgedMaterialConditions
    .map((condition) => condition.fingerprint);
  const settled = new Set(state.acknowledgedMaterialFingerprints);
  const event = events.find((candidate) => !settled.has(eventMaterialFingerprint(candidate))) ?? null;
  if (event) updateObservedCommentIds(state, snapshot);
  else updateObservedState(state, snapshot);
  return event;
}

function registrationDeltaEvent(registrationDelta) {
  if (!registrationDelta?.detected) return null;
  const material = {
    changes: registrationDelta.changes || [],
    newInlineComments: registrationDelta.newInlineComments || [],
  };
  return {
    eventId: sha256(JSON.stringify({ kind: "monitor_registration_delta", material })),
    kind: "monitor_registration_delta",
    severity: "attention",
    summary: "PR state changed while monitor ownership was transferring",
    observedAt: registrationDelta.currentObservedAt,
    details: {
      ...material,
      previousObservedAt: registrationDelta.previousObservedAt,
      currentObservedAt: registrationDelta.currentObservedAt,
    },
  };
}

function pendingHandoffEvents(previousState) {
  if (!previousState) return [];
  const pendingEvents = [...(previousState.pendingEvents || [])];
  if (previousState.event && ["waking", "notification_failed"].includes(previousState.status)) {
    pendingEvents.push(previousState.event);
  }
  const delivered = new Set([
    ...(previousState.deliveredEventIds || []),
    ...(previousState.reconciledEventIds || []),
  ]);
  const byId = new Map();
  for (const event of pendingEvents) {
    const id = eventId(event);
    if (!delivered.has(id)) byId.set(id, { ...event, eventId: id });
  }
  return [...byId.values()];
}

/**
 * Consolidate every material fact present at registration into one fenced event.
 * The caller must either acknowledge this exact event or select monitor-owned
 * delivery; it must never route the same registration event through both paths.
 */
export function buildInitialMaterialState(binding, baseline, previousState = null, registrationDelta = null) {
  const seed = {
    seenCommentIds: snapshotCommentIds(baseline),
    seenReviewIds: snapshotReviewIds(baseline),
    wasQueued: Boolean(baseline.core.mergeQueueEntry),
    queueEntryId: baseline.core.mergeQueueEntry?.id ?? null,
    commentMonitoring: binding.commentMonitoring ?? previousState?.commentMonitoring ?? null,
  };
  const currentEvents = materialEvents(seed, baseline).map((event) => ({
    ...event,
    observedAt: baseline.observedAt,
    eventId: eventId({ ...event, observedAt: baseline.observedAt }),
  }));
  const currentEvent = currentEvents[0] ?? null;
  const deltaEvent = registrationDeltaEvent(registrationDelta);
  const carriedEvents = pendingHandoffEvents(previousState);
  const rawSources = [...currentEvents, deltaEvent, ...carriedEvents].filter(Boolean);
  if (rawSources.length === 0) return null;

  const sourceEventIds = [...new Set(rawSources.map((event) => eventId(event)))];
  const ambiguousDeliveryEventIds = [...new Set((previousState?.deliveryOutbox || [])
    .filter((entry) => entry.delivery?.status === "delivering")
    .map((entry) => eventId(entry.event))
    .filter((id) => sourceEventIds.includes(id)))];
  const sourceFingerprints = [...new Set(rawSources.map(eventMaterialFingerprint))].sort();
  const materialFingerprint = sha256(JSON.stringify({
    snapshot: stableSnapshotSummary(baseline),
    sources: sourceFingerprints,
  }));
  const fencedEventId = sha256(JSON.stringify({
    schema: REGISTRATION_SCHEMA,
    prUrl: binding.prUrl,
    threadId: binding.threadId,
    cwd: binding.cwd,
    ownerSurface: binding.ownerSurface,
    ownerGeneration: binding.ownerGeneration,
    materialFingerprint,
  }));
  const severity = rawSources.some((event) => event.severity !== "success") ? "attention" : "success";
  const summary = rawSources.length === 1
    ? rawSources[0].summary
    : `${rawSources.length} material PR conditions were present at monitor registration`;
  return {
    detected: true,
    eventId: fencedEventId,
    materialFingerprint,
    currentMaterialFingerprint: currentEvent ? materialStateFingerprint(baseline, currentEvent) : null,
    currentMaterialFingerprints: currentEvents.map(eventMaterialFingerprint).sort(),
    currentMaterialConditions: currentEvents.map(materialCondition)
      .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
    sourceEventIds,
    ambiguousDeliveryEventIds,
    event: {
      eventId: fencedEventId,
      kind: "monitor_initial_material_state",
      severity,
      summary,
      observedAt: baseline.observedAt,
      details: {
        currentEvent,
        currentEvents,
        registrationDelta: registrationDelta?.detected ? registrationDelta : null,
        carriedEvents,
      },
    },
  };
}

/** Map a structured start result to the CLI's fail-closed registration status. */
export function registrationExitCode(result) {
  return result?.monitorStarted === false && result?.status === "initial_material_state"
    ? INITIAL_MATERIAL_EXIT_CODE
    : 0;
}

/** Persist the fields needed to identify a registration-to-registration delta. */
export function summarizeSnapshot(snapshot) {
  const checkStates = collapseCheckRuns(snapshot.checks).map((check) => ({
    kind: check.kind,
    name: check.name,
    status: check.status,
    conclusion: check.conclusion ?? null,
    runId: check.runId ?? null,
    appId: check.appId ?? null,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    observedAt: snapshot.observedAt,
    state: snapshot.core.state,
    merged: Boolean(snapshot.core.merged),
    headRefOid: snapshot.core.headRefOid,
    mergeable: snapshot.core.mergeable,
    mergeStateStatus: snapshot.core.mergeStateStatus,
    reviewDecision: snapshot.core.reviewDecision ?? null,
    isDraft: Boolean(snapshot.core.isDraft),
    checkSha: snapshot.checkSha,
    queueEntryId: snapshot.core.mergeQueueEntry?.id ?? null,
    queueState: snapshot.core.mergeQueueEntry?.state ?? null,
    commentIds: snapshotCommentIds(snapshot),
    reviewThreads: reviewThreadStates(snapshot),
    unresolvedReviewThreads: unresolvedReviewThreadStates(snapshot),
    checkStates,
  };
}

function previousSnapshotSummary(state) {
  const last = state.lastSnapshot ?? {};
  const registration = state.registrationSnapshot ?? {};
  return {
    observedAt: last.observedAt ?? registration.observedAt ?? state.lastObservedAt ?? state.startedAt ?? null,
    state: last.state ?? registration.state ?? null,
    merged: last.merged ?? registration.merged ?? (last.state === "MERGED" ? true : null),
    headRefOid: last.headRefOid ?? registration.headRefOid ?? state.lastHeadOid ?? null,
    mergeable: last.mergeable ?? registration.mergeable ?? state.lastMergeable ?? null,
    mergeStateStatus: last.mergeStateStatus ?? registration.mergeStateStatus ?? state.lastMergeStateStatus ?? null,
    reviewDecision: last.reviewDecision ?? registration.reviewDecision ?? null,
    isDraft: last.isDraft ?? registration.isDraft ?? null,
    checkSha: last.checkSha ?? registration.checkSha ?? state.lastCheckSha ?? null,
    queueEntryId: last.queueEntryId ?? registration.queueEntryId ?? state.queueEntryId ?? null,
    queueState: last.queueState ?? registration.queueState ?? null,
    commentIds: state.seenCommentIds ?? registration.commentIds ?? [],
    reviewThreads: Array.isArray(last.reviewThreads)
      ? last.reviewThreads
      : (Array.isArray(registration.reviewThreads) ? registration.reviewThreads : null),
    unresolvedReviewThreads: Array.isArray(last.unresolvedReviewThreads)
      ? last.unresolvedReviewThreads
      : (Array.isArray(registration.unresolvedReviewThreads) ? registration.unresolvedReviewThreads : null),
    checkStates: Array.isArray(last.checkStates)
      ? last.checkStates
      : (Array.isArray(registration.checkStates) ? registration.checkStates : null),
  };
}

/** Compare a stopped monitor's last known snapshot with a replacement baseline. */
export function buildReregistrationDelta(
  previousState,
  baseline,
  commentMonitoring = previousState.commentMonitoring ?? null,
) {
  const previous = previousSnapshotSummary(previousState);
  const current = summarizeSnapshot(baseline);
  const changes = [];
  for (const field of [
    "state", "merged", "headRefOid", "mergeable", "mergeStateStatus",
    "reviewDecision", "isDraft", "checkSha", "queueEntryId", "queueState",
  ]) {
    if (previous[field] != null && previous[field] !== current[field]) {
      changes.push({ field, before: previous[field], after: current[field] });
    }
  }
  if (previous.checkStates) {
    const before = JSON.stringify(previous.checkStates);
    const after = JSON.stringify(current.checkStates);
    if (before !== after) changes.push({ field: "checkStates", before: previous.checkStates, after: current.checkStates });
  }
  if (previous.reviewThreads) {
    const before = JSON.stringify(previous.reviewThreads);
    const after = JSON.stringify(current.reviewThreads);
    if (before !== after) changes.push({ field: "reviewThreads", before: previous.reviewThreads, after: current.reviewThreads });
  }
  const newInlineComments = unseenMaterialComments({
    seenCommentIds: previous.commentIds ?? [],
    commentMonitoring,
  }, baseline);
  const detected = changes.length > 0 || newInlineComments.length > 0;
  return {
    detected,
    previousObservedAt: previous.observedAt,
    currentObservedAt: current.observedAt,
    changes,
    newInlineComments,
    guidance: detected
      ? "Treat this delta as registration material. The start contract must either require exact caller acknowledgement or queue one monitor-owned wake."
      : "No registration delta was detected; continue from the replacement baseline.",
  };
}

function codexRoot() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function statePathFor(pr, threadId) {
  const safe = `${pr.host}-${pr.owner}-${pr.repo}-${pr.number}-${threadId}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return join(codexRoot(), "pr-monitors", `${safe}.json`);
}

function sharedAppServer() {
  const socket = join(codexRoot(), "app-server-control", "app-server-control.sock");
  const candidates = [
    join(codexRoot(), "packages", "standalone", "current", "codex"),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "codex",
  ];
  for (const executable of candidates) {
    if (executable.includes("/") && !existsSync(executable)) continue;
    const start = spawnSync(executable, ["app-server", "daemon", "start"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (start.status !== 0) continue;
    const probe = spawnSync(executable, ["app-server", "daemon", "version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (probe.status !== 0) continue;
    try {
      const version = JSON.parse(probe.stdout);
      if (version.status === "running" &&
          version.managedCodexVersion === version.appServerVersion &&
          existsSync(socket)) {
        return { executable, socket, version };
      }
    } catch {
      // Try the next known Codex executable.
    }
  }
  fail([
    "The managed Codex installation is unavailable.",
    "Run the skill's setup-app-server.mjs script,",
    "then restart ChatGPT.",
  ].join(" "));
}

function notificationHelper() {
  const helper = join(dirname(fileURLToPath(import.meta.url)), "app-server-notify.js");
  if (!existsSync(helper)) fail(`The App Server notification helper is missing: ${helper}`);
  return helper;
}

/**
 * Run the notifier probe without imposing a shorter parent deadline than the
 * notifier's bounded App Server requests. The separate process preserves the
 * legacy/static runtime surface used by detached monitor notifications.
 */
export function runNotifierProbe(invocation, appServer, threadId, dependencies = {}) {
  const helper = dependencies.helper || notificationHelper();
  const spawnProcess = dependencies.spawn || spawn;
  const child = spawnProcess(invocation.node, [
    helper,
    "--socket", appServer.socket,
    "--thread-id", threadId,
    "--probe-only",
    "--wait-seconds", "15",
    "--transport", invocation.transport,
    ...(invocation.transport === "proxy" ? ["--codex", appServer.executable] : []),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: invocation.env,
  });
  return new Promise((resolveProbe, rejectProbe) => {
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code, signal) => {
      if (spawnError) {
        rejectProbe(new Error(`Unable to inspect the launching thread in the managed App Server: ${spawnError.message}`));
        return;
      }
      if (code !== 0) {
        rejectProbe(new Error(
          stderr.trim() || `Managed App Server thread probe exited ${code ?? `on signal ${signal || "unknown"}`}`,
        ));
        return;
      }
      let probe;
      try {
        probe = JSON.parse(stdout.trim());
      } catch {
        rejectProbe(new Error(`Managed App Server thread probe returned invalid output: ${stdout.slice(0, 300)}`));
        return;
      }
      if (probe.result !== "probed" || probe.threadStatus === "systemError") {
        rejectProbe(new Error(`Managed App Server returned an invalid thread probe: ${stdout.trim()}`));
        return;
      }
      resolveProbe(probe);
    });
  });
}

function proxyInvocation() {
  return { node: process.execPath, transport: "proxy", env: process.env };
}

function desktopInvocation() {
  return {
    node: process.execPath,
    transport: "desktop",
    env: process.env,
  };
}

/** Verify the exact owner thread and choose its notification transport. */
async function probeSharedThread(appServer, threadId, ownerSurface) {
  const failures = [];
  try {
    return { probe: await runNotifierProbe(proxyInvocation(), appServer, threadId), invocation: proxyInvocation() };
  } catch (error) {
    failures.push(`portable proxy: ${error.message}`);
  }
  if (ownerSurface === "cli") {
    fail(`The CLI owner requires the portable App Server proxy, but its probe failed (${failures.join("; ")}).`);
  }
  try {
    const invocation = desktopInvocation();
    return { probe: await runNotifierProbe(invocation, appServer, threadId), invocation };
  } catch (error) {
    failures.push(`Desktop fallback: ${error.message}`);
  }
  fail(`No App Server notification transport could probe the owner thread (${failures.join("; ")}).`);
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Claim one root-transfer receipt for one exact prior monitor state and target owner. */
export function claimMonitorTransfer(receiptFile, receipt, claim) {
  const lockFile = `${receiptFile}.monitor-claims.lock`;
  let lockFd;
  try {
    lockFd = openSync(lockFile, "wx", 0o600);
    const current = readState(receiptFile);
    if (current.schema !== ROOT_TRANSFER_SCHEMA || current.transferId !== receipt.transferId) {
      fail("Root-transfer receipt changed before monitor claim");
    }
    current.monitorClaims ||= [];
    const prior = current.monitorClaims.find((item) => item.previousStateSha256 === claim.previousStateSha256);
    if (prior) {
      if (JSON.stringify(prior.target) !== JSON.stringify(claim.target) || prior.prUrl !== claim.prUrl) {
        fail("Root-transfer receipt was already claimed by a different monitor target");
      }
      return prior;
    }
    const recorded = { claimId: randomUUID(), ...claim, claimedAt: new Date().toISOString() };
    current.monitorClaims.push(recorded);
    writeState(receiptFile, current);
    return recorded;
  } finally {
    if (lockFd != null) {
      closeSync(lockFd);
      try { unlinkSync(lockFile); } catch {}
    }
  }
}

/** Carry all unacknowledged monitor work across an owner-generation handoff. */
export function buildMonitorHandoff(previousState, registrationDelta, options = {}) {
  const deliveredEventIds = [...new Set(previousState.deliveredEventIds || [])];
  const acknowledgedEventIds = new Set([
    ...(previousState.reconciledEventIds || []),
    ...(options.acknowledgedEventIds || []),
  ]);
  const pendingEvents = pendingHandoffEvents(previousState);
  const deltaEvent = registrationDeltaEvent(registrationDelta);
  if (deltaEvent) pendingEvents.push(deltaEvent);
  const byId = new Map();
  for (const event of pendingEvents) {
    const id = eventId(event);
    if (!deliveredEventIds.includes(id) && !acknowledgedEventIds.has(id)) {
      byId.set(id, { ...event, eventId: id });
    }
  }
  return {
    deliveredEventIds,
    pendingEvents: [...byId.values()],
    deliveryOutbox: [...(previousState.deliveryOutbox || [])],
  };
}

function readState(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonicalDirectory(pathValue, label) {
  if (!pathValue) fail(`${label} is required`);
  const path = realpathSync(resolve(pathValue));
  if (!statSync(path).isDirectory()) fail(`${label} must be a directory`);
  return path;
}

function canonicalFile(pathValue, label) {
  if (!pathValue) fail(`${label} is required`);
  const path = realpathSync(resolve(pathValue));
  if (!statSync(path).isFile()) fail(`${label} must be a file`);
  return path;
}

function parseGeneration(value, option) {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    fail(`${option} must be a non-negative whole number`);
  }
  return generation;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function eventPrompt(state, event) {
  const action = event.severity === "success"
    ? "Report the successful state to the user and do not change the PR unless the existing thread explicitly requires more work."
    : "Inspect the cited PR state, continue the existing authorized workflow, and address the problem if the thread already authorizes changes. Restart $gh-monitor-pr afterward when continued monitoring is appropriate.";
  return [
    `[gh-monitor-pr] Detached monitor event for ${state.pr.url}`,
    `Owner: ${state.ownerSurface ?? "desktop"} generation ${state.ownerGeneration ?? 0}`,
    `Event: ${event.summary}`,
    `Type: ${event.kind}`,
    `Observed: ${event.observedAt}`,
    `Evidence: ${JSON.stringify(event.details)}`,
    action,
  ].join("\n");
}

/** Supply additive defaults when reading version-3 Desktop monitor state. */
export function normalizeMonitorState(state) {
  const legacy = state.version == null || state.version <= 3;
  return {
    ...state,
    ownerSurface: state.ownerSurface ?? (legacy ? "desktop" : null),
    ownerGeneration: state.ownerGeneration ?? (legacy ? 0 : null),
    notificationTransport: state.notificationTransport ?? (legacy ? "desktop" : null),
  };
}

/** Validate explicit owner fencing metadata while preserving Desktop defaults. */
export function parseOwnerMetadata(options) {
  const ownerSurface = options["owner-surface"] ?? "desktop";
  if (!OWNER_SURFACES.has(ownerSurface)) fail("--owner-surface must be desktop or cli");
  const ownerGeneration = Number(options["owner-generation"] ?? 0);
  if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration < 0) {
    fail("--owner-generation must be a non-negative whole number");
  }
  if (ownerSurface === "cli" && ownerGeneration < 1) {
    fail("CLI ownership requires --owner-generation of at least 1");
  }
  return { ownerSurface, ownerGeneration };
}

function canonicalStoredPr(state) {
  if (!state.pr?.url) fail("Replacement state is missing its pull-request URL");
  const parsed = parsePrUrl(state.pr.url);
  for (const field of ["host", "owner", "repo", "number"]) {
    if (state.pr[field] != null && state.pr[field] !== parsed[field]) {
      fail(`Replacement state has inconsistent pull-request identity field: ${field}`);
    }
  }
  return parsed;
}

/** Validate one exact owner-generation handoff before replacement registration. */
export function validateReplacementLineage(previousState, pr, threadId, nextOwner, transfer = null) {
  const previousPr = canonicalStoredPr(previousState);
  if (previousPr.url !== pr.url ||
      previousPr.host !== pr.host ||
      previousPr.owner !== pr.owner ||
      previousPr.repo !== pr.repo ||
      previousPr.number !== pr.number) {
    fail(`Replacement state belongs to a different pull request: ${previousPr.url}`);
  }
  const legacy = previousState.version == null || previousState.version <= 3;
  const previousOwnerSurface = legacy ? "desktop" : previousState.ownerSurface;
  const previousOwnerGeneration = legacy ? 0 : previousState.ownerGeneration;
  if (!OWNER_SURFACES.has(previousOwnerSurface)) {
    fail(`Replacement state has invalid prior owner surface: ${previousOwnerSurface || "missing"}`);
  }
  if (!Number.isSafeInteger(previousOwnerGeneration) || previousOwnerGeneration < 0 ||
      (previousOwnerSurface === "cli" && previousOwnerGeneration < 1)) {
    fail(`Replacement state has invalid prior owner generation: ${previousOwnerGeneration ?? "missing"}`);
  }
  if (!OWNER_SURFACES.has(nextOwner.ownerSurface)) {
    fail(`Replacement has invalid next owner surface: ${nextOwner.ownerSurface || "missing"}`);
  }
  if (!Number.isSafeInteger(nextOwner.ownerGeneration) || nextOwner.ownerGeneration < 0 ||
      (nextOwner.ownerSurface === "cli" && nextOwner.ownerGeneration < 1)) {
    fail(`Replacement has invalid next owner generation: ${nextOwner.ownerGeneration ?? "missing"}`);
  }

  const expectedGeneration = previousOwnerGeneration + 1;
  if (nextOwner.ownerGeneration !== expectedGeneration) {
    const relation = nextOwner.ownerGeneration <= previousOwnerGeneration
      ? "equal or stale"
      : "skipped";
    fail([
      `Replacement generation must advance exactly from ${previousOwnerGeneration} to ${expectedGeneration};`,
      `received ${nextOwner.ownerGeneration} (${relation}).`,
    ].join(" "));
  }
  if (!previousState.threadId) fail("Replacement state is missing its root thread");
  if (previousState.threadId !== threadId) {
    const receipt = transfer?.receipt;
    if (!receipt) {
      fail(`Replacement state belongs to a different root thread: ${previousState.threadId}`);
    }
    const targetCwd = realpathSync(resolve(transfer.cwd));
    const previousCwd = previousState.cwd ? realpathSync(resolve(previousState.cwd)) : null;
    if (
      receipt.schema !== ROOT_TRANSFER_SCHEMA ||
      receipt.status !== "PREPARED" ||
      !receipt.transferId ||
      receipt.from?.threadId !== previousState.threadId ||
      !previousCwd ||
      realpathSync(resolve(receipt.from?.cwd || "")) !== previousCwd ||
      receipt.from?.surface !== previousOwnerSurface ||
      receipt.from?.generation !== previousOwnerGeneration ||
      receipt.to?.threadId !== threadId ||
      receipt.to?.surface !== nextOwner.ownerSurface ||
      receipt.to?.generation !== nextOwner.ownerGeneration ||
      realpathSync(resolve(receipt.to?.cwd || "")) !== targetCwd
    ) {
      fail("Root-transfer receipt does not authorize this monitor owner change");
    }
  }
  return { previousOwnerSurface, previousOwnerGeneration };
}

function trackedProcessIsActive(state, verifier = verifyProcessIdentity) {
  const expected = state.processIdentity || (state.pid ? { pid: state.pid } : null);
  if (!expected) return false;
  const observed = verifier(expected);
  if (typeof observed === "boolean") return observed;
  return Boolean(observed?.alive && observed?.matches);
}

function parseEventIdList(value) {
  if (!value) return [];
  return [...new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean))];
}

/**
 * Validate an in-place restart by the exact same owner generation.
 * Ambiguous App Server acceptances may be reconciled only by naming their exact
 * event ids; their original outbox entries remain immutable history.
 */
export function validateSameOwnerRecovery(previousState, binding, baseline, verifier = verifyProcessIdentity) {
  const previousPr = canonicalStoredPr(previousState);
  if (previousPr.url !== binding.pr.url) {
    fail(`Same-owner recovery state belongs to a different pull request: ${previousPr.url}`);
  }
  const normalized = normalizeMonitorState(previousState);
  if (
    normalized.threadId !== binding.threadId ||
    normalized.ownerSurface !== binding.ownerSurface ||
    normalized.ownerGeneration !== binding.ownerGeneration
  ) {
    fail("Same-owner recovery requires the exact prior thread, surface, and generation");
  }
  if (!previousState.cwd || realpathSync(resolve(previousState.cwd)) !== binding.cwd) {
    fail("Same-owner recovery requires the exact prior cwd");
  }
  if (!["completed", "notification_failed", "stopped"].includes(previousState.status)) {
    fail(`Same-owner recovery requires completed, notification_failed, or stopped state; received ${previousState.status}`);
  }
  if (trackedProcessIsActive(previousState, verifier)) {
    fail(`Same-owner recovery refuses a live matching monitor process: ${previousState.pid}`);
  }
  if (!/^[0-9a-f]{40,64}$/i.test(binding.expectedHead || "")) {
    fail("Same-owner recovery requires --expected-head with a full commit oid");
  }
  if (baseline.core.headRefOid !== binding.expectedHead) {
    fail(`Same-owner recovery expected head ${binding.expectedHead}, but GitHub reported ${baseline.core.headRefOid}`);
  }

  const reconciledEventIds = new Set(binding.reconciledEventIds || []);
  const ambiguousEntries = (previousState.deliveryOutbox || [])
    .filter((entry) => entry.delivery?.status === "delivering");
  const ambiguousById = new Map(ambiguousEntries.map((entry) => [eventId(entry.event), entry]));
  for (const id of reconciledEventIds) {
    const entry = ambiguousById.get(id);
    if (!entry) fail(`Reconciled event is not an ambiguous delivering receipt: ${id}`);
    const parent = entry.delivery?.parent;
    if (!parent || parent.threadId !== binding.threadId ||
        realpathSync(resolve(parent.cwd || "")) !== binding.cwd ||
        parent.generation !== binding.ownerGeneration) {
      fail(`Ambiguous delivery ${id} does not match the exact same owner binding`);
    }
    if ((previousState.deliveredEventIds || []).includes(id)) {
      fail(`Ambiguous delivery ${id} is already durably delivered`);
    }
  }
  const unresolvedAmbiguousEventIds = [...ambiguousById.keys()]
    .filter((id) => !reconciledEventIds.has(id));
  if (unresolvedAmbiguousEventIds.length) {
    fail(`Same-owner recovery requires explicit reconciliation for ambiguous event${unresolvedAmbiguousEventIds.length === 1 ? "" : "s"}: ${unresolvedAmbiguousEventIds.join(",")}`);
  }

  return {
    reconciledEventIds: [...reconciledEventIds],
    reconciledDeliveries: [...reconciledEventIds].map((id) => {
      const entry = ambiguousById.get(id);
      return {
        eventId: id,
        attemptId: entry.delivery.attemptId ?? null,
        deliveryStatus: entry.delivery.status,
        outcome: entry.delivery.outcome ?? "ambiguous",
        parent: entry.delivery.parent,
        lastUpdatedAt: entry.delivery.updatedAt ?? null,
        reconciliation: "accepted_and_handled_observed_by_exact_owner",
      };
    }),
  };
}

function rootAuthorityScopeHash(scope) {
  return sha256(JSON.stringify({
    sweepId: scope.sweepId,
    projectId: scope.projectId,
    repoKey: scope.repoKey,
    userKey: scope.userKey,
    repoCommonDir: scope.repoCommonDir,
    rootCwd: scope.rootCwd,
  }));
}

function readCurrentRootLease(ledgerFile) {
  const records = [];
  let previousHash = null;
  for (const [index, line] of readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail(`Malformed root ownership ledger at line ${index + 1}: ${error.message}`);
    }
    const { hash, ...unsigned } = record;
    if (
      record.schema !== OWNERSHIP_SCHEMA ||
      record.sequence !== index + 1 ||
      record.previousHash !== previousHash ||
      sha256(JSON.stringify(unsigned)) !== hash ||
      Object.hasOwn(record, "leaseToken") ||
      Object.hasOwn(record, "token")
    ) {
      fail(`Invalid append-only root ownership ledger at line ${index + 1}`);
    }
    records.push(record);
    previousHash = hash;
  }
  const lease = records.filter((record) => record.ticket === "@sweep-root").at(-1);
  if (!lease) fail("Persistent sweep-root lease is missing");
  return lease;
}

function readCurrentRootRegistry(registryFile, rootPath, authority) {
  const records = [];
  let previousHash = null;
  for (const [index, line] of readFileSync(registryFile, "utf8").split("\n").filter(Boolean).entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail(`Malformed sweep root registry at line ${index + 1}: ${error.message}`);
    }
    const { hash, ...unsigned } = record;
    if (
      record.schema !== ROOT_REGISTRY_SCHEMA || record.sequence !== index + 1 ||
      record.previousHash !== previousHash || sha256(JSON.stringify(unsigned)) !== hash
    ) {
      fail(`Invalid append-only sweep root registry at line ${index + 1}`);
    }
    records.push(record);
    previousHash = hash;
  }
  const current = records.filter((record) => record.sweepId === authority.sweepId).at(-1);
  if (!current || ["TERMINAL", "ABANDONED", "CREATION_PREPARED", "TRANSFER_PREPARED"].includes(current.event)) {
    fail("Sweep root registry does not contain an active current root record");
  }
  if (
    canonicalDirectory(current.rootPath, "registered root path") !== rootPath ||
    current.ownerThreadId !== authority.ownerThreadId ||
    current.ownerSurface !== authority.ownerSurface ||
    current.ownerGeneration !== authority.generation
  ) {
    fail("Sweep root registry does not match the ACTIVE root authority");
  }
  return current;
}

function requirePrivateOwnedPath(path, expectedMode, label) {
  const metadata = statSync(path);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid != null && metadata.uid !== currentUid) {
    fail(`${label} must be owned by the current user`);
  }
  if ((metadata.mode & 0o777) !== expectedMode) {
    fail(`${label} must be mode 0${expectedMode.toString(8)}`);
  }
}

function sweepRegistryBase(authorityFile, explicitStateBase = null) {
  const rootPath = canonicalDirectory(dirname(authorityFile), "sweep root path");
  requirePrivateOwnedPath(rootPath, 0o700, "Sweep root path");
  let base;
  if (explicitStateBase) {
    base = canonicalDirectory(explicitStateBase, "root state base");
  } else {
    const candidates = [dirname(rootPath), dirname(dirname(rootPath))]
      .filter((candidate, index, values) => values.indexOf(candidate) === index)
      .filter((candidate) => existsSync(resolve(candidate, "registry.jsonl")));
    if (candidates.length !== 1) {
      fail("Legacy binding repair could not identify one canonical sweep root registry; pass --root-state-base");
    }
    [base] = candidates;
  }
  requirePrivateOwnedPath(base, 0o700, "Root state base");
  const registryFile = canonicalFile(resolve(base, "registry.jsonl"), "sweep root registry");
  requirePrivateOwnedPath(registryFile, 0o600, "Sweep root registry");
  return { base, rootPath, registryFile };
}

function withSweepRegistryLock(authorityFile, explicitStateBase, callback) {
  const { base, rootPath, registryFile } = sweepRegistryBase(authorityFile, explicitStateBase);
  const lock = resolve(base, "registry.lock");
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) {
        fail(`Could not acquire sweep registry lock: ${lock}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return callback({ base, rootPath, registryFile });
  } finally {
    rmdirSync(lock);
  }
}

function exactProcessIsAbsent(state, verifier) {
  if (
    !Number.isSafeInteger(state.pid) || state.pid < 1 ||
    !state.processIdentity || state.processIdentity.pid !== state.pid ||
    typeof state.processIdentity.startToken !== "string" || !state.processIdentity.startToken ||
    !/^[0-9a-f]{64}$/i.test(state.processIdentity.commandSha256 || "")
  ) {
    fail("Legacy binding repair requires a complete exact monitor process identity");
  }
  const observed = verifier(state.processIdentity);
  if (!observed || typeof observed !== "object") {
    fail("Legacy binding repair refuses an ambiguous process-identity result");
  }
  if (observed.alive || observed.reason !== "process_absent" || observed.actual != null) {
    fail(`Legacy binding repair requires the exact monitor process to be absent; received ${observed.reason || "unknown"}`);
  }
  if (state.status !== "stopped") {
    fail(`Legacy binding repair requires durable stopped state; received ${state.status || "missing"}`);
  }
}

function validateSettledRepairEvents(state, bindingGeneration) {
  if (!Array.isArray(state.pendingEvents) || state.pendingEvents.length !== 0) {
    fail("Legacy binding repair requires no pending events");
  }
  if (!Array.isArray(state.deliveryOutbox) || !Array.isArray(state.deliveredEventIds)
      || !Array.isArray(state.reconciledEventIds)) {
    fail("Legacy binding repair requires well-formed delivery and reconciliation history");
  }
  const delivered = new Set(state.deliveredEventIds);
  const reconciled = new Set(state.reconciledEventIds);
  const stateCwd = canonicalDirectory(state.cwd, "monitor cwd");
  if (delivered.size !== state.deliveredEventIds.length || reconciled.size !== state.reconciledEventIds.length) {
    fail("Legacy binding repair refuses duplicate delivered or reconciled event ids");
  }
  const ambiguous = new Map();
  for (const entry of state.deliveryOutbox) {
    if (!entry?.event || !entry?.delivery?.status) fail("Legacy binding repair found a malformed delivery receipt");
    const id = eventId(entry.event);
    if (entry.delivery.status === "delivering") {
      if (ambiguous.has(id)) fail(`Legacy binding repair found duplicate ambiguous event ${id}`);
      ambiguous.set(id, entry);
    } else if (entry.delivery.status === "delivered") {
      if (!delivered.has(id)) fail(`Delivered receipt is missing its durable event id: ${id}`);
    } else {
      fail(`Legacy binding repair found unsettled delivery status ${entry.delivery.status} for ${id}`);
    }
  }
  for (const id of reconciled) {
    if (!ambiguous.has(id)) fail(`Reconciled event is not an ambiguous delivering receipt: ${id}`);
    if (delivered.has(id)) fail(`Ambiguous event is also marked delivered: ${id}`);
  }
  for (const [id, entry] of ambiguous) {
    if (!reconciled.has(id)) fail(`Legacy binding repair requires reconciliation for ambiguous event: ${id}`);
    const parent = entry.delivery.parent;
    if (!parent || parent.threadId !== state.threadId ||
        canonicalDirectory(parent.cwd, `ambiguous delivery ${id} parent cwd`) !== stateCwd ||
        parent.generation !== bindingGeneration) {
      fail(`Ambiguous delivery ${id} does not match the expected parent binding`);
    }
  }
  if (state.event) {
    const currentEventId = eventId(state.event);
    if (!delivered.has(currentEventId) && !reconciled.has(currentEventId)) {
      fail(`Legacy binding repair found an unreconciled current event: ${currentEventId}`);
    }
  }
  return ambiguous;
}

function validateRootAuthority(authorityFile, request, registryContext) {
  requirePrivateOwnedPath(authorityFile, 0o600, "Root authority receipt");
  const rootPath = dirname(authorityFile);
  if (authorityFile !== resolve(rootPath, "authority.json")) {
    fail("Legacy binding repair requires the canonical root authority receipt");
  }
  const scopeFile = canonicalFile(resolve(rootPath, "scope.json"), "root scope receipt");
  const ledgerFile = canonicalFile(resolve(rootPath, "ownership.jsonl"), "root ownership ledger");
  requirePrivateOwnedPath(scopeFile, 0o600, "Root scope receipt");
  requirePrivateOwnedPath(ledgerFile, 0o600, "Root ownership ledger");
  const authorityBytes = readFileSync(authorityFile);
  let authority;
  let scope;
  try {
    authority = JSON.parse(authorityBytes);
    scope = JSON.parse(readFileSync(scopeFile, "utf8"));
  } catch (error) {
    fail(`Malformed root authority or scope receipt: ${error.message}`);
  }
  if (
    authority.schema !== ROOT_AUTHORITY_SCHEMA || authority.state !== "ACTIVE" ||
    scope.schema !== ROOT_SCOPE_SCHEMA || authority.sweepId !== scope.sweepId ||
    !scope.sweepId || !scope.projectId || !scope.repoKey || !scope.userKey ||
    !scope.repoCommonDir || !scope.rootCwd ||
    authority.scopeHash !== rootAuthorityScopeHash(scope)
  ) {
    fail("Root authority receipt is not an ACTIVE exact-scope authority");
  }
  const scopeCwd = canonicalDirectory(scope.rootCwd, "root scope cwd");
  if (
    authority.ownerThreadId !== request.threadId ||
    authority.ownerSurface !== request.targetSurface ||
    authority.generation !== request.targetGeneration ||
    scopeCwd !== request.cwd
  ) {
    fail("Root authority receipt does not match the requested target thread/cwd/surface/generation");
  }
  const lease = readCurrentRootLease(ledgerFile);
  if (
    lease.event === "RELEASE" || lease.ownerRole !== "root" || lease.expiresAt !== null ||
    lease.ownerId !== authority.ownerThreadId || lease.ownerSurface !== authority.ownerSurface ||
    lease.generation !== authority.generation
  ) {
    fail("Persistent sweep-root lease does not match the ACTIVE root authority");
  }
  const registryFile = registryContext.registryFile;
  const registry = readCurrentRootRegistry(registryFile, registryContext.rootPath, authority);
  return {
    authority,
    authorityFile,
    authoritySha256: sha256(authorityBytes),
    scopeFile,
    scopeSha256: sha256(readFileSync(scopeFile)),
    ledgerFile,
    lease,
    registryFile,
    registry,
  };
}

function readBindingRepairAudit(auditFile) {
  if ((statSync(auditFile).mode & 0o777) !== 0o400) {
    fail("Legacy binding repair audit must be immutable mode 0400");
  }
  const audit = readState(auditFile);
  if (audit.schema !== LEGACY_BINDING_AUDIT_SCHEMA || !audit.originalStateBase64 || !audit.receipt) {
    fail("Legacy binding repair audit is malformed");
  }
  const originalBytes = Buffer.from(audit.originalStateBase64, "base64");
  if (sha256(originalBytes) !== audit.originalStateSha256) {
    fail("Legacy binding repair audit original-state digest does not match its retained bytes");
  }
  return { audit, originalBytes };
}

/**
 * Correct one historical monitor generation tag after proving the exact active
 * sweep-root authority. This is intentionally narrower than owner transfer.
 */
export function repairLegacyOwnerBinding(url, options, dependencies = {}) {
  const requiredOptions = [
    "state-file", "expected-thread-id", "expected-cwd", "expected-prior-owner-surface",
    "expected-prior-owner-generation", "target-owner-surface", "target-owner-generation",
    "root-authority-file",
  ];
  for (const option of requiredOptions) if (!options[option]) fail(`repair-legacy-binding requires --${option}`);
  const pr = parsePrUrl(url);
  const threadId = options["expected-thread-id"];
  const cwd = canonicalDirectory(options["expected-cwd"], "expected monitor cwd");
  const priorSurface = options["expected-prior-owner-surface"];
  const targetSurface = options["target-owner-surface"];
  if (!OWNER_SURFACES.has(priorSurface) || !OWNER_SURFACES.has(targetSurface)) {
    fail("Legacy binding repair owner surfaces must be desktop or cli");
  }
  const priorGeneration = parseGeneration(options["expected-prior-owner-generation"], "--expected-prior-owner-generation");
  const targetGeneration = parseGeneration(options["target-owner-generation"], "--target-owner-generation");
  if (priorSurface !== targetSurface || priorGeneration !== targetGeneration + 1) {
    fail("Legacy binding repair only permits a same-surface correction from target generation plus one");
  }
  const stateFile = canonicalFile(options["state-file"], "monitor state file");
  const expectedStateFile = canonicalFile(
    (dependencies.statePathFor || statePathFor)(pr, threadId),
    "canonical monitor state file",
  );
  if (stateFile !== expectedStateFile) fail(`Legacy binding repair requires the canonical state file: ${expectedStateFile}`);
  const authorityFile = canonicalFile(options["root-authority-file"], "root authority receipt");
  return withSweepRegistryLock(authorityFile, options["root-state-base"] || null, (registryContext) => {
    const authority = validateRootAuthority(
      authorityFile,
      { threadId, cwd, targetSurface, targetGeneration },
      registryContext,
    );
    const lockFile = `${stateFile}.legacy-owner-binding-repair.lock`;
    let lockFd;
    try {
      lockFd = openSync(lockFile, "wx", 0o600);
      const originalBytes = readFileSync(stateFile);
      let state;
      try { state = JSON.parse(originalBytes); } catch (error) { fail(`Malformed monitor state: ${error.message}`); }
      if (!state || typeof state !== "object" || Array.isArray(state) || !Number.isSafeInteger(state.version) || state.version < 4) {
        fail("Legacy binding repair requires a well-formed explicit-owner monitor state");
      }
      const storedPr = canonicalStoredPr(state);
      if (storedPr.url !== pr.url || state.threadId !== threadId ||
          canonicalDirectory(state.cwd, "monitor cwd") !== cwd ||
          (state.stateFile && canonicalFile(state.stateFile, "stored monitor state file") !== stateFile)) {
        fail("Legacy binding repair state does not match the exact requested PR/thread/cwd");
      }
      exactProcessIsAbsent(state, dependencies.verifyProcessIdentity || verifyProcessIdentity);
      const auditFile = `${stateFile}.legacy-owner-binding-audit.json`;
      const existingReceipt = state.legacyOwnerBindingRepair || null;
      if (existingReceipt) {
        if (
          existingReceipt.schema !== LEGACY_BINDING_REPAIR_SCHEMA ||
          existingReceipt.prior?.ownerSurface !== priorSurface ||
          existingReceipt.prior?.ownerGeneration !== priorGeneration ||
          existingReceipt.target?.threadId !== threadId || existingReceipt.target?.cwd !== cwd ||
          existingReceipt.target?.ownerSurface !== targetSurface ||
          existingReceipt.target?.ownerGeneration !== targetGeneration ||
          state.ownerSurface !== targetSurface || state.ownerGeneration !== targetGeneration ||
          existingReceipt.auditFile !== auditFile
        ) {
          fail("Legacy binding repair was already claimed by a different target or prior binding");
        }
        validateSettledRepairEvents(state, targetGeneration);
        const { audit } = readBindingRepairAudit(auditFile);
        if (audit.receipt.repairId !== existingReceipt.repairId ||
            audit.originalStateSha256 !== existingReceipt.originalStateSha256) {
          fail("Legacy binding repair audit does not match the repaired state receipt");
        }
        return { alreadyRepaired: true, stateFile, auditFile, receipt: existingReceipt };
      }
      if (state.ownerSurface !== priorSurface || state.ownerGeneration !== priorGeneration) {
        fail("Legacy binding repair state does not match the explicit expected prior owner binding");
      }
      const ambiguous = validateSettledRepairEvents(state, priorGeneration);
      const originalStateSha256 = sha256(originalBytes);
      const repairedAt = new Date().toISOString();
      const receipt = {
        schema: LEGACY_BINDING_REPAIR_SCHEMA,
        repairId: randomUUID(),
        repairedAt,
        originalStateSha256,
        auditFile,
        prior: { ownerSurface: priorSurface, ownerGeneration: priorGeneration },
        target: { threadId, cwd, ownerSurface: targetSurface, ownerGeneration: targetGeneration },
        authority: {
          authorityFile: authority.authorityFile,
          authoritySha256: authority.authoritySha256,
          scopeFile: authority.scopeFile,
          scopeSha256: authority.scopeSha256,
          sweepId: authority.authority.sweepId,
        },
        persistentRootLease: {
          ledgerFile: authority.ledgerFile,
          sequence: authority.lease.sequence,
          hash: authority.lease.hash,
          leaseId: authority.lease.leaseId,
          generation: authority.lease.generation,
        },
        rootRegistry: {
        registryFile: authority.registryFile,
        stateBase: registryContext.base,
          sequence: authority.registry.sequence,
          hash: authority.registry.hash,
          event: authority.registry.event,
        },
        reconciledParentEventIds: [...ambiguous.keys()],
      };
      const audit = {
        schema: LEGACY_BINDING_AUDIT_SCHEMA,
        createdAt: repairedAt,
        stateFile,
        originalStateSha256,
        originalStateBase64: originalBytes.toString("base64"),
        receipt,
      };
      if (existsSync(auditFile)) {
        const existing = readBindingRepairAudit(auditFile).audit;
        if (existing.originalStateSha256 !== originalStateSha256 ||
            existing.receipt.prior?.ownerSurface !== priorSurface ||
            existing.receipt.prior?.ownerGeneration !== priorGeneration ||
            JSON.stringify(existing.receipt.target) !== JSON.stringify(receipt.target)) {
          fail("Legacy binding repair audit was already claimed by different state or binding");
        }
        Object.assign(receipt, existing.receipt);
      } else {
        writeFileSync(auditFile, `${JSON.stringify(audit, null, 2)}\n`, { flag: "wx", mode: 0o400 });
        chmodSync(auditFile, 0o400);
      }
      const repaired = structuredClone(state);
      repaired.ownerSurface = targetSurface;
      repaired.ownerGeneration = targetGeneration;
      for (const entry of repaired.deliveryOutbox) {
        if (entry.delivery.status === "delivering" && repaired.reconciledEventIds.includes(eventId(entry.event))) {
          entry.delivery.parent.generation = targetGeneration;
        }
      }
      repaired.legacyOwnerBindingRepair = receipt;
      if (!readFileSync(stateFile).equals(originalBytes)) fail("Monitor state changed during legacy binding repair");
      writeState(stateFile, repaired);
      return { alreadyRepaired: false, stateFile, auditFile, receipt };
    } finally {
      if (lockFd != null) closeSync(lockFd);
      try { unlinkSync(lockFile); } catch {}
    }
  });
}

function notificationInvocationForState(state) {
  if (normalizeMonitorState(state).notificationTransport === "proxy") return proxyInvocation();
  return desktopInvocation();
}

function spawnAppServerNotification(state, prompt) {
  const invocation = notificationInvocationForState(state);
  const helper = notificationHelper();
  const socket = state.appServerSocket || join(codexRoot(), "app-server-control", "app-server-control.sock");
  const notificationCwd = existsSync(state.cwd) ? state.cwd : homedir();
  return new Promise((resolveAttempt, rejectAttempt) => {
    const child = spawn(invocation.node, [
      helper,
      "--socket", socket,
      "--thread-id", state.threadId,
      "--cwd", notificationCwd,
      "--wait-seconds", String(NOTIFICATION_DELIVERY_WAIT_SECONDS),
      "--transport", invocation.transport,
      ...(invocation.transport === "proxy"
        ? ["--codex", state.codexExecutable || "codex"]
        : []),
    ], {
      cwd: notificationCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: invocation.env,
    });
    let stdout = "";
    let stderr = "";
    let accepted = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (accepted || !stdout.includes("\n")) return;
      try {
        const result = JSON.parse(stdout.slice(0, stdout.indexOf("\n")));
        if (result.status !== "accepted" || !result.turnId) return;
        accepted = true;
        resolveAttempt({ ...result, transport: result.transport ?? invocation.transport });
      } catch {
        // Let the child exit report the malformed output with full context.
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectAttempt);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectAttempt(new Error(stderr.trim() || `App Server notification helper exited ${code}`));
        return;
      }
      if (!accepted) {
        rejectAttempt(new Error(`App Server notification helper returned no acceptance: ${stdout.trim()}`));
        return;
      }
      if (!accepted) return;
    });
    child.stdin.end(prompt);
  });
}

function enqueueMonitorDelivery(state, event, parent) {
  const id = eventId(event);
  state.deliveryOutbox ||= [];
  const existing = state.deliveryOutbox.find((entry) => eventId(entry.event) === id);
  if (existing) {
    if (JSON.stringify(existing.event) !== JSON.stringify(event)) {
      fail(`Outbox eventId ${id} conflicts with different content`);
    }
    return existing;
  }
  const entry = {
    event,
    delivery: parent
      ? { status: "pending", updatedAt: now() }
      : { status: "not_configured", updatedAt: now() },
  };
  state.deliveryOutbox.push(entry);
  writeState(state.stateFile, state);
  return entry;
}

async function deliverMonitorDelivery(state, entry, parent, send, afterRemoteAcceptance = null) {
  const id = eventId(entry.event);
  if (!parent) return entry.delivery;
  if (entry.delivery.status === "delivered" || entry.delivery.status === "not_configured") return entry.delivery;
  if (entry.delivery.status === "delivering") {
    fail(`Delivery ${id} has an ambiguous accepted outcome; reconcile the exact parent before retry`);
  }
  entry.delivery = {
    status: "delivering",
    attemptId: randomUUID(),
    parent: { ...parent },
    updatedAt: now(),
  };
  writeState(state.stateFile, state);
  try {
    const result = await send(eventPrompt(state, entry.event));
    if (result?.status !== "accepted" || !result.turnId) {
      fail("App Server notification did not return an accepted turn");
    }
    await afterRemoteAcceptance?.(result);
    entry.delivery = {
      status: "delivered",
      mode: result.mode,
      turnId: result.turnId,
      updatedAt: now(),
    };
  } catch (error) {
    entry.delivery = {
      status: "delivering",
      attemptId: entry.delivery.attemptId,
      parent: entry.delivery.parent,
      failure: error.message,
      outcome: "ambiguous",
      updatedAt: now(),
    };
  }
  writeState(state.stateFile, state);
  return entry.delivery;
}

/** Wake a stored Codex thread through the native App Server notifier with monitor-local receipts. */
export async function appServerAttempt(state, event, dependencies = {}) {
  const parent = { threadId: state.threadId, cwd: state.cwd, generation: state.ownerGeneration ?? 0 };
  const entry = enqueueMonitorDelivery(state, event, parent);
  const delivery = await deliverMonitorDelivery(
    state,
    entry,
    parent,
    (prompt) => (dependencies.spawnNotification || spawnAppServerNotification)(state, prompt),
    dependencies.afterRemoteAcceptance,
  );
  if (delivery.status !== "delivered") {
    fail(delivery.failure || `Monitor delivery ${eventId(event)} remains ambiguous`);
  }
  state.wakeMode = delivery.mode;
  state.wakeTurnId = delivery.turnId;
  state.wakeTransport = notificationInvocationForState(state).transport;
  state.status = "completed";
  state.notifiedAt = new Date().toISOString();
  state.completedAt = state.notifiedAt;
  state.wakeAttempts = 0;
  state.deliveredEventIds ||= [];
  const deliveredId = eventId(event);
  if (!state.deliveredEventIds.includes(deliveredId)) state.deliveredEventIds.push(deliveredId);
  state.pendingEvents = (state.pendingEvents || []).filter((item) => eventId(item) !== deliveredId);
  delete state.lastWakeError;
  writeState(state.stateFile, state);
}

async function wakeThread(state, event) {
  if ([...(state.deliveredEventIds || []), ...(state.reconciledEventIds || [])].includes(eventId(event))) return;
  const lockFile = join(codexRoot(), "pr-monitors", `thread-${state.threadId.replace(/[^a-zA-Z0-9_.-]/g, "-")}.lock`);
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
  let lockFd;
  while (lockFd == null) {
    try {
      lockFd = openSync(lockFile, "wx", 0o600);
      writeFileSync(lockFd, `${process.pid}\n`);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let ownerPid = 0;
      try { ownerPid = Number(readFileSync(lockFile, "utf8").trim()); } catch {}
      if (!isPidAlive(ownerPid)) {
        try { unlinkSync(lockFile); } catch {}
        continue;
      }
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 1_000));
    }
  }
  let attempts = 0;
  try {
    while (attempts < 6) {
      attempts += 1;
      try {
        await appServerAttempt(state, event);
        return;
      } catch (error) {
        state.lastWakeError = error.message;
        state.wakeAttempts = attempts;
        writeState(state.stateFile, state);
        const delivery = (state.deliveryOutbox || [])
          .find((entry) => eventId(entry.event) === eventId(event))?.delivery;
        if (delivery?.status === "delivering") throw error;
        if (attempts >= 6) throw error;
        await new Promise((resolveTimer) => setTimeout(resolveTimer, Math.min(60_000, attempts * 10_000)));
      }
    }
  } finally {
    closeSync(lockFd);
    try { unlinkSync(lockFile); } catch {}
  }
}

async function runDaemon(stateFile) {
  const state = readState(stateFile);
  state.pid = process.pid;
  state.processIdentity = captureProcessIdentity(process.pid);
  if (!state.processIdentity) fail("Could not capture the monitor process identity");
  state.status = "running";
  state.stateFile = stateFile;
  writeState(stateFile, state);

  let timer;
  let stopping = false;
  const stop = (signal) => {
    stopping = true;
    if (timer) clearTimeout(timer);
    state.status = "stopped";
    state.stoppedAt = new Date().toISOString();
    state.stopSignal = signal;
    writeState(stateFile, state);
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const settledEventIds = new Set([
    ...(state.deliveredEventIds || []),
    ...(state.reconciledEventIds || []),
  ]);
  const pending = (state.pendingEvents || []).find((event) => !settledEventIds.has(eventId(event)));
  if (pending) {
    state.event = pending;
    state.status = "waking";
    writeState(stateFile, state);
    try {
      await wakeThread(state, pending);
    } catch (error) {
      state.status = "notification_failed";
      state.lastWakeError = error.message;
      state.notificationFailedAt = new Date().toISOString();
      writeState(stateFile, state);
    }
    return;
  }

  const schedule = () => {
    if (!stopping) timer = setTimeout(tick, state.intervalSeconds * 1000);
  };
  const tick = async () => {
    try {
      const snapshot = fetchSnapshot(state.pr);
      state.consecutiveQueryFailures = 0;
      const event = evaluateMonitorPoll(state, snapshot);
      if (event) {
        state.pendingEvents ||= [];
        if (!state.pendingEvents.some((item) => eventId(item) === event.eventId)) state.pendingEvents.push(event);
        state.event = event;
        state.status = "waking";
        writeState(stateFile, state);
        try {
          await wakeThread(state, event);
        } catch (error) {
          state.status = "notification_failed";
          state.lastWakeError = error.message;
          state.notificationFailedAt = new Date().toISOString();
          writeState(stateFile, state);
        }
        return;
      }
      writeState(stateFile, state);
    } catch (error) {
      state.consecutiveQueryFailures = (state.consecutiveQueryFailures ?? 0) + 1;
      state.lastQueryError = error.message;
      state.lastQueryErrorAt = new Date().toISOString();
      if (state.consecutiveQueryFailures >= MAX_QUERY_FAILURES) {
        const event = {
          kind: "monitor_query_failed",
          severity: "attention",
          summary: `PR monitor failed ${state.consecutiveQueryFailures} consecutive GitHub queries`,
          observedAt: state.lastQueryErrorAt,
          details: { error: error.message },
        };
        if (!eventKindAllowed(state, event)) {
          writeState(stateFile, state);
          schedule();
          return;
        }
        event.eventId = eventId(event);
        state.pendingEvents ||= [];
        if (!state.pendingEvents.some((item) => eventId(item) === event.eventId)) state.pendingEvents.push(event);
        state.event = event;
        state.status = "waking";
        writeState(stateFile, state);
        try {
          await wakeThread(state, event);
        } catch (wakeError) {
          state.status = "notification_failed";
          state.lastWakeError = wakeError.message;
          state.notificationFailedAt = new Date().toISOString();
          writeState(stateFile, state);
        }
        return;
      }
      writeState(stateFile, state);
    }
    schedule();
  };
  schedule();
}

/** Evaluate one successful GitHub poll and persist its observation in memory. */
export function evaluateMonitorPoll(state, snapshot) {
  let event = evaluateUnsettledSnapshot(state, snapshot);
  const summary = summarizeSnapshot(snapshot);
  state.lastSnapshot = {
    ...summary,
    checks: snapshot.checks.length,
  };
  if (!event) event = stallEvent(state, snapshot);
  if (event) {
    event.observedAt = snapshot.observedAt;
    event.eventId = eventId(event);
  }
  return event;
}

/**
 * With a stall deadline, wake once when an open, unqueued PR has made no
 * observable progress (same head, checks, reviews, comments, and merge state)
 * for that long. Any change restarts the clock; one stall wakes only once.
 */
export function stallEvent(state, snapshot) {
  const seconds = state.stallAfterSeconds;
  if (!Number.isInteger(seconds) || seconds <= 0) return null;
  const core = snapshot.core;
  if (core.merged || core.state !== "OPEN" || core.mergeQueueEntry) {
    state.stallFingerprint = null;
    state.stallSince = null;
    return null;
  }
  // Kept apart from summarizeSnapshot so existing registration fingerprints stay stable.
  const fingerprint = sha256(JSON.stringify({
    summary: stableSnapshotSummary(snapshot),
    reviewIds: snapshotReviewIds(snapshot),
    headRollupState: snapshot.headRollupState ?? null,
  }));
  if (state.stallFingerprint !== fingerprint) {
    state.stallFingerprint = fingerprint;
    state.stallSince = snapshot.observedAt;
    return null;
  }
  const stalledMs = Date.parse(snapshot.observedAt) - Date.parse(state.stallSince);
  if (!(stalledMs >= seconds * 1000) || state.stallNotifiedFingerprint === fingerprint) return null;
  const { failing, pending } = classifyChecks(snapshot.checks);
  const event = {
    kind: "stalled",
    severity: "attention",
    summary: `Pull request made no observable progress for ${Math.floor(stalledMs / 1000)} seconds`,
    details: {
      since: state.stallSince,
      stallAfterSeconds: seconds,
      headRefOid: core.headRefOid,
      reviewDecision: core.reviewDecision ?? null,
      mergeStateStatus: core.mergeStateStatus ?? null,
      failingChecks: failing.map((check) => check.name),
      pendingChecks: pending.map((check) => check.name),
    },
  };
  if (!eventKindAllowed(state, event)) return null;
  state.stallNotifiedFingerprint = fingerprint;
  return event;
}

function parseStallAfter(value) {
  if (value == null) return null;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 60) fail("--stall-after must be a whole number of at least 60 seconds");
  return seconds;
}

export const SNAPSHOT_SCHEMA = "GH_MONITOR_PR_SNAPSHOT v1";
export const SNAPSHOT_EXIT_CODES = Object.freeze({
  ready: 0,
  merged: 0,
  conflict: 2,
  unresolved_threads: 3,
  ci_failing: 4,
  pending: 5,
  queued: 5,
  gate: 6,
  closed: 6,
  query_failed: 7,
});

/**
 * Reduce one snapshot to a single typed verdict, in tier order: terminal
 * state, conflict, unresolved threads, failing CI (including a failing rollup
 * GitHub blocks on with no visible failing check), queue, pending checks, then
 * review and merge-state gates. It never registers or wakes anything.
 */
export function snapshotVerdict(pr, snapshot) {
  const core = snapshot.core;
  const queued = Boolean(core.mergeQueueEntry);
  const { failing, pending } = classifyChecks(snapshot.checks);
  const threads = unresolvedReviewThreads(snapshot);
  const rollupRefused = !queued && failing.length === 0 && core.mergeStateStatus === "BLOCKED" &&
    ["FAILURE", "ERROR"].includes(snapshot.headRollupState);
  const gates = [];
  if (core.isDraft) gates.push("draft");
  if (core.reviewDecision === "CHANGES_REQUESTED") gates.push("changes_requested");
  if (core.reviewDecision === "REVIEW_REQUIRED") gates.push("review_required");
  if (!queued && core.mergeable !== "MERGEABLE") gates.push(`mergeable_${String(core.mergeable).toLowerCase()}`);
  if (!queued && !["CLEAN", "HAS_HOOKS"].includes(core.mergeStateStatus)) {
    gates.push(`merge_state_${String(core.mergeStateStatus).toLowerCase()}`);
  }
  if (queued && core.mergeQueueEntry.state === "UNMERGEABLE") gates.push("queue_unmergeable");
  let verdict;
  if (core.merged || core.state === "MERGED") verdict = "merged";
  else if (core.state === "CLOSED") verdict = "closed";
  else if (!queued && (core.mergeable === "CONFLICTING" || core.mergeStateStatus === "DIRTY")) verdict = "conflict";
  else if (threads.length) verdict = "unresolved_threads";
  else if (failing.length || rollupRefused) verdict = "ci_failing";
  else if (queued && core.mergeQueueEntry.state !== "UNMERGEABLE") verdict = "queued";
  else if (pending.length) verdict = "pending";
  else if (gates.length) verdict = "gate";
  else verdict = "ready";
  return {
    schema: SNAPSHOT_SCHEMA,
    pr: pr.url,
    observedAt: snapshot.observedAt,
    verdict,
    exitCode: SNAPSHOT_EXIT_CODES[verdict],
    headRefOid: core.headRefOid,
    checkSha: snapshot.checkSha,
    reviewDecision: core.reviewDecision ?? null,
    isDraft: Boolean(core.isDraft),
    mergeable: core.mergeable ?? null,
    mergeStateStatus: core.mergeStateStatus ?? null,
    headRollupState: snapshot.headRollupState ?? null,
    queue: queued
      ? { id: core.mergeQueueEntry.id, state: core.mergeQueueEntry.state, position: core.mergeQueueEntry.position ?? null }
      : null,
    unresolvedThreads: { count: threads.length, urls: threads.map((thread) => thread.url).filter(Boolean) },
    failingChecks: failing.map((check) => ({ name: check.name, url: check.url ?? null })),
    pendingChecks: pending.map((check) => check.name),
    rollupRefused,
    gates,
  };
}

/** One bounded read with no monitor registration, for handoff gates. */
export function takeSnapshot(url, dependencies = {}) {
  const pr = parsePrUrl(url);
  try {
    return snapshotVerdict(pr, (dependencies.fetchSnapshot || fetchSnapshot)(pr));
  } catch (error) {
    return {
      schema: SNAPSHOT_SCHEMA,
      pr: pr.url,
      observedAt: new Date().toISOString(),
      verdict: "query_failed",
      exitCode: SNAPSHOT_EXIT_CODES.query_failed,
      error: error.message,
    };
  }
}

function registrationContext(url, options, defaultInterval = 60) {
  const pr = parsePrUrl(url);
  const threadId = options["thread-id"] || process.env.CODEX_THREAD_ID;
  if (!threadId) fail("CODEX_THREAD_ID is absent; refusing to guess which chat to wake");
  const cwd = realpathSync(resolve(options.cwd || process.cwd()));
  const intervalSeconds = Number(options.interval ?? defaultInterval);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10) {
    fail("--interval must be a whole number of at least 10 seconds");
  }
  const { ownerSurface, ownerGeneration } = parseOwnerMetadata(options);
  const eventKinds = parseEventKindFilter(options["event-kinds"]);
  const stallAfterSeconds = parseStallAfter(options["stall-after"]);
  return { pr, threadId, cwd, intervalSeconds, ownerSurface, ownerGeneration, eventKinds, stallAfterSeconds };
}

function parseEventKindFilter(value) {
  if (!value) return null;
  const items = [...new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean))];
  if (!items.length) fail("--event-kinds must include at least one event kind");
  return items;
}

function eventKindAllowed(state, event) {
  const allowed = state.eventKinds;
  return !Array.isArray(allowed) || allowed.includes(event.kind);
}

function initialMaterialPolicy(options) {
  const policy = options["initial-material-policy"] || "reject";
  if (!INITIAL_MATERIAL_POLICIES.has(policy)) {
    fail("--initial-material-policy must be reject or deliver");
  }
  if (policy === "deliver" && options["acknowledge-initial-event"]) {
    fail("--acknowledge-initial-event cannot be combined with monitor-owned initial delivery");
  }
  return policy;
}

function blockedRegistration(context, stateFile, baseline, registrationDelta, initialMaterialState) {
  return {
    schema: REGISTRATION_SCHEMA,
    status: "initial_material_state",
    monitorStarted: false,
    exitCode: INITIAL_MATERIAL_EXIT_CODE,
    pr: context.pr,
    threadId: context.threadId,
    ownerSurface: context.ownerSurface,
    ownerGeneration: context.ownerGeneration,
    cwd: context.cwd,
    intervalSeconds: context.intervalSeconds,
    commentMonitoring: context.commentMonitoring,
    prospectiveStateFile: stateFile,
    registrationSnapshot: summarizeSnapshot(baseline),
    registrationDelta,
    initialMaterialState: {
      ...initialMaterialState,
      delivery: "caller_acknowledgement_required",
      guidance: [
        "The monitor was not started.",
        "Route this exact event once, then retry with",
        `--acknowledge-initial-event ${initialMaterialState.eventId}.`,
      ].join(" "),
    },
  };
}

function buildRunningState(context, appServer, invocation, threadProbe, baseline, stateFile, handoff, additions = {}) {
  return {
    version: 7,
    status: "starting",
    pr: context.pr,
    threadId: context.threadId,
    ownerSurface: context.ownerSurface,
    ownerGeneration: context.ownerGeneration,
    cwd: context.cwd,
    intervalSeconds: context.intervalSeconds,
    eventKinds: context.eventKinds,
    stallAfterSeconds: context.stallAfterSeconds ?? null,
    codexExecutable: appServer.executable,
    appServerSocket: appServer.socket,
    appServerVersion: appServer.version.appServerVersion,
    notificationTransport: invocation.transport,
    appServerThreadStatus: "active_at_registration",
    appServerActiveTurnId: threadProbe.activeTurnId,
    startedAt: new Date().toISOString(),
    registrationSnapshot: summarizeSnapshot(baseline),
    ...handoff,
    ...additions,
    commentMonitoring: context.commentMonitoring,
    seenCommentIds: snapshotCommentIds(baseline),
    seenReviewIds: snapshotReviewIds(baseline),
    reviewThreadStates: reviewThreadStates(baseline),
    unresolvedReviewThreads: unresolvedReviewThreadStates(baseline),
    wasQueued: Boolean(baseline.core.mergeQueueEntry),
    queueEntryId: baseline.core.mergeQueueEntry?.id ?? null,
    lastHeadOid: baseline.core.headRefOid,
    lastMergeable: baseline.core.mergeable,
    lastMergeStateStatus: baseline.core.mergeStateStatus,
    lastCheckSha: baseline.checkSha,
    consecutiveQueryFailures: 0,
    stateFile,
  };
}

function launchDetachedMonitor(state) {
  const logFile = state.stateFile.replace(/\.json$/, ".log");
  state.logFile = logFile;
  writeState(state.stateFile, state);

  const logFd = openSync(logFile, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run", "--state-file", state.stateFile], {
    cwd: state.cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  closeSync(logFd);
  state.pid = child.pid;
  for (let attempt = 0; attempt < 20 && !state.processIdentity; attempt += 1) {
    state.processIdentity = captureProcessIdentity(child.pid);
    if (!state.processIdentity) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!state.processIdentity) fail("Could not capture the detached monitor process identity");
  state.status = "running";
  writeState(state.stateFile, state);
  return state;
}

async function activeRegistrationTransport(context) {
  const appServer = sharedAppServer();
  const { probe: threadProbe, invocation } = await probeSharedThread(
    appServer,
    context.threadId,
    context.ownerSurface,
  );
  if (threadProbe.threadStatus !== "active" || threadProbe.activeTurnId == null) {
    fail([
      `The launching thread ${context.threadId} is not active in the managed App Server`,
      `(reported state: ${threadProbe.threadStatus || "unknown"}).`,
      context.ownerSurface === "desktop"
        ? "Quit ChatGPT completely, reopen it, and register the monitor again."
        : "Resume this exact CLI root through the managed App Server and register the monitor from its active turn.",
    ].join(" "));
  }
  return { appServer, threadProbe, invocation };
}

async function startMonitor(url, options) {
  const context = registrationContext(url, options);
  const { pr, threadId, cwd, ownerSurface, ownerGeneration } = context;
  const stateFile = statePathFor(pr, threadId);
  const policy = initialMaterialPolicy(options);
  let previousState = null;
  let replacementLineage = null;
  let rootTransfer = null;
  let transferClaim = null;
  const previousStateFile = options["previous-state-file"]
    ? resolve(options["previous-state-file"])
    : null;
  const rootTransferFile = options["root-transfer-file"]
    ? resolve(options["root-transfer-file"])
    : null;
  if (rootTransferFile && !previousStateFile) {
    fail("--root-transfer-file requires --previous-state-file");
  }
  if (previousStateFile) {
    previousState = readState(previousStateFile);
    if (rootTransferFile) {
      if ((statSync(rootTransferFile).mode & 0o077) !== 0) {
        fail("Root-transfer receipt must be mode 0600");
      }
      rootTransfer = readState(rootTransferFile);
    }
    replacementLineage = validateReplacementLineage(
      previousState,
      pr,
      threadId,
      { ownerSurface, ownerGeneration },
      rootTransfer ? { receipt: rootTransfer, cwd } : null,
    );
    const verification = verifyStoppedMonitor(previousState);
    if (!verification.verifiedStopped) {
      fail(`Replacement registration requires a verified stopped monitor: ${previousStateFile}`);
    }
  }
  if (existsSync(stateFile)) {
    const existing = readState(stateFile);
    if (["starting", "running", "waking", "notified"].includes(existing.status) && trackedProcessIsActive(existing)) {
      const existingSurface = existing.ownerSurface ?? "desktop";
      const existingGeneration = existing.ownerGeneration ?? 0;
      if (existingSurface !== ownerSurface || existingGeneration !== ownerGeneration) {
        fail([
          `A live monitor already owns ${pr.url} for thread ${threadId}`,
          `as ${existingSurface} generation ${existingGeneration}.`,
          "Stop and verify that monitor before registering a replacement owner generation.",
        ].join(" "));
      }
      if (options["acknowledge-initial-event"]) {
        fail("An initial-material acknowledgement cannot be applied to an already-running monitor");
      }
      if (options["include-self-comments"] === true &&
          existing.commentMonitoring?.includeSelfComments !== true) {
        fail("--include-self-comments cannot change an already-running monitor; transfer or recover it first");
      }
      return { alreadyRunning: true, ...normalizeMonitorState(existing) };
    }
    if (!previousStateFile || resolve(previousStateFile) !== resolve(stateFile)) {
      fail([
        `An inactive monitor state already exists for ${pr.url} and this exact owner generation.`,
        "Refusing to overwrite its delivery history.",
        "Use recover-same-owner with the exact state file and expected current head.",
      ].join(" "));
    }
  }

  const { appServer, threadProbe, invocation } = await activeRegistrationTransport(context);
  context.commentMonitoring = buildCommentMonitoring(
    options,
    fetchAuthenticatedLogin(pr.host),
    previousState,
  );
  const baseline = fetchSnapshot(pr);
  const registrationDelta = previousState
    ? buildReregistrationDelta(previousState, baseline, context.commentMonitoring)
    : null;
  const binding = {
    prUrl: pr.url,
    threadId,
    cwd,
    ownerSurface,
    ownerGeneration,
    commentMonitoring: context.commentMonitoring,
  };
  const initialMaterialState = buildInitialMaterialState(binding, baseline, previousState, registrationDelta);
  if (initialMaterialState?.ambiguousDeliveryEventIds.length) {
    fail([
      "Registration encountered an ambiguous prior App Server acceptance and will not replay or discard it.",
      `Events: ${initialMaterialState.ambiguousDeliveryEventIds.join(",")}.`,
      "The exact unchanged owner must use recover-same-owner; an owner transfer remains blocked.",
    ].join(" "));
  }
  const acknowledgement = options["acknowledge-initial-event"] || null;
  if (initialMaterialState && policy === "reject" && acknowledgement !== initialMaterialState.eventId) {
    return blockedRegistration(context, stateFile, baseline, registrationDelta, initialMaterialState);
  }
  if (!initialMaterialState && acknowledgement) {
    fail("The supplied initial-material acknowledgement is stale; no matching material state exists now");
  }

  if (rootTransferFile) {
    transferClaim = claimMonitorTransfer(rootTransferFile, rootTransfer, {
      prUrl: pr.url,
      previousStateFile,
      previousStateSha256: sha256(readFileSync(previousStateFile)),
      target: { threadId, cwd, ownerSurface, ownerGeneration, stateFile },
    });
  }

  const acknowledgedSourceIds = initialMaterialState?.sourceEventIds || [];
  const handoff = previousState
    ? buildMonitorHandoff(previousState, null, { acknowledgedEventIds: acknowledgedSourceIds })
    : { deliveredEventIds: [], pendingEvents: [], deliveryOutbox: [] };
  if (initialMaterialState && policy === "deliver") handoff.pendingEvents.push(initialMaterialState.event);
  const initialDelivery = !initialMaterialState
    ? "not_applicable"
    : (policy === "deliver" ? "detached_monitor" : "caller_acknowledged");
  const state = buildRunningState(context, appServer, invocation, threadProbe, baseline, stateFile, handoff, {
    registration: {
      schema: REGISTRATION_SCHEMA,
      status: "monitor_started",
      monitorStarted: true,
      initialMaterialEventId: initialMaterialState?.eventId ?? null,
      initialMaterialDelivery: initialDelivery,
      acknowledgedInitialEventId: initialDelivery === "caller_acknowledged" ? acknowledgement : null,
    },
    initialMaterialState: initialMaterialState
      ? { ...initialMaterialState, delivery: initialDelivery }
      : { detected: false, delivery: initialDelivery },
    ...(initialDelivery === "caller_acknowledged" && initialMaterialState.currentMaterialFingerprints?.length
      ? {
        acknowledgedMaterialFingerprints: initialMaterialState.currentMaterialFingerprints,
        acknowledgedMaterialConditions: initialMaterialState.currentMaterialConditions,
      }
      : {}),
    registrationAcknowledgedEventIds: initialDelivery === "caller_acknowledged"
      ? acknowledgedSourceIds
      : [],
    ...(previousStateFile ? {
      previousStateFile,
      previousOwnerSurface: replacementLineage.previousOwnerSurface,
      previousOwnerGeneration: replacementLineage.previousOwnerGeneration,
      registrationDelta,
      ...(rootTransferFile ? {
        rootTransferFile,
        rootTransferId: rootTransfer.transferId,
        rootTransferClaimId: transferClaim.claimId,
      } : {}),
    } : {}),
  });
  return launchDetachedMonitor(state);
}

export async function recoverSameOwner(url, options, dependencies = {}) {
  if (!options["state-file"]) fail("recover-same-owner requires --state-file");
  if (!options["expected-head"]) fail("recover-same-owner requires --expected-head");
  const stateFile = realpathSync(resolve(options["state-file"]));
  const previousStateBytes = readFileSync(stateFile);
  const previousState = JSON.parse(previousStateBytes);
  const normalizedPreviousState = normalizeMonitorState(previousState);
  const context = registrationContext(url, {
    ...options,
    "thread-id": options["thread-id"] ?? normalizedPreviousState.threadId,
    cwd: options.cwd ?? previousState.cwd,
    "owner-surface": options["owner-surface"] ?? normalizedPreviousState.ownerSurface,
    "owner-generation": options["owner-generation"] ?? String(normalizedPreviousState.ownerGeneration),
    "stall-after": options["stall-after"] ?? (previousState.stallAfterSeconds == null
      ? undefined
      : String(previousState.stallAfterSeconds)),
  }, previousState.intervalSeconds ?? 60);
  const expectedStateFile = realpathSync(resolve(
    (dependencies.statePathFor || statePathFor)(context.pr, context.threadId),
  ));
  if (stateFile !== expectedStateFile) {
    fail(`Same-owner recovery requires the canonical state file: ${expectedStateFile}`);
  }
  const reconciledEventIds = parseEventIdList(options["reconcile-ambiguous-event"]);
  const { appServer, threadProbe, invocation } = await (
    dependencies.activeRegistrationTransport || activeRegistrationTransport
  )(context);
  context.commentMonitoring = buildCommentMonitoring(
    options,
    (dependencies.fetchAuthenticatedLogin || fetchAuthenticatedLogin)(context.pr.host),
    previousState,
  );
  const baseline = (dependencies.fetchSnapshot || fetchSnapshot)(context.pr);
  const recovery = validateSameOwnerRecovery(previousState, {
    ...context,
    expectedHead: options["expected-head"],
    reconciledEventIds,
  }, baseline);
  const allReconciledEventIds = [...new Set([
    ...(previousState.reconciledEventIds || []),
    ...recovery.reconciledEventIds,
  ])];
  const settledPreviousState = { ...previousState, reconciledEventIds: allReconciledEventIds };
  const registrationDelta = buildReregistrationDelta(
    previousState,
    baseline,
    context.commentMonitoring,
  );
  const binding = {
    prUrl: context.pr.url,
    threadId: context.threadId,
    cwd: context.cwd,
    ownerSurface: context.ownerSurface,
    ownerGeneration: context.ownerGeneration,
    commentMonitoring: context.commentMonitoring,
  };
  const currentMaterialState = buildInitialMaterialState(binding, baseline);
  const priorSettledEventIds = new Set([
    ...(previousState.deliveredEventIds || []),
    ...allReconciledEventIds,
  ]);
  const priorMaterialFingerprints = new Set(previousState.acknowledgedMaterialFingerprints || []);
  for (const condition of previousState.acknowledgedMaterialConditions || []) {
    priorMaterialFingerprints.add(condition.fingerprint);
  }
  const settledHistoricalEvents = [
    ...(previousState.deliveryOutbox || [])
      .filter((entry) => priorSettledEventIds.has(eventId(entry.event)))
      .map((entry) => entry.event),
    ...(previousState.event && priorSettledEventIds.has(eventId(previousState.event))
      ? [previousState.event]
      : []),
  ];
  for (const event of settledHistoricalEvents) {
    for (const fingerprint of coveredMaterialFingerprints(event)) {
      priorMaterialFingerprints.add(fingerprint);
    }
  }
  const currentEvents = currentMaterialState?.event.details.currentEvents
    || (currentMaterialState?.event.details.currentEvent ? [currentMaterialState.event.details.currentEvent] : []);
  if (previousState.acknowledgedCurrentMaterialFingerprint) {
    for (const event of currentEvents) {
      if (materialStateFingerprint(baseline, event) === previousState.acknowledgedCurrentMaterialFingerprint) {
        priorMaterialFingerprints.add(eventMaterialFingerprint(event));
      }
    }
  }
  const priorEventCoversCurrent = currentEvents.length > 0 && currentEvents.every(
    (event) => priorMaterialFingerprints.has(eventMaterialFingerprint(event)),
  );
  const acknowledgement = options["acknowledge-initial-event"] || null;
  if (currentMaterialState && !priorEventCoversCurrent && acknowledgement !== currentMaterialState.eventId) {
    return {
      ...blockedRegistration(context, stateFile, baseline, registrationDelta, currentMaterialState),
      recovery: {
        required: true,
        priorStateSha256: sha256(previousStateBytes),
        reconciledAmbiguousEventIds: recovery.reconciledEventIds,
        expectedHead: options["expected-head"],
      },
    };
  }
  if (!currentMaterialState && acknowledgement) {
    fail("The supplied initial-material acknowledgement is stale; no matching material state exists now");
  }

  const handoff = buildMonitorHandoff(settledPreviousState, null, {
    acknowledgedEventIds: allReconciledEventIds,
  });
  const recoveredAt = new Date().toISOString();
  const receipt = {
    schema: "GH_MONITOR_PR_SAME_OWNER_RECOVERY v1",
    recoveryId: randomUUID(),
    recoveredAt,
    priorStateSha256: sha256(previousStateBytes),
    prior: {
      version: previousState.version ?? null,
      status: previousState.status,
      pid: previousState.pid ?? null,
      processIdentity: previousState.processIdentity ?? null,
      startedAt: previousState.startedAt ?? null,
      completedAt: previousState.completedAt ?? null,
      stoppedAt: previousState.stoppedAt ?? null,
      notificationFailedAt: previousState.notificationFailedAt ?? null,
      lastWakeError: previousState.lastWakeError ?? null,
      registrationSnapshot: previousState.registrationSnapshot ?? null,
      lastSnapshot: previousState.lastSnapshot ?? null,
      seenCommentIds: previousState.seenCommentIds ?? [],
      reviewThreadStates: previousState.reviewThreadStates ?? [],
      unresolvedReviewThreads: previousState.unresolvedReviewThreads ?? [],
      event: previousState.event ?? null,
    },
    owner: {
      threadId: context.threadId,
      cwd: context.cwd,
      ownerSurface: context.ownerSurface,
      ownerGeneration: context.ownerGeneration,
    },
    commentMonitoring: context.commentMonitoring,
    expectedHead: options["expected-head"],
    baselineHead: baseline.core.headRefOid,
    registrationDelta,
    reconciledDeliveries: recovery.reconciledDeliveries,
  };
  const initialDelivery = !currentMaterialState
    ? "not_applicable"
    : (priorEventCoversCurrent ? "same_owner_reconciled" : "caller_acknowledged");
  const recoveryHistory = [...(previousState.recoveryHistory || []), receipt];
  const state = buildRunningState(context, appServer, invocation, threadProbe, baseline, stateFile, handoff, {
    registration: {
      schema: REGISTRATION_SCHEMA,
      status: "monitor_started_same_owner_recovery",
      monitorStarted: true,
      initialMaterialEventId: currentMaterialState?.eventId ?? null,
      initialMaterialDelivery: initialDelivery,
      acknowledgedInitialEventId: initialDelivery === "caller_acknowledged" ? acknowledgement : null,
    },
    initialMaterialState: currentMaterialState
      ? { ...currentMaterialState, delivery: initialDelivery }
      : { detected: false, delivery: initialDelivery },
    ...(currentMaterialState?.currentMaterialFingerprints?.length
      ? {
        acknowledgedMaterialFingerprints: currentMaterialState.currentMaterialFingerprints,
        acknowledgedMaterialConditions: currentMaterialState.currentMaterialConditions,
      }
      : {}),
    deliveredEventIds: [...new Set(previousState.deliveredEventIds || [])],
    reconciledEventIds: allReconciledEventIds,
    registrationAcknowledgedEventIds: initialDelivery === "caller_acknowledged"
      ? currentMaterialState.sourceEventIds
      : [],
    sameOwnerRecovery: receipt,
    recoveryHistory,
    ...(previousState.legacyOwnerBindingRepair
      ? { legacyOwnerBindingRepair: previousState.legacyOwnerBindingRepair }
      : {}),
  });
  return (dependencies.launchDetachedMonitor || launchDetachedMonitor)(state);
}

function statusMonitor(stateFile) {
  const state = readState(resolve(stateFile));
  return {
    ...normalizeMonitorState(state),
    ...verifyStoppedMonitor(state),
  };
}

/** Confirm both process exit and the monitor's durable stopped state. */
export function verifyStoppedMonitor(state, verifier = verifyProcessIdentity) {
  const expected = state.processIdentity || (state.pid ? { pid: state.pid } : null);
  const observed = verifier(expected);
  const processResult = typeof observed === "boolean"
    ? { alive: observed, matches: observed }
    : observed;
  const processAlive = Boolean(processResult?.alive);
  return {
    verifiedStopped: !processAlive && state.status === "stopped",
    processAlive,
    processIdentityMatches: Boolean(processResult?.matches),
    processIdentityReason: processResult?.reason || null,
    stateStatus: state.status,
    stoppedAt: state.stoppedAt ?? null,
  };
}

async function stopMonitor(stateFile, waitSeconds = 15) {
  const path = resolve(stateFile);
  let state = readState(path);
  const processResult = verifyProcessIdentity(state.processIdentity || (state.pid ? { pid: state.pid } : null));
  const wasAlive = processResult.alive;
  if (wasAlive && !processResult.matches) {
    fail(`Refusing to signal PID ${state.pid}: ${processResult.reason}`);
  }
  state.stopRequestedAt = new Date().toISOString();
  if (wasAlive) {
    writeState(path, state);
    try {
      process.kill(state.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      state = readState(path);
      state.statusBeforeStop = state.status;
      state.status = "stopped";
      state.stoppedAt = new Date().toISOString();
      state.stopSignal = "exited_before_signal";
      writeState(path, state);
    }
  } else if (state.status !== "stopped") {
    state.statusBeforeStop = state.status;
    state.status = "stopped";
    state.stoppedAt = new Date().toISOString();
    state.stopSignal = "already_exited";
    writeState(path, state);
  }
  const deadline = Date.now() + waitSeconds * 1_000;
  while (Date.now() <= deadline) {
    state = readState(path);
    const verification = verifyStoppedMonitor(state);
    if (verification.verifiedStopped) {
      return { stateFile: path, pid: state.pid, stopRequested: true, ...verification };
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
  }
  state = readState(path);
  return { stateFile: path, pid: state.pid, stopRequested: true, ...verifyStoppedMonitor(state) };
}

async function main() {
  const { command, options, positional } = parseArgs(process.argv.slice(2));
  if (command === "start") {
    if (!positional[0]) fail("Usage: monitor-pr.mjs start <pr-url> [--thread-id ID] [--cwd PATH] [--interval SECONDS] [--stall-after SECONDS] [--owner-surface desktop|cli] [--owner-generation N] [--previous-state-file PATH] [--root-transfer-file PATH] [--include-self-comments]");
    console.log(JSON.stringify(await startMonitor(positional[0], options), null, 2));
  } else if (command === "recover-same-owner") {
    if (!positional[0]) fail("Usage: monitor-pr.mjs recover-same-owner <pr-url> --state-file PATH --expected-head OID [--reconcile-ambiguous-event EVENT_IDS] [--acknowledge-initial-event EVENT_ID] [--include-self-comments]");
    console.log(JSON.stringify(await recoverSameOwner(positional[0], options), null, 2));
  } else if (command === "repair-legacy-binding") {
    if (!positional[0]) fail("Usage: monitor-pr.mjs repair-legacy-binding <pr-url> --state-file PATH --expected-thread-id ID --expected-cwd PATH --expected-prior-owner-surface desktop|cli --expected-prior-owner-generation N --target-owner-surface desktop|cli --target-owner-generation N --root-authority-file PATH [--root-state-base PATH]");
    console.log(JSON.stringify(repairLegacyOwnerBinding(positional[0], options), null, 2));
  } else if (command === "snapshot") {
    if (!positional[0]) fail("Usage: monitor-pr.mjs snapshot <pr-url>");
    const result = takeSnapshot(positional[0]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.exitCode;
  } else if (command === "run") {
    if (!options["state-file"]) fail("run requires --state-file");
    await runDaemon(resolve(options["state-file"]));
  } else if (command === "status") {
    if (!options["state-file"]) fail("status requires --state-file");
    console.log(JSON.stringify(statusMonitor(options["state-file"]), null, 2));
  } else if (command === "verify-stopped") {
    if (!options["state-file"]) fail("verify-stopped requires --state-file");
    const result = statusMonitor(options["state-file"]);
    console.log(JSON.stringify(result, null, 2));
    if (!result.verifiedStopped) process.exitCode = 1;
  } else if (command === "stop") {
    if (!options["state-file"]) fail("stop requires --state-file");
    const waitSeconds = Number(options["wait-seconds"] ?? 15);
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0) fail("--wait-seconds must be zero or greater");
    const result = await stopMonitor(options["state-file"], waitSeconds);
    console.log(JSON.stringify(result, null, 2));
    if (!result.verifiedStopped) process.exitCode = 1;
  } else {
    fail("Usage: monitor-pr.mjs <start|recover-same-owner|repair-legacy-binding|snapshot|status|stop|verify-stopped> ...");
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`gh-monitor-pr: ${error.message}`);
    process.exitCode = 1;
  });
}
