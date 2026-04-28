---
name: decision-table
description: Use when the user wants a code-grounded decision table for current behavior, wants to compare current behavior against a plan or work item, or needs a control-flow artifact for recovery, retry, finalization, validation, state-machine, or review-heavy edge cases.
---

# Decision Table

## Purpose

Generate a repo-local decision-table artifact that makes control-flow and stateful edge cases reviewable.

Use the decision table as the source of truth. A flowchart is optional and secondary.

## Output Location

Write artifacts under:

`<repo-root>/.closedloop-ai/decision-tables/`

Create the directory if it does not exist.

Default to one artifact per full work item:

- plan-scoped: `<plan-id>.md`
- non-plan-scoped: `<short-work-name>.md`

Use lowercase kebab-case for non-plan names.

If the work item contains multiple important behavior areas, keep them as sections inside the same artifact.

Only split into multiple files when one artifact would be too large to review quickly or when the work clearly spans separate repos or systems.

## Workflow

1. Resolve the repo root and the work item under review.
2. If the user supplied a plan, ticket, or work description, infer what behavior needs to be mapped:
   - control-flow or stateful surfaces that can change externally visible behavior
   - retries, recovery, replay, or finalization paths
   - validation, rejection, and error handling paths
   - state transitions and durable side effects
3. Ignore purely mechanical edits unless they change behavior.
4. If the user supplied a plan, read it first and extract only behaviorally relevant requirements.
5. Read repo-level guardrails that can constrain or overrule the plan, such as agent instruction files (`AGENTS.md`, `CLAUDE.md`, or equivalent), compatibility rules, contributor docs, and API contract guidance. Treat these as co-equal requirements, not optional context.
6. If the plan and repo-level guardrails conflict, do not silently pick one. Record the tension in the artifact, add a `Plan Clarifications` note when appropriate, and surface the conflict to the user if it affects implementation or review.
7. Read the code paths that currently implement the work item. Build the table from code, not from expectations.
8. For shared routes, handlers, helpers, contracts, or policy surfaces, build a call-site inventory before choosing axes. Search for literal route paths, exported helper names, event names, header/reason/status strings, and shared types. For each caller, record what data it can supply, what response shapes/statuses it expects, whether older or newer peer versions exist, and how missing or unknown fields degrade.
9. When mapping handlers, services, or adapters, explicitly model dependency outcomes that can change externally visible behavior: success, null/absent, validation failure, and thrown/rejected dependency failure when the callee can throw or reject.
10. Before implementation, run a behavioral edge-case expansion pass for each intended row:
   - Structured-result contracts: include rows for synchronous preparation failures before fetch/await/return, such as URL construction, payload building, JSON/body/header construction, parser setup, and other throw-capable setup code.
   - Exported boundary invariants: when a helper, service, adapter, route, command, job, or handler can be called by more than one path, include rows for the invariants it must enforce itself even when current callers validate first, especially before network I/O, persistence, credentials, filesystem mutation, or other durable side effects.
   - Contract-signal precedence: when a dependency or peer returns multiple signals that can affect the same decision, such as transport status, structured body fields, error codes, reason strings, headers, metadata, exit status, or sentinel files, include rows for each signal and for conflicts between signals. State which signal wins and how unknown or missing signals degrade.
   - Library-managed lifecycle re-entry: include rows for automatic reconnects, retry timers, callbacks, restarts, framework-owned replays, and other paths that can re-enter with reused state.
   - Active-processing re-entry: when a flow can receive a new event, request, callback, file, message, or retry while an earlier item is still being handled, include rows for idle, active, queued, coalesced, duplicate, dropped, and shutdown states as applicable. State when pending work drains and whether callers see a retryable, terminal, or silent outcome.
   - Terminal-state transition guards: when a flow has terminal or one-way states such as approved, denied, expired, consumed, completed, cancelled, revoked, or failed, include rows for every mutating action attempted from each terminal state. State which states are mutable, which are no-ops, which return a terminal error, and which durable fields must never be rewritten. Include repeated UI actions such as approve-then-deny, deny-then-approve, double-clicks, retries after timeout, and stale browser tabs after another actor already completed the flow.
   - Cancellation and shutdown: when a flow waits, sleeps, backs off, schedules a timer, retries, or runs asynchronously, include rows for cancellation or shutdown before the wait, during the wait, after the wait but before the next side effect, and during the side effect when applicable.
   - Time-bound credentials, signatures, or payloads: include rows for first attempt, retry/reconnect, restart, expired past timestamps, future timestamps, and clock-boundary conditions, and state whether timestamped or expiring material is regenerated, rejected, or reused.
   - One-time side effects: when a flow deletes, consumes, rotates, invalidates, acknowledges, commits, uploads, locks, or otherwise spends a one-time resource, include rows for failures and re-entry before and after that side effect. Include cleanup or consume failures on success, validation failure, parse failure, and dependency failure branches when those branches attempt cleanup. State whether the resource can be safely reused, retried, replaced, or must be considered spent.
   - Shared durable resources: when deleting, rotating, revoking, or clearing persisted keys, credentials, locks, cache entries, files, profiles, identities, or other durable resources, include rows for no remaining references, another saved/profile reference, active runtime reference, stale reference, and unknown lookup failure. State whether the resource is reference-counted, ownership-scoped, shared, or safe to delete unconditionally.
   - Profile or config cloning: when saving, duplicating, importing, switching, or snapshotting a profile/config from active runtime state, include rows for fields that must be copied, regenerated, omitted, or downgraded. Treat credentials, signing keys, service IDs, device IDs, integration IDs, public keys, machine identities, and other ownership-scoped identifiers as non-transferable by default unless the plan explicitly says they are shared.
   - Diagnostic contracts: when the plan requires redacted diagnostics, telemetry, or structured reasons, include expected reason/category values for each failure class, such as validation failure, missing state, unavailable secure storage, signer failure, timeout, network failure, and remote rejection.
   - Advertised status inventory: when code exposes statuses, reasons, modes, variants, exit values, event names, or other enumerated outcomes, inventory which branches can produce each value and flag dead, unreachable, duplicated, or misleading values.
   - Exception scope: for route handlers, middleware, auth wrappers, and policy helpers, distinguish setup failures, auth/proof failures, database or lookup failures, and downstream handler failures so catch-all blocks do not collapse unrelated errors into the same external status or message.
   - Serverless async side effects: for serverless or edge route handlers, include rows for side effects that happen after the response path, such as last-used timestamps, telemetry, uploads, notifications, and cleanup. State whether they are awaited, passed to a platform lifecycle primitive such as `waitUntil` where available, persisted through an outbox, or intentionally best-effort.
   - Path and identity policy canonicalization: for allowlists, denylists, ownership checks, cache keys, dedupe keys, lock keys, object identifiers, and other policy comparisons, include rows for raw input, normalized form, canonical form, aliases, symbolic references, case or separator variants, parent/child boundaries, empty values, and missing targets where applicable.
   - Partial update preservation: when a route or service updates a nested object, JSON blob, configuration record, metadata map, or persisted state bundle, include rows for omitted fields, explicit empty/null fields, single-field updates, and full replacement. State whether the operation merges with existing state or replaces it, and which existing fields must survive unknown or partial updates.
   - Persistence access paths: when adding persisted fields, tables, indexes, uniqueness constraints, or cleanup jobs, inventory the actual reads, writes, filters, sort orders, expiry scans, rate limits, and ownership checks that will use them. Distinguish query-critical indexes from write-only metadata, future-only fields, redundant left-prefix indexes, and indexes that need additional columns to match the real predicate.
   - Side-effect boundary: for every validation or preparation failure, state whether network calls, persistence, key generation, retries, telemetry, or other durable side effects should happen.
   - Testable invariant: for signing, canonicalization, validation, and compatibility rows, state the exact invariant a test must prove, including a positive control and one-axis mutation when a field binding matters.
