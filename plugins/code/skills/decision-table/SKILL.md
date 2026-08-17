---
name: decision-table
description: Use when the user wants a code-grounded decision table for current behavior, wants to compare current behavior against a plan or work item, or needs a control-flow artifact for recovery, retry, finalization, validation, state-machine, or review-heavy edge cases.
---

# Decision Table

## Purpose

Generate a repo-local decision-table artifact that makes control-flow and stateful edge cases reviewable. The decision table is the source of truth; a Mermaid diagram is optional and secondary.

## Output Location

Write artifacts under `<repo-root>/.closedloop-ai/decision-tables/`. Create the directory if missing.

Default to one artifact per work item:

- plan-scoped: `<plan-id>.md`
- non-plan-scoped: `<short-work-name>.md` (lowercase kebab-case)

Keep multiple behavior areas as sections inside the same artifact. Only split into multiple files when one artifact would be too large to review quickly or when the work clearly spans separate repos/systems.

## Workflow

1. Resolve the repo root and the work item under review.
2. If a plan/ticket/description is supplied, infer behavior to map: control-flow surfaces, retries/recovery/finalization, validation/error paths, state transitions, durable side effects. Ignore purely mechanical edits.
3. Read the plan first (if any) and extract only behaviorally relevant requirements.
4. Read repo-level guardrails as co-equal requirements: agent instruction files (`AGENTS.md`, `CLAUDE.md`), compatibility rules, contributor docs, API contracts. If the plan and guardrails conflict, record the tension in the artifact, add a `Plan Clarifications` note when appropriate, and surface the conflict to the user if it affects implementation or review.
5. Read the actual code paths. Build the table from code, not expectations.
6. For shared routes, handlers, helpers, contracts, or policy surfaces, build a call-site inventory before choosing axes. Search for literal route paths, exported helper names, feature flag keys, rollout keys, query parameters, cache key segments, environment variable names, storage keys, event names, command names, plugin or marketplace identifiers, header/reason/status strings, and shared types. For each caller, record what data it can supply, what response shapes/statuses it expects, peer version skew, and how missing/unknown fields degrade. Classify each literal by semantic purpose and source of truth; do not treat similar-looking strings as aliases unless a shared constant, documented contract, or existing compatibility path proves they are aliases.
7. For dependencies, model success, null/absent, validation failure, and thrown/rejected branches whenever externally visible behavior depends on them.
8. Run the behavioral edge-case expansion pass. Apply every category in `references/edge-cases.md`. Each must be represented by rows or an explicit non-applicability note with source-backed evidence. When multiple evidence, authority, history, or fallback sources can coexist, add a bounded interaction pass: cover pairwise and high-risk intersections instead of an unbounded Cartesian product, including legacy/absent plus fresh valid, corrupt/undated plus fresh valid, irrelevant historical plus current authoritative, tied/conflicting current records, and source/state precedence. For distributed command, signing, key, capability, or cross-process state work, treat web app, backend, Electron, local store, OS notification, cache, and remote peer behavior as separate surfaces unless code proves they are the same surface.
9. Choose a small set of state axes that explain the branch behavior. Reuse the same axes within a behavior area across `Current Code` and `Intended Change`.
10. Write the artifact using `references/artifact-format.md`.
11. When a plan is in scope, include `Current Code`, `Intended Change`, `Delta Checklist`, and `Required Tests`. When no plan is in scope, omit `Intended Change` and focus on the current-state table plus gaps or suspicious branches.
12. Give every material decision row a stable row ID. For `Required Tests`, map each test to one or more row IDs and name the invariant being proved, the positive path, and the wrong-input, mixed-state, failure, or compatibility mutation. A test must prove the specific binding/fallback/diagnostic the row claims; it cannot just trigger a generic rejection. When a row depends on an exact external contract literal, the test oracle must fail closed for the wrong literal: feature-flag mocks enable only the exact expected key, query/header/event assertions check exact names and values, and cache/storage/command/plugin identifiers are asserted by semantic type rather than broad substring or "any key" matching.
13. Once implementation begins, freeze `Current Code` and `Intended Change`. All later updates are append-only in `Verification Findings`, `Fixes Applied`, `Final Alignment Status`, and optional `Plan Clarifications`.
14. After implementation, verify the final code against the intended behavior. If drift, missing edges, missing tests, or guardrail violations exist, fix them, append the verification/fix sections, and re-verify until aligned. `Final Alignment Status: Not aligned` is a terminal stop: do not proceed to PR creation, merge, completion, or any downstream success state while it remains. Fixable repo-local findings remain unresolved work and must be fixed and re-verified; they cannot be normalized into a successful handoff.
15. Record evidence artifacts for high-yield coverage and non-applicability claims. Use `references/artifact-format.md` and capture the actual command or source evidence for changed exports, package subpaths, CLI flags, route/query/header/event/cache/storage/command literals, path or filesystem writes, untrusted input fields, persisted schema fields, replay/idempotency behavior, and test-boundary coverage. Do not accept an assertion such as "no consumers", "not externally visible", or "covered by tests" without the corresponding evidence.
16. Run the adversarial responsibility split described below. When delegation is available, this is a post-implementation review by independent lane workers. When delegation is unavailable, run the applicable lanes sequentially and record that the pass was not independent.
17. Group `Fixes Applied` by discovery source when more than one source exists (e.g., `Initial verification`, `Adversarial abuse/filesystem lane`, `Adversarial compatibility lane`, `Runtime testing`, `Review findings`, `Validation failures`, `Repo guardrails`, `Plan clarification`, `Final hygiene`). Do not leave a broad `During verification` bucket once other sources have produced fixes.
18. Treat `Verification Findings` as a resolution queue, not a backlog. Every finding must be (a) fixed, (b) marked not applicable with source-backed evidence, or (c) carried into `Final Alignment Status: Not aligned` with a specific human/external blocker (credentials, deployment access, product decision, unavailable independent adversarial review, etc.). Do not record fixable repo-local work as a permanent gap when the user asked for implementation.
19. Before marking final alignment, run two passes:
    - **Internal consistency:** if the same state, reason, or dependency failure appears with different intended outcomes, add the missing distinguishing axis or fix the mismatch.
    - **Review-prevention:** for every touched externally visible surface, walk `references/review-prevention.md`. Each item must be fixed, already covered by a named row/test, marked not applicable with source-backed evidence, or carried into `Not aligned`. Do not mark `Aligned` while any item is merely assumed covered.
    - **Coverage and evidence disposition rule (hard rule):** every `Covered` or `already covered` disposition, whether it appears in `Verification Findings`, in the Behavioral Edge-Case Expansion, in the adversarial lanes, or in the review-prevention pass, must cite a specific test name and the wrong-input or negative case that test fails closed on. Every `not applicable` disposition must cite source-backed evidence such as grep output, export/package inventory, call-site inventory, schema/query inventory, or code references proving the surface is absent or out of scope. A coverage claim backed only by a happy-path assertion, a pure helper test for an integration boundary, or no evidence is treated as `Not aligned`, not as covered. This applies to security findings: do not mark a security finding `Covered` without a named test proving the rejected or blocked case.
