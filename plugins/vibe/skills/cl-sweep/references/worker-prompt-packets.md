# Worker Prompt Packets

Use this reference whenever `$cl-sweep` launches or resumes a feature owner for
per-member analysis, feature execution, or completion evidence. Read
[Feature Unit Execution](feature-units.md) first.

Every launch and resume packet, including a correction turn, ends with the
verbatim output of `scripts/standing-orders.mjs render --root <root>`, even
when it is `none`. Never paraphrase, reorder, or trim it.

## Analyze Ticket Prompt

```text
Use $cl-analyze <full_ticket_url>. Feature manifest: <durable path/attachment and hash>; feature id: <id>; member role: <role>; feature priority evidence: <live member priority, declared/effective rank and inherited chain>; internal dependency context: <scheduled_in_unit dependency/order/acceptance evidence or none>; known requirements candidates: <direct links, explicit inherited/designated PRDs, or none_found_yet>. Resolve the ticket-specific approved requirements contract yourself using the skill's bounded read-only discovery rules. Dynamically discover and use closedloop-graph proactively as a primary discovery surface even when direct links exist: inspect bounded PRD/plan/split lineage, blockers/producers, semantic matches, duplicates, active or landed PR overlap, and codebase intelligence including symbols, files, ownership boundaries, dependencies, call/data paths, co-change history, tests, and blast radius until one adjacent expansion yields no new material ticket or code fact. Re-fetch all material ticket findings from live ClosedLoop and verify code findings against the current checkout, tests, and current PR state. Do not assume unrelated project PRDs apply, and do not treat no direct link as proof that no PRD exists. A proven internal dependency may be recorded as scheduled_in_unit only when the frozen manifest, shared interface, implementation order, and end-to-end acceptance prove this same owner will satisfy it in the shared PR; this exception does not waive any readiness, requirements, or acceptance gate. Every external dependency remains blocking until resolved or, when Feature Unit Execution's protected-owner policy permits, explicitly transferred. Before returning PRODUCT_BLOCKED or suggesting a Product contact, run Product Answer Discovery: search linked PRDs, plans, comments, sibling tickets, semantic facts, prior blockers, related product/design artifacts, and workflow repo memory for an existing authoritative answer; if the Product contact is unavailable or out-of-office in current user/session context, first use existing answers and otherwise surface the exact missing decisions privately to Daniel/current user or engineering instead of reflexively tagging Product. Produce the required structured decision report, name the governing PRD versions and requirement IDs, classify the link state, and provide an exact source -> relationship type -> target recommendation when one unambiguous link is missing. If UI work is needed, identify whether the ticket includes a design, screenshot, or prototype that clearly shows the expected UI; if not, decide whether GO_WITH_UI_PLAN_APPROVAL is appropriate or product clarification is required. If the ticket touches a third-party API, SDK, hosted platform, model provider, auth/billing provider, webhook, or fast-moving dependency, consult official current online documentation and include the required external-doc evidence. Do not execute the ticket, edit code, change ClosedLoop status or relationships, open a PR, add ClosedLoop comments, or DM anyone.
```

## Execute Ticket Prompt

Before sending this prompt, read [Open PR Lifecycle](open-pr-lifecycle.md). When
PR work can occur, replace `<open_pr_lifecycle_worker_packet>` with that
reference's current Worker PR Packet.

