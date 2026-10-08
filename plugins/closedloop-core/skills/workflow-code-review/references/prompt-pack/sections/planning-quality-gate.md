# Planning Quality Gate

Before uploading or notifying the user that a plan is ready, the orchestrator must use the TypeScript batch runner to launch independent read-only plan-review lane subagents. Run this gate for both newly authored plans and existing linked plans selected by work-item intake.

This file is the orchestrator-facing process doc. Lane workers receive `sections/plan-review-lanes/common.md` plus their own lane file; do not paste this whole gate file into lane spawns.

## Grounding Manifest Verification

The orchestrator runs `{{WORKFLOW_CLI}} plan-grounding verify --goal-slug <goal-slug> --work-item-id <work-item-id> --plan-file <returned draft plan path>` after planning returns and each semantic revision, before review lanes spawn. It verifies the hard plan contract (`## Source Scope Resolution`, required sections, `## Runtime Investigation`) plus `## Grounding Manifest` (base pins, cited files, grep claims) against ledger worktrees and records `planning.grounding`. The runner requires current verified grounding before plan-review lanes; missing, stale, or failed deterministic verification routes back to planning with the failure list.

## Review Lanes

Lane content lives in `sections/plan-review-lanes/<laneId>.md`; the shared evidence shape, finding fields, matrix expectations, PASS/FAIL/BLOCKED semantics, read-only rule, and candidate-knowledge-notes rule live in `sections/plan-review-lanes/common.md`.

Core lanes:

- `executor-readiness`: template completeness, acceptance criteria coverage, task order, file ownership, setup-aware validation, executor readiness, linked-plan freshness, execution dry run.
- `adversarial-contract`: call-site inventory, canonicalization/signing, trust boundaries, compatibility/version skew, propagation paths, failure/replay/recovery, exact taxonomy, adversarial review passes.
- `repo-grounding-reuse`: grounding in current code; reuse/extend/create decisions for helpers, schemas, constants, permissions, status maps, validators.
- `api-data-model-ownership`: contract ownership, exposure surface parity, stateful resource compatibility, multi-producer persistence ownership, external observation ownership.
- `principal-architecture`: `$principal-engineer` design-quality review with `Fix now` / `Ask first` / `Follow-up` / `Ignore` classification.

Specialty lanes:

- `database-migration-safety`: ORM schema, migrations, raw SQL, constraints, drift validation, cutover/backfill safety.
- `security-abuse`: attacker capability, authorization, isolation, untrusted input, abuse paths, negative tests.
- `e2e-user-flow`: E2E/user-flow applicability, user-visible state matrix, visual viewport and rendered-screen validation.
- `real-boundary-coverage`: real producer-to-consumer boundary tests, multi-producer persistence/result mapping coverage, multi-step failure-mode coverage.
- `precedent-conformance`: diffs the plan against the nearest existing analogue feature declared in the `precedents` manifest entries; fails when a load-bearing analogue discipline has no plan equivalent and no justification.

For cross-repo, security-sensitive, auth/signing, API/wire-contract, persistence, replay/recovery, or compatibility-sensitive work, the executor-readiness and adversarial-contract lanes must be substantive. For nontrivial changes to existing code, the repo-grounding-reuse lane must be substantive. Applicability triggers for the API/data-model, database/migration, security-abuse, and principal-architecture lanes are defined in each lane file.

For straightforward single-repo work, nonapplicable lanes should return `not_applicable` with concrete evidence instead of broad speculative review.

## Deterministic Specialty-Lane Skip (First Full Review Only)

The planning worker's return includes per-specialty-lane applicability declarations (`lane_applicability`) with repo-grounded reasons, ingested as `planning.laneApplicability`. On the first full review only, the runner may skip the planner-declarable specialty lanes `e2e-user-flow`, and `real-boundary-coverage` when planning declared the lane `not_applicable` with a reason. The skip is recorded as lane evidence with status `not_applicable` and the planning-provided reason, so aggregation works unchanged. Core lanes always run. The `security-abuse` lane is never planner-declarable: it always runs on a first full review and only the lane itself may return `not_applicable`; the planning ingest CLI ignores a planner `not_applicable` declaration for it with a warning (fail closed). The `precedent-conformance` lane is never planner-declarable for the same reason and is also ignored with a warning if a planner declares it `not_applicable`; it is independent on purpose, since planners are blind to the analogues they missed, so only the lane itself may return `not_applicable` using the manifest's `precedents_none_reason` after it independently confirms no analogue exists. A missing declaration means the lane runs (fail closed). Targeted re-checks after revisions never use planning declarations; lanes mapped from changed sections or `requiredRecheckLanes` always run.

## Spawning Lanes

