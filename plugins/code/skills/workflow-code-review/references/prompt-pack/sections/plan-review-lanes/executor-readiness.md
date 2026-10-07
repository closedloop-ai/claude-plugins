# Executor-Readiness Lane

Read `sections/plan-review-lanes/common.md` first; it defines the shared lane contract, evidence JSONL shape, and verdict semantics.

This core lane always runs. It verifies template completeness, AC coverage, task order, file ownership, validation, and whether another agent can execute the plan without making product, architecture, contract, storage, validation, or testing decisions. For cross-repo, security, auth/signing, API/wire-contract, persistence, replay/recovery, or compatibility-sensitive work, review must be substantive.

## Required Checks

The reviewer must check whether:

- the plan uses the required template completely, including `Source Scope Resolution` with primary requirements, linked-doc roles, scope decisions, and every `AC-*`/`T-*` mapped to declared primary `REQ-*` requirements; `CTX-*` constraints may supplement, not replace, primary scope
- existing linked plans have an executable status. `DRAFT`, `IN_PROGRESS`, `IN_REVIEW`, and `APPROVED` may proceed; `OBSOLETE`, `EXECUTED`, `DONE`, missing, or unknown statuses block or require user approval for reuse/replacement.
- linked/prerequisite docs stay constraints, sequencing, precedent, related context, existing-plan evidence, or delegated scope; they do not replace primary requirements unless the primary document says so
- all work-item acceptance criteria are covered
- each task is executor-ready and leaves no product, architecture, file ownership, API contract, storage, validation, or testing decision to the execution agent
- the repo impact matrix is accurate
- the plan contains technical current contract, target contract, owner surfaces, consumer surfaces, compatibility behavior, and validation strategy where applicable, not mostly executor instructions or generic repo-search prompts
- nontrivial changes to code, schemas, control flow, data flow, runtime handoffs, or UI workflows include concise Mermaid flowcharts generated with `$mermaid-visualizer` that explain the current and proposed flow for human review, or a concise non-applicability reason for trivial/mechanical work
- the plan passes a literal execution consistency check: no production work hidden in test tasks, no referenced symbols/imports/destructures missing from the task list, no misleading field semantics, no hard-coded local worktree paths, and no acceptance criteria without automated validation or explicit non-automatable rationale
- `Runtime Investigation` is `required` for observed-behavior bugs, regressions, count/state/data/projection mismatches, flaky behavior, integration failures, or any diagnosis depending on current runtime behavior, and names memory, surfaces, probes, evidence, limits, and confidence
- runtime investigation is `not_applicable` only for requirements/code-grounded work, with a concrete reason; reject it for current-behavior discrepancies when repo-supported runtime evidence is practical
- the plan includes a PR Size Budget with a plausible additions+deletions estimate per planned PR/repo, compares the largest estimated PR to `WORKFLOW_LARGE_PR_CHANGED_LINES_THRESHOLD`, and does not present an oversized plan as normal approval-ready without a decomposition recommendation
- tests and validation commands are specific enough, repo-relative, and setup-aware for the package, workspace, database, generated-client, service, or runtime boundary they exercise
- configured `WORKFLOW_FEATURE_FLAG_REPO` work includes a `${WORKFLOW_FEATURE_FLAG_PROVIDER}` flag for rollout-sensitive features with flag name, evaluation point, fallback, rollout notes, and enabled/disabled tests, or a repo-grounded non-applicability reason
- manual/live/staging/provider/identity/permission/upstream validation debt has Manual Testing Debt Classification (`none`, `automated`, `justified`, `blocked_external`, or `unresolved`); vague manual-verification language fails
- existing linked plans are validated against the latest fetched base branch/SHA for each implementation repo, not a stale local checkout
- existing linked plans still match the latest source work-item content, acceptance criteria, current repo guardrails, current code paths, current API/storage contracts, current validation commands, and current compatibility requirements
- Open Questions and Gaps contain true blockers only, not work the agent could resolve from repo context

## Deterministic Grounding Report

Consume `planning.grounding` instead of re-deriving existence checks. The orchestrator already verified base shas, cited-file existence, and grep claims. Review manifest completeness and claim quality: every task/test file in `files[]`, every imports/consumes/shared-by assertion backed by a grep claim with `expected_paths`, and every removal sweep backed by baseline plus post-change claims. Fail missing load-bearing manifest evidence, not re-derived existence.

## Lane Focus

