# Ticket Queue And Batching

Use this reference for ticket selection, feature-unit formation, queue
maintenance, terminal-owner removal, and legacy split-state handling. Read
[Feature Unit Execution](feature-units.md) with it.

## Ticket Selection

1. Identify the requested ClosedLoop project and the authenticated user. If the
   project is missing or ambiguous, ask one concise clarification and stop.
2. After root/worker/open-PR reconciliation, read and follow
   `../../cl-work-report/SKILL.md`. Use its fully paginated, project-wide live
   ticket universe and feature grouping as the initial discovery snapshot. Do
   not substitute an assigned-only or FEATURE-only query. The executable member
   allowlist is `TODO` and `BACKLOG`. Treat
   `TRIAGE` as analysis-only unless project documentation explicitly says
   assigned `TRIAGE` features are ready for engineering automation, and record
   that evidence before execution or splitting. Treat `IN_PROGRESS` and
   `IN_REVIEW` only as resume/monitor states tied to an existing memory record,
   branch, or PR. Reconsider `BLOCKED` only when its stored `recheck_when`
   condition is satisfied. Always skip `DONE` and `CANCELED`.
   Tickets carrying a tag in the repo-skill routing table below are never
   execution candidates: exclude them from feature units, manifests, leases,
   and worker dispatch, never change their ClosedLoop status, and list them in
   the inventory under a separate `Handled by a repo skill` line naming the
   skill the user runs locally. Match tags case-insensitively.

   | Ticket tag | Repo skill the user runs |
   | --- | --- |
   | `feature-map` | `feature-map-refresh` (symphony-alpha; the only non-CI writer of FEATURE_MAP.md) |

   Before seeding or resuming any ticket from that universe, apply the current
   root's `scope-exclusions.json` as a hard negative allowlist. Preserve an
   excluded ticket's prior session/PR/priority as read-only historical context,
   not an execution slot or monitor obligation. A direct user re-inclusion of
   the exact ticket must be recorded by a guarded update to that file before
   the ordinary readiness and lease gates run again. Never infer re-inclusion
   from assignment, dependency changes, available capacity, or stale memory.
3. For each unit seeded by the Sweep owner's nonterminal assignments, resolve
   every proposed member and ownership gap before implementation dispatch.
   Treat the report's full linked group as context. Define the selected bounded
   execution unit from the owner's assignments plus only minimal, individually
   justified other-owner transfers that the user explicitly approves and
   Feature Unit Execution's protected-owner policy permits. Do not
   adopt all siblings or an umbrella parent merely because assigned tickets
   span that feature. Preserve shared other-owner components as external
   dependencies and stop for a feature-boundary decision when the assigned slice
   is not independently functional.
   Use one complete user-facing page/capability as the normal boundary: include
   its full backend/UI/Storybook acceptance scope, keep other pages in a broad
   PRD separate, and keep a shared cross-page foundation as one prerequisite
   unit with one owner. A ticket that indivisibly spans incompatible page units
   is a boundary conflict, never duplicated or silently split.
   Preserve each ticket's `design prerequisite`, `shipping member`,
   `rollout-gated cleanup`, or `context only` role. Confirm inferred/ambiguous
   groups and stop on `SCOPE_DECISION_REQUIRED` or
   `SINGLE_PR_CONFLICT`; do not remove a blocked or other-owner shipping member
   to create an apparently ready subset. Keep the complete role inventory
   visible, but place only approved nonterminal shipping implementation members
   in the executable manifest and lease scope. Terminal context and satisfied
   design prerequisites need no new analysis or implementation lease. An
   unsatisfied design prerequisite or unresolved rollout-gated cleanup boundary
   holds the unit.