Each plan-review subagent must use the `status_file` path assigned by the orchestrator and return the lane evidence JSONL contract defined in `sections/plan-review-lanes/common.md`. After the subagent returns, the orchestrator must run `{{WORKFLOW_CLI}} lane --goal-slug <goal-slug> --work-item-id <work-item-id> --kind plan --lane-id <laneId> --status-file <status_file>` before rerunning `{{WORKFLOW_CLI}} next`. The CLI rejects a lane-id mismatch before writing the ledger; it also stamps the current ledger plan version as the authoritative reviewed version.

If the orchestrator provides a `planning_loop_id`, plan-review, revision, and targeted re-check subagents must use ClosedLoop MCP `add_loop_event` for major review starts, review outcomes, blockers, revisions, and re-check results. They must not create, complete, fail, or cancel manual loops.

If the revision or re-check is caused by a user-requested plan update after the previous planning handoff completed, the orchestrator must create a fresh planning manual loop first and pass that new `planning_loop_id` to the subagents. If the previous planning loop is still active, reuse the existing loop.

## Finding Verification

After every launched lane is terminal but before aggregation, the runner inserts a finding-verification stage whenever a blocking finding across the terminal lanes still lacks a current-plan-version `planning.findingVerification` entry. Coverage gates the stage: the runner emits `verify_plan_findings` enumerating only the uncovered blocking findings, and re-emits it when a lane re-run surfaces a new blocking finding at the same plan version, so aggregation stays gated until every enumerated blocking finding has an entry. The orchestrator must spawn read-only falsification verifiers per blocking finding and record the outcomes with `{{WORKFLOW_CLI}} plan-review verify --goal-slug <goal-slug> --work-item-id <work-item-id> --status-file <status_file>` before the runner allows `aggregate_plan_review`. The command requires a real status file (it rejects inline JSON and a work_item_id mismatch), stamps the plan version from the ledger, and merges the recorded outcomes by findingId so multiple verify runs at the same plan version accumulate coverage. Each finding receives one verifier outcome: `confirmed`, `refuted`, or `unverifiable`. Refuted findings are downgraded to advisory in aggregation; `confirmed` and `unverifiable` findings stay blocking, and a still-missing entry is treated as `unverifiable` at aggregation (fail closed). A lane failure backed by finding artifact paths or true ledger blockers, rather than by enumerated blocking findings, is never cleared by refutation and stays failing even when every enumerated finding is refuted. The orchestrator-facing spawning and recording process lives in `sections/plan-finding-verification.md`. A new semantic revision changes the plan version, dropping prior verification so fresh blocking findings are re-verified.

## Aggregation

Each lane records `planning.planReviewLanes.<laneId>` evidence. The orchestrator may aggregate the gate only after every launched lane is terminal with `pass`, `fail`, `blocked`, or `not_applicable`, and after the finding-verification stage has recorded `planning.findingVerification` for the current plan version when blocking findings exist. Aggregation is ledger coordination only; the orchestrator must not perform source review or plan review itself. When the runner emits `aggregate_plan_review`, run `{{WORKFLOW_CLI}} plan-review aggregate --goal-slug <goal-slug> --work-item-id <work-item-id>` and then rerun `{{WORKFLOW_CLI}} next`; do not hand-patch `planning.planningQualityPassed` with `{{WORKFLOW_CLI}} ledger upsert`. Aggregation counts refuted findings as advisory and keeps `confirmed` and `unverifiable` findings blocking.

The TypeScript runner owns plan-review freshness. For semantic revisions, lanes named by `requiredRecheckLanes` and lanes mapped from `planning.pendingRevisionSections` must have current-version evidence before aggregation; mapped lanes are authoritative even if the revision worker omitted them from `requiredRecheckLanes`. The aggregate worker must only aggregate the standard `PLAN_REVIEW_LANES` selected by the runner and must not count `plan-integrity-contract` as part of normal planning quality.

## Plan-Integrity-Contract Lane

The `plan-integrity-contract` lane is a conditional approval-integrity lane, not a normal aggregation lane. The runner requests it after planning quality and, when auto-execution is enabled, after auto-execution evaluation; it must run before either `wait_for_human_approval` or `mark_plan_accepted` when triggered. It triggers when the plan has at least two counted semantic revisions or the auto-execution risk tier is `HIGH` or `CRITICAL`. When auto-execution is disabled, the risk tier is unavailable and only the semantic-revision-count trigger applies. Lane content: `sections/plan-review-lanes/plan-integrity-contract.md`.

## Existing Linked Plan Freshness

For `linked_plan_intake`, the planning quality gate is a freshness and executor-readiness gate for the existing plan; the reviewer steps live in `sections/plan-review-lanes/executor-readiness.md`. If the existing linked plan is stale but repo-local corrections are clear, the lane returns `FAIL` with required corrections; the orchestrator must launch a plan-revision subagent to update that same linked plan with ClosedLoop MCP `create_document_version`; it must not create a duplicate plan. If the lane returns `BLOCKED` (non-executable status, ambiguous source/plan relationship, unrefreshable base branch, or a human/product/architecture decision), ask the user instead of approving or executing the plan.

