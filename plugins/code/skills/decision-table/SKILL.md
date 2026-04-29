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
6. For shared routes, handlers, helpers, contracts, or policy surfaces, build a call-site inventory before choosing axes. Search for literal route paths, exported helper names, event names, header/reason/status strings, and shared types. For each caller, record what data it can supply, what response shapes/statuses it expects, peer version skew, and how missing/unknown fields degrade.
7. For dependencies, model success, null/absent, validation failure, and thrown/rejected branches whenever externally visible behavior depends on them.
8. Run the behavioral edge-case expansion pass. Apply every category in `references/edge-cases.md`. Each must be represented by rows or an explicit non-applicability note.
9. Choose a small set of state axes that explain the branch behavior. Reuse the same axes within a behavior area across `Current Code` and `Intended Change`.
10. Write the artifact using `references/artifact-format.md`.
11. When a plan is in scope, include `Current Code`, `Intended Change`, `Delta Checklist`, and `Required Tests`. When no plan is in scope, omit `Intended Change` and focus on the current-state table plus gaps or suspicious branches.
12. For `Required Tests`, name the invariant being proved, the positive path, and the failure or compatibility mutation. A test must prove the specific binding/fallback/diagnostic the row claims; it cannot just trigger a generic rejection.
13. Once implementation begins, freeze `Current Code` and `Intended Change`. All later updates are append-only in `Verification Findings`, `Fixes Applied`, `Final Alignment Status`, and optional `Plan Clarifications`.
14. After implementation, verify the final code against the intended behavior. If drift, missing edges, missing tests, or guardrail violations exist, fix them, append the verification/fix sections, and re-verify until aligned.
15. Group `Fixes Applied` by discovery source when more than one source exists (e.g., `Initial verification`, `Runtime testing`, `Review findings`, `Validation failures`, `Repo guardrails`, `Plan clarification`, `Final hygiene`). Do not leave a broad `During verification` bucket once other sources have produced fixes.
16. Treat `Verification Findings` as a resolution queue, not a backlog. Every finding must be (a) fixed, (b) marked not applicable with source-backed evidence, or (c) carried into `Final Alignment Status: Not aligned` with a specific human/external blocker (credentials, deployment access, product decision, etc.). Do not record fixable repo-local work as a permanent gap when the user asked for implementation.
17. Before marking final alignment, run two passes:
    - **Internal consistency:** if the same state, reason, or dependency failure appears with different intended outcomes, add the missing distinguishing axis or fix the mismatch.
    - **Review-prevention:** for every touched externally visible surface, walk `references/review-prevention.md`. Each item must be fixed, already covered by a named row/test, marked not applicable with reason, or carried into `Not aligned`. Do not mark `Aligned` while any item is merely assumed covered.
18. Only change `Intended Change` post-implementation if the plan itself was ambiguous or wrong. Record this as `Plan Clarifications` with reason and source. Never silently rewrite the target.
19. Always give the user a human-facing closeout summary outside the artifact. Separate: what was verified and fixed, important nuances, and anything still requiring user input or external action. If the agent cannot complete something autonomously (product decision, credentials, deployment access), ask the user directly. If no user action is required, say so. If the user also asked for review, use the artifact as a first-class input rather than recreating the analysis.

## Table Rules

- Prefer rows over prose. If a behavioral difference matters, capture it as a row.
- Keep wording compact and behaviorally specific. Use clickable file links and plan IDs/URLs for non-obvious rows.
- Treat an entry path as actual caller plus capabilities, not just a route or module name. Include rows for callers that cannot supply newly required headers, proof material, payload fields, or response handling.
- Call out parity requirements between entry paths (live vs recovery, upload vs replay, retry vs terminal, middleware vs direct, internal vs external). When two entry paths must enforce the same policy, final verification should confirm a shared helper or focused parity tests unless duplication is intentionally documented.
- Separate explicit requirements from inference. When the plan implies behavior without stating it, label the row inferred.
- When repo guardrails impose compatibility, version-skew, or fallback requirements, include them in `Intended Change` even if the plan text is narrower.
- Surface externally visible outcomes, not just internal branches.
- For wire contracts crossing packages, apps, repos, or process boundaries, prefer shared constants/types for header names, reason strings, modes, status meanings, and response shapes. If duplicated, record the drift risk or add a follow-up.
- If the same state or failure reason appears in multiple rows with different intended outcomes, add the missing axis or flag the contradiction before implementation.
- Do not use soft final states (`Partially aligned`, `Mostly aligned`, `Recorded Gaps`). Use `Aligned` only when no known fixable drift or required-test gap remains; otherwise `Not aligned` with the blocker.
- Do not mark `Aligned` if repo guardrails are violated, a required backward-compatible fallback is missing, plan/guardrail tension is unresolved, throw-capable preparation or framework-managed retry/reconnect paths are unrepresented, or the review-prevention pass is incomplete.
- The decision table is an LLM working artifact. Never bury user-actionable information only in the artifact; surface it in the final response.

## Prompt Guidance

Default invocation:

> Invoke the decision-table skill for this work item. Infer what needs to be mapped, write one artifact under `.closedloop-ai/decision-tables/`, then implement, verify final code against that artifact, and fix any drift or missing tests before finishing. Treat verification findings as a resolution queue: every finding must be fixed, proven not applicable, or carried into `Final Alignment Status: Not aligned` with a concrete human/external blocker. Keep baseline and target sections frozen; append verification and fixes.

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
