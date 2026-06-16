# Review-Prevention Pass

Run this pass before marking `Final Alignment Status: Aligned`. For every touched externally visible surface (route, handler, service, command, adapter, UI action, persisted-state update, shared helper), ask whether a code reviewer could still find any of the items below.

For every item: fix it, mark it already covered by a named row/test, mark not applicable with reason, or carry it into `Not aligned` with a concrete blocker. Do not mark `Aligned` while any item is merely assumed covered.

Coverage-claim rule: any `covered`, `not applicable`, or `already covered` disposition in this pass must cite a specific test name and the wrong-input or negative case that test fails closed on. A coverage claim backed only by a happy-path assertion, or by no test at all (including for security findings), is treated as `Not aligned`, not as covered.

## Items

1. **Unmodeled dependency throw/reject branch** that maps to the wrong external status, retryability, or message.
2. **Terminal-state or repeated-action mutation** that overwrites durable state (approved, denied, expired, consumed, completed, cancelled, revoked, failed).
3. **Partial update** that drops unrelated existing nested/JSON/config/metadata fields.
4. **Feature-flag, rollout, or permission path** that bypasses the intended gate or uses the wrong identity.
5. **Caller or version-skew path** that cannot supply a newly required field, header, proof, or response shape.
6. **Duplicated policy, helper, constant, or wire-contract logic** that should be shared or parity-tested.
7. **External contract literal collision** where a feature flag key, rollout name, query parameter, cache segment, header, event name, command name, storage key, plugin identifier, URL scheme, reason string, or status value is confused with a similarly named internal label or unrelated contract.
8. **Permissive test mock hides a wrong external key** because the mock returns enabled, valid, found, or accepted for any feature flag, header, query parameter, event, cache key, storage key, command name, or plugin identifier instead of failing closed unless the exact expected literal is used.
9. **Test that asserts only that something failed**, without proving the specific invariant, fallback, binding, or diagnostic reason from the table.
10. **Cleanup/finalizer state scoped too narrowly** for the cleanup mechanism that runs on error, cancellation, signal, trap, retry, process exit, disposal, or a language cleanup block.
11. **Durable output using raw input** after validation used an expanded, normalized, canonical, resolved, or otherwise transformed value.
12. **Validation checks a different representation** than the value later consumed by a decision, side effect, output, or boundary payload.
13. **State produced inside an isolated execution context** that is assumed to be available to a later phase without an explicit return, output, persistence, recomputation, or other propagation mechanism.
14. **Distinct modeled states with indistinguishable observable output** where the table or user-facing copy treats the states as meaningfully different, but the implemented status, message, action availability, styling, telemetry, or response signal is identical unless that parity is explicitly intentional.
15. **Replay or continuation path bypasses an initial-entry gate** such as a command guard, policy check, validation step, target resolver, or health check.
16. **Owner-scoped pending state leaks across surfaces** because loading, disabled, or label state reads a global pending/checking flag without matching the current owner, command, document, target, or attempt id.
17. **Sentinel value semantics collapse** where omitted, `undefined`, `null`, empty, and explicit values have different downstream meaning but are defaulted, coalesced, or serialized as the wrong shape.
18. **Adapter-variant error metadata mismatch** where code maps a dependency or database error by only one metadata shape even though the dependency may report an equivalent signal as a constraint name, field array, column array, structured object, missing metadata, or legacy/unknown value.
19. **Existing-data migration blocker** where a new unique constraint or stricter persisted invariant assumes all existing rows already satisfy the invariant instead of cleaning, backfilling, or explicitly preflighting violating rows before the constraint is created.
20. **Cleanup-induced adjacent constraint failure** where a migration repair satisfies the new invariant but leaves stale identity, reference, or preference state that makes the next normal application update fail on another constraint.
21. **Terminal local state not recoverable after external finalization failure** where a job, event, marker, status, or artifact is persisted locally but the external post, upload, acknowledgement, or finalization fails, and recovery cannot replay it because eligibility fields are missing or required credentials, tokens, signatures, secrets, locks, or marker data were deleted.
22. **Cross-surface write with no reconciliation path** where a web/backend/local write updates one surface but another process, replica, Electron runtime, cache, or peer only changes after manual refresh or never converges after missed events, offline time, reconnect, heartbeat, poll, or startup.
23. **Visible data mistaken for fired side effect** where a key, command, notification, badge, telemetry event, dispatch, cleanup, or prompt appears in a list/cache/view but the operational side effect never fires, repeats incorrectly, or lacks a dedupe rule.
24. **Stale cached capability false negative or false positive** where supported-operation or peer-capability cache causes a required safety action to be skipped, dispatches an unsupported command without fallback, or never reconciles after authoritative peer evidence changes.
25. **Legacy persisted record promoted or deleted without evidence** where missing provenance, source, trust, ownership, or capability fields default too optimistically, backfill without authoritative proof, downgrade unsafely, or treat manual/local records as managed remote records.
26. **Distributed lifecycle gap** where register/create, approval/authorization, normal command, revoke/delete, offline/reconnect reconciliation, repeated action/idempotency, or stale UI/cache behavior lacks its own row and required test.
27. **Derivation reads the incoming patch instead of merged state** where an upsert or partial update triggers a derived field, reducer, stamped value, or validation that consumes only the incoming patch rather than the post-merge result (existing state union patch), so a single-field or partial update that omits an identity or state field the derivation depends on produces a stale or wrong derived value.
28. **Gate-versus-filter predicate divergence** where the same eligibility, completion, or terminal predicate is enforced at one site (a gate) but re-derived independently at another (a list filter, a terminal or disposition check, a batch or unscoped routing path, or an early short-circuit), and the two derivations can disagree because they do not share a helper.
29. **Coverage claim without a fail-closed test** where a `covered`, `not applicable`, or `already covered` disposition cites no test, or cites only a happy-path assertion, instead of a named test that fails closed on the wrong-input or negative case (including security findings).

