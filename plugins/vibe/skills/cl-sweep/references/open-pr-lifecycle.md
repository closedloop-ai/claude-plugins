# Open PR Lifecycle

Use this procedure for every sweep-owned PR before ledger rewrites, ticket
selection, resume, compaction recovery, blocked-goal decisions, and completion
decisions. Treat external-owner PRs as read-only context unless the current user
explicitly transfers that exact PR or owner lane into the sweep.

## Contents

- Ownership Invariant
- Build the Bounded Open-PR Set
- Single Monitor Protocol
- Event Routing
- UI/Non-UI Merge Disposition
- Review Remediation Cutoff
- Coverage and External Gate Failures
- Merge Queue Generation Protocol
- Generation Conflict Probe
- Worker PR Packet
- Terminal Reconciliation
- Required Ledger Fields

## Ownership Invariant

An open sweep-owned PR is a nonterminal parent obligation. The `$cl-execute`
child remains the ticket owner for diagnosis, remediation, validation,
review-thread replies and resolution, re-enqueue actions, and terminal
ClosedLoop/plan/memory/result reconciliation. The `$cl-sweep` parent owns
passive event detection and the merge-queue generation protocol. The parent
never implements, runs or triggers CI/review, or fixes the PR; the child never
passively polls after handoff.

For a feature unit, the one PR belongs to its designated execution owner and
covers every executable shipping member in the versioned manifest. Preserve
external or already-in-flight PR owners; require an explicit migration or
feature-boundary decision before replacing or combining them.

A PR is sweep-owned only when current private state proves this sweep owns that
exact PR/head: a current ticket-worker `PR_MONITORING_HANDOFF` or
`WAITING_HUMAN_MERGE` record naming the PR, a workflow-memory/ledger row written
by this sweep that binds the PR to the worker, a PR created by a current sweep
child, or an explicit current user instruction naming the PR or owner lane.
Ticket slug matches, split-lineage edges, dependency relevance, project
membership, historical monitor records, prior queue membership, green checks,
or merge readiness are discovery evidence only. They do not grant ownership of
an external-owner PR.

Keep the child task id and host, branch, PR, current head, monitor identity, and
recheck condition in workflow memory and the durable ledger until live GitHub
proves the PR merged or closed and the child completes reconciliation.

## Build the Bounded Open-PR Set

Union these sources, then re-fetch every candidate from live GitHub:

1. Open PR rows in the prior ledger or queue attachment.
2. Latest workflow-memory records for locked tickets in active or waiting
   states, including archived child tasks.
3. Locked tickets whose live ClosedLoop status is `IN_PROGRESS` or `IN_REVIEW`,
   plus direct branch/plan relationships.
4. Open repository PRs whose title, body, or head branch contains a locked
   ticket slug.

Treat ClosedLoop Graph as discovery evidence and live GitHub as PR authority.
Reject a ledger rewrite that omits a prior open PR without live `MERGED` or
`CLOSED` evidence. A completed child goal, archived task, assignment change,
green checks, resolved reviews, or merge readiness is not removal evidence.

After the union, classify every candidate before starting or recovering a
monitor:

- `owned_sweep_pr`: current sweep state satisfies the ownership invariant above.
- `external_context_pr`: the PR was discovered by slug, lineage, dependency,
  project state, or historical monitor/queue records, but lacks current
  sweep-ownership proof.

Only `owned_sweep_pr` enters the monitor, event-routing, enqueue, re-enqueue,
merge, and terminal-reconciliation lifecycle below. Keep
`external_context_pr` rows only as dependency/context notes. Do not start or
recover parent-owned detached monitors, enqueue, re-enqueue, merge, close,
trigger/rerun CI or review, reply to comments, diagnose failures, or route
remediation for them. If older sweep state already registered a monitor for an
external-context PR, stop/drop it after verifying no pending material event; if
there is a pending event, route only a no-mutation external-context summary,
then stop/drop the monitor and record the correction privately.

## Single Monitor Protocol

For each sweep-owned open PR, use `$gh-monitor-pr` to run exactly one detached
monitor targeting the parent sweep thread. Key logical sweep ownership by `(PR
URL, sweep id)` and physical delivery by the current `(PR URL, parent thread
id, root generation)`. Always pass the current root surface and generation,
including Desktop generation `1` for a newly indexed sweep; do not use the
standalone Desktop generation-`0` compatibility default. Before every start or
refresh:

Once a healthy detached monitor is registered for the exact PR/head or immutable
queue generation, it is the sole passive event detector. The parent must not
perform routine, turn-boundary, goal-continuation, or heartbeat polling for that
PR, and must not write no-op monitor-heartbeat ledger or memory records. The
parent routes material monitor events, answers explicit user status requests
from durable state when sufficient, and performs terminal cleanup or
reconciliation.

1. Read the recorded monitor state file and run `monitor-pr.mjs status`.
2. Reuse it only when it is healthy, targets the same parent thread and PR, and
   watches the current PR head or recorded queue generation.
3. Stop it before replacement when it is unhealthy, exited without a handled
   event, targets another owner thread, or watches a stale head/generation.
4. Start one replacement from the parent thread, record its PID, state file,
   log file, target thread, PR, watched head/generation, health, and start time,
   then query-verify the ledger/memory write.

After every start or refresh, register the monitor state file with
`sweep-root-state.mjs register-monitor`. During a project-keyed root adoption,
stop and verify the old monitor, then pass both its state and the prepared
`CL_SWEEP_ROOT_TRANSFER v1` receipt to `gh-monitor-pr`. Advance the owner
generation exactly once. The replacement baseline's `registrationDelta` is the
new root's first material event. Never run an old-thread and new-thread monitor
for the same sweep PR concurrently.

The detached monitor exits after its first wake. A material event therefore
consumes that monitor generation. After routing the event and receiving the
worker's new handoff, start or refresh one monitor for the resulting head or
queue generation. Never overlap old and replacement monitors for the same key.
Stop and remove the recorded monitor when the PR merges, closes, is explicitly
abandoned, leaves sweep ownership, or is replaced by another PR. Preserve the
PR row until terminal child reconciliation completes.

## Event Routing

A monitor wake for a sweep-owned PR is evidence to inspect, not permission for
the parent to repair.
The parent re-fetches the bounded live state and sends the existing ticket
worker a compact routing envelope: PR URL/state; previous and current head;
review event/thread ids and URLs; failing check name, conclusion, and run URL;
queue membership and immutable generation tuple; dequeue event and reason;
merge commit/time; and monitor state/log identity. Unarchive the exact child if
needed and explicitly resume it.

This is a strict evidence ceiling, not a minimum investigation checklist. The
parent must not download Actions job logs, read full annotations or test output,
inspect source diffs, run code/Graph ownership searches to attribute the failure,
reproduce it, classify it as target- or predecessor-owned, or propose the code
repair. The ticket worker owns all of that diagnosis and returns a compact
evidenced classification. The parent may then route that worker-produced result
to an already tracked cross-ticket owner without independently repeating it.
The only parent-owned diagnostic exception is the immutable queue-generation
conflict probe below, because it fences which generation the worker should act
on; monitor-process troubleshooting is also parent-owned but must not expand
into ticket diagnosis.

If a legacy monitor wakes for an external-context PR, do not route remediation
or queue recovery. Record a no-mutation external-context summary, stop/drop the
monitor, and keep the PR out of the sweep-owned open-PR set unless the user has
explicitly transferred it into the sweep.

Merge-queue events while the PR remains queued are passive monitor state, not a
worker remediation trigger. Do not wake the ticket worker, inspect logs or
diffs, fetch ownership evidence, patch, rebase, push, trigger CI/review, merge,
enqueue, or requeue solely because a merge-group check failed, GitHub marked an
opaque queue entry `UNMERGEABLE`, or the immutable queue generation changed. In
particular, a `merge_queue_unmergeable` event with `headCommit: null` is
non-actionable by itself because GitHub may be comparing against future queue
composition. Keep or recover the detached monitor and wait for one of these
material events: the PR leaves the queue before merging, the PR merges/closes,
the source PR head changes, a current-head check fails, a concrete source PR
conflict appears, or a current unresolved review thread appears. If the PR is
ejected/left the queue unmerged, route that dequeue/ejection event to the worker
with the compact evidence envelope.

Use this mapping for sweep-owned PRs:

| Material event | Parent action |
|---|---|
| New actionable feedback, failed current-head check, head change, confirmed source PR conflict, or dequeue/ejection before merge | Write `ACTIVE_EXECUTING`; resume the worker with exact evidence. Coverage remains worker-owned until green. |
| Current head becomes green/review-ready | Require canonical integrated-feature manual QA on the applicable head for every PR. For UI PRs, also require one pre-PR Parker pass, a not-applicable proof, or Daniel's explicit exception; if absent, resume the worker for that evidence/exception/blocker. If manual QA is pending or stale, keep the same owner in `WAITING_MANUAL_QA` through existing `WAITING_HUMAN`. Otherwise resume the worker to run the bounded conformance/merge action, or record `WAITING_HUMAN_MERGE` when policy requires a human. |
| Merge-queue check failure, opaque queue `UNMERGEABLE`, or queue generation change while still queued | Do not wake the worker or diagnose. Keep or recover the detached monitor for the same PR/head/queue generation and wait for ejection, merge, closure, current-head failure, concrete source conflict, head change, or review feedback. |
| Merged | Stop the monitor and resume the worker for terminal ticket, plan, legacy split-parent if present, workflow-memory, and structured-result reconciliation. |
| Closed unmerged | Stop the monitor, write `ACTIVE_EXECUTING` with `reason: closed_unmerged_reconciliation`, and resume the worker. Never infer `DONE` or `CANCELED`. |
| Monitor operational failure | Stop/replace it when ownership remains valid; route to the worker only if PR evidence also requires worker action. |

After remediation the worker must return a fresh structured handoff and stop
passive polling. The parent verifies the reported head/state and the live
unresolved review-thread count for that exact PR/head, persists it, and starts or
refreshes the single monitor only when zero current unresolved review threads
remain. A worker claim, stale monitor snapshot, check-rollup summary, or missing
thread field is not proof. If live GitHub shows any unresolved review thread,
reject the handoff as malformed/incomplete, write `ACTIVE_EXECUTING` with the
thread URLs/count, and resume the same worker to address, reply/defer, and
resolve them under the review-remediation rules before any passive monitor,
ready-to-merge, manual-merge, enqueue, or requeue disposition. An executed
coverage failure cannot be classified as advisory or non-attributable. Only
inability to execute the job may remain `WAITING_CI`.

## UI/Non-UI Merge Disposition

Before any merge disposition, require the execution child to classify and record
the sweep-owned PR's actual diff and affected runtime surfaces as `ui_work: YES`
or `ui_work: NO`. `UNKNOWN` blocks disposition. Any user-perceivable UI change
makes a mixed PR UI work.

UI PRs require Daniel's human/manual merge by default. Green,
review-complete, requirements-conformant, mergeable non-UI PRs must be resumed
to the child for immediate direct enqueue through the ordinary protected GitHub
merge queue under `$cl-execute`/`$cl-sweep` standing authorization. Do not use
`autoMergeRequest` or `gh-stack` unless the user separately authorizes that
exact mechanism. A newer explicit user instruction for the exact PR may override
this default.

For both UI and non-UI PRs, "review-complete" means the parent has live-fetched
the exact PR/head and observed zero current unresolved review threads. Do not
infer review completion from worker prose, approvals, green CI, `mergeStateStatus`,
or a monitor state file alone.

Before a UI PR enters `PR_MONITORING_HANDOFF`, `WAITING_HUMAN_MERGE`, a
ready-to-merge summary, or any queue/manual-merge path, require one dedicated
pre-PR Parker visual-QA pass, a precise not-applicable production-consumer
proof, or Daniel's explicit exception for an already-open PR. If an already-open
UI PR lacks that evidence or exception, resume the exact child to provide the
existing pre-PR evidence, obtain Daniel's exception, or return the exact
blocker; do not present it as waiting only on CI or manual merge. Later PR head
changes after the pre-PR pass or Daniel exception do not require another Parker
pass unless Daniel explicitly asks.

Standing non-UI queue authorization never applies to external-owner PRs. Those
stay read-only until the user explicitly transfers that exact PR or owner lane
into the sweep.

Ticket-specific or older workflow-memory instructions requiring Daniel's manual
merge for every Branches PR are obsolete and must not override this standing
UI/non-UI policy. Treat them as historical evidence only. Do not convert a ready
non-UI PR to `WAITING_HUMAN_MERGE` because of such a record; only a newer
explicit user instruction for that exact PR can do so.

## Review Remediation Cutoff

The execution child follows `$cl-execute`'s review and PR-comment rules in
`../../cl-execute/references/implementation-review-pr.md`: how many coordinated
review generations run, what counts as the one ordinary review-remediation
push, how comments are triaged, and how valid comment fixes are bundled into an
independently required repair commit. The parent does not restate those rules;
it enforces the resulting cutoff. The one ordinary review-remediation push
remains the default review-driven code cutoff: never ask the user to authorize
another review generation or a comment-only or review-only push, and never
manually trigger review or CI. Later comments alone never justify a push and may
be included only when an automatic CI failure, source
conflict, queue/base failure, or validation regression independently requires
another repair commit.