4. Load enough ClosedLoop metadata to choose one implementation repo before
   creating the feature worktree. Use ticket fields, linked plans, project
   conventions, and repo memory. If the repo cannot be identified confidently,
   either ask the engineering attention contact or create an analysis-only
   projectless child; do not create a guessed repo worktree. Analysis-only
   children are not execution-eligible. If they later identify a repo and return
   `GO`, create a fresh repo-scoped worktree child and rerun `$cl-analyze` there
   before `$cl-execute`.
5. Query workflow repo memory in the canonical `<memory_repo>` for each
   candidate ticket's latest exact `cl_sweep_ticket_state`.
6. Reconcile every member against `list_threads`, active child thread ids from
   memory, ClosedLoop feature status, active PRs, and branch names before
   launching any child. Apply the open-PR retention guard from
   [Open PR Lifecycle](open-pr-lifecycle.md) before rewriting the ledger or
   selecting another ticket.
7. If the latest state is `INTENT_ANALYZING` with no child thread id, search for
   the stable child title. If no child exists and the ticket has not materially
   changed, write and verify a superseding `INTENT_ANALYZING` record with
   `reason: recovered stale intent with no child thread`, then launch one
   replacement analysis child. If a possible child exists but cannot be
   verified, write `MANUAL_INTERVENTION` privately and surface it to the user;
   do not post a ticket comment or DM.
8. Exclude tickets whose latest memory state is `INTENT_ANALYZING`,
   `ACTIVE_ANALYZING`, `ACTIVE_SPLITTING`, `ACTIVE_PLANNING`,
   `ACTIVE_EXECUTING`, `WAITING_UI_PLAN_APPROVAL`, `PR_MONITORING_HANDOFF`,
   `WAITING_CI`, `WAITING_REVIEW`, `WAITING_MANUAL_QA`, or
   `WAITING_HUMAN_MERGE` unless the recorded
   child must be resumed for a material event or reconciliation.
9. If the latest state is `SPLIT_REPAIR_REQUIRED`, treat it as legacy evidence.
   Do not run split repair and do not invoke `$cl-split`. Re-launch analysis for
   the current issue only when the ticket changed materially after the stored
   `closedloop_updated_at`, the stored `recheck_when` condition is satisfied, or
   the user explicitly asked to retry that ticket under the single-ticket
   policy.
10. Exclude tickets with `BLOCKED_SKIP`, `SPLIT_BLOCKED`, `SPLIT_PROPOSED`, or
   `SPLIT_CREATED`, or with latest fields showing `ALREADY_DONE_OR_DUPLICATE`,
   top-level `Complexity: HIGH` without an accepted unsplit atomic-shape
   override, or `Risk: EXTREME`,
   unless the ticket changed materially after the stored `closedloop_updated_at`,
   the stored `recheck_when` condition is satisfied, related child tickets now
   exist, or the user explicitly asked to retry. For `SPLIT_CREATED`, prefer
   working the created child tickets, not retrying the parent. If a
   `SPLIT_CREATED` parent is `BLOCKED` only because of the old split-parent
   convention and any implementation child remains unfinished, correct the
   parent to `IN_PROGRESS` and record a superseding memory state; do not treat
   that parent as product- or engineering-blocked.
11. Treat query-verified `CANCELED` as terminal under the same material-change
    or explicit-retry exceptions; do not infer it from PR state.
12. Do not treat `COMMUNICATION_PENDING` or
    `COMMUNICATION_FAILED_MANUAL_FOLLOWUP` as executable. These states apply
    only to authorized Product comments or explicitly user-requested
    communications. Verify their outcome before retrying and surface failure
    privately to the user. Never create them for a forbidden engineering
    comment.
13. For parents in `SPLIT_PROPOSED`, treat the state as legacy evidence. Do not
    create or search for new child tickets as a parent repair action. If related
    assigned issues already exist, analyze each one only as the single ticket it
    now is.
14. Prefer full ClosedLoop ticket URLs when prompting feature owners so later
   execution has an unambiguous ticket target.

## Feature Unit Formation