20. Only change `Intended Change` post-implementation if the plan itself was ambiguous or wrong. Record this as `Plan Clarifications` with reason and source. Never silently rewrite the target.
21. Always give the user a human-facing closeout summary outside the artifact. Separate: what was verified and fixed, important nuances, and anything still requiring user input or external action. When status is `Not aligned`, explicitly state that downstream PR/merge/completion is blocked, name every unresolved blocker, and give the exact next action and owner; never phrase it as completion. If the agent cannot complete something autonomously (product decision, credentials, deployment access, independent adversarial review), ask the user directly. If no user action is required, say so. If the user also asked for review, use the artifact as a first-class input rather than recreating the analysis.

## Adversarial Responsibility Split

The decision table author must not be the only adversary when the work is contract-heavy, security-sensitive, filesystem-facing, input-parser-facing, replay/idempotency-heavy, or when the work item explicitly asks for independent review.

When this skill is invoked by a coordinator or main agent with delegation available, split post-implementation verification into independent adversarial lanes after the diff exists. Lane workers receive the frozen decision table, the diff, relevant code, repo guardrails, evidence artifacts, and test results. They return findings only: missing rows, invalid `Covered` or `not applicable` dispositions, missing real-boundary tests, concrete bugs/regressions, and the exact evidence behind each finding.