```text
Proceed with $cl-execute <full_ticket_url>. You are already in this ticket's child worktree. Applicable approved requirements contract: <exact PRD slugs/versions and requirement IDs, or evidenced not_applicable>. Re-fetch that exact contract and use the $cl-analyze result above as preflight evidence, including external official-doc evidence and UI design guidance when applicable, but re-check anything that may have changed before marking the ticket in progress. Every planning, implementation, validation, conflict-resolution, and review worker must check changes against these exact requirements. Do not accept review feedback that would create requirements drift; explain the conflict with exact PRD requirement IDs instead. Before reporting completion, perform one bounded final requirements-conformance check and report its evidence. If the analyze decision is GO_WITH_UI_PLAN_APPROVAL, or the current sweep/session instruction requires Daniel's personal approval for every implementation plan, create and upload the implementation plan, then stop with WAITING_UI_PLAN_APPROVAL before plan approval, feature status mutation, branch creation, code changes, PR work, or merge work until Daniel personally approves that exact plan.
If this ticket is about latency, throughput, performance, profiling, optimization, query/runtime cost, or a performance-budget regression, enforce $cl-execute's Performance Measurement Contract in ../../cl-execute/references/planning-and-gates.md and report its evidence in the CL Execute Result `Performance measurement` field.
<open_pr_lifecycle_worker_packet>
Every worker must run local browser E2E headlessly and local Electron E2E through the repository-supported displayless harness and documented launch path so no Chrome/Electron window or popup appears on Daniel's interactive desktop. Ordinary Playwright headless mode does not make `_electron.launch` displayless; never silently fall back to headed/visible execution. If a required local scenario has no supported displayless path, stop it, report the exact limitation in `Automated E2E display mode`, and use automatically started CI as authoritative E2E evidence when policy permits without weakening or silently skipping validation. This does not authorize manual CI/review triggers or change visual-QA requirements; interactive visual QA may use browser/computer tools only when explicitly required, while automated E2E remains headless/displayless.
For an in-flight change affecting UI/UX, inspect the existing browser and Electron E2E specs for the changed user journey and update the applicable specs when behavior or assertions have changed. Before its first PR handoff, give an `E2E spec impact` decision naming the affected specs and what changed, or the concrete existing coverage that makes a spec edit unnecessary. Full E2E no longer gates an ordinary PR or merge queue merely because UI/UX code changed; only the `@smoke` subset is ordinarily gated. A green PR/queue is therefore not full E2E evidence. When E2E specs are changed, observe their automatically started PR run on that head before readiness; their first authoritative CI run is on the PR, not main. Do not manually trigger CI or review. Keep required local browser/Electron runs headless/displayless, and if a required scenario cannot run locally, name the exact unsupported path and confirm a matching automatic PR run actually occurred before using CI as substitute evidence. This new pre-merge check does not reopen an already-merged PR, require a second PR, or block that ticket's terminal reconciliation retroactively; any observed coverage gap there is a private finding unless Daniel expressly commissions follow-up work.
When the target repository declares an evidence-capture verification protocol or a correction-event intake, follow $cl-execute's repo verification and correction-event steps and report `Repo verification evidence` and `Correction events` in the result. Run this feature in its single owner lane. Different independently valid feature units may proceed concurrently despite ordinary file, package, test, adapter, route, or contract overlap. Resolve normal merge conflicts against current main. Internal member dependencies follow the frozen in-branch order; an external unlanded API/behavior dependency or incompatible semantic/product decision remains blocking.
```

For a feature unit, replace the first line with:

```text
Proceed with $cl-execute batch: <all selected page/capability shipping-member full ticket URLs>. You are the designated feature execution owner in the shared worktree. Feature/batch manifest: <durable path/attachment and hash>. Re-fetch and enforce every selected member's independent GO, approved requirements contract, approval gates, acceptance criteria, priority evidence, merge policy, and status. Follow the manifest's proven internal dependency order without requiring separate member PRs; stop on external blockers or boundary drift. Produce one functional integrated feature with one combined plan, branch, established review lifecycle, PR, post-PR manual-QA plan comment, monitor, and queue-recovery lifecycle. Report per-ticket validation/completion evidence and integrated end-to-end acceptance across every required shipping surface. Do not absorb context-only or externally owned dependency tickets, drop a blocked selected member, or create separate backend, Storybook, or UI PRs.
```

## Completion Evidence Gates

Read execution checkpoints until each running child returns the required
`CL Execute Result`. Require `Automated E2E display mode` at checkpoints and
before terminal success.

When the target repository declares an evidence-capture verification protocol,
require a `Repo verification evidence` value before accepting a PR handoff; it
supports and never replaces Parker visual QA, E2E, or human manual QA. In
`symphony-alpha` (the `control` skill), a handoff with `UI work: YES` or a
runtime behavior change is rejected unless the value lists before and after
artifact paths captured with `pnpm control` for each touched surface, or is
`blocked` with the exact control command and error. `not_applicable` is
accepted only when it names docs-only, tests-only, CI/config-only, or a
behavior-neutral refactor proven by tests.

For performance tickets, require `Performance measurement` evidence before
terminal success or PR handoff that claims the performance acceptance is met.
Reject missing worker-isolated seeded workload evidence, repeated
baseline/after samples, control, mechanism, product-surface relevance when the
goal is page/route/workflow speed, production telemetry query/window and values
or an explicit Datadog/RUM/APM access gap when such telemetry exists, verdict,
remaining-bottleneck check, or explicit stopping condition unless the child
explicitly returns a blocker, `NO_WORK`, or inconclusive/refuted result. Reject a
performance handoff that stops after one measured change without showing that
additional in-scope improvements are within noise/negligible, blocked, or
outside the approved ticket/PRD/product boundary.