11. Choose a small set of state axes that explain the branch behavior. Reuse the same axes within each behavior area for current and intended tables.
12. Write the artifact using the format in `references/artifact-format.md`.
13. When a plan is in scope, include:
   - `Current Code`
   - `Intended Change`
   - `Delta Checklist`
   - `Required Tests`
14. When writing `Required Tests`, name the invariant being proved, the positive path, and the failure or compatibility mutation. Do not let a test merely trigger a generic rejection when the row claims to prove a specific binding, fallback, or diagnostic reason.
15. When no plan is in scope, omit `Intended Change` and focus on the current-state table plus gaps or suspicious branches.
16. Once implementation begins, treat `Current Code` and `Intended Change` as frozen. Do not rewrite them to match the final implementation.
17. After implementation, verify the final code against the intended behavior in the artifact by appending:
   - `Verification Findings`
   - `Fixes Applied`
   - `Final Alignment Status`
18. If verification or review finds drift, behavioral mismatches, missing edge cases, missing tests, or repo-guardrail violations, fix them in the code and tests, append the verification/fix sections, and re-verify until the final code aligns with the intended behavior.
19. Organize `Fixes Applied` by discovery source when more than one source exists. Use source labels such as `Initial verification`, `Runtime/manual testing`, `Review findings`, `Validation failures`, `Repo guardrails`, `Plan clarification`, and `Final hygiene`. Do not leave a broad `During verification` bucket once review, runtime, validation, or follow-up fixes have also been applied.
20. Treat `Verification Findings` as a resolution queue, not a backlog. Every finding must be fixed, marked not applicable with evidence, or carried into `Final Alignment Status: Not aligned` with the specific human/external blocker that prevents autonomous completion. Do not leave fixable repo-local work as a recorded gap when the user asked for implementation.
21. Before marking final alignment, run an internal consistency pass over the artifact. If the same state, reason, or dependency failure appears with different intended external outcomes, add the missing distinguishing axis, record a plan clarification, or treat it as a mismatch to fix.
22. Before marking final alignment, run a review-prevention pass over every touched externally visible surface. For each changed route, handler, service, command, adapter, UI action, persisted-state update, and shared helper, ask whether a code reviewer could still find:
   - an unmodeled dependency throw/reject branch that maps to the wrong external status, retryability, or message
   - a terminal-state or repeated-action mutation that overwrites durable state
   - a partial update that drops unrelated existing nested/JSON/config/metadata fields
   - a feature-flag, rollout, or permission path that bypasses the intended gate or uses the wrong identity
   - a caller or version-skew path that cannot supply a newly required field, header, proof, or response shape
   - duplicated policy, helper, constant, or wire-contract logic that should be shared or parity-tested
   - a test that asserts only that something failed, without proving the specific invariant, fallback, binding, or diagnostic reason from the table
