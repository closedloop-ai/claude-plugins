# Durable Ticket State

Use workflow repo memory as the durable state log for tickets that are active,
executing, blocked, skipped, done, or waiting on manual follow-up.
The parent summary is useful context, but workflow repo memory is the source
that survives compaction, restart, and fresh project sweeps.

## Memory Root And Namespace

Resolve the workflow memory root with the standalone workflow-memory package:

```bash
workflow-memory root <optional-env-file-flag>
```

Use `<optional-env-file-flag>` only when the local installation documents one,
for example `--env-file <path-to-workflow-memory-env>`. Do not assume a
machine-specific env-file path in the shared skill pack.

Use canonical trigger/action key `cl_sweep_ticket_state`. Resolve one
deterministic canonical memory repo namespace before ticket selection starts:
use the project implementation repo when it is unambiguous at the project
level, otherwise use a repo-memory namespace explicitly documented for that
ClosedLoop project. If neither can be resolved deterministically, stop before
launching child work and surface the private orchestration blocker to the user;
do not post a ticket comment or DM. Do not vary the memory namespace per ticket
or per sweep run; store the implementation repo separately in the memory body.

## Query

Before launching or resuming a ticket, query memory for prior state:

```bash
workflow-memory query --summary-only <optional-env-file-flag> --repo <memory_repo> --query "cl_sweep_ticket_state <project_slug_or_url> <FEA-slug>"
```

Prefer `--summary-only` whenever the installed CLI advertises it. Preserve the
returned ids, paths, scores, match reasons, relations, warnings, and attachment
metadata, then expand the body of only the exact selected record when its body
is materially required. If the installed CLI predates this option, fall back to
the ordinary query without treating that compatibility fallback as a blocker.

Also run the action-filtered query when supported by the current CLI:

```bash
workflow-memory query --summary-only <optional-env-file-flag> --repo <memory_repo> --action cl_sweep_ticket_state --query "<project_slug_or_url> <FEA-slug>"
```

## State Record Schema

The workflow-memory store is append-only for this use. Make writes idempotent by
using stable title/trigger fields, then selecting the latest exact
project/ticket record by `recorded_at` during queries. Write a superseding
record for each phase transition:

```text
cl_sweep_ticket_state
project: <project slug or URL>
sweep_id: <stable project-keyed sweep id>
sweep_root: <absolute stable sweep root path>
root_thread_id: <current parent CODEX_THREAD_ID>
root_generation: <positive callback/root ownership generation>
ticket: <FEA slug and URL>
state: <INTENT_ANALYZING | ACTIVE_ANALYZING | ACTIVE_SPLITTING | ACTIVE_PLANNING | ACTIVE_EXECUTING | WAITING_UI_PLAN_APPROVAL | PR_MONITORING_HANDOFF | WAITING_CI | WAITING_REVIEW | WAITING_MANUAL_QA | WAITING_HUMAN_MERGE | SPLIT_CREATED | DIRECT_EXECUTION_RECOMMENDED | CHILD_EXECUTION_ONLY | SPLIT_PROPOSED | SPLIT_REPAIR_REQUIRED | SPLIT_BLOCKED | BLOCKED_SKIP | COMMUNICATION_PENDING | DONE | CANCELED | COMMUNICATION_FAILED_MANUAL_FOLLOWUP | MANUAL_INTERVENTION>
child_thread_id: <thread id or none>
child_host_id: <host id or none>
child_thread_title: <stable title such as CL Analyze <FEA-slug> or none>
codex_project_id: <project id or none>
execution_surface: <desktop | cli>
owner_role: <root | ticket_worker>
owner_id: <Desktop task id | CLI managed thread/session owner id>
owner_generation: <positive integer>
ownership_ledger: <absolute ownership.jsonl path or none on legacy Desktop records>
lease_id: <opaque lease id or none>
lease_token_hash: <sha256 token hash or none; never store the raw token>
worker_session_id: <managed/App Server or codex exec session id or none>
checkpoint: <absolute verified checkpoint path or none>
last_event_id: <accepted callback event id or none>
worker_replacement: <none | prior owner/generation and reason>
worktree: <yes | no | unknown>
memory_repo: <canonical sweep-state repo namespace>
implementation_repo: <repo name or unknown>
branch: <branch name or none>
pr: <PR URL/number or none>
pr_state: <OPEN | MERGED | CLOSED | none>
pr_head: <head SHA or none>
pr_mergeability: <live mergeability/merge-state summary or none>
pr_checks: <aggregate automatic-check state or none>
pr_unresolved_threads: <count or unknown>
merge_policy: <automatic | merge_queue | human_review_and_merge | none>
merge_disposition: <direct_protected_queue | human_manual_merge | undetermined>
monitor_target_thread_id: <parent sweep thread id or none>
monitor_pid: <pid or none>
monitor_state_file: <absolute path or none>
monitor_log_file: <absolute path or none>
monitor_watched_head_or_generation: <head SHA or immutable queue generation tuple or none>
monitor_health: <healthy | event_consumed | stale | stopped | failed | none>
monitor_started_at: <ISO timestamp or none>
monitor_event_handoff: <none | pending_worker | worker_resumed | handoff_returned | reconciled>
batch_id: <stable feature-unit id or none>
batch_members: <comma-separated ticket slugs/URLs or none>
batch_owner_thread_id: <thread id or none>
batch_manifest: <versioned durable feature manifest path/attachment and sha256 or none>
batch_anchor_ticket: <canonical callback ticket or none>
feature_role: <design_prerequisite | shipping_member | rollout_gated_cleanup | context_only | none>
priority_value: <live priority value or UNKNOWN>
priority_order_evidence: <live schema ordering/version or unknown>
feature_declared_priority: <highest required-member live priority or UNKNOWN>
feature_effective_priority: <declared or inherited downstream rank or UNKNOWN>
priority_inheritance_chain: <verified blocking chain or none>
expected_surfaces: <repo/package/files/routes/contracts likely touched>
external_docs: <not_applicable | official docs URLs/date/version | blocked/unknown reason>
ui_work: <YES | NO | UNKNOWN>
ui_design_source: <not_applicable | design | screenshot | prototype | missing>
ui_visual_qa: <passed with pre-PR artifact ids/hashes | not_applicable with production-consumer proof | explicit_exception with Daniel's exact exception | blocked with exact blocker | missing>
human_ui_plan_approval: <not_required | required | approved | blocked>
ui_plan_url_or_id: <ClosedLoop plan URL/id when waiting for approval, or none>
manual_qa_plan_comment_url: <single author-owned PR comment URL or none>
manual_qa_author: <live PR author/responsible human identity or none>
manual_qa_record: <existing result-artifact reference/hash or none>
manual_qa_state: <not_started | waiting | passed | failed | blocked | stale | not_applicable>
manual_qa_head_coverage: <exact current/tested heads plus carry-forward/rerun evidence or none>
split_lineage: <top_level | split_child | unknown>
parent_split_ticket: <parent FEA/url and split signature, or none>
split_signature: <stable split signature or none>
child_ticket_slugs: <comma-separated child FEA slugs or none>
child_ticket_urls: <comma-separated child URLs or none>
child_assignees: <child assignees or none>
child_statuses: <child statuses or none>
parent_status_after_split: <IN_PROGRESS | DONE | unchanged | not_applicable>
closedloop_updated_at: <ticket updated timestamp>
latest_relevant_comment_at: <timestamp/id or none>
status: <ClosedLoop feature status>
assignee: <assignee name/id>
acceptance_criteria_fingerprint: <stable summary or hash>
requirements_contract: <applicable approved PRD slugs/versions and inherited requirement IDs | not_applicable with evidence>
requirements_link_state: <LINKED | INHERITED | MISSING_LINK | AMBIGUOUS | NOT_APPLICABLE>
requirements_relationship: <verified relationship id/direction/type | exact recommended source/type/target | none>
decision: <GO | GO_WITH_UI_PLAN_APPROVAL | SPLIT_RECOMMENDED | DIRECT_EXECUTION_RECOMMENDED | CHILD_EXECUTION_ONLY | SPLIT_REPAIR_REQUIRED | PRODUCT_BLOCKED | ENGINEERING_BLOCKED | ALREADY_DONE_OR_DUPLICATE | HUMAN_REVIEW_REQUIRED | SPLIT_CREATED | SPLIT_PROPOSED | DONE | MANUAL_INTERVENTION>
complexity: <LOW|MEDIUM|HIGH>
risk: <LOW|MEDIUM|HIGH|EXTREME>
closedloop_comment_target: <none | product contact | explicitly_user_authorized>
closedloop_comment_status: <not_required | pending | posted | blocked>
closedloop_comment_key: <stable comment idempotency key or none>
closedloop_comment_id_or_url: <comment id/url after post or none>
engineering_attention_dm: <not_required | explicitly_user_authorized | sent | blocked>
engineering_attention_dm_key: <stable DM idempotency key or none>
engineering_attention_dm_permalink_or_timestamp: <permalink/timestamp after sent or none>
unsent_communication: <exact unsent ClosedLoop comment or engineering attention DM when blocked, otherwise none>
reason: <one-line state or blocker>
evidence: <ticket/code evidence summary>
recheck_when: <specific ticket, PR, product, or engineering transition that should trigger action>
recorded_at: <ISO timestamp>
```