Use the existing batch representation for every feature unit. Complete and
freeze membership before implementation, then analyze each member and form one
execution owner:

1. Re-fetch every required member's priority from live ClosedLoop immediately
   before scheduling. Derive the feature's declared rank from its highest live
   required-member priority. Verify the live priority domain, then apply the
   sweep's explicit semantic scheduling policy:
   `URGENT > HIGH > MEDIUM > LOW > null/UNKNOWN`. Do not infer numeric,
   lexical, or enum direction, and never mutate ticket priority. Record the
   actual values and policy used. A missing or unrecognized value remains
   visible and ranks last.
2. Build the verified dependency DAG and detect cycles. A feature's effective
   rank is the highest of its declared rank and the effective ranks of
   downstream in-scope features that it demonstrably unblocks, transitively.
   Schedule topologically eligible prerequisites by effective rank descending.
   Thus a lower-declared-priority prerequisite for a blocked highest-priority
   feature runs before an unrelated medium-priority feature. A cycle remains an
   unresolved wait and never authorizes forced execution. Do not pull an
   other-owner or out-of-scope prerequisite into execution; surface its owner,
   inherited rank, blocking chain, and reassignment/coordination decision.
3. Among eligible units with equal effective rank, use declared rank, then the
   stable feature id as the deterministic tie-breaker.
   Critical-path order inside a unit follows its manifest and is implemented in
   the same PR. Never use smallest-ticket-first.
4. Every selected nonterminal shipping execution member needs its own valid `GO` or approved
   `GO_WITH_UI_PLAN_APPROVAL`, requirements contract, approvals, status,
   acceptance criteria, and non-`EXTREME` risk disposition. A proven internal
   dependency may be implemented in order inside the shared branch; it does not
   require a separately landed member PR. An external dependency must be
   resolved or, when the protected-owner policy permits, explicitly transferred
   first.
5. Require one repository and compatible implementation, validation,
   rollback/release, review, merge, and ownership policies for the entire unit.
   Park cross-repository or irreconcilable units and ask for a revised boundary.
6. Persist a versioned manifest with a stable batch/feature id, exact member
   URLs, owners, repositories, live priority values and ordering evidence,
   declared and effective ranks, inherited blocking chains, functional roles,
   grouping evidence, per-ticket
   analysis/PRD/approval/acceptance references, combined functional acceptance
   boundary, expected surfaces, aggregate complexity/risk, validation and
   rollback boundary, merge policy, canonical callback ticket, owner thread,
   and membership rationale. The owner gets one lane, worktree, branch, plan,
   established review lifecycle, PR, manual-QA plan, and queue-recovery
   lifecycle. Record the
   same manifest path/hash in every member's durable state.
7. Preserve existing in-flight branches and PR owners. Do not recombine,
   supersede, or close them without an explicit migration decision. If any
   required member blocks, park the whole unit; do not remove it or ship a
   backend/UI/Storybook subset as the complete feature.

## Queue Management

1. Maintain an active feature-owner set, a monitored waiting set, and an ordered
   next-ready feature queue derived from the locked manifests plus each listed
   member's direct dependency and stored `recheck_when` conditions. Persist the
   next-ready queue in the parent ledger or attached queue artifact with, for
   every remaining feature and member, its order, current eligibility, exact blockers,
   integration-overlap notes, existing child thread, and the event that makes it
   eligible. Update this table immediately after every ticket, PR, dependency,
   ownership, approval, or waiting-state transition. Do not rebuild it from a
   project-wide inventory when the manifest remains valid. Ticket lifecycle
   state is part of parent queue ownership: after re-fetching live ClosedLoop
   state, correct an in-scope Sweep-owner ticket whose `TRIAGE`, `BACKLOG`,
   `TODO`, `BLOCKED`, `IN_PROGRESS`, or `IN_REVIEW` state no longer matches its
   approved requirements, validated analysis/readiness state, active execution,
   dependency state, or live PR state. Never mutate status merely to make the
   ledger self-consistent, from stale analysis, or across an unresolved
   Product/requirements, ownership, safety, or dependency gate. Re-fetch the
   corrected ticket and write a superseding workflow-memory record immediately.
   Before treating the queue as reconciled, compare its entire assigned
   nonterminal scope with the operator-facing ownership ledger. Create a
   normally fenced parked owner for every legitimate waiting ticket that lacks
   a recoverable feature owner, using Durable Ticket State's operator-visible
   coverage invariant. Create one shared parked feature owner/session and bind
   every applicable member ledger row to it; never create an independent parked
   session per component ticket. Never leave such a ticket represented only in the queue artifact,
   workflow memory, or display feed.
   Show blocked high-priority units prominently with their declared/effective
   ranks and exact blocking chain, then schedule the next topologically eligible
   unit. A newly observed priority never preempts a valid active writer or the
   mandatory existing-PR event reconciliation.