Use the smallest lane set that matches the touched surfaces. Default lanes for high-risk work:

- **Abuse / filesystem / untrusted input:** symlinks, clobbering, traversal, bounded reads, forgeable fields, identity mismatch, count inflation, destructive cleanup, and raw-vs-canonical policy comparisons.
- **Published contract / compatibility:** package exports, subpath renames, new required fields, old typed consumers, legacy persisted/artifact reads, registry or marketplace metadata, response shapes, and version skew.
- **Input validation / parsing:** CLI flags, valueless flags, `0`/empty/invalid values, coercion, validation ownership, sentinel values, and validation of the representation actually consumed.
- **State / replay / idempotency:** retry/replay reuse, accumulators, terminal states, durable finalization, partial external acknowledgement, cleanup after partial failure, and repeated-action behavior.
- **Test realism:** whether cited tests enter through the real boundary such as CLI, route handler, package export, attribution/ingest pipeline, persisted replay, worker/job, or public API. Pure helper tests only cover helper-local invariants unless paired with a real-boundary test proving production wiring.

When this skill is invoked inside a worker or subagent that cannot spawn additional subagents, do not attempt delegation. Instead:

- If assigned a specific adversarial lane, run only that lane and return evidence-backed findings.
- If acting as the table or implementation author, run the relevant adversarial lanes sequentially as separate passes and record that they were not independent.
- If the work item or coordinator required independent adversarial lanes, add an `External Adversarial Review Needed` verification finding instead of marking the artifact fully aligned.

Do not mark `Final Alignment Status: Aligned` solely on the basis of unavailable delegated review when independent adversarial review was required. Either hand the artifact back to the coordinator for lane review or mark `Not aligned` with the blocker `independent adversarial review not run`.

## Table Rules