## Operator-Visible Coverage Invariant

Every assigned nonterminal ticket in the locked sweep scope must also have a
current operator-visible ownership-ledger record. This includes approval,
dependency, Product, external-owner, and manual-intervention waits. Workflow
memory, `queue.md`, and the additive ticket-status/display feeds are supporting
records; none makes an otherwise ownerless ticket visible to an operator whose
surface reads the ownership ledger.

When reconciliation discovers a valid nonterminal wait with no recoverable
Desktop child or CLI feature session, create one normally fenced parked feature
owner under the selected execution surface: write and verify intent, create the
shared worktree and exact session, acquire a distinct lease for each selected
executable member, then run one bounded no-mutation reconciliation turn that
returns the matching waiting/blocker callback. Bind every applicable member
ledger row to that shared owner; do not create an implementation session for
each component ticket. Context-only and externally owned dependency rows remain
visible without entering the implementation lease manifest. Persist the
resulting state and keep the owner idle/resumable. Lease acquisition and an in-flight
reconciliation turn are transitional; do not report coverage complete until the
callback is durably accepted and the operator-facing state is classified rather
than unknown. This recovery must not approve a plan, start
implementation, mutate source or external state, or consume an active-work slot
after the callback parks the owner.

Use `WAITING_UI_PLAN_APPROVAL` for an exact implementation-plan approval gate,
including a plan-authored Daniel-approval gate on a non-UI ticket. For the
non-UI case record `ui_work: NO`, `ui_design_source: not_applicable`, and the
exact plan/version and approval condition so the state name cannot imply UI
scope that does not exist.

## Feature Unit Ownership Invariant

Read [Feature Unit Execution](feature-units.md). Every assigned nonterminal
ticket in the locked sweep scope has its own workflow-memory record and
operator-visible ownership-ledger record, including context and externally
owned dependencies. Only the selected executable members receive implementation
generations and leases for the shared feature owner. Each of those member rows
retains its own requirements contract, priority, status, and acceptance
evidence while pointing to the same feature id, owner/session, worktree, branch,
PR, canonical callback ticket, and exact manifest path/hash. Never copy the
canonical ticket's lease into another member row.

For multi-member CLI owners, the private `CL_SWEEP_FEATURE_OWNERSHIP v1`
manifest is the runtime ownership authority for the grouped session. Initialize both App Server
and compatibility sessions with `--feature-manifest` and
`--ownership-ledger`. The runtime-persisted `featureOwnership` must match the
manifest's feature id, anchor/canonical ticket, owner, worktree, and sorted
member bindings. Scoped callbacks/results carry the matching
`payload.feature_ownership` summary for callbacks and the matching
`result.feature_ownership` summary for result artifacts. Any missing/mismatched member lease,
manifest digest, transfer binding, or incomplete multi-member lease operation
invalidates the old feature scope. Complete the remaining per-ticket lease
operations, write and verify the immutable replacement manifest, and only then
initialize the replacement owner. Do not dispatch, accept evidence, mutate, replace, transfer, clean up,
or finish the sweep through an invalid scope.

A singleton uses the ordinary single-ticket session and lease contract. Do not
pass feature-ownership init arguments for a one-member scope.

