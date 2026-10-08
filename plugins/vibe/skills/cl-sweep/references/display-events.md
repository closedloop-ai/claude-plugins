# Wallpaper display events

For both Desktop task workers and CLI workers in a sweep, publish public activity
metadata with `scripts/display-event.mjs`. This is an additive display feed;
ownership, lease, callback and workflow-memory lifecycle rules remain authoritative.
Logging is best effort: a `{ "recorded": false }` result never blocks ticket work.
Do not start or resume a worker to populate the display, and do not backfill guessed
activity for already-running work.

Use the current sweep root, sweep ID, ticket owner ID and owner generation from
the existing sweep binding (Desktop: task owner, CLI: session owner). A batch has
one owner. Parent transfers do not change this identity. Never use root generation
as owner generation, and never substitute the root coordinator as a ticket owner.
Resolve `<cl-sweep-skill-dir>` from this installed skill pack before running the
examples below.

```bash
node "<cl-sweep-skill-dir>/scripts/display-event.mjs" \
  --root '<sweep_root>' --sweep-id '<sweep_id>' \
  --worker-id '<owner_id>' --owner-generation '<owner_generation>' \
  --kind phase --phase coding
```

Immediately before actual planning, coding, or author-side reviewing begins,
record `planning`, `coding`, or `reviewing`. While reviewing, add
`--review-kind plan` for plan review or `--review-kind code` for implementation/code
review; new review reports must specify one of those values. It is valid only on `reviewing`, never inferred from
a PR or the ticket business status. A reviewing owner may coordinate
read-only review lanes. Set `waiting_for_human` only at an explicit human-input
boundary. For a known human reason add `--wait-kind plan_review`, `human_merge`,
or `human_input`; use `manual_qa` for an explicit responsible-human QA checkpoint and `product_decision` when a decision from Product is explicitly
required. This means waiting for Product, not necessarily the current user.
`ui_plan_approval` is accepted as a plan-review alias. Structured
callbacks preserve exact plan-approval and human-merge reasons, with explicit
human status taking precedence over a conflicting summary reason. For every new human-wait report, provide the known `--wait-kind` and
`--wait-reason '<specific public action required, including artifact version>'`.
Describe all required approvals when there is more than one. This optional field
is deliberately public display copy: one nonempty line, at most 300 characters,
without control characters. Do not include credentials, local paths, prompts,
transcript excerpts, or private routing text. Never infer or backfill a historical
reason from another field. No additional service queries are required.
When producing a callback whose existing validator permits additive summary
fields, explicitly author `payload.summary.wait_reason` with the same public copy;
this NEW optional field is consumed only for human waits. Invalid optional callback
copy is ignored so valid waiting state survives. Do not copy `routing.recheck_when`
automatically. Without permission from the callback schema, use the explicit phase
report instead. Clear the reason by reporting the next phase or a human phase
without it; it is never carried forward automatically.
The `ui_plan_approval` alias is normalized to `plan_review`. Human reasons
are valid only on `waiting_for_human`, and automatic-wait reasons only on `waiting`.
When actually entering a wait, publish `--phase waiting`; optionally
add `--wait-kind merge_queue|review|ci|monitoring|dependency|other` for its known
reason. For example, after confirmed merge-queue entry report
`--phase waiting --wait-kind merge_queue` instead of leaving a bare null phase.
This applies to both Desktop and CLI owners. Do not infer a wait from an open PR
or its business status, and do not make extra queries to classify it.
On completion, cancellation, failure, validation, or leaving an activity without
a known next activity, record `--phase null` without `--wait-kind`. Exit a wait by
reporting the next actual phase or null; a new phase clears its previous reason.
Clear human wait once human input arrives; it remains active participation while
waiting. Never map
`ACTIVE_EXECUTING` or `WAITING_REVIEW` to a fine-grained activity. Existing workers
that have not received these instructions retain their honest unknown state.

After a Desktop `send_message_to_thread` or CLI dispatch successfully returns
transport acceptance, record a `message` event (never before invoking the send), using `--direction to_worker` or
`to_orchestrator`, `--stage sent`, and a stable `--message-id`. Record `delivered`
only when transport explicitly confirms delivery to the recipient; successful
queueing or an idle/active thread is insufficient. The App Server session adapter
automatically records accepted turn sends, accepted outbound worker callbacks,
and confirmed parent delivery; do not duplicate those points. Accepted structured callbacks `PR_MONITORING_HANDOFF`, `WAITING_REVIEW`, and `WAITING_CI` automatically preserve waiting with reason monitoring, review, or CI respectively. Explicit human waits take precedence. These callbacks never imply merge-queue entry. When the existing callback/artifact validator permits `payload.summary.wait_kind`, an explicitly known reason from the approved wait-kind list takes precedence over generic monitoring; for example, use `merge_queue` only after confirmed queue entry. Do not add fields that the callback validator rejects; use an explicit phase report instead. Never include the
message body, prompt, transcript, credentials or lease secret.