2. A feature owner is active while it is analyzing members, planning, executing, or
   needs one parent action such as legacy split-state reconciliation or an authorized Product-decision
   comment. A child is monitored, but not counted against the effective
   active-work limit, while it is in `WAITING_UI_PLAN_APPROVAL`,
   `PR_MONITORING_HANDOFF`, `WAITING_CI`, `WAITING_REVIEW`,
   `WAITING_MANUAL_QA`, or
   `WAITING_HUMAN_MERGE`. Watching a monitored child is never the parent
   orchestrator's only activity while the next-ready queue contains an eligible
   ticket.
3. At the start of every sweep cycle, reconcile every sweep-owned tracked open
   PR and its recorded monitor once using
   [Open PR Lifecycle](open-pr-lifecycle.md), beginning with durable
   worker/monitor state. For an exact PR/head or queue generation with a
   registered healthy monitor, do not re-query GitHub; reuse it. Stop and
   replace a stale one; start one when absent. Never create two monitors for the
   same PR and parent thread.
4. On a monitor wake, persist the exact current-head/review/check/queue/close or
   merge event and monitor state, then immediately resume the existing owning
   child with that evidence when remediation, enqueue/re-enqueue, or terminal
   reconciliation is needed. After the child returns a fresh handoff, verify the
   new head/generation and start or refresh the single monitor. Apply resulting
   transitions to the next-ready queue, then immediately fill every free active
   slot from the ordered queue up to the effective concurrency limit. A stored
   blocker may be re-analyzed as soon as its exact `recheck_when` condition is
   satisfied; do not wait for the user to ask what is next. If no ticket can use
   a free slot, the queue must already state the exact literal dependency,
   semantic/product conflict, atomic-combination reason, or human decision for
   every remaining item so the parent can answer from the artifact without a
   fresh broad search.
   Before filling a slot, re-fetch material priority for every eligible unit and
   recompute transitive effective rank with cycle detection. A report snapshot
   or workflow-memory value is evidence, not current scheduling authority.
   Fill every remaining free lane after the highest-ranked eligible selection.
   Do not reserve an idle lane for a blocked downstream unit: if prerequisite A
   is selected because it inherits B's higher rank, the next free lane may run
   the next eligible independent unit C. Recompute after A completes so B can
   become the highest eligible unit.
5. Launch or resume feature owners until the active set reaches the effective
   concurrency limit, defaulting to three and never exceeding ten. One feature
   counts once regardless of member count. A designated owner may analyze its
   members serially before execution; never launch independent mutating
   component owners merely to fill lanes. Keep bounded look-ahead analysis or
   acceptance preparation inside the feature lane when useful. Do not spend
   repeated tokens rediscovering the queue: re-fetch only the locked members and direct
   dependency facts whose recorded transition condition changed.
6. Before treating a child as terminal, apply the open-PR retention guard. A
   child goal completing, a task being archived, or a PR becoming green does not
   make the parent state terminal while the PR remains open. Stop and record
   cleanup of any detached monitor when the PR merges, closes, is abandoned, or
   leaves parent ownership.
