# Parent Summary

Open every status report with two lines derived from durable state (the
ownership ledger, durable ticket state, and monitor state), never from
narrative:

- `Changed since last report:` ticket state transitions, PRs opened, merged,
  or closed, new blockers, and cleared blockers, each with its ticket slug, or
  `none`. Compare against the digest saved at the previous report, then save
  the new digest in the root as a private mode-`0600` file.
- `Needs Daniel:` only the decisions or approvals the root cannot advance on
  its own, each with the exact ask, or `none`.

Give the full table below at checkpoints, in the final response, or on
request. Maintain a parent-thread table with:

- Canonical project id, stable sweep id/root path, current root thread/surface,
  root generation/lease, transfer history, and any ownership conflict
- Ticket slug and URL
- Complete linked-role context inventory and the smaller approved executable
  shipping-member scope for each bounded unit, including each explicit transfer
  and any boundary decision or single-PR conflict
- Each member's live priority value, schema ordering evidence, feature declared
  and effective rank, verified inheritance chain, dependency eligibility, and
  stable tie-break fields; missing/unknown priority remains visible
- Execution surface, owner role/id/generation, lease status, last accepted event
  id, replacement history, and Desktop child thread id or CLI agent id
- Worktree path/branch/head, verified checkpoint, and cleanup state
- Ticket-worker-owned support request/result ids, artifact hashes, any recorded
  root-fallback limitation, and the worker-reported code-review generation ids
- Decision
- Complexity and risk
- UI/non-UI classification, merge disposition, UI design source, and human UI
  plan approval state, if any
- Split outcome and child tickets, if any
- Parent status for split parents, including any legacy `BLOCKED` to
  `IN_PROGRESS` correction
- ClosedLoop comment target and engineering attention DM status, if any
- Workflow memory state, including whether a skip record was found or written
- Applicable approved PRD versions and requirement IDs, requirements-link state,
  and any relationship created and verified by the parent
- Terminal requirements-conformance evidence, or explicit evidenced
  `not_applicable`
- Performance measurement evidence for performance tickets: seeded workload,
  worker-isolated database/datastore state, baseline/after/control samples,
  noise floor, mechanism, product-surface relevance, verdict,
  remaining-bottleneck check, and stopping condition, or explicit
  blocked/inconclusive reason
- Review-learning memory titles or ids for accepted reusable PR findings, or
  explicit `not_applicable`
- Automated E2E headless/displayless evidence, or the exact unsupported-local-path
  limitation and authoritative automatic-CI evidence
- Ordered next-ready queue, including exact blocker, integration-overlap note,
  and eligibility event for every remaining locked ticket
- Feature/batch id and versioned manifest, canonical callback ticket, all member
  roles, executable member leases, execution owner, aggregate risk, integrated
  functional acceptance, shared validation/rollback boundary, one-PR
  disposition, and any in-flight-owner migration decision
- Manual-QA plan comment URL, live PR author/responsible human, result artifact,
  state, current/tested head coverage, impacted reruns/carry-forward evidence,
  and full-feature scenario coverage
- Protected merge-queue state for each sweep PR: membership and position,
  speculative merge-group commit, required-check state, mergeability/conflict
  state, latest failure/dequeue/merge event with timestamp, and evidence-handoff
  status
- Detached monitor identity for each open PR: target parent thread, PID,
  state/log files, watched head/generation, health, and replacement/cleanup state
- Execution status, PR URL, merge status, or blocker
- `Process feedback` lines collected from every accepted `CL Execute Result`,
  deduplicated, each with the tickets that raised it

## Final Response

In the final response, report the selected execution surface, which tickets were
executed grouped by feature and shared PR, which were blocked or need a boundary
or ownership decision, the live declared/effective priority order and inherited
blocking chains, who was tagged in ClosedLoop, whether the
engineering attention contact was DM'd, and any Desktop child or CLI worker that
needs manual follow-up. The engineering attention contact should not appear as a
ClosedLoop tag target. Present the deduplicated `Process feedback` once, at the
end of the sweep, as proposed skill edits for the user to accept or reject. The
sweep never edits skills itself.

When the parent goal is fully satisfied, mark the goal complete if goal tooling
is available. Valid monitored waits such as `WAITING_UI_PLAN_APPROVAL`,
`WAITING_CI`, `WAITING_REVIEW`, `WAITING_MANUAL_QA`, and
`WAITING_HUMAN_MERGE` must not trigger
blocker comments, `BLOCKED_SKIP`, or blocked-goal reporting solely because
approval, CI, review, or human merge is pending. If the parent cannot make
progress because all remaining tickets need human input outside a valid
monitored wait state, mark or report the goal as blocked only after the
applicable goal-blocking policy is satisfied.