When the normal workflow verifies a PR and its ticket relationship, publish
`--kind pr --url '<https PR URL>' --number '<number>' --state '<state>'`
with `--relation own|dependency|reference` and the associated `--ticket <slug>`.
Use `own` only for a verified delivery PR for this worker's ticket or batch member.
Use `dependency` for an upstream blocker PR and attribute its blocking ticket;
never show it as the blocked worker's own implementation. `reference` is contextual
only and may omit its ticket. Own and dependency reports require ticket attribution.
Legacy unclassified PR records are references, not proof of delivery ownership.
Only `github.com` PR URLs are supported; state is `draft`, `open`, `merged`,
`closed`, or `unknown`. Use `draft` only when GitHub confirms an open draft.
Use already available workflow evidence; do not query services just for reporting,
and do not interpret a closed PR as a completed ticket.

The append-only file is `<sweep_root>/display-events.jsonl`. Each record is a
whitelisted `CL_SWEEP_DISPLAY_EVENT v1` object with `id`, `sweepId`, `workerId`,
`ownerGeneration`, `kind`, and ISO `at`. Phase records add nullable `phase` and optional `waitKind` for `waiting` or `waiting_for_human`;
message records add `direction`, `stage`, `messageId`; PR records add
`pr: {url, number, state, relation?, ticket?}`. Reviewing phase records may add
`reviewKind: plan|code`. Consumers deduplicate `id`, fence by current owner
and generation, and never use this file to mutate ownership or lifecycle.

After journaling, the reporter also broadcasts the identical JSON line to
`${CODEX_HOME:-$HOME/.codex}/cl-sweep-state/display-events.sock`. The listener owns
this Unix socket; connect/write failure is ignored and bounded to 100 ms. The
journal remains authoritative for recovery and missed notifications.


## Explicit sweep resume selection

A successful same-owner `sweep-root-state.mjs open` records a best-effort root
activation only after ownership validation and ACTIVE authority persistence.
The fixed state-base `display-activations.jsonl` journal contains
`CL_SWEEP_DISPLAY_ACTIVATION v1`: `id`, `sweepId`, `projectId`, `ownerThreadId`,
`ownerGeneration`, `kind: resumed`, `at`, and `afterRegistrySequence` (the maximum
validated registry sequence while the resume lock is held). The identical JSON
line is broadcast to the display socket. Tests using `--state-base` keep this
journal and socket inside that isolated state base.

Consumers order selection by the registry sequence watermark, not wall-clock
time, and validate the exact current root owner/generation before accepting the
activation. New roots and completed adoption already have registry evidence;
cleanup and terminal records never imply reactivation. This root selection
contract is separate from worker phase events. Do not manually backfill it or
resume a worker to update the wallpaper. Logging failure leaves resume success
and all ownership semantics unchanged.


## Business status from existing ClosedLoop reads

Immediately after an already-required authenticated ClosedLoop ticket read
returns its business status, publish that observation for the current sweep:

```bash
node "<cl-sweep-skill-dir>/scripts/display-event.mjs" \
  --root '<sweep_root>' --sweep-id '<sweep_id>' --kind ticket_status \
  --ticket '<ISS-or-FEA-slug>' --status '<observed-status>' \
  --verified-at '<UTC ISO timestamp of that successful read>'
```

Supported observed values are `BACKLOG`, `TODO`, `IN_PROGRESS`, `IN_REVIEW`,
`DONE`, and `CANCELED`. Use an actual observation timestamp ending in `Z`, never
an invented current timestamp for historical knowledge. Do not make additional
ClosedLoop requests for the wallpaper, infer completion from a session/PR,
or backfill assumptions. Logging failure never blocks the existing workflow.

The helper appends `CL_SWEEP_TICKET_STATUS v1` records to
`<sweep_root>/ticket-status.jsonl` and broadcasts the same metadata-only JSON.
Fields are `id`, `sweepId`, `ticket`, `status`, `verifiedAt`, `at`, and
`source: closedloop`. This is a locally recorded business observation, not a
live refresh performed by the wallpaper. Owner identity is deliberately absent:
ownership remains authoritative in the latest hash-validated ticket lease.


## Explicit ticket dependencies