7. When the feature owner is actually terminal, remove it from the active set:
   - The shared PR is merged, integrated acceptance and manual QA pass on the
     applicable final head, every member is reconciled, no completion message
     was posted, and `DONE` is recorded per member.
   - Explicitly abandoned, superseded, duplicate, or no longer required, with
     the ClosedLoop ticket canceled, linked plan reconciled, supporting human
     evidence recorded, and `CANCELED` query-verified.
   - Legacy split-created or split-proposed state reconciled without new split
     work, split-created parent status corrected to `IN_PROGRESS` when already
     existing children remain, and assigned tickets re-queried for current
     single-ticket work.
   - Engineering/operational blocker recorded privately as `BLOCKED_SKIP` with
     its recheck condition and surfaced to the user; no ticket comment or DM is
     required.
   - Authorized Product/explicit-user communication failed, the unsent message
     was recorded as `COMMUNICATION_FAILED_MANUAL_FOLLOWUP`, and the parent
     summary clearly requires manual follow-up.
   - Manual intervention required, its private evidence/action was recorded and
     surfaced to the user; no public recordkeeping comment or DM is required.
8. After removing a terminal feature owner, refresh its direct dependents in the locked
   queue and launch the next eligible ticket if one exists.
9. Continue this cycle until there are no eligible assigned tickets left, the
   active set is empty, and no monitored child remains in
   `WAITING_UI_PLAN_APPROVAL`, `PR_MONITORING_HANDOFF`, `WAITING_CI`,
   `WAITING_REVIEW`, `WAITING_MANUAL_QA`, or `WAITING_HUMAN_MERGE`. If a monitored owner cannot
   progress because human input is required, first route or record that blocker
   and convert it to `MANUAL_INTERVENTION`, `BLOCKED_SKIP`, or
   `COMMUNICATION_FAILED_MANUAL_FOLLOWUP` only when the wait is no longer a
   valid approval/review/CI/human-merge wait state.
10. If every remaining assigned ticket is blocked, duplicated, high-complexity
    without an override, extreme-risk, communication-failed, or waiting for human
    input outside a valid monitored state, add only applicable Product-decision
    comments and summarize all engineering/operational blockers privately to the
    user. Do not post engineering comments or DMs. For valid
    `WAITING_UI_PLAN_APPROVAL` or `WAITING_HUMAN_MERGE` tickets, keep the
    plan/PR linked and monitored without a blocker comment. Leave the goal active
    with explicit `recheck_when` conditions, or mark/report it blocked only when
    goal policy allows; do not mark it complete.

## Legacy Split State Handling

Use this section only when older memory or callbacks contain split states such
as `SPLIT_REPAIR_REQUIRED`, `SPLIT_CREATED`, or `SPLIT_PROPOSED`. They are
legacy evidence. Do not invoke `$cl-split`, do not create child tickets, and do
not emit split repair as the next action for a new analysis.

1. Identify the current issue and any historical parent/sibling links only to
   avoid duplicate work and understand existing context.
2. Preserve active or completed child issue work as historical evidence. Do not
   supersede, rewrite, replace, or add sibling tickets as a split repair.
3. If the current issue is eligible for retry, send it back through
   `$cl-analyze` as a single ticket. If it remains too broad, overlapping,
   dependent, or unclear, record `BLOCKED_SKIP` or `MANUAL_INTERVENTION` with
   private evidence unless an exact-ticket or session-level instruction accepts
   the unsplit atomic ticket shape.
4. Do not send external communication for legacy split-state handling. Use a
   Product comment only for an independently actionable Product decision.
5. Keep any already-existing assigned child issues in the queue only as their
   own single tickets. Correct an old split-created parent from `BLOCKED` to
   `IN_PROGRESS` only when existing child implementation work remains; never do
   that by creating new children.
