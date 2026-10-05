# Review Lens Map

Use these workflow prompt-pack files as reusable review lenses only. Do not execute their orchestration, planning, approval, upload, notification, manual-loop, finalization, PR lifecycle polling, test, validation, visual-check, commit, push, or merge instructions.

Locate the prompt pack as the skill's "Prompt Pack Discovery" section says: a valid `WORKFLOW_PROMPT_PACK_ROOT` when set, otherwise the copy bundled with this skill at `references/prompt-pack/`.

## Plan Review Lanes

Reference: `sections/plan-review-lanes/common.md` plus the lane files named below. `sections/planning-quality-gate.md` is the orchestrator-facing process doc and is not a review lens; the lane content lives in the per-lane files.

Borrow:

- API/Data-Model Ownership review: `sections/plan-review-lanes/api-data-model-ownership.md`
- Database/Migration Safety review: `sections/plan-review-lanes/database-migration-safety.md`
- Security-abuse review: `sections/plan-review-lanes/security-abuse.md`
- Principal Architecture review: `sections/plan-review-lanes/principal-architecture.md`
- adversarial contract passes, executable validation expectations as review criteria only, and feature-flag applicability reasoning when the repo uses a configured feature flag provider: `sections/plan-review-lanes/adversarial-contract.md`
- literal consistency checks and execution dry-run expectations: `sections/plan-review-lanes/executor-readiness.md`

Do not borrow:

- plan template enforcement
- plan upload/handoff
- approval gates
- plan revision loops and revision caps or limit decisions
- planning verdicts such as "plan ready"
- lane evidence JSONL recording, severity normalization, or the lane CLI contract from `common.md`
- lane_applicability skip machinery and plan-integrity-contract triggering
- plan-grounding manifest verification commands

Translate to code review by asking whether the merged diff has a production-reachable defect in ownership, contracts, security, or validation. The plan lanes may suggest questions, but their preferred architecture or product choice is not an actionable code finding without the skill's Actionable Finding Standard.
For database/migration-sensitive diffs, inspect whether generated or hand-authored migrations match the schema, ORM metadata, existing data, and deployed consumers. Claim breakage only after identifying the specific mismatched object and failing production path; absent drift validation alone is normally a validation gap.

## Implementation Quality Gate

Reference: no file read by default. The borrowable lens content here (changed-file to guardrail-rule compliance, the Guardrail Automation Gap Assessment, the Correctness Escape Pattern Pass, and decision-table alignment) is already restated inline in this skill's lane specs in `SKILL.md`; rely on those. The rest of `sections/implementation-quality-gate.md` is orchestrator machinery the do-not-borrow list excludes. Only when the diff changes user-visible flows or producer-to-consumer boundaries, read the E2E/user-flow and real-boundary validation passages in `sections/implementation-quality-gate.md`: search for "E2E/User-Flow Validation Pass" and "Real Boundary Scenario Coverage" by name, since the file has no headings.

Borrow:

- review plan, decision table, full diff, untracked files, guardrails, and already-available-at-snapshot validation results when available
- changed-file to guardrail-rule compliance
- Guardrail Automation Gap Assessment for valid guardrail/convention/static-safety findings
- decision-table alignment when a decision table exists
- database/migration safety evidence when ORM schema, migrations, raw SQL, generated database clients/types, seeds, backfills, or persisted models changed
- principal implementation review for nontrivial diffs
- one bounded fix/re-check concept as a recommendation only

Do not borrow:

- launching fix agents unless the user separately asks to fix
- committing, pushing, or marking implementation quality as passed

Translate to code review by finding concrete mismatches between intended behavior, actual code, repo rules, and validation. Start with boundary arithmetic, cache invalidation, scaling, partial failure, recovery, read/write consistency, compatibility envelopes, stale/null/mixed state, and idempotency/retry. Use the generic Correctness Escape Pattern Pass without encoding repo-specific surfaces or inventing an issue for every pattern.
For migration work, note what deploy/apply success does not prove, but report a finding only when a repo-required check or a concrete migration/ORM/consumer incompatibility supports it.

## Planning Phase

Reference: `sections/planning-phase.md`, but do not read the whole file; read only these sections: "Required Repo Impact Matrix", "Required Contract Resolution" with its subsections named below, and "Database/Migration Safety".

Borrow:

- repo impact matrix mindset: "Required Repo Impact Matrix"
- producer-to-consumer tracing: the "Required Contract Resolution" intro
- Contract Ownership Decision: "Contract Ownership Decision" under "Required Contract Resolution"
- Database/Migration Safety decision: "Database/Migration Safety"
- runtime path matrix: "Runtime Path Matrix"
- shared package/version matrix: "Shared Package And Version Matrix"
- consumer inventory: "Consumer Inventory"
- descriptor/envelope taxonomy: "Descriptor Or Envelope Taxonomy"
- no deferred architecture decisions: "No Deferred Architecture Decisions"

Do not borrow:

- creating or uploading a plan
- requiring the plan template
- worktree setup
- plan-status loops

Translate to code review by checking whether the chosen source of truth creates a concrete failure at an affected production consumer. Do not promote a different product choice, preferred owner, or merely different Desktop/web implementation to a finding.
For database work, check whether generated migrations, hand-authored SQL, or schema mappings create a specific break in ORM metadata, existing data, or a consumer rather than inferring breakage from the choice itself.

## Post PR Lifecycle Gate

Reference: none. The bullets below are the complete lens for this gate; `sections/post-pr-lifecycle-gate.md` is orchestrator machinery and must not be read.

Borrow only when the review target includes existing PR review comments:

- human and code-owner comments carry more weight than bot comments
- broad human concerns about hacks, wrong abstraction, wrong owner, or muddy contracts warrant source inspection, but become findings only with a reachable failure path
- valid comments should be addressed; invalid comments need evidence-backed pushback

Do not borrow:

- polling
- replying to comments
- resolving threads
- PR readiness state transitions

Translate to code review by checking human architecture concerns against production behavior without treating the comment's authority as proof of a defect.

## Lightweight Knowledge Capture

Reference: `sections/lightweight-knowledge-capture.md`

Borrow only if the user asks to update durable workflow knowledge. Ordinary code review should not write candidate knowledge notes.