- Verify tasks, commands, file paths, tests, and ACs are concrete enough to execute without inventing policy.
- Verify every AC/task maps to a primary requirement; fail missing mappings, CTX-only mappings, precedent/out-of-scope-only mappings, or contradictions with the primary work item.
- Reject source-text/grep tests when a production-path behavior, adapter, type, integration, or fixture-driven test can prove the same invariant.
- Fail this lane when required validation is vague, points at missing files, omits setup for stateful commands, omits package/workspace/database/generated-client prerequisites, or lacks a positive control plus failure mutation for changed contracts.
- Verify constants, flags, schema/type imports, and helpers follow repo conventions. If conventions conflict, require an evidenced location or Open Question/GAP blocker.
- Verify every acceptance criterion has automated coverage in the test plan, or is moved to Risks/Compatibility/Manual Validation with a clear reason it cannot be automated. Planning-time search evidence alone is not AC validation.
- Verify validation commands are repo-relative, such as using `$REPO_ROOT` or package manager `-C` flags, and do not hard-code one user's absolute worktree path unless the repo guardrails require it.

## Execution Dry Run

The reviewer must dry-run the plan from top to bottom.

The dry run must identify missing prerequisites, ambiguous ownership, missing file paths/API contracts/validation commands, unresolved product/security decisions, or steps requiring the execution agent to infer behavior.

Fail the plan if an execution agent would need to make product, architecture, file ownership, API contract, storage, validation, testing, security, compatibility, package-version, runtime-path, descriptor-taxonomy, or consumer-inventory decisions.

Fail plans that read mainly as executor instructions, discovery prompts, or generic validation advice without the current contract, target contract, owner/consumer surfaces, compatibility behavior, and validation strategy.

Dry-run each task exactly as written. Fail hidden production work in test/validation/docs/review-only tasks; referenced symbols/imports/route values/constants/enums/types/flags/fixtures not already present or created earlier; misleading field names such as `*DocumentId` without guaranteed dereference/null behavior; or anything requiring the executor to infer task order, source-of-truth modules, wire semantics, or validation.

For manual testing debt, fail the plan if manual verification remains unclassified, if existing automation can cover the behavior but the plan leaves it manual, or if the plan omits the highest practical automated substitute and exact setup-aware validation command for justified or external manual checks.

For runtime investigation, fail the plan if an observed-behavior bug or discrepancy is marked `not_applicable` without a repo-grounded reason, if required read-only probes were skipped despite available local/dev/test tooling or relevant repo memory, or if the plan claims a runtime-confirmed diagnosis without naming the probe and evidence. Do not require runtime investigation for straightforward additive work, such as adding a new button or field, when there is no reported current-behavior discrepancy and the plan says why code/requirements are sufficient.

For feature flags, apply `sections/planning-phase.md`; do not flag every API, type, test, telemetry, refactor, or compatibility change. Fail missing required flag coverage, silent non-applicability for ambiguous rollout-sensitive changes, or non-applicability without repo evidence. If the plan chooses the flag name, require concise kebab-case plus evaluation point, fallback, compatibility, rollout notes, and enabled/disabled tests.

Search for conditional handoff language such as "if needed", "where appropriate", "executor should decide", "implementation may choose", or equivalent wording. Fail the plan when that language applies to package strategy, runtime paths, schema shape, file ownership, compatibility, validation setup, or test coverage and the repo context can resolve it. If repo context cannot resolve the issue, verify it is listed as an Open Question or Gap blocker and directly reported to the user.

## Existing Linked Plan Freshness

For `linked_plan_intake`, this lane is a freshness and executor-readiness gate for the existing plan. It must not rubber-stamp the plan because it is already linked.

The reviewer must:

1. Verify the selected plan status is executable under `sections/work-item-intake.md`.
2. Verify the orchestrator refreshed every implementation repo to the latest base branch/SHA before review.
3. Compare the plan against the latest source work-item content and acceptance criteria.
4. Compare the plan against current repo guardrails, current code paths, current contracts, current validation commands, and current cross-repo compatibility requirements from the refreshed worktree.
5. Treat source-work-item updates after the plan version, missing base-refresh evidence, missing files/modules, changed contracts, changed validation commands, obsolete assumptions, or status ambiguity as review findings.

If the existing linked plan is stale but repo-local corrections are clear, return `FAIL` with required corrections so the orchestrator launches a plan-revision subagent to update that same linked plan with ClosedLoop MCP `create_document_version`; a duplicate plan must not be created.

If the existing linked plan has a non-executable status, the correct source/plan relationship is ambiguous, the base branch cannot be refreshed, or the needed changes require a human/product/architecture decision, return `BLOCKED` and surface the user decision instead of approving the plan.

## Lane-Specific Evidence Matrix Rows

In addition to the generic rows in `common.md`, include:

- plan status and linked-plan freshness evidence if the plan is an existing linked plan
- source scope resolution checked, including primary requirement inventory, linked document roles, scope decisions, and AC/task traceability
- literal execution consistency checked, including task placement, referenced symbols, field semantics, DB/query snippets, validation commands, and AC coverage
- runtime investigation applicability, including required probes/evidence or the concrete non-applicability reason
- feature flag name and enabled/disabled behavior for rollout-sensitive work in `WORKFLOW_FEATURE_FLAG_REPO`, if configured, or explicit non-applicability reason under `sections/planning-phase.md`