Parent coordinators must enforce this cutoff even when a ticket worker reports
`MANUAL_INTERVENTION_REQUIRED`, `REVIEW_BLOCKED`, or a `parent_action` asking
for second-push authorization. Treat that callback as evidence to validate, not
as the final routing decision. Before asking the user to authorize another
source push for review feedback after the first PR-comment remediation push,
require either:

- an independent source-changing trigger: automatic CI failure, source conflict,
  queue/base failure, or validation regression that already requires a repair
  commit; or
- a worker-produced `DEFERRED_REVIEW_FINDINGS` classification for every
  unresolved thread, including whether each finding proves a current
  acceptance, requirements, security, data-integrity, or compatibility violation
  versus a valid follow-up-ticket item.

If neither evidence path is present, the parent action is to resume or steer the
same worker for bounded post-cutoff classification. Do not collapse this state
to "authorize a second push, replan, or close", and do not ask the user for
second-push authorization while the follow-up-ticket path has not been
evaluated.

Without an independently required repair commit, when review findings remain
unresolved after the ordinary cutoff, resume the same child only for bounded
PRD-aware classification and require one `DEFERRED_REVIEW_FINDINGS` block
containing the PR/comment URLs, severity, concise defect/risk, applicable PRD
boundary, likely code surface, and duplicate-search evidence. For genuinely
out-of-scope follow-up work, the parent sweep may create or reuse one simple
consolidated PRD-compatible ticket for that comment wave, add it to the locked
queue, and return its URL to the child. The child then links and resolves those
deferred threads without changing current-PR code.

If a deferred finding proves the current PR violates its own acceptance,
requirements, security, data-integrity, or compatibility contract, do not merge
or ask for another push. Return a nonmergeable
`MANUAL_INTERVENTION_REQUIRED` disposition with the exact conflict. If restoring
the deliverable requires a new ticket or PR to carry any approved scope from
this unmerged PR, stop at the Cross-Ticket Replacement Gate below; do not
automatically create a replacement from the blocker callback.
Automatic CI failures, merge conflicts, queue failures, and validation
regressions remain current-ticket responsibilities and must still be fixed until
the PR reaches its authorized merge path.

## Cross-Ticket Replacement Gate

Before proposing a second ticket or PR to deliver an unmerged predecessor's
approved acceptance, recheck the predecessor's *current* PR/head and any
independent CI, conflict, queue/base, or validation repair trigger. A review
cutoff is not by itself permission to move the feature. Keep the predecessor
nonmergeable and its exact owner parked while the decision is unresolved; do
not shrink its acceptance or describe the new ticket as a narrow bugfix if it
must port the original feature.

Present one short private operator decision **before** creating the replacement
ticket, drafting/uploading its plan, acquiring its implementation owner, or
changing the old PR/ticket disposition. State plainly:

- which original ticket, plan, PR, and approved deliverable would move; what
  remains with the old PR; and whether the replacement must port the entire
  feature or only a separable subset;
- why repairing the original PR is currently unavailable or worse, including
  the live repair-trigger check, and the concrete alternatives (repair the
  original when authorized, replace its delivery, or keep it parked);
- the proposed new ticket/PR owner, the code and test scope to be carried,
  expected review and manual-QA ownership, and the intended status/link/PR
  disposition for *both* tickets after delivery.

Ask for explicit approval of that **cross-ticket replacement and disposition**,
separately from any implementation-plan approval. A generic sweep request,
priority instruction, worker recommendation, approved PRD, or “approve PLN-X”
does not answer it, even when PLN-X describes the port. Record the exact
operator answer and approved scope in the private sweep ledger and workflow
repo memory, query-verify both, and make the replacement ticket/plan and both
owners read the same decision. If a supported live ClosedLoop relationship can
represent the approved ticket-to-ticket succession, create and re-fetch only
that exact relation; otherwise keep the lineage explicit in the operator
ledger and do not claim ClosedLoop itself links the tickets.

At replacement PR handoff and terminal reconciliation, re-check that the PR
still matches the separately approved transfer: carry every moved acceptance
criterion, identify what was retained versus changed, bind final-head QA to
each ticket without relabeling the predecessor's unrun checkpoints as PASS, and
verify the old PR/ticket/plan disposition with its exact owner. Any materially
broader port or changed disposition requires a new plain-language operator
decision; approval of a revised implementation plan alone cannot silently
expand the transfer. Genuinely out-of-scope follow-up tickets that do not
replace an unmerged deliverable retain the ordinary follow-up path above.

