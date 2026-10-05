# Monitoring, Merge, And Completion

Use this reference for passive monitoring handoff, merge queue recovery,
post-start blockers, merge disposition, and final reconciliation.

## Passive Monitoring Handoff

After opening the feature's single PR, posting and verifying the owned feature
manual-QA plan comment, completing the required two-pass coordinated review
sequence, addressing existing feedback, validating fixes, and recording current
head/check/review/queue/manual-QA state, stop passive polling.

When a parent task id was supplied, send the parent the structured handoff
before ending the turn. On Desktop, use the statically available
`send_message_to_thread` capability and preserve the existing callback. On CLI,
emit the matching current-generation `CL_SWEEP_EVENT v1` as the final response
line; the managed App Server runner persists and delivers it. Never issue a
dynamic TUI tool call for parent messaging.

Do this for support requests, `PR_MONITORING_HANDOFF`, every blocker or human
decision state, every completed material-event remediation that produces a new
head/generation, and terminal `CL Execute Result`. Include ticket, owner id/
surface/generation, worktree, PR URL and exact head/generation when applicable,
status, blocker/CI/review state, and exact next parent action. Retry once and
report callback failure; never silently idle or invite polling.

- When invoked by `$cl-sweep`, return `Status: PR_MONITORING_HANDOFF` for
  ordinary passive PR events. Return `Status: WAITING_MANUAL_QA` while required
  human QA is incomplete. Do not launch a child-targeted monitor.
- Every handoff must include `UI work` and merge disposition:
  `direct_protected_queue`, `human_manual_merge`, or `undetermined`.
- Every handoff must link the owned feature manual-QA comment and durable record,
  name the responsible human author and tested head, and report required
  scenario totals by `PENDING`, `PASS`, `FAIL`, and `BLOCKED`. Incomplete QA
  uses human-readable `WAITING_MANUAL_QA`, transported through the existing
  `WAITING_HUMAN` callback kind with `payload.summary.wait_kind: manual_qa`,
  artifact references, and a concrete `payload.routing.recheck_when`. Do not
  create a new callback kind, enqueue the PR, or report it as waiting only for
  human merge.
- Every handoff for `UI work: YES` must also include `UI visual QA` as the
  [Parker Visual-QA Gate](implementation-review-pr.md#parker-visual-qa-gate)
  defines it. `blocked` or `missing` is an active blocker under that gate, not
  a waiting-on-merge state.
- When standalone, launch exactly one `$gh-monitor-pr` detached monitor for the
  PR targeting this thread, record its identity, and end the turn.
- On every material event handoff, verify PR URL, head, check/review or queue
  evidence, and monitor generation against live GitHub before mutating.
- On merge evidence, perform Completion and return `MERGED`; do not hand off
  terminal reconciliation to the parent.

## Merge Queue Recovery

After a PR enters a merge queue, the ticket worker retains remediation and
reconciliation ownership until merge or explicit abandonment. The sweep parent
owns passive queue event detection. A queue entry disappearing before merge is
recoverable, not terminal success or an automatic human blocker.

1. When resumed with a queue event, verify exact generation, current head, check,
   removal event, and conflict-probe evidence. Do not trigger CI or review.
2. If the PR left the queue without merging, inspect PR and queue evidence for
   current-head checks, merge-group checks/annotations, mergeability/conflicts,
   required reviews, unresolved threads, head changes, and queue/timeline state.
3. If attributable to the PR, fix the concrete issue:
   - For failing tests/checks, diagnose, fix, run affected validation, wait for
     stale branch CI when required by the push gate, push, and rely on automatic
     checks.
   - For confirmed source conflict, proven unlanded dependency, or concrete
     queue/base failure requiring source integration, integrate current main,
     preserve requirements, validate, and push.
   - For required review feedback, address the existing comment, reply, and
     resolve without another coordinated review pass beyond the already
     completed two-pass sequence.
4. Treat every current-head red check as PR-owned by default, including failures
   that appear outside touched files. "Unrelated" is not a passive wait state:
   before routing externally, compare live evidence from current `origin/main`,
   the PR or merge-group head, and relevant peer PR runs when useful. If latest
   main already fixes the failure, integrate main and push. If latest main or
   peer PRs are green for the same lane, fix this branch or stabilize the
   flaky-but-owned path until automatic current-head evidence is green.
5. If evidence proves a CI-provider outage, credential outage, or job execution
   failure that is not repairable in this branch, do not create speculative
   churn or weaken CI. Inspect the job/config, determine the exact repair and
   owner, make the repair only if safe and in scope, otherwise route the
   smallest action while retaining ticket ownership.
6. Re-enqueue after gates pass, then return a fresh handoff. Repeat event-driven
   recovery as needed.
7. For open PRs, use `PR_MONITORING_HANDOFF` with pending CI/review while
   automatic gates, external repair, or queue recovery are pending. Reserve
   `WAITING_CI` and `WAITING_REVIEW` for waits before an open PR exists.
8. Record final queue outcome and concise recovery count/reasons in the result.

An executed current-head coverage job reporting insufficient coverage is not a
post-start blocker and cannot use blocker, review-waiting, or human-merge-ready
status. Continue diagnosis/correction until green. Only a CI-provider outage or
inability to execute the job may be an external wait.

## Post-Start Blockers

If execution becomes blocked after the feature was marked `IN_PROGRESS`, stop
mutating unsafe scope but do not abandon an open PR. Retain ownership and a
specific recheck condition until merge or explicit abandonment.

1. Update the ClosedLoop feature to `BLOCKED` when the blocker prevents progress.
2. Record blocker, evidence, and next required human action in the private
   result and workflow memory. Add a ClosedLoop comment only for a genuine
   Product decision or when explicitly requested.
3. Return `BLOCKED_AFTER_START`, `CI_FAILED_NEEDS_HUMAN`, `REVIEW_BLOCKED`,
   `MANUAL_INTERVENTION_REQUIRED`, or another stable matching status.
4. If invoked by `$cl-sweep`, leave Product-decision comments to the parent.
   Never emit engineering/operational comments or DMs unless explicitly asked.

## Completion

1. After merge, mark each included ClosedLoop ticket `DONE` only after its own
   acceptance criteria and requirements evidence pass and the integrated
   feature manual QA has current, responsible-human evidence for every required
   scenario. Merge evidence alone cannot substitute for missing or stale manual
   QA evidence.
2. Mark every linked implementation plan `EXECUTED`. If already `EXECUTED`,
   verify without redundant update.
3. Reconcile split parents and ticket execution/review-learning workflow-memory
   records, then query-verify terminal state before returning `MERGED`.
4. Do not post ticket completion messages in Slack or ClosedLoop. Feature
   status, plan status, PR state, validation results, merge state, and structured
   result are the completion record.
5. End with the `CL Execute Result` schema from
   [result-formats.md](result-formats.md).