When an existing ticket read or coordinator decision explicitly establishes a
blocking relationship, report that directed relation. Report `cleared` only
when the relationship is explicitly resolved or removed. Never infer an edge
from generic waiting, prompts, transcript keywords, or shared PRs; a blocker
reaching DONE alone does not prove that the dependency was cleared. Do not make
extra service requests for the wallpaper or backfill example relationships.

```bash
node "<cl-sweep-skill-dir>/scripts/display-event.mjs" \
  --root '<sweep_root>' --sweep-id '<sweep_id>' --kind dependency \
  --blocked-ticket '<blocked-slug>' --blocking-ticket '<blocking-slug>' \
  --state '<blocked-or-cleared>' --verified-at '<UTC ISO observation timestamp>'
```

`<sweep_root>/dependencies.jsonl` contains `CL_SWEEP_DEPENDENCY v1` records:
`id`, `sweepId`, `blockedTicket`, `blockingTicket`, `state`, `verifiedAt`, and
`at`. Both tickets must be distinct ISS/FEA slugs. Timestamps use UTC `Z` and
`verifiedAt` cannot be later than `at`. For each directed pair, consumers select
the latest `verifiedAt`, then `at`, then journal order; a `cleared` record removes
the displayed edge. The same metadata is broadcast to the display socket.
Ownership is separate: consumers resolve endpoints from current ticket owners,
never from saved agent IDs. Reporting is best effort and controls no workers.


Exact callback statuses `PRODUCT_BLOCKED` and `WAITING_PRODUCT_DECISION`, or an
explicit summary `wait_kind: product_decision`, report a Product-decision wait.
Exact plan-approval and human-merge statuses retain precedence. Generic blocked
or manual-intervention states do not imply Product involvement. Authors should
provide the deliberately public action needed through `wait_reason` or
`--wait-reason`; private routing text is never copied automatically.


## Persistent manual-QA gates, independent of activity

When normal workflow evidence establishes that manual QA is required, publish
an `open` gate independently of coding, reviewing, or waiting phase reports.
Keep reporting the current activity normally. An open gate survives phase
changes, owner replacement, and PR lifecycle changes; none of those completes QA.

```bash
node "<cl-sweep-skill-dir>/scripts/display-event.mjs" \
  --root '<sweep_root>' --sweep-id '<sweep_id>' --kind gate \
  --ticket '<ticket-slug>' --gate-id '<existing-scoped-QA-identity>' \
  --gate-kind manual_qa --gate-state open \
  --verified-at '<UTC observation timestamp>' --action '<public QA action>'
```

Use a stable, explicitly supplied gate identity from the existing owned QA plan.
For an owned PR QA comment, use `pr-<number>-qa-comment-<commentId>`: this identifies
the QA-plan obligation, not coverage of a particular code head. Inspect the current
`gates.jsonl` before reporting and reuse that identity for the same plan while
coding or remediation continues; do not create duplicate open gates. Do not invent
an identity from a callback, generic waiting state, or ticket slug alone.

Update the public action and current QA evidence as needed, and re-evaluate
coverage for the final head. A prior passed record never proves new code was
verified: explicitly reopen the same plan obligation when its evidence becomes
stale. If the QA-plan identity itself is superseded, explicitly cancel the old
gate and open the new one. Report every applicable member ticket when one feature
has multiple tickets. No extra service queries are required.

Report `completed` only after verified responsible-human PASS evidence is accepted
for the applicable current scope and final-head coverage of that exact plan. Report `canceled` only for an explicit withdrawal of
that obligation. Neither coding resumption, phase clearing, PR merge, nor ticket
completion is a substitute. Do not reconstruct historical gates from old phase
events or assume they closed. The legacy manual-QA waiting phase remains valid
for current activity, but is not the persistent gate record.

The separate `<sweep_root>/gates.jsonl` journal contains `CL_SWEEP_GATE v1`:
`id`, `sweepId`, `ticket`, `gateId`, `kind: manual_qa`,
`state: open|completed|canceled`, `verifiedAt`, `at`, and optional `action`.
Gate IDs use 1–200 compact ASCII identifier characters, including colon, slash,
hyphen and UUIDs. Observation time is required UTC `Z`, no later than `at`.
The optional action is deliberately public, trimmed, nonempty, one line and at
most 300 characters; never include credentials, prompts, transcripts or local
paths. Consumers select the latest observation per ticket and gate ID by
`verifiedAt`, then `at`, then journal order. Records have no owner identity;
consumers resolve current visible owners separately. The same event broadcasts
on the display socket. No callback automatically fabricates or closes a gate.