## Contract-Heavy Review Surface

For contract-heavy work, also explicitly review:

- new-shape and old/unknown-shape compatibility behavior when guardrails require version-skew safety
- precedence between competing decision signals (status, structured fields, error codes, headers, metadata, exit state, persisted markers)
- call-site inventory completeness for shared routes, helpers, contracts, and policy surfaces
- caller capability differences, especially callers that cannot supply newly required headers, proof material, fields, or response handling
- dependency throw/reject branches on route/handler surfaces that promise exact status codes or error bodies
- catch-all error handling that may map unrelated failures to a specific auth/verifier/validation/dependency diagnostic
- in-progress guards that return without preserving, rejecting, or explicitly classifying later work
- replay and continuation paths, including conflict replays, retry callbacks, confirmation callbacks, and deferred command callbacks, that must enforce the same gate or policy as the original entry path
- owner-keyed pending/loading/disabled UI whose observable state must be scoped to the current owner, command, document, target, or attempt instead of unrelated active work
- terminal-state guards that fail to preserve approved/denied/expired/consumed/completed/cancelled/revoked/failed state when a later or repeated action arrives
- terminal local state whose external finalization fails after persistence but before acknowledgement, leaving recovery unable to replay the same user-visible terminal outcome
- cross-surface propagation and reconciliation after writes, including immediate push/control events, poll/heartbeat/reconnect/startup, manual refresh, missed-event recovery, offline recovery, and durable source-of-truth precedence
- data visibility versus side effects, especially cases where refreshed/listed state exists but OS notifications, command dispatches, revocations, telemetry, cleanup, or deduplicated prompts do not fire
- cached capability or supported-operation drift, including fresh cache, stale false negative, stale false positive, old peer, unknown peer shape, fallback, retry, and cache reconciliation
- backward-compatible defaults for legacy persisted records missing provenance/source/trust/ownership fields, including conservative defaults, evidence-backed promotion/backfill, downgrade behavior, and manual-record protection
- distributed lifecycle coverage across register/create, approval/authorization, normal command execution, revoke/delete, offline/reconnect reconciliation, repeated action/idempotency, and stale UI/cache scenarios
- retries or replays that reuse resources after delete/consume/rotate/invalidate/acknowledge/commit/upload/lock side effects
- payload fields whose omitted, `undefined`, `null`, empty, and explicit values are semantically distinct at the next boundary
- exact external contract literals, including feature flag keys, rollout names, query parameters, cache segments, headers, storage keys, event names, command names, plugin identifiers, URL schemes, reason strings, and status values, and whether similarly named internal labels are intentionally distinct or shared through a constant
- test mocks for those literals that must fail closed when the implementation uses the wrong key, name, identifier, or semantic role
- destructive cleanup that deletes a shared durable resource still referenced by another profile, active runtime identity, fallback identity, retry path, or recovery path
- path/identity/policy checks comparing raw spelling instead of normalized or canonical equivalents where equivalence matters
- validation checks that run on raw input while a side effect, command, state transition, policy decision, boundary payload, or user-facing output consumes a trimmed, parsed, normalized, canonicalized, defaulted, or coerced value
- durable messages, handoffs, configurations, state records, commands, or files that serialize raw path, identity, endpoint, workspace, profile, account, or tenant input instead of the canonical value that validation and policy checks approved
- deferred cleanup handlers, traps, disposers, process-exit hooks, and finalizers whose cleanup handles live only in a local/callback scope unavailable when cleanup actually runs
- later phases that depend on values computed inside an isolated execution context without proving the state crosses that boundary through an explicit propagation mechanism
- partial updates that overwrite unrelated fields when the intended behavior is additive or merge-preserving
- semantically distinct user-visible states that share the same observable status signal, label, action affordance, or presentation despite the table claiming different outcomes
- schema indexes/constraints that are redundant, unused by current access paths, mismatched to predicates or sort orders, or added for write-only metadata without a documented read path
- unique constraints or stricter persisted invariants that can fail on existing violating rows because the migration lacks a cleanup, backfill, or explicit preflight before creating the constraint
- migration cleanup/backfill that changes identity-bearing rows without checking adjacent unique constraints, references, preferences, and the first normal write or recovery path that will touch those rows afterward
- database/ORM error mapping that only recognizes one adapter-specific metadata shape when equivalent constraint or field signals can be reported in multiple shapes
- serverless async side effects that may be dropped unless awaited, scheduled with a platform primitive, or persisted
- test oracle quality for canonicalization, signing, validation, and compatibility rows
- duplicated policy logic or wire-contract constants that can drift between intended-parity entry paths
- the same eligibility, completion, or terminal predicate enforced at a gate but re-derived independently at another site (predicate at a gate vs. re-derived in a list filter, scoped vs. unscoped routing, a terminal or disposition check, a batch path, or an early short-circuit), where the two can disagree unless they share a helper or are tied together by a parity test
- whether `Final Alignment Status` is still defensible given the implemented compatibility and failure behavior