23. For every item from the review-prevention pass, add a verification note: fixed, already covered by a named row/test, not applicable with the reason, or `Not aligned` with the human/external blocker. Do not mark `Aligned` while any item is merely assumed covered.
24. Only change `Intended Change` after implementation if the plan itself was ambiguous or incorrect. When that happens, add an explicit `Plan Clarifications` note with the reason and source rather than silently rewriting the target behavior.
25. Always give the user a human-facing closeout summary outside the artifact after verification is complete.
26. In that closeout summary, explicitly separate:
   - what was verified and fixed
   - important nuances the user should know
   - anything that still needs user input or external action
27. If there is any user-actionable item that the agent cannot safely complete itself, surface it directly to the user as an explicit question or action item. Do not leave it only inside the decision table.
28. If there is no user action required, say so plainly.
29. If the user also asks for review, use the written artifact as a first-class input to the review rather than recreating the analysis from scratch.

## Table Rules

- Prefer rows over prose. If a behavioral difference matters, capture it as a row.
- Keep row wording compact and behaviorally specific.
- Default to one artifact per plan or work item, with internal sections for distinct behavior areas when needed.
- Use source references for non-obvious rows:
  - workspace files with clickable links
  - plan identifiers or URLs for intended behavior
- Separate explicit requirements from inference. If the plan implies behavior that is not directly stated, label that as inferred.
- When repo-level guardrails impose compatibility, version-skew, or fallback requirements, include them in `Intended Change` even if the plan text is narrower.
- Treat an entry path as an actual caller plus its capabilities, not just a route or module name. Include rows for callers that cannot provide newly required headers, proof material, payload fields, or response handling.
- Call out parity requirements between entry paths, such as live path vs recovery path, upload path vs replay path, retry path vs terminal path, middleware path vs direct route path, or internal caller vs external caller.
- When two entry paths are meant to enforce the same policy, final verification should confirm a shared helper or focused parity tests unless there is a documented reason to keep duplicated logic.
- For route handlers, RPC handlers, webhooks, and other contract surfaces, include rows for dependency throws/rejections whenever the handler promises exact externally visible status codes or error bodies.
- For structured-result or compatibility surfaces, include rows or explicit non-applicability notes for newly introduced throw-capable preparation code and framework-managed retry/reconnect paths before marking final alignment.
- For shared helpers or exported boundaries, do not rely only on caller-side validation. Either record that the boundary enforces its own invariants, or record why the boundary is intentionally private/single-caller and how that is kept true.
- For contracts with multiple decision signals, include rows or explicit non-applicability notes for signal precedence, including conflicts between transport-level and payload-level signals, older peers that omit newer fields, and newer peers that send unknown fields or values.
- For stateful flows with in-progress guards, waits, delays, timers, retries, or asynchronous continuations, include rows or explicit non-applicability notes for new work arriving while processing is active, after one-time side effects have happened, and before/during/after shutdown or cancellation.
- For stateful approval, denial, cancellation, expiration, consumption, or completion flows, require transition rows for every mutating action from terminal states. Final verification must prove terminal states cannot be overwritten by later actions unless the intended table explicitly allows a rollback or superseding transition.
- For time-window checks, require both stale/too-old and future/too-new rows unless future values are impossible by construction and that construction is documented.
- For cleanup, consume, or delete behavior, require parity rows for invalid and dependency-failure branches, not only valid or happy-path branches.
- For deletion, revocation, rotation, or clearing of durable keys, credentials, identities, files, locks, cache entries, profiles, or state bundles, require reference-safety rows proving the resource is not still used by another saved profile, active runtime identity, fallback identity, retry path, or recovery path before deletion.
- For save, duplicate, import, switch, or snapshot flows, require profile/config identity rows proving which fields are copied versus regenerated or omitted. Final verification must prove a new profile/config cannot accidentally inherit another profile's ownership-scoped service ID, device ID, integration ID, signing key, public key, machine identity, or credential binding.
- For enumerated external outcomes, verify that every advertised status/reason/value is produced by some branch, and every produced value is documented by the table.
- For path, identity, or policy comparisons, include rows or explicit non-applicability notes for canonicalization and equivalence classes such as aliases, symbolic references, separator differences, case differences, parent/child lookalikes, and non-existent targets.
- For partial updates to nested objects, JSON blobs, metadata, configuration, or persisted state bundles, require rows that distinguish merge-vs-replace behavior and prove omitted existing fields are preserved unless full replacement is explicitly intended.
- For schema or persistence changes, require an access-path inventory for every new index and constraint. Remove or mark not-applicable any index that is not justified by a current query, rate limit, cleanup path, uniqueness guarantee, sort order, or explicitly documented near-term requirement.
- For serverless or edge route handlers, do not treat fire-and-forget promises as durable unless the code awaits them, passes them to a platform lifecycle primitive, persists work for later processing, or explicitly declares the side effect best-effort.
- For wire contracts that cross packages, apps, repos, or process boundaries, prefer shared constants/types for header names, reason strings, modes, status meanings, and response shapes. If constants are duplicated, record the drift risk or add a follow-up.
- For signing, canonicalization, validation, and compatibility tests, require a positive control and one-axis mutation when the decision row claims a specific field binding or fallback behavior.
- For retry or recovery tests, require a positive retryable case, a terminal/non-retryable case, and an unknown-or-legacy-shape case when the contract supports partial or version-skewed peers.
- For lifecycle re-entry tests, require an idle path, an active-processing path, and a drain or terminal-outcome assertion when the implementation queues, coalesces, deduplicates, drops, or rejects repeated work.
- For path-policy tests, require a safe positive control, a blocked canonical control, and at least one equivalent or near-equivalent mutation that could bypass naive string comparison.
- If the same state or failure reason appears in multiple rows with different intended outcomes, add the missing axis or flag the contradiction before implementation.
- Surface externally visible outcomes, not just internal branches.
- `Current Code` is a pre-implementation baseline snapshot. Freeze it once implementation begins.
- `Intended Change` is the target behavior derived from the plan or work item. Do not rewrite it to match final code.
- Post-implementation updates must be append-only in `Verification Findings`, `Fixes Applied`, `Final Alignment Status`, and optional `Plan Clarifications`.
- `Fixes Applied` should be grouped by discovery source once the section contains more than one source of fixes. Keep each group factual and tied to a corresponding finding, validation failure, review issue, runtime check, guardrail issue, or final hygiene step.
- `Verification Findings` is not a passive backlog. Every finding must have a matching fix, a source-backed not-applicable explanation, or a `Not aligned` blocker that requires user input, credentials, external access, deployment state, or a product decision.
- Do not use soft final states such as `Partially aligned`, `Mostly aligned`, or `Recorded Gaps`. Use `Aligned` only when no known fixable drift or required-test gap remains. Otherwise use `Not aligned` and state the blocker or required user action.
- Do not mark `Final Alignment Status` as aligned if repo-level guardrails are violated, if a required backward-compatible fallback path is missing, or if plan-vs-guardrail tension remains unresolved.
- Do not mark `Final Alignment Status` as aligned for a structured-result or compatibility surface until all newly introduced throw-capable preparation code and framework-managed retry/reconnect paths are represented by either a decision-table row or an explicit non-applicability note.
- Do not mark `Final Alignment Status` as aligned until the review-prevention pass has covered every touched externally visible surface and recorded how likely review findings were prevented or ruled out.
- The decision table is an LLM working artifact, not the only communication channel for the human user.
- Never bury user-actionable information only in the artifact; surface it in the final response.