## Coverage and External Gate Failures

Do not accept an open-PR child as terminal merely because a failing gate is
external to the ticket diff. Infrastructure, credential, GitHub App,
repository-access, and platform failures remain nonterminal ticket-child
obligations until the PR merges or the user explicitly abandons it. Require the
child to diagnose the exact repair, perform it with existing authorized access
when safe and in scope, otherwise route the smallest concrete
owner/action/access requirement, return a monitored handoff, and recover or
re-enqueue when the parent reports that the condition cleared. The child must
not weaken CI or add unrelated code merely to pass an external gate, but
`unrelated` is not a valid reason to release PR ownership.

Treat any failing automatically reported current-head coverage check as
`ACTIVE_EXECUTING`, regardless of whether GitHub branch protection marks it
required or whether the measured package was in the ticket's initial diff.
Resume or retain the exact ticket child to diagnose and fix it. Do not accept
`PR_MONITORING_HANDOFF`, `WAITING_HUMAN_MERGE`, merge readiness, or an advisory
or non-attributable disposition while coverage is red. The parent hands off
coarse failure evidence; the child owns logs, reproduction, correction,
validation, and automatic-CI recovery. Only a confirmed CI-provider outage or
inability that prevents the coverage job from executing may remain
`WAITING_CI`; once the job executes and reports insufficient coverage, it must
remain `ACTIVE_EXECUTING` until green.

## Merge Queue Generation Protocol

For sweep-owned PRs, the parent owns passive queue membership/generation
detection and generation-scoped conflict evidence. Key observations by entry
id, `baseCommit.oid`, PR `headRefOid`, and `headCommit.oid`; do not infer
health from top-level PR mergeability. Send confirmed SHAs, checks, removal
event, and probe output to the worker. The worker owns source integration,
fixes, validation, replies, resolution, and re-enqueue; the parent then monitors
the new generation. For external-context PRs, queue events are status context
only and must not be recovered, enqueued, re-enqueued, or diagnosed by the
sweep.
Neither role manually triggers CI or review. Queue recovery does not reopen
code review; the worker stays under `$cl-execute`'s review rules.

## Generation Conflict Probe

Use the queue entry's `state`, not nested PR mergeability. Query the minimum
read-only GraphQL fields: queue merge method; entry id, position, state,
`baseCommit.oid`, `headCommit.oid`, and synthetic check rollup; PR number,
`headRefOid`, mergeability; and pagination. Follow pages through every sweep PR
and candidate predecessor. Query on a monitor wake, enqueue/re-enqueue handoff,
parent resume, or compaction recovery; never create a passive polling loop.

Treat `UNMERGEABLE` as nonhealthy, not proof of source conflict. A null
synthetic head in `QUEUED` or `LOCKED` is transitional. Identify the predecessor
whose synthetic head equals the target entry's base; never infer it from queue
position. For a merge- or squash-based generation, fetch the exact queue base,
PR head, and merge base, then run:

```text
git merge-tree --write-tree --messages --merge-base=<merge-base> <queue-base> <pr-head>
```

Exit 0 is clean, exit 1 is a source conflict, and any other exit is
inconclusive. Before reporting exit 1, immediately re-query and require the same
entry id, base, PR head, and synthetic head. Discard stale results after a
rebuild. Rebase queues require ticket-worker commit-by-commit diagnosis.

When an entry disappears, query the latest ordered queue lifecycle events. A
matching latest `RemovedFromMergeQueueEvent` with exact reason
`merge_conflict` is authoritative; hand its timestamp, reason, and
`beforeCommit.oid` to the worker. Record `manual`, unknown reasons, and missing
SHAs exactly. Never infer conflict from absence or a later force-push.

GitHub documents that a merge group contains the target branch and preceding
queued PRs, and that conflicts or failed required checks remove a PR:
https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue

## Worker PR Packet

When `$cl-sweep` sends `$cl-execute` to a ticket worker, include the following
packet verbatim or as an equivalent self-contained artifact whenever PR work can
occur:

```text
For a feature unit, create exactly one PR covering every executable shipping member. After the PR exists, read and follow ../../cl-execute/references/feature-manual-qa.md. As the live PR author, own one manual-QA plan comment and update it in place. If the PR author is a bot, name the explicit responsible human. Map every member acceptance criterion to scenarios and include the full shipping-surface workflow. Record the exact current/tested heads; a head change makes impacted scenarios stale until rerun, with prior-head carry-forward allowed only under the canonical justification. Return WAITING_MANUAL_QA through the existing WAITING_HUMAN event while evidence is pending, failed, blocked, missing, stale, or not author-owned. Posting the plan does not open UI and does not replace Parker visual QA or automated headless/displayless E2E.
Before merge disposition, classify and record the actual sweep-owned PR as UI or non-UI. UI PRs wait for Daniel's human/manual merge by default. Green, mergeable non-UI PRs owned by this sweep must be directly enqueued immediately through the ordinary protected GitHub merge queue under standing authorization. Do not use autoMergeRequest or gh-stack unless separately authorized for that exact mechanism. Ignore older ticket-specific or Branches-wide workflow-memory instructions requiring manual merge for all PRs; only a newer exact user instruction may override this default. This standing authorization never applies to external-owner PRs; those remain read-only context until the user explicitly transfers that exact PR or owner lane into the sweep.
For UI, UI-impacting contract, or workflow changes, satisfy the Parker Visual-QA Gate in ../../cl-execute/references/implementation-review-pr.md before first push/open PR or any action that raises PR review/CI. The parent does not ask for a later current-head Parker refresh unless Daniel explicitly asks.
Follow the code-review and PR-comment rules in ../../cl-execute/references/implementation-review-pr.md for review generations, comment triage, the one ordinary review-remediation push, and bundling valid comment fixes into an independently required repair commit. Never manually trigger or retrigger review or CI. Later comments alone never justify a push. Without an independently required repair commit, classify unresolved findings into one DEFERRED_REVIEW_FINDINGS block with the PR/comment URLs, severity, concise defect/risk, applicable PRD boundary, likely code surface, and duplicate-search evidence. For genuinely out-of-scope work, the parent may create one consolidated follow-up ticket and return its URL; then link and resolve those threads without changing current-PR code. If a deferred finding proves the current PR violates its own acceptance or governing contract, return MANUAL_INTERVENTION_REQUIRED and do not merge. Before any replacement ticket or PR re-delivers that unmerged feature, stop for the separate plain-language operator approval in the Cross-Ticket Replacement Gate; plan approval alone does not authorize the transfer. Revalidate in-PR fixes and establish the current PR/head/check/review/queue state. Then return PR_MONITORING_HANDOFF to the parent thread and stop passive polling. Do not launch a child-targeted monitor. The parent will run exactly one detached $gh-monitor-pr monitor for this sweep-owned PR and resume this same child with exact material event evidence. On each resume, perform only bounded event handling; do not reopen code review. Fix CI/conflict/queue/validation failures, process deferred-comment linkage as directed by the parent, enqueue or re-enqueue as applicable, and return a fresh handoff. On merge evidence, reconcile ticket, plan, split-parent, workflow-memory, and structured result state. When the decision-table skill is available, use it once and keep it bounded to the meaningful state/edge-case surface; do not loop it. Persist and query-verify any qualifying generalized review lesson required by $cl-execute.
Do not merge or rebase current main merely because it advanced or as a final-integration precaution. When the PR head is green and GitHub reports it mergeable, enqueue that unchanged validated head and let the protected merge queue perform speculative integration. Integrate main only for a confirmed source conflict, a proven unlanded dependency, or concrete queue/base failure evidence.
```

## Terminal Reconciliation

A closed-unmerged child must return one of: a new open PR handoff;
`BLOCKED_SKIP`/`MANUAL_INTERVENTION` after normal routing; or `CANCELED` only
with explicit current abandonment evidence, live canceled ClosedLoop state,
and reconciled plan state. A merged child must verify acceptance and
requirements evidence, mark included features `DONE`, mark linked plans
`EXECUTED`, verify canonical manual QA and integrated feature acceptance on the
applicable final head, reconcile legacy split parents if present and workflow memory, and return the final
structured result. The parent writes `DONE` only after verifying that result.

## Required Ledger Fields

For every sweep-owned open PR retain: ticket; PR and branch; current head; child
task id and host; ClosedLoop ticket/plan state; merge policy; checks;
unresolved review count; mergeability; `ui_work`; `ui_visual_qa`; queue
membership and generation tuple; last event and observation; exact
`recheck_when`; monitor PID, state/log files, target parent thread, watched
head/generation, health, and start time; and event-handoff status. Update and
query-verify the row after every material transition. For every external-context
PR retain only the dependency/context reason, live PR URL/state/head, why
ownership proof failed, and the no-mutation next action.