Reject headed/visible execution, silent fallback, weakened/skipped validation,
or interactive visual-QA evidence presented as automated E2E. Ask the same
child once to provide compliant evidence without the parent starting E2E, CI, or
review. Accept an unsupported local scenario only when the exact
displayless-path limitation is recorded and a matching automatically started
CI run actually supplies authoritative evidence when policy permits. For every
open UI/UX-affecting PR, require the worker's `E2E spec impact` decision at its first
PR handoff: name changed browser/Electron specs, or concrete existing coverage
explaining why no spec edit was needed. Before queue, merge readiness, or
merge, require the changed specs' automatic PR run on the applicable
head to have passed. Neither a green ordinary PR nor a green merge queue proves
the full E2E suite ran; only the `@smoke` subset ordinarily gates them when E2E
specs were not changed. Do not apply this new gate retroactively during terminal
reconciliation of an already-merged PR.

Map `WAITING_UI_PLAN_APPROVAL` directly. Map `WAITING_MANUAL_QA` through the
existing `WAITING_HUMAN` event kind with `summary.wait_kind: manual_qa`, result
artifact references, and `routing.recheck_when`; the same live PR author remains
the owner and the parent routes human evidence back to it. For `PR_MONITORING_HANDOFF`, ready,
merge-queue, coverage failure, material monitor events, closed-unmerged, and
merged states, apply [Open PR Lifecycle](open-pr-lifecycle.md) rather than
inline PR rules. A handoff packet that omits live unresolved-review-thread
evidence is insufficient for readiness: fetch the exact PR/head, and if any
unresolved thread remains, send those thread URLs back to the same worker instead
of accepting a passive monitor, queue, or ready state.

Before accepting PR readiness, `DONE`, or `MERGED`, read and enforce
[`../../cl-execute/references/feature-manual-qa.md`](../../cl-execute/references/feature-manual-qa.md).
Require the one author-owned manual-QA plan comment URL, responsible human,
exact current/tested head coverage, complete acceptance-to-scenario mapping,
shipping-surface workflow evidence, and passed human record. Head changes stale
impacted scenarios; accept prior-head carry-forward only with the canonical
justification and rerun evidence. Pending, failed, blocked, missing, stale, or
non-author evidence stays `WAITING_MANUAL_QA` and is never ready. Posting the
plan does not open UI automatically and does not replace Parker visual QA or
automated headless/displayless E2E.

Before accepting `DONE` or `MERGED`, require live merged evidence for the one
shared PR and for every
linked PR plus the result's `Requirements contract` and `Review learning memory`
fields. The requirements field must name the exact approved PRD versions and
requirement IDs checked, or evidenced `not_applicable`, with no unresolved
drift. The review-learning field must list query-verified memory titles/ids for
qualifying accepted findings; `not_applicable` is valid only when no finding
qualified. Ask the same child once to complete either gate without another
review; otherwise use `MANUAL_INTERVENTION_REQUIRED`.

For `WAITING_UI_PLAN_APPROVAL`, continue the same owner only after explicit
human approval for that uploaded plan. For `WAITING_MANUAL_QA`, continue the
same owner only after the canonical human evidence arrives. After `MERGED`,
verify every member's ticket/plan/workflow-memory reconciliation plus integrated
functional acceptance before writing `DONE` for any member.

## Execution Blocker Routing

If `$cl-execute` returns `BLOCKED_BEFORE_START`, `BLOCKED_AFTER_START`,
`CI_FAILED_NEEDS_HUMAN`, `REVIEW_BLOCKED`, or `MANUAL_INTERVENTION_REQUIRED`,
do not retry execution blindly. The parent still owns unblock routing: classify
the blocker and immediately take any safe authorized action that can move the
ticket, such as resuming the exact worker with a changed condition, applying a
human-granted validation waiver, asking the worker for bounded classification of
an unrelated red gate, routing a Product decision through the communication
policy, routing missing upstream evidence to its owner, or closing/narrowing a
no-work ticket when the user has authorized that disposition. If no action is
yet authorized, ask for the exact missing decision or approval instead of
presenting the blocker as a settled parked state. Recording `BLOCKED_SKIP` or
`MANUAL_INTERVENTION` is the result after routing, not a substitute for routing,
and status summaries must name either the action taken or the exact outside
condition the parent cannot advance.

This blocker routing does not apply when the reported CI blocker is an executed
coverage failure: reject that result, restore `ACTIVE_EXECUTING`, and resume the
same child until coverage is green. Keep a confirmed CI-provider outage or
inability that prevented the coverage job from executing in `WAITING_CI` instead
of converting it to a terminal blocker.

For Product blockers, use [Communication Policy](communication-policy.md). For
every engineering/operational result, keep evidence private, write
`BLOCKED_SKIP` or `MANUAL_INTERVENTION`, and surface the action to the user
without a ticket comment or DM. The surfaced action must be concrete: name the
changed condition, waiver, owner/product decision, validation path, source
evidence, or close/narrow disposition needed next.