## Prompt Guidance

Good default invocation:

`Invoke the decision-table skill for this work item. Infer what needs to be mapped, write one artifact under .closedloop-ai/decision-tables/, then implement, verify final code against that artifact, and fix any drift or missing tests before finishing. Treat verification findings as a resolution queue, not a backlog: every finding must be fixed, proven not applicable, or carried into Final Alignment Status: Not aligned with a concrete human/external blocker. Keep the baseline and target sections frozen; append verification and fixes instead of rewriting them.`

When a plan exists:

`Invoke the decision-table skill with PLAN-123. Before coding, generate the current-state and intended-state decision table for the full plan, write it to .closedloop-ai/decision-tables/plan-123.md, and incorporate repo guardrails such as agent instruction files and compatibility docs as co-equal requirements. Then implement the plan, verify final code against that artifact, and fix any drift or missing tests before finishing. Treat verification findings as a resolution queue, not a backlog: every finding must be fixed, proven not applicable, or carried into Final Alignment Status: Not aligned with a concrete human/external blocker. Keep the baseline and target sections frozen; append verification and fixes instead of rewriting them.`

When you want the requirement spelled out even more explicitly:

`Invoke the decision-table skill with PLAN-123. Before coding, generate the current-state and intended-state decision table for the full plan and write it to .closedloop-ai/decision-tables/plan-123.md. Read repo guardrails such as agent instruction files and compatibility docs and treat them as co-equal requirements. Model dependency success, null/absent, and thrown/rejected branches anywhere the surface promises exact status or error behavior. Then implement the plan. After implementation, verify the final code against the intended table. If the code, tests, artifact, or compatibility behavior drift from the intended behavior, fix the issues, append verification and fix sections, and re-verify until aligned. Treat verification findings as a resolution queue, not a backlog: every finding must be fixed, proven not applicable, or carried into Final Alignment Status: Not aligned with a concrete human/external blocker. Do not rewrite the baseline or intended sections unless you are explicitly recording a plan clarification.`