- Prefer rows over prose. If a behavioral difference matters, capture it as a row.
- Keep wording compact and behaviorally specific. Use clickable file links and plan IDs/URLs for non-obvious rows.
- Treat an entry path as actual caller plus capabilities, not just a route or module name. Include rows for callers that cannot supply newly required headers, proof material, payload fields, or response handling.
- Call out parity requirements between entry paths (live vs recovery, upload vs replay, retry vs terminal, middleware vs direct, internal vs external). When two entry paths must enforce the same policy, final verification should confirm a shared helper or focused parity tests unless duplication is intentionally documented.
- When one behavior or policy has multiple executable twins (for example a pure helper, SQL predicate, route, worker, producer, or recovery path), use one shared scenario corpus to exercise every twin through its real production boundary and assert identical decisions. Source-string, AST-presence, and SQL-shape assertions are supplemental only and never prove behavioral parity. Treat a negative source-shape assertion that requires a predicate or policy term to be absent as suspicious: if it pins a missing predicate or permits divergence, record it as `Not aligned` until corrected.
- For cross-surface state changes, include how each affected replica or process learns about the write, what durable source of truth resolves disagreement, and how missed events, offline peers, refreshes, reconnects, polling, heartbeats, and startup recovery converge.
- Separate data visibility from side effects. A table row proving data appears in a list, cache, or refresh result does not prove notifications, telemetry, command dispatch, revocation, deduplication, or other effects fired.
- For cached peer capabilities or supported operations, include fresh cache, stale false negative, stale false positive, old peer, retry, fallback, and reconciliation rows before relying on the cache to skip a command or safety action.
- For persisted records gaining new provenance, source, trust, or ownership fields, include rows for missing fields, conservative defaults, evidence-based promotion/backfill, downgrade behavior, and protection for manual or legacy records that must not be accidentally deleted or promoted.
- For distributed lifecycle work, model register/create, approval/authorization, normal command execution, revoke/delete, offline/reconnect reconciliation, repeated action/idempotency, and stale UI/cache behavior as distinct lifecycle rows.
- Separate explicit requirements from inference. When the plan implies behavior without stating it, label the row inferred.
- When repo guardrails impose compatibility, version-skew, or fallback requirements, include them in `Intended Change` even if the plan text is narrower.
- Surface externally visible outcomes, not just internal branches.
- For wire contracts crossing packages, apps, repos, or process boundaries, prefer shared constants/types for header names, reason strings, modes, status meanings, and response shapes. If duplicated, record the drift risk or add a follow-up.
- For feature flags, rollout controls, query parameters, cache keys, storage keys, environment variables, event names, command names, plugin identifiers, marketplace identifiers, URL schemes, and other external contract literals, record the exact literal, semantic type, source of truth, owning surface, and all producers/consumers. Similar spelling is not evidence of equivalence; if two strings must stay in sync, use a shared constant or add a parity test.
- If the same state or failure reason appears in multiple rows with different intended outcomes, add the missing axis or flag the contradiction before implementation.
- Every `Covered` or `already covered` disposition must cite a specific test name and the wrong-input or negative case that test fails closed on. Coverage for a CLI, route, package export, worker/job, replay, ingest, attribution, or other integration surface must cite a test through that real boundary; a pure helper test only covers helper-local invariants. Every `not applicable` disposition must cite source-backed evidence such as grep output, export/package inventory, call-site inventory, schema/query inventory, or code references proving the surface is absent or out of scope.
- Do not use soft final states (`Partially aligned`, `Mostly aligned`, `Recorded Gaps`). Use `Aligned` only when no known fixable drift or required-test gap remains; otherwise `Not aligned` with the blocker.
- Treat `Not aligned` as a hard workflow gate, not a report-only status. No PR, merge, completion signal, or success closeout may follow until the artifact is re-verified as `Aligned`.
- Do not mark `Aligned` if repo guardrails are violated, a required backward-compatible fallback is missing, plan/guardrail tension is unresolved, throw-capable preparation or framework-managed retry/reconnect paths are unrepresented, required evidence artifacts are missing, required independent adversarial review was not run, or the review-prevention pass is incomplete.
- The decision table is an LLM working artifact. Never bury user-actionable information only in the artifact; surface it in the final response.

## Prompt Guidance

Default invocation:

> Invoke the decision-table skill for this work item. Infer what needs to be mapped, write one artifact under `.closedloop-ai/decision-tables/`, then implement, verify final code against that artifact, and fix any drift or missing tests before finishing. Treat verification findings as a resolution queue: every finding must be fixed, proven not applicable with source-backed evidence, or carried into `Final Alignment Status: Not aligned` with a concrete human/external blocker. Record evidence artifacts for high-yield claims, run the adversarial responsibility split when available, and keep baseline and target sections frozen; append verification and fixes.

When a plan is in scope, replace "this work item" with the plan ID, point the artifact path at `.closedloop-ai/decision-tables/<plan-id>.md`, and add: "Read repo guardrails such as agent instruction files and compatibility docs and treat them as co-equal requirements. Model dependency success, null/absent, and thrown/rejected branches anywhere the surface promises exact status or error behavior."

## Human Handoff

The final user-facing message must not assume the user will read the artifact. Include:

- what was verified
- what was fixed
- any behavior nuance or plan clarification the user should know
- any external/human action required (asked directly, not buried in the artifact)
- "no user action required" when that applies

## Review Guidance

Normal review is enough once the artifact exists. Review the change against the decision table, the plan, and repo-level guardrails. Treat mismatches as issues to fix, not just findings to report, and surface user-actionable items directly in the final response.

For contract-heavy work, walk `references/review-prevention.md` against the implemented surfaces. A separate review skill is only worth adding if this becomes a repeated, high-volume workflow that needs a fixed rubric layered on top of the existing review prompt.

## Optional Mermaid

Only produce a Mermaid diagram if the user asks for it or if the table is too large to scan quickly. Derive Mermaid from the decision table, not the other way around.