## Revision Triage

The orchestrator must triage review findings:

- Valid/actionable findings on a newly authored plan: send them back to the original planning subagent to revise the plan.
- Valid/actionable findings on an existing linked plan: launch a planning subagent in plan-revision mode to update that existing plan with ClosedLoop MCP `create_document_version`; do not create a duplicate plan.
- User-requested semantic changes to a plan after handoff: launch a planning subagent in plan-revision mode, update the existing plan with ClosedLoop MCP `create_document_version` when the artifact already exists, then run the required targeted re-check before asking for approval again.
- User-requested nonsemantic changes to a plan after handoff, such as diagrams in `Visual References`, formatting, typo fixes, links, or explanatory notes, must be classified before clearing review evidence. If the classifier verifies no normative plan content changed, record `planning.pendingRevisionKind: "nonsemantic"`, changed sections, latest plan version, `planning.lastReviewedVersion` equal to the latest version, and `planning.nonsemanticRevisionVerifiedAt`. Do not clear `planning.planningQualityPassed`, `planning.planReviewLanes`, `planning.autoExecutionVerdict`, or `planning.autoExecutionRiskTier` for verified nonsemantic amendments.
- No-op plan-revision outcomes, where the plan-revision worker makes no document edit because the current plan already addresses the finding, must be recorded separately from nonsemantic amendments. Record `planning.pendingRevisionKind: "noop"`, latest plan version, `planning.noopRevisionVerifiedAt`, and targeted `planning.requiredRecheckLanes`. Clear stale failed aggregate fields so the targeted re-check can verify the no-op outcome. Do not increment `planning.semanticRevisionCount` and do not pretend a new plan version was created.
- Unclear findings: ask the user before changing the plan.
- Invalid/not applicable findings: record the reason.

Publish plan revisions and plan content to ClosedLoop only through the MCP `create_document_version` tool, passing the full body as its `content` argument even when it is tens of thousands of characters. Do not fall back to curl, the raw ClosedLoop HTTP API, or a hand-built MCP JSON-RPC payload to dodge the body size: shell credentials are intentionally absent, so direct writes fail. Never read or print ClosedLoop API keys.

## Targeted Re-Checks

After each semantic or no-op revision classification, launch targeted re-check subagents to verify the addressed findings, any changed plan sections, and any new risks introduced by the revision. For plans that required multiple independent reviewers, including the API/Data-Model Ownership reviewer, Database/Migration Safety reviewer, security-abuse reviewer, and Principal Architecture reviewer, run the relevant targeted re-check for each reviewer lane that found issues. Verified nonsemantic amendments bypass targeted re-checks and preserve prior auto-execution evidence because their risk tier did not change.

If a revision changes, preserves, narrows, broadens, or relocates any API, MCP, wire, shared type, persisted model, response field, domain relationship, lineage metadata, or projection shape, the targeted re-check must re-certify the Contract Ownership Decision even if the original ownership reviewer previously passed the plan. Do not assume ownership remains valid after a shape-preserving revision when a reviewer or user has questioned the API/data-model surface.

If a revision changes, preserves, narrows, broadens, regenerates, or edits any ORM schema, migration, raw SQL, generated database client/type, persisted model, index, constraint, foreign key, backfill, or seed data, the targeted re-check must re-certify the Database/Migration Safety decision. Do not assume migration safety remains valid after a shape-preserving revision when SQL provenance, constraint names, generated schema metadata, or validation commands changed.

## Revision-Pass Cap

Do not run infinite plan-review loops. Allow one full independent review, up to four plan revision passes by default, and a targeted re-check after each revision pass. The cap is enforced by the TypeScript runner from `planning.semanticRevisionCount` against `WORKFLOW_MAX_PLAN_REVISION_PASSES` (default 4) plus user-granted passes; open semantic revisions count once even if they emit multiple document versions. When the cap or a repeated blocking finding fires, the runner emits `request_plan_revision_limit_decision` and the orchestrator must record the user's continue/halt decision instead of launching another revision.

A fifth revision pass is allowed only when all remaining blockers are concrete and repo-local, reviewers supplied exact required corrections, no product/security/architecture decision is unresolved, and the previous revision made clear progress. Do not run more than five plan revision passes, for six total plan rounds including the initial full review. If serious blockers remain after the allowed revision passes, report them to the user with the latest reviewer evidence instead of marking the plan ready.

## Upload And Notify

Only after the planning quality gate passes should a newly authored plan be uploaded and `WORKFLOW_NOTIFIER_COMMAND` be run when configured. For an existing linked plan, do not upload a duplicate; run the notifier only after the linked plan passes the gate.
