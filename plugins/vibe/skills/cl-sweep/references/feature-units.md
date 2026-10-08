# Feature Unit Execution

Use this reference after the project root and every existing worker/open PR have
been reconciled. It defines the execution boundary produced by
`../../cl-work-report/SKILL.md`.

## Complete The Boundary Before Execution

Read and follow `../../cl-work-report/SKILL.md` to build the initial project-wide
inventory. Reuse its fully paginated live snapshot and verified feature groups;
do not run a second assigned-only discovery pass. Refresh only listed members
and direct dependency facts unless a material change invalidates the snapshot.

Resolve every inferred or ambiguous group before implementation. The report's
full linked feature group is context, not automatic execution ownership. Start
the executable boundary from the Sweep owner's assigned tickets. Add only the
minimum specific other-owner tickets whose transfer is necessary for the
bounded functional outcome, explicitly approved, and permitted by the
[protected-owner policy](../../cl-work-report/SKILL.md#protected-owners). Never infer that assignment
of tickets spread across several parent features authorizes taking over every
linked sibling or whole umbrella feature.

The default product-feature boundary is one complete user-facing page or
capability, end to end. Include every backend, UI, Storybook, and other ticket
required by that page's scoped acceptance in one PR, even when only some are
currently assigned to the Sweep owner; list the missing page members as exact
ownership recommendations and require approval before transfer/execution. Do
not shrink the unit to the owner's partial ticket subset when that would leave
the page nonfunctional, and do not expand it to a large PRD that defines several
pages. Each independent page is its own feature unit.

A shared foundation used by several pages remains one separately owned
dependency unit and may land first. Never duplicate the shared ticket under two
page owners or PRs. If one indivisible ticket spans incompatible page units,
stop on a boundary conflict; do not split the ticket, duplicate it, or silently
drop part of its acceptance.

Freeze a manifest that names the selected bounded functional outcome,
end-to-end acceptance boundary, every linked context ticket, the smaller
approved execution-member set, and each ticket's owner, repository, status,
priority, functional role, and membership evidence. Preserve the report's role
classification: `design prerequisite`, `shipping member`, `rollout-gated
cleanup`, or `context only`. Every backend, Storybook, UI, and other shipping
member required inside the selected execution boundary lands in its one PR.
Other-owner shared components and siblings stay visible as context or external
dependencies unless their exact transfer is approved. Context-only tickets do
not enter execution. A selected rollout-gated cleanup ticket remains visible and mandatory but is
not forced into the pre-rollout PR. If its sequence makes the proposed feature
boundary ambiguous, stop on `SCOPE_DECISION_REQUIRED`; never invent
a second PR boundary. A singleton is valid when the report proves one ticket is
the whole functional feature. A `SINGLE_PR_CONFLICT`, ambiguous lineage, or
unresolved membership is a blocker; ask for a revised feature boundary rather
than silently choosing one. Legacy batch or wave labels never override these
live role and functional-boundary findings.

When the assigned work cannot form a functional bounded slice without adopting
a broader inseparable feature, stop on `SCOPE_DECISION_REQUIRED` and
present the minimal exact scope choices. Do not launch or automatically transfer
the wider group. Distinct assigned slices may remain separate feature units even
when they share an upstream PRD or parent; keep the shared component with its
current owner and coordinate or wait on its explicit dependency.

Once frozen, the shipping feature unit is the scheduling, ownership, implementation,
PR, manual-QA, and completion unit. The tickets remain independent ClosedLoop
records. Do not split them, merge their acceptance contracts, or drop a blocked
member to claim a complete feature. A membership revision requires fresh live
evidence and a new manifest version that still describes one functional unit.

Keep the complete linked-role inventory separate from the executable ownership
scope. Only the approved selected unit's nonterminal shipping implementation members
enter the shared PR and feature-ownership lease manifest. Terminal context and
already-satisfied/approved design prerequisites remain visible evidence; do not
request a new `GO` or acquire implementation leases for them. An unsatisfied
design prerequisite holds the unit. An unresolved rollout-gated cleanup
boundary holds the unit for `SCOPE_DECISION_REQUIRED`; never drop it
or force it into the pre-rollout PR.

## Readiness And Dependencies

Analyze every nonterminal shipping execution member separately and retain its
own readiness decision,
approved requirements and approval gates, risk/complexity, acceptance criteria,
status, and terminal evidence. Implementation starts only after all required
members are eligible and the combined implementation is coherent.

An internal dependency between members may be implemented in dependency order
inside the same branch and PR when the feature shares one interface and
acceptance boundary. Give every analysis worker the frozen manifest and exact
internal dependency context. The downstream member may record
`scheduled_in_unit` only when the manifest, shared interface, planned order, and
acceptance proof establish that the same feature owner will satisfy it. This
does not bypass the member's readiness or acceptance gates. Do not require the
upstream member to land in a separate PR first. An external blocker must be resolved, or its exact ownership/scope
transfer explicitly authorized, before dependent implementation starts.
Reassignment recommendations from the report never authorize a reassignment.
Approve a transfer only when its marginal delivery benefit over keeping the
current owner and coordinating is proven; shared lineage or a `BLOCKS` edge
alone is insufficient.

### Protected Current Assignees

Read and enforce the canonical
[Protected owners](../../cl-work-report/SKILL.md#protected-owners) policy before
feature selection, reassignment advice or action, dispatch, resume, migration,
manifest expansion, or lease acquisition. Never recommend or perform an
ownership transfer for a ticket classified by that policy, include it in
another owner's executable manifest, or acquire or renew a sweep implementation
lease for it. The guard applies to every role, not only design work. Generic
sweep, feature-execution, scope, or reassignment approval does not override it;
only the explicit policy-revision condition in the canonical section can do so.

Re-fetch current assignment and apply the canonical exact-identity check before
every dispatch or resume. If a frozen executable member is now protected,
invalidate that execution scope and park the unit without changing assignment
or silently removing the required member. Preserve the protected ticket as an
owned external dependency. An explicitly agreed contribution may resolve the
feature boundary only when assignment remains unchanged and the exact
contribution and owner interface are recorded; otherwise hold the dependent
unit. Other owners remain eligible only under the existing evidence,
marginal-benefit, explicit-transfer, readiness, and scope gates.

A selected required non-protected other-owner or unassigned member is an ownership gap. Preserve its
current owner and any existing PR. Park the feature with the exact decision
needed unless ownership of that exact ticket is explicitly transferred or the
owners agree on one safe execution owner. Do not absorb an external owner's
active branch or PR. If separate PRs are already in flight, preserve their
exact owners and ask for a concrete migration or boundary decision before new
feature execution; never combine, close, or supersede them automatically.

This also applies when both PRs belong to this sweep. A post-review-cutoff
ticket that would port an unmerged predecessor's approved feature into a new
PR is a replacement of the delivery boundary, not a small independent fix.
Use the [Cross-Ticket Replacement Gate](open-pr-lifecycle.md#cross-ticket-replacement-gate)
before making that second ticket or plan executable. Record the original and
replacement tickets as one explicitly approved delivery lineage while keeping
their independent acceptance/status records; two simultaneous owners must not
both mutate competing versions of the same feature.

## One Owner And One PR

Represent a feature unit with the existing batch machinery. Use one execution
owner, lane, worktree, branch, combined plan, established review lifecycle, PR, monitor, and
queue lifecycle. Component tickets do not consume separate execution lanes;
the active-work concurrency limit counts feature owners. Unrelated singleton
features remain separate owners and PRs.

All members must use one implementation repository. A feature spanning
repositories or irreconcilable merge, release, rollback, security, or ownership
policies is an explicit blocker requiring a revised feature boundary. Never
silently create multiple PRs for one feature.

Persist one stable `batch_id` as the feature-unit id and store the same
`batch_members`, `batch_owner_thread_id`, and versioned `batch_manifest` path
and hash in every selected nonterminal execution member's durable record. Every
assigned nonterminal ticket in the locked sweep scope still retains its own
operator-visible ledger row, including context and external dependencies, but
only selected executable members enter the shared implementation lease scope.
Bind those member rows to the same owner/session/worktree/branch/PR while
retaining their own ticket identity, generation, lease id/hash, requirements,
status, and acceptance evidence. Before dispatch, resume, callback acceptance,
mutation, or terminal reconciliation, validate current ownership for every
selected executable member. No selected member may be independently scheduled
while the feature owner is active or parked.

The App Server and compatibility session protocols remain single-ticket
transports. Choose one stable canonical callback ticket: prefer an included
assigned parent feature; otherwise choose the deterministic first assigned
member recorded in the frozen manifest. Initialize the session and emit every
`CL_SWEEP_EVENT v1` / `CL_SWEEP_RESULT v1` with that canonical ticket and its
lease. For multi-member CLI owners, persist one private
`CL_SWEEP_FEATURE_OWNERSHIP v1` manifest and initialize the session with `--feature-manifest` and
`--ownership-ledger`. Its `anchor_ticket` is the canonical callback ticket and
its sorted unique `members` contain each ticket's own generation, lease id, and
lease-token hash. The runtime persists `featureOwnership` and verifies the
manifest plus every current member lease at dispatch, callback/result handling,
delivery, rebind, recovery, and replacement boundaries. A partial member-lease
rotation invalidates the old feature scope. Complete the remaining per-ticket
lease operations, write a new immutable manifest, and only then initialize the
replacement owner.

Never put a list in `event.ticket`, change callback enums, or emit one member
callback per ticket. Scoped callbacks include the runtime-required
`payload.feature_ownership`; scoped `CL_SWEEP_RESULT v1` artifacts put the same
summary at `result.feature_ownership`. Both carry the feature id, manifest
SHA-256, and sorted member ticket list; complete per-member results live in the
artifact result. A singleton uses the existing ordinary single-ticket session
without feature-ownership init arguments.
The parent writes superseding state for each member from the accepted aggregate
evidence.

## Functional And Manual QA Completion

The shared PR must implement and validate the whole feature. Per-ticket checks
remain necessary, and the owner must also prove the integrated end-to-end
acceptance boundary across every required surface. Backend-only, UI-only, or
Storybook-only completion is not feature completion when the manifest requires
the other surfaces.

Read and follow
[`../../cl-execute/references/feature-manual-qa.md`](../../cl-execute/references/feature-manual-qa.md)
for the post-PR manual-QA contract. The live PR author owns one manual-QA plan
comment for the integrated feature and updates that comment in place. Record
its URL and evidence through the existing result artifact, handoff, durable
member records, and parent summary. Posting the plan does not open a browser or
start interactive QA. Parker visual QA and automated headless/displayless
browser and Electron gates remain separate and unchanged.

Manual QA is required for UI and non-UI features. A pending, failed, blocked,
missing, stale-head, or non-author result cannot be presented as ready or
complete. Accept readiness and terminal reconciliation only when the canonical
manual-QA contract confirms human author evidence for the relevant final head
and covers the complete integrated feature. Do not add a new callback enum;
route pending evidence through the existing handoff/wait/result artifact
contracts.

Write `DONE` only after the one shared PR is live-verified merged and every
member's requirements, acceptance, integrated functional validation, manual QA,
ClosedLoop status, and plan state are reconciled. Clean up the shared owner,
monitor, worktree, and leases once, after every member row is terminal.