When reading older workflow repo-memory records, treat `daniel_dm`,
`daniel_dm_key`, `daniel_dm_permalink_or_timestamp`, and `Daniel-attention`
target labels as legacy schema aliases for `engineering_attention_dm`,
`engineering_attention_dm_key`, `engineering_attention_dm_permalink_or_timestamp`,
and `engineering-attention`. Do not use legacy values to resolve the current DM
recipient or to decide a DM has already been handled for the current engineering
attention contact. Always resolve the current DM identity from `cl-policy` and
any optional user-local override before sending or suppressing a direct message.
When writing new records, use only the engineering-attention field names above.
Also treat `ACTIVE_SPLITTING`, `SPLIT_CREATED`, `SPLIT_PROPOSED`,
`SPLIT_REPAIR_REQUIRED`, `SPLIT_BLOCKED`, `DIRECT_EXECUTION_RECOMMENDED`, and
`CHILD_EXECUTION_ONLY` as legacy split-state values. They remain in the schema
so older sweep memory can be parsed and reconciled, but new sweeps must not
write them as the next state for a current analysis. New analyses keep the
issue as its single ticket and write `BLOCKED_SKIP`, `MANUAL_INTERVENTION`,
`ACTIVE_PLANNING`, or `ACTIVE_EXECUTING` according to the normal single-ticket
gates.

For PR merge disposition memory, apply the UI/non-UI policy in
[Open PR Lifecycle](open-pr-lifecycle.md). Before disposition, write and
query-verify a current record containing `ui_work: YES|NO`, the matching
`ui_visual_qa`, `merge_disposition`, and any newer exact user override evidence.

## Write And Verify

Store each state record with repo scope:

```bash
workflow-memory add <optional-env-file-flag> --scope repo --repo <memory_repo> --visibility local --title "cl_sweep_ticket_state <project_slug> <FEA-slug> <state>" --trigger "cl_sweep_ticket_state,<project_slug>,<FEA-slug>,<state>" --body-file <path-to-body-file>
```

Before the first write in a sweep, run `workflow-memory add --help` to confirm
the required command surface. Use `--attachment-file <path>` when a durable
supporting artifact belongs with the record. If repo-scoped writes are
unavailable, stop before launching ticket work because duplicate suppression
cannot be trusted. After every write, immediately verify it with
`workflow-memory query` for the exact project and ticket in the canonical
`<memory_repo>`. If the write or verification fails, do not launch more work for
that ticket; record the failure privately in the parent summary/memory and
surface it to the user. Do not post a ticket comment or DM.

## Transition Rules

Before launching a child, write and verify an `INTENT_ANALYZING` record with the
stable child title and `child_thread_id: none`. Then run `list_threads` for the
project and ticket slug/title; if a matching child already exists, resume or
reconcile it instead of creating another one. After `create_thread` returns,
write `ACTIVE_ANALYZING` with the child thread id.

Do not send `$cl-split` or write new `ACTIVE_SPLITTING` records. When sending
`$cl-execute` for `GO_WITH_UI_PLAN_APPROVAL`, or for any current session where
Daniel must personally approve every implementation plan before code starts,
write `ACTIVE_PLANNING`. When sending `$cl-execute` for normal `GO` with no
additional plan-only gate, write `ACTIVE_EXECUTING`.

When `$cl-execute` returns `WAITING_UI_PLAN_APPROVAL`, write that state with the
plan URL/id, UI design source, exact approval requirement, and
`recheck_when: human-authored approval for matching UI plan is present`; keep it
monitored until that approval is detected.

When `$cl-execute` returns `PR_MONITORING_HANDOFF`, verify the live PR/head and
live unresolved review-thread count for that exact PR/head before writing any
waiting, ready, queue, or monitor state. If the count is nonzero or cannot be
fetched, reject the handoff and resume the same worker with the thread evidence;
do not start/refresh the parent monitor or present the PR as ready. Once the live
count is exactly zero, write the applicable waiting state plus all monitor
fields, and apply [Open PR Lifecycle](open-pr-lifecycle.md) to reuse or start
exactly one parent-targeted monitor; never write `DONE`. When an execution result
stops at a required human review or merge boundary with an open PR, write
`WAITING_HUMAN_MERGE` with the PR number, exact child thread id/host, head,
mergeability, checks, unresolved-thread count, `ui_visual_qa`, monitor identity, and
`recheck_when`; never write `DONE`.

