# Review-Prevention Pass

Run this pass before marking `Final Alignment Status: Aligned`. For every touched externally visible surface (route, handler, service, command, adapter, UI action, persisted-state update, shared helper), ask whether a code reviewer could still find any of the items below.

For every item: fix it, mark it already covered by a named row/test, mark not applicable with reason, or carry it into `Not aligned` with a concrete blocker. Do not mark `Aligned` while any item is merely assumed covered.

## Items

1. **Unmodeled dependency throw/reject branch** that maps to the wrong external status, retryability, or message.
2. **Terminal-state or repeated-action mutation** that overwrites durable state (approved, denied, expired, consumed, completed, cancelled, revoked, failed).
3. **Partial update** that drops unrelated existing nested/JSON/config/metadata fields.
4. **Feature-flag, rollout, or permission path** that bypasses the intended gate or uses the wrong identity.
5. **Caller or version-skew path** that cannot supply a newly required field, header, proof, or response shape.
6. **Duplicated policy, helper, constant, or wire-contract logic** that should be shared or parity-tested.
7. **Test that asserts only that something failed**, without proving the specific invariant, fallback, binding, or diagnostic reason from the table.

## Contract-Heavy Review Surface

For contract-heavy work, also explicitly review:

- new-shape and old/unknown-shape compatibility behavior when guardrails require version-skew safety
- precedence between competing decision signals (status, structured fields, error codes, headers, metadata, exit state, persisted markers)
- call-site inventory completeness for shared routes, helpers, contracts, and policy surfaces
- caller capability differences, especially callers that cannot supply newly required headers, proof material, fields, or response handling
- dependency throw/reject branches on route/handler surfaces that promise exact status codes or error bodies
- catch-all error handling that may map unrelated failures to a specific auth/verifier/validation/dependency diagnostic
- in-progress guards that return without preserving, rejecting, or explicitly classifying later work
- terminal-state guards that fail to preserve approved/denied/expired/consumed/completed/cancelled/revoked/failed state when a later or repeated action arrives
- retries or replays that reuse resources after delete/consume/rotate/invalidate/acknowledge/commit/upload/lock side effects
- destructive cleanup that deletes a shared durable resource still referenced by another profile, active runtime identity, fallback identity, retry path, or recovery path
- path/identity/policy checks comparing raw spelling instead of normalized or canonical equivalents where equivalence matters
- partial updates that overwrite unrelated fields when the intended behavior is additive or merge-preserving
- schema indexes/constraints that are redundant, unused by current access paths, mismatched to predicates or sort orders, or added for write-only metadata without a documented read path
- serverless async side effects that may be dropped unless awaited, scheduled with a platform primitive, or persisted
- test oracle quality for canonicalization, signing, validation, and compatibility rows
- duplicated policy logic or wire-contract constants that can drift between intended-parity entry paths
- whether `Final Alignment Status` is still defensible given the implemented compatibility and failure behavior
