# Parent Goal

Use this reference when `$cl-sweep` creates, adopts, resumes, reconciles, or
completes the parent `/goal`.

## Creation And Adoption

Resolve or adopt the project-keyed sweep root first. Then call `get_goal` if
goal tooling is available. Continue only when the active unfinished goal matches
the same canonical ClosedLoop project and sweep id. A newly adopting chat may
create a local goal that names the adopted sweep id/root generation; that is a
new callback owner for the same durable sweep, not a second sweep root.

If an unfinished goal exists for a different project or objective, stop and
report the conflict instead of creating a duplicate.

## Objective Template

If no unfinished goal exists in the current thread, create a persistent `/goal`
with an objective equivalent to:

```text
Finish all actionable ClosedLoop work assigned to the policy Sweep owner in <project> as bounded product-feature units. After recovering the project root and reconciling every active owner and open PR, use the read-only cl-work-report project-wide snapshot to see complete lineage and roles, then select execution scope from the owner's assigned tickets plus only minimal explicitly approved transfers. The normal boundary is one complete user-facing page or capability across its required backend, UI, Storybook, and acceptance scope; a multi-page PRD is context, not one automatic unit. Shared foundations remain separately owned prerequisite units and are never duplicated. Preserve every issue as its own single ticket, with independent analysis, approved requirements, priority, approval, status, acceptance, and terminal evidence. Do not execute inferred, ambiguous, cross-repository, irreconcilably governed, ownership-conflicted, or indivisibly cross-feature boundaries until resolved.

Keep up to the effective active-feature-owner limit at a time: three by default and no more than ten when explicitly authorized by the user. Count one feature once regardless of component-ticket count. Order dependency-eligible units by effective priority: each unit's highest live required-member priority, inherited transitively by verified in-scope prerequisites from downstream units they unblock, with cycle detection and stable tie-breaking. Never mutate ticket priority or silently execute other-owner/out-of-scope prerequisites. Preserve valid active writers and reconcile material PR events before new scheduling.

Use the existing batch machinery for one execution owner, worktree, branch, combined plan, established review lifecycle, PR, monitor, manual-QA plan, and cleanup lifecycle per selected page/capability. Never shrink the selected page to a nonfunctional assigned-only subset, expand it to every sibling in an umbrella PRD, split its required backend/Storybook/UI members into separate PRs, or remove a blocked selected member to claim completion. Internal member dependencies may be satisfied in manifest order in the shared PR when proven; external blockers remain with their current owner and must resolve or receive explicit minimal ownership/scope authorization first. Preserve in-flight external owners/PRs and ask for a concrete migration or boundary decision.

Use workflow repo memory and the operator-facing ownership ledger as durable state. On CLI, give every member its own lease/generation row bound to the shared owner, and use the runtime-verified feature-ownership manifest plus one canonical callback ticket. Keep existing callback enums; carry WAITING_MANUAL_QA through WAITING_HUMAN and existing result artifacts. The live PR author remains responsible for one post-PR manual-QA plan comment and human evidence covering the integrated feature on the applicable final head. Do not present pending, failed, blocked, missing, stale, or non-author QA as ready or complete. Preserve Parker visual QA, headless/displayless automated E2E, requirements, communication, review, monitoring, merge, high-complexity, and EXTREME-risk gates.

Treat historical split records as legacy evidence only. Do not run $cl-split, do not create child tickets, do not post completion messages, manually trigger review or CI, or automatically reassign work. Use Product Answer Discovery and the communication policy for genuine Product decisions; keep engineering blockers private unless explicitly authorized. Write DONE only after the one shared PR is live-verified merged and every member's requirements, integrated functional acceptance, manual QA, ClosedLoop status, plan state, durable record, and ownership cleanup are reconciled.
```

## Resume And Completion

On resume after compaction or interruption, first reconcile the goal state by
reading the parent summary, listing active feature-owner threads, reading their
latest status, querying workflow repo memory and ownership state for every
member, and re-querying ClosedLoop for the locked units. Reconcile open PRs and
runtime-verified feature-ownership manifests before new discovery or scheduling.

For every existing owner that should continue, inspect its current goal/task
state. When it is paused or blocked only because the prior run stopped or
parked, send an explicit instruction to resume that same goal before expecting
more work. Do not create a replacement goal or silently assume it resumed.

Mark the parent goal complete only when the objective is actually satisfied.
`WAITING_UI_PLAN_APPROVAL`, `PR_MONITORING_HANDOFF`, `WAITING_CI`,
`WAITING_REVIEW`, `WAITING_MANUAL_QA`, and `WAITING_HUMAN_MERGE` are not
complete. Mark the goal blocked only after the same human-input or
external-state blocker has repeated for the applicable three consecutive goal
turns.

## Goal-Bound Invariants

Treat the single-monitor protocol in [Open PR Lifecycle](open-pr-lifecycle.md)
as part of the parent goal even when an older resumed goal text omits it. Treat
the selected execution surface, feature manifests, member owner generations and
leases, callback ledger, support-lane generations, worktree/checkpoint paths,
durable member states, manual-QA evidence, and cleanup state as part of the goal.

On CLI, "child thread" in older goal text means the current leased cwd-bound
owner session. It may manage only bounded support lanes, and support agents may
not delegate further.