When the feature owner returns `WAITING_MANUAL_QA`, keep the same execution
owner, worktree, branch, PR, monitor, feature manifest, and every member lease.
Transport it as existing `WAITING_HUMAN` with `summary.wait_kind: manual_qa`,
the result artifact, and `routing.recheck_when`. Record the manual-QA comment,
author, result state, and exact head coverage on every shipping member. Resume
the same owner with human evidence; never create a QA-only owner or treat a
posted plan as a pass.

Historical `$cl-split` results may remain in older memory. Reconcile
`SPLIT_CREATED`, `DIRECT_EXECUTION_RECOMMENDED`, `CHILD_EXECUTION_ONLY`, or
`SPLIT_PROPOSED` only as legacy evidence; do not invoke split tooling, do not
create child tickets, and do not retry parent splitting. Keep every current
issue as its own single-ticket analysis and execution candidate.

Keep the parent ClosedLoop status `IN_PROGRESS` while any child ClosedLoop
status is `TODO`, sweep-actionable `BACKLOG`, `IN_PROGRESS`, or `IN_REVIEW`, or
any child latest memory state is `ACTIVE_EXECUTING`,
`WAITING_UI_PLAN_APPROVAL`, `WAITING_CI`, `WAITING_REVIEW`,
`PR_MONITORING_HANDOFF`, `WAITING_MANUAL_QA`, or `WAITING_HUMAN_MERGE`.

If a legacy callback or memory record contains `SPLIT_REPAIR_REQUIRED`, record
the evidence privately but do not attempt legacy split repair or call
`$cl-split`. Re-analyze the current issue under the single-ticket policy when
allowed by the material-change or explicit-retry rules; otherwise write
`BLOCKED_SKIP` or `MANUAL_INTERVENTION` with the exact recheck condition. For
`PRODUCT_BLOCKED`, use `COMMUNICATION_PENDING` only for the authorized
Product-decision comment, then record success/failure. For every
engineering/operational blocker, write `BLOCKED_SKIP`, `SPLIT_BLOCKED`, or
`MANUAL_INTERVENTION` directly with private evidence and surface it to the user;
no comment/DM prerequisite exists. Use `COMMUNICATION_FAILED_MANUAL_FOLLOWUP`
only for an authorized Product comment or explicit user-requested communication
that failed.

Treat memory as a state log, not a permanent cancellation. Re-run `$cl-analyze`
only when the ticket has materially changed after `closedloop_updated_at`, a
stored `recheck_when` condition is satisfied, the latest state is
`COMMUNICATION_FAILED_MANUAL_FOLLOWUP` and the communication was later handled,
or the user explicitly asks to retry that ticket. Do not create more children
from a legacy `SPLIT_CREATED` parent; work any already-existing assigned child
issues only as the single tickets they now are.

Write terminal memory state `CANCELED` only after live ClosedLoop shows the
ticket canceled and any linked implementation plan has been reconciled to its
appropriate non-executing terminal state, with explicit current user, product,
or engineering evidence that the work is abandoned, superseded, duplicate, or
no longer required. A closed-unmerged GitHub PR is never sufficient evidence.

## Additive display telemetry

At actual phase boundaries follow [display events](display-events.md) for both
Desktop and CLI. Keep this feed separate from the durable state fields above;
logging failure must not change ownership, lifecycle, or required memory writes.
After an existing authenticated ClosedLoop read, also publish its verified business
status through that reference; memory and session state are not substitute evidence.

For a feature unit, write `DONE` only after the shared PR is live-verified
merged, canonical manual QA passes for the applicable final head, integrated
functional acceptance passes, and every member's requirements, ticket status,
and linked plan are reconciled. Write and query-verify every member transition
before releasing all member leases and cleaning up the shared owner once.

## Additive display telemetry

At actual phase boundaries follow [display events](display-events.md) for both
Desktop and CLI. Keep this feed separate from the durable state fields above;
logging failure must not change ownership, lifecycle, or required memory writes.
After an existing authenticated ClosedLoop read, also publish its verified business
status through that reference; memory and session state are not substitute evidence.