## Human Handoff

The final user-facing message must not assume the user will read the decision table.

Include a concise summary of:

- what was verified
- what was fixed
- any behavior nuance or plan clarification the user should know
- any external or human action required

If the agent cannot complete something autonomously because it requires a product decision, credentials, deployment access, or another human-controlled step, ask the user directly in the final response.

If there is no human action required, say that explicitly.

## Review Guidance

Normal review is enough once the artifact exists. Review the change against the decision table, the plan, and repo-level guardrails such as agent instruction files, compatibility rules, and contributor docs. Treat any mismatches as issues to fix, not just findings to report, and surface any remaining user-actionable items directly in the final response.

For contract-heavy work, explicitly review:

- new-shape and old/unknown-shape compatibility behavior when repo guardrails require version-skew safety
- precedence between competing decision signals, such as status, structured fields, error codes, headers, metadata, exit state, and persisted markers
- call-site inventory completeness for shared routes, helpers, contracts, and policy surfaces
- caller capability differences, especially callers that cannot supply newly required headers, proof material, fields, or response handling
- dependency throw/reject branches on route or handler surfaces that promise exact status codes or error bodies
- catch-all error handling that may map unrelated failures to a specific auth, verifier, validation, or dependency diagnostic
- in-progress guards that return without preserving, rejecting, or explicitly classifying later work
- terminal-state guards that fail to preserve approved, denied, expired, consumed, completed, cancelled, revoked, or failed state when a later or repeated action arrives
- retries or replays that reuse resources after delete, consume, rotate, invalidate, acknowledge, commit, upload, or lock side effects
- destructive cleanup that deletes a shared durable resource still referenced by another profile, active runtime identity, fallback identity, retry path, or recovery path
- path, identity, and policy checks that compare raw spelling instead of normalized or canonical equivalents where equivalence matters
- partial updates that overwrite unrelated fields in nested objects, JSON blobs, metadata, configuration, or persisted state bundles when the intended behavior is additive or merge-preserving
- schema indexes or constraints that are redundant, unused by current access paths, mismatched to predicates or sort orders, or added for write-only metadata without a documented read path
- serverless async side effects that may be dropped unless awaited, scheduled with a platform primitive, or persisted
- test oracle quality for canonicalization, signing, validation, and compatibility rows
- duplicated policy logic or wire-contract constants that can drift between intended-parity entry paths
- whether `Final Alignment Status` is still defensible given the implemented compatibility and failure behavior

A separate review skill is only worth adding if this becomes a repeated, high-volume workflow and you want a fixed review rubric layered on top of the existing review prompt.

## Optional Mermaid

Only produce a Mermaid diagram if the user asks for it or if the table is too large to scan quickly. The Mermaid should be derived from the decision table, not the other way around.
